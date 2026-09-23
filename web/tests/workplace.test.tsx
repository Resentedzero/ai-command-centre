/**
 * Workplace in the web: a meeting desire exists only for a real meeting the API reported; run work
 * outranks it; agents walk to the named room and stand there as "meeting", never "working"; a room that is
 * not on the map shows no one inside it; the agent panel and Calendar page read their facts from the API
 * in the Keep's timezone; the Calendar decides nothing itself.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { spawn, step, type LivingWorld, type WorldArea } from "../lib/living";
import { desireFor } from "../lib/activity";
import { statusLine } from "../components/world/AgentPanel";
import { fromWall, hhmm, wall } from "../lib/keepTime";
import type { AgentCardData, CalendarData, Meeting, MeetingPresence } from "../lib/api";

const api = vi.hoisted(() => ({
  getCalendar: vi.fn(),
  getRegistry: vi.fn(),
  listNotifications: vi.fn(),
  recordMeetingOutcome: vi.fn(),
  rescheduleMeeting: vi.fn(),
  scheduleMeeting: vi.fn(),
  sendWorkplaceMessage: vi.fn(),
  startWorkFromDecision: vi.fn(),
  cancelMeeting: vi.fn(),
  subscribeToActivity: vi.fn(),
}));
vi.mock("../lib/api", () => api);

import CalendarPage from "../app/calendar/page";

const area = (id: string, purpose: string, x: number, y: number, w: number, h: number): WorldArea => ({ id, name: id, purpose, x, y, w, h, active: true });
const world: LivingWorld = {
  areas: [area("plaza", "common", 0, 0, 400, 200), area("hall", "corridor", 0, 196, 400, 40), area("Council hall", "waiting", 0, 232, 400, 200)],
  workstations: [{ id: "desk", areaId: "plaza", name: "Desk", activity: "generic", x: 50, y: 50, active: true }],
};
const presence = (over: Partial<MeetingPresence> = {}): MeetingPresence => ({ agentName: "Researcher", meetingId: "m1", title: "All-hands", roomName: "Boardroom", locationAreaName: "Council hall", phase: "in_meeting", startsAt: "2026-09-17T13:00:00Z", endsAt: "2026-09-17T13:30:00Z", ...over });
const row = (over: Partial<AgentCardData> = {}): AgentCardData => ({ agentDefinitionId: "a1", agentName: "Researcher", runId: "r1", taskInstanceId: "t1", taskStatus: "active", taskDefinitionName: "x", goalTitle: null, latestActivitySummary: null, activity: null, ...over });

describe("the world: meetings are real or absent", () => {
  it("no presence, no meeting; the priority is stopped > awaiting approval > meeting > work > queued > ambient", () => {
    expect(desireFor([], [], ["a1"], null)).toEqual({ kind: "idle" });
    expect(desireFor([], [], ["a1"], presence())).toMatchObject({ kind: "meeting", areaName: "Council hall", phase: "in_meeting" });
    // A real meeting outranks a run in progress: the agent is at the meeting, and its run keeps running.
    expect(desireFor([row()], [], ["a1"], presence()).kind).toBe("meeting");
    expect(desireFor([row()], [], ["a1"], null).kind).toBe("work");
    expect(desireFor([row({ taskStatus: "awaiting_approval" })], [], ["a1"], presence()).kind).toBe("wait");
    expect(desireFor([], [{ id: "s", scope: "global", scopeRefId: "*", reason: null, engagedAt: "", engagedBy: "" }] as never, ["a1"], presence()).kind).toBe("stopped");
    expect(desireFor([row({ taskStatus: "pending" })], [], ["a1"], presence()).kind).toBe("meeting");
  });

  it("walks to the meeting room, stands there as in a meeting (never working), and leaves when the meeting is gone", () => {
    let sim = spawn("Researcher", world, 0);
    const meeting = desireFor([], [], ["a1"], presence());
    for (let t = 0; t < 60_000; t += 250) sim = step(sim, meeting, world, undefined, t);
    expect(sim.presence).toBe("meeting");
    expect(sim.at.y).toBeGreaterThanOrEqual(232);
    // The meeting ends (presence no longer reported): the agent is idle again and walks away over time.
    let after = sim;
    for (let t = 60_000; t < 200_000; t += 250) after = step(after, { kind: "idle" }, world, undefined, t);
    expect(after.presence).not.toBe("meeting");
    expect(after.intent.startsWith("meeting:")).toBe(false);
  });

  it("a room that is not on the map draws nobody inside it", () => {
    let sim = spawn("Researcher", world, 0);
    const meeting = desireFor([], [], ["a1"], presence({ locationAreaName: null }));
    for (let t = 0; t < 5_000; t += 250) sim = step(sim, meeting, world, undefined, t);
    expect(sim.presence).toBe("standing");
    expect(sim.intent).toBe("nowhere:meeting");
  });

  it("the panel status names the real meeting, and is never worded as work", () => {
    expect(statusLine(desireFor([], [], ["a1"], presence()), null, null)).toEqual({ text: "In a meeting · All-hands", tone: "neutral" });
    expect(statusLine(desireFor([], [], ["a1"], presence({ phase: "gathering" })), null, null).text).toBe("Gathering for a meeting · All-hands");
  });
});

describe("Keep time", () => {
  it("formats in the configured zone, not the browser's, across daylight saving", () => {
    expect(hhmm("2026-07-01T08:00:00Z", "Europe/London")).toBe("09:00");
    expect(hhmm("2026-12-01T08:00:00Z", "Europe/London")).toBe("08:00");
    expect(hhmm("2026-09-17T13:00:00Z", "America/New_York")).toBe("09:00");
    expect(fromWall({ year: 2026, month: 10, day: 25, hour: 1, minute: 30 }, "Europe/London").toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(wall("2026-09-17T23:30:00Z", "Europe/London")).toMatchObject({ day: 18, hour: 0, weekday: 5 });
  });
});

describe("the Calendar page", () => {
  const meeting: Meeting = {
    id: "m1",
    title: "All-hands",
    agenda: "Catch up",
    organiser: "agent:Manager",
    room: { id: "room1", name: "Boardroom", purpose: "boardroom", capacity: 12, locationAreaName: "Council hall" },
    startsAt: "2026-09-17T13:00:00Z",
    endsAt: "2026-09-17T13:30:00Z",
    status: "scheduled",
    cancelledAt: null,
    cancelReason: null,
    participants: [
      { agentName: "Manager", role: "organiser" },
      { agentName: "Researcher", role: "participant" },
    ],
    notes: [],
    decisions: [],
    actions: [],
    goalId: "g1",
    runId: "r1",
    revision: 1,
    createdAt: "",
    updatedAt: "",
  };
  const calendar: CalendarData = {
    now: "2026-09-17T09:00:00Z",
    settings: { timezone: "America/New_York", workStartMinute: 540, workEndMinute: 1020, workingDays: [1, 2, 3, 4, 5], outsideWorkingHours: "forbid", workOutsideHours: "allow", defaultMeetingMinutes: 30, reminderMinutes: 10, gatherMinutes: 2, notifyInvitations: true, notifyReminders: true, notifyAnnouncements: true },
    rooms: [{ id: "room1", name: "Boardroom", purpose: "boardroom", capacity: 12, locationAreaName: "Council hall", active: true }],
    meetings: [meeting],
    entries: [{ id: "e1", agentName: "Researcher", kind: "break", title: "Lunch", startsAt: "2026-09-17T16:00:00Z", endsAt: "2026-09-17T17:00:00Z", createdBy: "human:operator" }],
  };

  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    api.getCalendar.mockResolvedValue(calendar);
    api.getRegistry.mockResolvedValue({ agentDefinitions: [{ name: "Manager" }, { name: "Researcher" }] });
    api.subscribeToActivity.mockReturnValue(() => {});
  });

  it("lays the week out in the Keep's timezone and shows the meeting's who, where and why from the records", async () => {
    await act(async () => {
      render(<CalendarPage />);
    });
    await act(async () => {});
    expect(screen.getByTestId("calendar-clock").textContent).toContain("America/New_York");
    const cell = screen.getByTestId("calendar-meeting");
    // 13:00Z is 09:00 in New York, whatever this machine's own zone is.
    expect(cell.textContent).toContain("09:00–09:30");
    expect(screen.getAllByTestId("calendar-day")).toHaveLength(7);
    expect(screen.getByTestId("calendar-entry").textContent).toContain("break: Lunch");
    fireEvent.click(cell);
    const detail = screen.getByTestId("meeting-detail");
    expect(within(detail).getByTestId("meeting-participants").textContent).toBe("Manager, Researcher");
    expect(detail.textContent).toContain("Boardroom · seats 12 · Council hall");
    expect(detail.textContent).toContain("None recorded");
    expect(within(detail).getByRole("link", { name: "the Manager's mission" }).getAttribute("href")).toBe("/command?goal=g1");
  });

  it("scheduling sends only who, how long and roughly when, and shows the backend's refusal", async () => {
    api.scheduleMeeting.mockRejectedValue(new Error("API request failed: POST /workplace/meetings -> 409 Conflict: no 30-minute slot when all 2 participants are available"));
    await act(async () => {
      render(<CalendarPage />);
    });
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "New meeting" }));
    const form = screen.getByTestId("new-meeting");
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Sync" } });
    fireEvent.click(within(form).getByLabelText("Everyone"));
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "Schedule" }));
    });
    expect(api.scheduleMeeting).toHaveBeenCalledWith({ title: "Sync", agenda: "", participants: ["Manager", "Researcher"], durationMinutes: 30, timing: { window: "asap" } });
    expect(within(form).getByRole("alert").textContent).toBe("Not scheduled: no 30-minute slot when all 2 participants are available");
  });
});
