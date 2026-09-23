/**
 * The internal workplace, against a real database and fixed clocks: zoned time (DST), working hours,
 * availability, conflicts, room capacity, the meeting lifecycle (schedule → reschedule → cancel,
 * status derived from time), outcomes, notifications, and event-verified presence.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { closeTestDb, resetTestSchema, testDb, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { seedPublishWorkflow, seedV11Definitions } from "../../src/definitions/seed.js";
import { activeAreaNames, applyTemplate, createDefaultWorld } from "../../src/world/worldConfig.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";
import { fromWallClock, wallClock } from "../../src/workplace/zonedTime.js";
import { workingIntervals, withinWorkingHours } from "../../src/workplace/availability.js";
import {
  WorkplaceError,
  availabilityFor,
  cancelMeeting,
  createCalendarEntry,
  createRoom,
  ensureDefaultRooms,
  getMeeting,
  listNotifications,
  listRooms,
  meetingPresence,
  proposeMeeting,
  recordMeetingOutcome,
  roomsOffTheMap,
  rescheduleMeeting,
  scheduleMeeting,
  timingWindow,
  updateSettings,
  readSettings,
} from "../../src/workplace/workplace.js";

const OP = { actor: "human:operator" };
// Thursday 17 September 2026, 10:00 in London (BST, UTC+1).
const NOW = new Date("2026-09-17T09:00:00Z");
const at = (iso: string) => new Date(iso);
const tx = (fn: (tx: DrizzleTransaction) => Promise<void>) => withRollback((t) => fn(t as unknown as DrizzleTransaction));
async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof WorkplaceError) return e.code;
    throw e;
  }
}
const room = async (t: DrizzleTransaction, name: string) => (await listRooms(t)).find((r) => r.name === name)!;

beforeAll(async () => {
  await resetTestSchema();
  await testDb.transaction((t) => seedPublishWorkflow(t));
  await testDb.transaction((t) => seedV11Definitions(t));
  // The rooms sit on the drawn rooms of the default world, as they do in a real Keep.
  await testDb.transaction((t) => createDefaultWorld(t));
  await testDb.transaction(async (t) => ensureDefaultRooms(t as unknown as DrizzleTransaction, "human:operator", await activeAreaNames(t)));
}, 30_000);

afterAll(async () => {
  await closeTestDb();
});

describe("zoned time", () => {
  it("converts wall clocks in the configured zone across daylight-saving changes, independent of the server zone", () => {
    expect(fromWallClock({ year: 2026, month: 7, day: 1, hour: 9, minute: 0 }, "Europe/London").toISOString()).toBe("2026-07-01T08:00:00.000Z");
    expect(fromWallClock({ year: 2026, month: 12, day: 1, hour: 9, minute: 0 }, "Europe/London").toISOString()).toBe("2026-12-01T09:00:00.000Z");
    // 25 Oct 2026 01:30 happens twice in London: the first (BST) occurrence is used.
    expect(fromWallClock({ year: 2026, month: 10, day: 25, hour: 1, minute: 30 }, "Europe/London").toISOString()).toBe("2026-10-25T00:30:00.000Z");
    // 29 Mar 2026 01:30 does not exist in London: resolved just after the gap.
    expect(fromWallClock({ year: 2026, month: 3, day: 29, hour: 1, minute: 30 }, "Europe/London").toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(fromWallClock({ year: 2026, month: 9, day: 17, hour: 9, minute: 0 }, "America/New_York").toISOString()).toBe("2026-09-17T13:00:00.000Z");
    expect(fromWallClock({ year: 2026, month: 9, day: 17, hour: 9, minute: 0 }, "Asia/Kolkata").toISOString()).toBe("2026-09-17T03:30:00.000Z");
    expect(wallClock(NOW, "Europe/London")).toMatchObject({ hour: 10, weekday: 4 });
  });

  it("working hours follow the zone on both sides of the clocks going back", () => {
    const hours = { workStartMinute: 540, workEndMinute: 1020, workingDays: [1, 2, 3, 4, 5, 6, 7] };
    const days = workingIntervals(hours, "Europe/London", { start: at("2026-10-24T00:00:00Z"), end: at("2026-10-26T23:00:00Z") });
    expect(days.map((d) => d.start.toISOString())).toEqual(["2026-10-24T08:00:00.000Z", "2026-10-25T09:00:00.000Z", "2026-10-26T09:00:00.000Z"]);
    expect(withinWorkingHours({ ...hours, workingDays: [1, 2, 3, 4, 5] }, "Europe/London", { start: at("2026-09-19T10:00:00Z"), end: at("2026-09-19T10:30:00Z") })).toBe(false);
  });

  it("timing windows are read in the workplace zone", async () => {
    await tx(async (t) => {
      const s = await readSettings(t);
      expect(timingWindow(s, { window: "tomorrow_morning" }, NOW, 30)).toEqual({ start: at("2026-09-17T23:00:00Z"), end: at("2026-09-18T11:00:00Z") });
      expect(timingWindow(s, { window: "at", at: "2026-09-18T14:00" }, NOW, 60)).toEqual({ start: at("2026-09-18T13:00:00Z"), end: at("2026-09-18T14:00:00Z") });
      const ny = { ...s, timezone: "America/New_York" };
      expect(timingWindow(ny, { window: "tomorrow_morning" }, NOW, 30)!.start.toISOString()).toBe("2026-09-18T04:00:00.000Z");
      expect(timingWindow(s, { window: "at", at: "18 Sept" }, NOW, 30)).toBeNull();
    });
  });
});

describe("proposals: availability, rooms and working hours decided by code", () => {
  it("picks the earliest slot where everyone is free, in the smallest room that fits", async () => {
    await tx(async (t) => {
      const p = await proposeMeeting(t, { participants: ["Researcher", "Publisher"], durationMinutes: 30, window: { start: NOW, end: at("2026-09-18T00:00:00Z") }, now: NOW });
      // Now + 2 minutes gather time, rounded up to the 15-minute grid; a room for two.
      expect(p).toMatchObject({ startsAt: at("2026-09-17T09:15:00Z"), endsAt: at("2026-09-17T09:45:00Z"), roomName: "One-to-one room" });
    });
  });

  it("skips a participant's existing meeting and break, and working-hours limits when enforced", async () => {
    await tx(async (t) => {
      const board = await room(t, "Boardroom");
      await scheduleMeeting(t, { title: "Existing", participants: ["Researcher"], startsAt: at("2026-09-17T09:15:00Z"), endsAt: at("2026-09-17T10:00:00Z"), roomId: board.id }, OP, NOW);
      await createCalendarEntry(t, { agentName: "Publisher", kind: "break", title: "Lunch", startsAt: "2026-09-17T10:00:00Z", endsAt: "2026-09-17T11:00:00Z" }, "human:operator");
      const p = await proposeMeeting(t, { participants: ["Researcher", "Publisher"], durationMinutes: 30, window: { start: NOW, end: at("2026-09-18T00:00:00Z") }, now: NOW });
      expect(p.startsAt).toEqual(at("2026-09-17T11:00:00Z"));
      // 16:45 London: a 30-minute meeting would end after 17:00, so the next working day's 09:00 (08:00Z) is chosen.
      const late = at("2026-09-17T15:40:00Z");
      const q = await proposeMeeting(t, { participants: ["Researcher"], durationMinutes: 30, window: { start: late, end: at("2026-09-20T00:00:00Z") }, now: late });
      expect(q.startsAt).toEqual(at("2026-09-18T08:00:00Z"));
      await updateSettings(t, { outsideWorkingHours: "allow" }, "human:operator");
      const r = await proposeMeeting(t, { participants: ["Researcher"], durationMinutes: 30, window: { start: late, end: at("2026-09-20T00:00:00Z") }, now: late });
      expect(r.startsAt).toEqual(at("2026-09-17T15:45:00Z"));
    });
  });

  it("names the real blocker: capacity, stopped agent, unknown agent, no common time, inactive room", async () => {
    await tx(async (t) => {
      const everyone = (await t.selectDistinct({ n: schema.agentDefinitions.name }).from(schema.agentDefinitions)).map((r) => r.n);
      const many = [...everyone, ...Array.from({ length: 15 }, (_, i) => `Temp ${i}`)];
      for (const name of many.filter((n) => !everyone.includes(n))) {
        await t.execute(sql`INSERT INTO agent_definitions (id, name, version, role, objective, instructions, execution_profile) VALUES (gen_random_uuid(), ${name}, 1, 'r', 'o', 'i', '{}'::jsonb)`);
      }
      const window = { start: NOW, end: at("2026-09-24T00:00:00Z") };
      expect(await code(proposeMeeting(t, { participants: many, durationMinutes: 30, window, now: NOW }))).toBe("insufficient_room_capacity");
      expect(await code(proposeMeeting(t, { participants: ["Researcher", "Nobody"], durationMinutes: 30, window, now: NOW }))).toBe("unknown_participant");
      expect(await code(proposeMeeting(t, { participants: ["Researcher"], durationMinutes: 30, window, now: NOW, roomName: "Conference room" }))).toBe("room_inactive");
      expect(await code(proposeMeeting(t, { participants: ["Researcher"], durationMinutes: 900, window, now: NOW }))).toBe("invalid_meeting");
      await createCalendarEntry(t, { agentName: "Researcher", kind: "unavailable", title: "Away", startsAt: "2026-09-17T00:00:00Z", endsAt: "2026-09-24T00:00:00Z" }, "human:operator");
      expect(await code(proposeMeeting(t, { participants: ["Researcher", "Publisher"], durationMinutes: 30, window, now: NOW }))).toBe("no_common_availability");
      const researcher = (await t.select().from(schema.agentDefinitions).where(eq(schema.agentDefinitions.name, "Publisher")))[0]!;
      await t.insert(schema.executionStops).values({ scope: "agent_definition", scopeRefId: researcher.id, reason: "hold", engagedBy: "human:operator" });
      expect(await code(proposeMeeting(t, { participants: ["Publisher"], durationMinutes: 30, window, now: NOW }))).toBe("participant_unavailable");
    });
  });
});

describe("meetings: exact validation, lifecycle and records", () => {
  it("refuses double booking of a room or a participant, past times and outside hours", async () => {
    await tx(async (t) => {
      const board = await room(t, "Boardroom");
      const small = await room(t, "Small meeting room");
      const slot = { startsAt: at("2026-09-17T10:00:00Z"), endsAt: at("2026-09-17T10:30:00Z") };
      await scheduleMeeting(t, { title: "A", participants: ["Researcher"], ...slot, roomId: board.id }, OP, NOW);
      expect(await code(scheduleMeeting(t, { title: "B", participants: ["Publisher"], ...slot, roomId: board.id }, OP, NOW))).toBe("room_conflict");
      expect(await code(scheduleMeeting(t, { title: "C", participants: ["Researcher"], ...slot, roomId: small.id }, OP, NOW))).toBe("participant_conflict");
      // Back to back is fine: ranges are half-open.
      expect(await code(scheduleMeeting(t, { title: "D", participants: ["Researcher"], startsAt: at("2026-09-17T10:30:00Z"), endsAt: at("2026-09-17T11:00:00Z"), roomId: board.id }, OP, NOW))).toBe("ok");
      expect(await code(scheduleMeeting(t, { title: "E", participants: ["Publisher"], startsAt: at("2026-09-17T08:00:00Z"), endsAt: at("2026-09-17T08:30:00Z"), roomId: board.id }, OP, NOW))).toBe("invalid_meeting");
      expect(await code(scheduleMeeting(t, { title: "F", participants: ["Publisher"], startsAt: at("2026-09-17T18:00:00Z"), endsAt: at("2026-09-17T18:30:00Z"), roomId: board.id }, OP, NOW))).toBe("outside_working_hours");
      expect(await code(scheduleMeeting(t, { title: "G", participants: ["Publisher", "Publisher"], ...slot, roomId: small.id }, OP, NOW))).toBe("invalid_meeting");
    });
  });

  it("schedule → invitations and reminders → reschedule (same meeting, reminders replaced) → cancel (kept) with events", async () => {
    await tx(async (t) => {
      const board = await room(t, "Boardroom");
      const small = await room(t, "Small meeting room");
      const { meetingId } = await scheduleMeeting(t, { title: "Research sync", agenda: "Plan", participants: ["Researcher", "Publisher"], startsAt: at("2026-09-17T13:00:00Z"), endsAt: at("2026-09-17T13:30:00Z"), roomId: board.id }, { actor: "agent:Manager" }, NOW);
      const inbox = await listNotifications(t, { recipient: "agent:Researcher" }, NOW);
      expect(inbox.map((n) => n.kind)).toEqual(["meeting_invitation"]);
      expect(inbox[0]!.body).toContain("2026-09-17 14:00–14:30 (Europe/London) in Boardroom");
      expect((await listNotifications(t, { recipient: "agent:Researcher" }, at("2026-09-17T12:55:00Z"))).map((n) => n.kind).sort()).toEqual(["meeting_invitation", "meeting_reminder"]);

      await rescheduleMeeting(t, { meetingId, startsAt: at("2026-09-17T14:00:00Z"), endsAt: at("2026-09-17T14:30:00Z"), roomId: small.id }, OP, NOW);
      expect(await t.select().from(schema.workplaceMeetings)).toHaveLength(1);
      const moved = (await getMeeting(t, meetingId, NOW))!;
      expect(moved).toMatchObject({ revision: 2, room: { name: "Small meeting room" }, status: "scheduled" });
      const later = await listNotifications(t, { recipient: "agent:Researcher" }, at("2026-09-17T13:55:00Z"));
      expect(later.filter((n) => n.kind === "meeting_reminder").map((n) => n.body)).toEqual([expect.stringContaining("15:00–15:30")]);

      expect(await code(rescheduleMeeting(t, { meetingId, startsAt: at("2026-09-17T14:00:00Z"), endsAt: at("2026-09-17T14:30:00Z"), roomId: small.id }, OP, NOW))).toBe("invalid_meeting");
      await cancelMeeting(t, { meetingId, reason: "not needed" }, OP, NOW);
      const cancelled = (await getMeeting(t, meetingId, NOW))!;
      expect(cancelled).toMatchObject({ status: "cancelled", cancelReason: "not needed" });
      expect((await listNotifications(t, { recipient: "agent:Publisher" }, at("2026-09-17T13:55:00Z"))).map((n) => n.kind)).not.toContain("meeting_reminder");
      expect(await code(cancelMeeting(t, { meetingId }, OP, NOW))).toBe("meeting_not_changeable");
      const types = (await t.select({ type: schema.events.eventType, actor: schema.events.actor }).from(schema.events).where(eq(schema.events.eventType, "meeting_scheduled"))).concat(
        await t.select({ type: schema.events.eventType, actor: schema.events.actor }).from(schema.events).where(eq(schema.events.eventType, "meeting_rescheduled")),
        await t.select({ type: schema.events.eventType, actor: schema.events.actor }).from(schema.events).where(eq(schema.events.eventType, "meeting_cancelled"))
      );
      expect(types).toEqual([
        { type: "meeting_scheduled", actor: "agent:Manager" },
        { type: "meeting_rescheduled", actor: "human:operator" },
        { type: "meeting_cancelled", actor: "human:operator" },
      ]);
    });
  });

  it("status is derived from time; outcomes only once started, stamped with who recorded them", async () => {
    await tx(async (t) => {
      const board = await room(t, "Boardroom");
      const { meetingId } = await scheduleMeeting(t, { title: "Review", participants: ["Researcher"], startsAt: at("2026-09-17T10:00:00Z"), endsAt: at("2026-09-17T10:30:00Z"), roomId: board.id }, OP, NOW);
      expect((await getMeeting(t, meetingId, at("2026-09-17T10:10:00Z")))!.status).toBe("in_progress");
      expect((await getMeeting(t, meetingId, at("2026-09-17T10:30:00Z")))!.status).toBe("completed");
      expect(await code(recordMeetingOutcome(t, meetingId, { decisions: ["Ship it"] }, "human:operator", NOW))).toBe("meeting_not_changeable");
      await recordMeetingOutcome(t, meetingId, { notes: ["Discussed scope"], decisions: ["Ship it"] }, "human:operator", at("2026-09-17T10:40:00Z"));
      expect((await getMeeting(t, meetingId, at("2026-09-17T10:40:00Z")))!.decisions).toEqual([{ text: "Ship it", actor: "human:operator", at: "2026-09-17T10:40:00.000Z" }]);
      expect(await code(rescheduleMeeting(t, { meetingId, startsAt: at("2026-09-17T12:00:00Z"), endsAt: at("2026-09-17T12:30:00Z"), roomId: board.id }, OP, at("2026-09-17T10:10:00Z")))).toBe("meeting_not_changeable");
      expect(await code(recordMeetingOutcome(t, meetingId, { decisions: ["x"], grant: "Manager" }, "human:operator", at("2026-09-17T10:40:00Z")))).toBe("invalid_meeting");
    });
  });

  it("status passes through starting (the gather window) before it begins, and can still be moved then", async () => {
    await tx(async (t) => {
      await updateSettings(t, { gatherMinutes: 10 }, "human:operator");
      const board = await room(t, "Boardroom");
      const small = await room(t, "Small meeting room");
      const { meetingId } = await scheduleMeeting(t, { title: "Sync", participants: ["Researcher"], startsAt: at("2026-09-17T10:00:00Z"), endsAt: at("2026-09-17T10:30:00Z"), roomId: board.id }, OP, NOW);
      const statusAt = async (iso: string) => (await getMeeting(t, meetingId, at(iso)))!.status;
      expect(await statusAt("2026-09-17T09:49:00Z")).toBe("scheduled");
      expect(await statusAt("2026-09-17T09:55:00Z")).toBe("starting");
      expect(await statusAt("2026-09-17T10:00:00Z")).toBe("in_progress");
      expect(await statusAt("2026-09-17T10:30:00Z")).toBe("completed");
      // A meeting that has not begun can still be moved, gather window or not.
      expect(await code(rescheduleMeeting(t, { meetingId, startsAt: at("2026-09-17T11:00:00Z"), endsAt: at("2026-09-17T11:30:00Z"), roomId: small.id }, OP, at("2026-09-17T09:55:00Z")))).toBe("ok");
      expect(await code(recordMeetingOutcome(t, meetingId, { notes: ["early"] }, "human:operator", at("2026-09-17T10:55:00Z")))).toBe("meeting_not_changeable");
    });
  });

  it("availability reports available, busy and unavailable with reasons", async () => {
    await tx(async (t) => {
      const board = await room(t, "Boardroom");
      await scheduleMeeting(t, { title: "Standup", participants: ["Researcher"], startsAt: at("2026-09-17T10:00:00Z"), endsAt: at("2026-09-17T10:15:00Z"), roomId: board.id }, OP, NOW);
      await createCalendarEntry(t, { agentName: "Reviewer", kind: "unavailable", title: "Off", startsAt: "2026-09-17T00:00:00Z", endsAt: "2026-09-18T00:00:00Z" }, "human:operator");
      const a = await availabilityFor(t, ["Researcher", "Publisher", "Reviewer"], { start: at("2026-09-17T10:00:00Z"), end: at("2026-09-17T11:00:00Z") });
      expect(a.map((x) => [x.agentName, x.status, x.reasons])).toEqual([
        ["Researcher", "busy", ["in meeting: Standup"]],
        ["Publisher", "available", []],
        ["Reviewer", "unavailable", ["unavailable: Off"]],
      ]);
    });
  });
});

describe("rooms are placed on the world the Keep actually has", () => {
  it("a template switch re-places the seeded rooms, keeps their meetings, and leaves an operator's room alone", async () => {
    await tx(async (t) => {
      // The default world has a Council hall; the scholars' world has a Council common room instead.
      expect((await room(t, "Boardroom")).locationAreaName).toBe("Council hall");
      const board = await room(t, "Boardroom");
      const { meetingId } = await scheduleMeeting(t, { title: "Before the move", participants: ["Researcher"], startsAt: at("2026-09-17T10:00:00Z"), endsAt: at("2026-09-17T10:30:00Z"), roomId: board.id }, OP, NOW);
      await createRoom(t, { name: "Operator's corner", purpose: "small_meeting", capacity: 3, locationAreaName: "Council hall", active: true }, "human:operator");

      await applyTemplate(t, "scholars");
      const areas = await activeAreaNames(t);
      expect(areas).not.toContain("Council hall");
      expect(await ensureDefaultRooms(t, "human:operator", areas)).toBe(true);

      // Seeded rooms follow the world; the meeting they already hold is untouched.
      expect((await room(t, "Boardroom")).locationAreaName).toBe("Council common room");
      expect(roomsOffTheMap(await listRooms(t), areas).map((r) => r.name)).toEqual(["Operator's corner"]);
      expect((await getMeeting(t, meetingId, NOW))!.room.name).toBe("Boardroom");
      // A room the operator placed is never moved by the seed.
      expect((await room(t, "Operator's corner")).locationAreaName).toBe("Council hall");
      // Nothing is invented: a room with nowhere to go says so instead.
      expect((await room(t, "Conference room")).locationAreaName).toBeNull();
    });
  });
});

describe("presence: only event-backed meetings put anyone anywhere", () => {
  it("gathering shortly before, in_meeting during, nobody after or when cancelled", async () => {
    await tx(async (t) => {
      const board = await room(t, "Boardroom");
      const { meetingId } = await scheduleMeeting(t, { title: "All hands", participants: ["Researcher", "Publisher"], startsAt: at("2026-09-17T10:00:00Z"), endsAt: at("2026-09-17T10:30:00Z"), roomId: board.id }, OP, NOW);
      expect(await meetingPresence(t, at("2026-09-17T09:50:00Z"))).toEqual([]);
      expect((await meetingPresence(t, at("2026-09-17T09:59:00Z"))).map((p) => [p.agentName, p.phase, p.locationAreaName])).toEqual([
        ["Publisher", "gathering", "Council hall"],
        ["Researcher", "gathering", "Council hall"],
      ]);
      expect((await meetingPresence(t, at("2026-09-17T10:10:00Z"))).map((p) => p.phase)).toEqual(["in_meeting", "in_meeting"]);
      expect(await meetingPresence(t, at("2026-09-17T10:30:00Z"))).toEqual([]);
      await cancelMeeting(t, { meetingId }, OP, NOW);
      expect(await meetingPresence(t, at("2026-09-17T10:10:00Z"))).toEqual([]);
    });
  });

  it("back-to-back meetings: an agent is in the one it is in, not gathering for the next", async () => {
    await tx(async (t) => {
      await updateSettings(t, { gatherMinutes: 30 }, "human:operator");
      const board = await room(t, "Boardroom");
      const small = await room(t, "Small meeting room");
      await scheduleMeeting(t, { title: "First", participants: ["Researcher"], startsAt: at("2026-09-17T10:00:00Z"), endsAt: at("2026-09-17T10:30:00Z"), roomId: board.id }, OP, NOW);
      await scheduleMeeting(t, { title: "Second", participants: ["Researcher", "Publisher"], startsAt: at("2026-09-17T10:30:00Z"), endsAt: at("2026-09-17T11:00:00Z"), roomId: small.id }, OP, NOW);
      expect((await meetingPresence(t, at("2026-09-17T10:15:00Z"))).map((p) => [p.agentName, p.title, p.phase])).toEqual([
        ["Publisher", "Second", "gathering"],
        ["Researcher", "First", "in_meeting"],
      ]);
    });
  });

  it("a meeting row written or altered without its event draws nobody", async () => {
    await tx(async (t) => {
      const board = await room(t, "Boardroom");
      const [forged] = await t.insert(schema.workplaceMeetings).values({ title: "Forged", organiser: "agent:Manager", roomId: board.id, startsAt: at("2026-09-17T10:00:00Z"), endsAt: at("2026-09-17T10:30:00Z") }).returning();
      await t.insert(schema.workplaceMeetingParticipants).values({ meetingId: forged!.id, agentName: "Researcher" });
      expect(await meetingPresence(t, at("2026-09-17T10:10:00Z"))).toEqual([]);
      const { meetingId } = await scheduleMeeting(t, { title: "Real", participants: ["Publisher"], startsAt: at("2026-09-17T11:00:00Z"), endsAt: at("2026-09-17T11:30:00Z"), roomId: board.id }, OP, NOW);
      await t.update(schema.workplaceMeetings).set({ startsAt: at("2026-09-17T10:05:00Z") }).where(eq(schema.workplaceMeetings.id, meetingId));
      expect(await meetingPresence(t, at("2026-09-17T10:10:00Z"))).toEqual([]);
      await t.insert(schema.workplaceMeetingParticipants).values({ meetingId, agentName: "Reviewer" });
      await t.update(schema.workplaceMeetings).set({ startsAt: at("2026-09-17T11:00:00Z") }).where(eq(schema.workplaceMeetings.id, meetingId));
      expect(await meetingPresence(t, at("2026-09-17T11:10:00Z"))).toEqual([]);
    });
  });
});
