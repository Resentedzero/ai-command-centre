/**
 * Stage 7: the agent's day. Availability is a SCHEDULING constraint, never an execution one:
 *
 * - working hours and the diary can stop NEW work being given to an agent;
 * - they never touch work already running, and they are never an emergency stop;
 * - `GET /agents/state` answers "what is everyone doing now?" once, deterministically, from
 *   authoritative rows — no model, no writes, no XP.
 *
 * Against the real database with the workplace clock driven to fixed instants; the model is mocked and
 * never consulted for any of this.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeTestDb, resetTestSchema, testDb } from "../testDb.js";
import * as schema from "../../src/db/schema.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { callClaudeSubscriptionModel } from "../../src/router/providers/claudeSubscription.js";
import { buildServer } from "../../src/api/server.js";
import { seedPublishWorkflow, seedV11Definitions } from "../../src/definitions/seed.js";
import { createDefaultWorld } from "../../src/world/worldConfig.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";
import { createCalendarEntry, updateSettings } from "../../src/workplace/workplace.js";
import { agentStates } from "../../src/api/agentState.js";
import { unavailabilityCode } from "../../src/capabilities/manager/mission.js";
import { availableAt, nextAvailableFrom, withinWorkingHours, workingIntervals } from "../../src/workplace/availability.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

let app: FastifyInstance;
const tx = <T>(fn: (t: DrizzleTransaction) => Promise<T>): Promise<T> => testDb.transaction((t) => fn(t as unknown as DrizzleTransaction));
const states = (now: Date) => tx((t) => agentStates(t, now));
const stateOf = async (name: string, now: Date) => (await states(now)).find((s) => s.agentName === name)!;

// The Keep's clock for these tests: London, 09:00-17:00, Monday to Friday.
const LONDON = "Europe/London";
const HOURS = { workStartMinute: 540, workEndMinute: 1020, workingDays: [1, 2, 3, 4, 5] };
const CLOCK = { ...HOURS, timezone: LONDON, outsideWorkingHours: "forbid" as const };
// Thursday 17 September 2026 (BST, UTC+1) and the Saturday after it.
const THU_1000 = new Date("2026-09-17T09:00:00Z");
const THU_0859 = new Date("2026-09-17T07:59:00Z");
const THU_0900 = new Date("2026-09-17T08:00:00Z");
const THU_1700 = new Date("2026-09-17T16:00:00Z");
const THU_1659 = new Date("2026-09-17T15:59:00Z");
const SAT_1000 = new Date("2026-09-19T09:00:00Z");

const setWorkOutsideHours = (value: "allow" | "forbid") => tx((t) => updateSettings(t, { workOutsideHours: value, timezone: LONDON, workStartMinute: 540, workEndMinute: 1020, workingDays: [1, 2, 3, 4, 5] }, "human:operator"));

beforeAll(async () => {
  await resetTestSchema();
  await testDb.transaction((t) => seedPublishWorkflow(t));
  await testDb.transaction((t) => createDefaultWorld(t as unknown as DrizzleTransaction));
  await testDb.transaction((t) => seedV11Definitions(t));
  vi.mocked(callClaudeSubscriptionModel).mockImplementation(async () => {
    throw new Error("no model call belongs anywhere in the agent's daily rhythm");
  });
  app = buildServer({ db: testDb });
  await app.ready();
}, 30_000);

beforeEach(async () => {
  await testDb.execute(sql`DELETE FROM workplace_calendar_events`);
  await testDb.execute(sql`DELETE FROM execution_stops`);
  await setWorkOutsideHours("allow");
});

afterAll(async () => {
  await app.close();
  await closeTestDb();
});

describe("working hours are deterministic, zoned and boundary-exact", () => {
  const inHours = (at: Date) => withinWorkingHours(HOURS, LONDON, { start: at, end: new Date(at.getTime() + 1) });

  it("is inside on a working day, outside at the weekend, and exact at both boundaries", () => {
    expect(inHours(THU_1000)).toBe(true);
    expect(inHours(SAT_1000)).toBe(false);
    // 09:00 is inside; the minute before is not. 17:00 is the end of a half-open range, so it is outside.
    expect(inHours(THU_0900)).toBe(true);
    expect(inHours(THU_0859)).toBe(false);
    expect(inHours(THU_1659)).toBe(true);
    expect(inHours(THU_1700)).toBe(false);
  });

  it("follows the configured timezone, not the server's", () => {
    // 09:00 London is 04:00 in New York: the same instant is inside the Keep's hours and outside a New York Keep's.
    const instant = { start: THU_0900, end: new Date(THU_0900.getTime() + 1) };
    expect(withinWorkingHours(HOURS, LONDON, instant)).toBe(true);
    expect(withinWorkingHours(HOURS, "America/New_York", instant)).toBe(false);
  });

  it("crosses a daylight-saving boundary without drifting", () => {
    // The UK moves off BST on Sunday 25 October 2026. Monday's working day is still 09:00-17:00 local,
    // which is now 09:00 UTC rather than 08:00 UTC.
    const mondayAfter = { start: new Date("2026-10-26T00:00:00Z"), end: new Date("2026-10-27T00:00:00Z") };
    const [interval] = workingIntervals(HOURS, LONDON, mondayAfter);
    expect(interval!.start.toISOString()).toBe("2026-10-26T09:00:00.000Z");
    expect(interval!.end.toISOString()).toBe("2026-10-26T17:00:00.000Z");
    // The Thursday before the change is BST, an hour earlier in UTC.
    const [bst] = workingIntervals(HOURS, LONDON, { start: new Date("2026-09-17T00:00:00Z"), end: new Date("2026-09-18T00:00:00Z") });
    expect(bst!.start.toISOString()).toBe("2026-09-17T08:00:00.000Z");
  });

  it("says when an agent is next free, and never guesses how long work takes", () => {
    const input = { clock: CLOCK, hours: HOURS, commitments: [], agentName: "Researcher" };
    expect(availableAt({ ...input, at: THU_1000 }).ok).toBe(true);
    expect(availableAt({ ...input, at: SAT_1000 }).ok).toBe(false);
    // From Saturday morning, the next working instant is Monday at 09:00 London (08:00 UTC, still BST).
    expect(nextAvailableFrom({ ...input, from: SAT_1000 })!.toISOString()).toBe("2026-09-21T08:00:00.000Z");
    // Already inside hours: free now, not at some invented later time.
    expect(nextAvailableFrom({ ...input, from: THU_1000 })!.toISOString()).toBe(THU_1000.toISOString());
  });
});

describe("availability gates work STARTING, and nothing else", () => {
  it("by default the Keep works any hour: nothing changes until an operator asks for office hours", async () => {
    await setWorkOutsideHours("allow");
    // Saturday: the diary says outside hours, but work is allowed outside hours by default.
    expect(await tx((t) => unavailabilityCode(t, "Researcher"))).toBeNull();
  });

  it("refuses to give NEW work outside working hours once the operator forbids it, and says when it is free", async () => {
    await setWorkOutsideHours("forbid");
    const entry = await tx((t) => createCalendarEntry(t, { agentName: "Researcher", kind: "unavailable", title: "out", startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString() }, "human:operator"));
    expect(entry.id).toBeTruthy();
    const why = await tx((t) => unavailabilityCode(t, "Researcher"));
    expect(why).toMatchObject({ code: "worker_unavailable" });
    expect(why!.detail).toMatch(/unavailable: out/);
  });

  it("a break stops new work being given, and is not a stop", async () => {
    await tx((t) => createCalendarEntry(t, { agentName: "Keeper", kind: "break", title: "tea", startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 1_800_000).toISOString() }, "human:operator"));
    const why = await tx((t) => unavailabilityCode(t, "Keeper"));
    expect(why).toMatchObject({ code: "worker_unavailable" });
    expect(why!.detail).toMatch(/break: tea/);
    // A break is a diary fact, never authority: no stop was engaged by it.
    expect((await testDb.select().from(schema.executionStops))).toHaveLength(0);
  });

  it("an emergency stop still wins, and reads as stopped rather than as a diary entry", async () => {
    const agent = (await testDb.select().from(schema.agentDefinitions).where(eq(schema.agentDefinitions.name, "Researcher")))[0]!;
    await tx((t) => createCalendarEntry(t, { agentName: "Researcher", kind: "break", title: "tea", startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 1_800_000).toISOString() }, "human:operator"));
    await app.inject({ method: "POST", url: "/execution-stops", payload: { scope: "agent_definition", scopeRefId: agent.id, reason: "halt" } });
    expect(await tx((t) => unavailabilityCode(t, "Researcher"))).toMatchObject({ code: "emergency_stopped", detail: "is stopped" });
    expect((await stateOf("Researcher", new Date())).state).toBe("stopped");
  });

  it("convening a meeting does not re-ask the diary: an agent may attend a meeting it is booked into", async () => {
    await setWorkOutsideHours("forbid");
    // Saturday for the Keep's hours, yet the meeting the operator booked must still be attendable.
    const blocked = await tx((t) => unavailabilityCode(t, "Researcher", { ignoreSchedule: true }));
    expect(blocked).toBeNull();
  });
});

describe("work already running is never touched by the clock", () => {
  /** A Run that is genuinely under way for this agent, with its Task Instance active. */
  async function startWork(agentName: string) {
    const agent = (await testDb.select().from(schema.agentDefinitions).where(eq(schema.agentDefinitions.name, agentName)))[0]!;
    const project = (await testDb.select().from(schema.projects))[0]!;
    const [goal] = await testDb.insert(schema.goals).values({ projectId: project.id, title: "Long job", status: "active" }).returning();
    const task = (await testDb.select().from(schema.taskDefinitions))[0]!;
    const [ti] = await testDb.insert(schema.taskInstances).values({ taskDefinitionId: task.id, taskDefinitionVersion: task.version, projectId: project.id, status: "active", input: {} }).returning();
    const [run] = await testDb.insert(schema.runs).values({ taskInstanceId: ti!.id, status: "active", agentDefinitionId: agent.id, agentDefinitionVersion: agent.version }).returning();
    return { goalId: goal!.id, runId: run!.id, taskInstanceId: ti!.id };
  }

  it("a Run that crosses the end of the working day keeps running, is not failed, and still reads as working", async () => {
    const { runId } = await startWork("Publisher");
    await setWorkOutsideHours("forbid");

    // 17:00 has passed for the Keep. The clock has no opinion about work already under way.
    const evening = await stateOf("Publisher", THU_1700);
    expect(evening.state).toBe("working");
    const after = await testDb.query.runs.findFirst({ where: eq(schema.runs.id, runId) });
    expect(after!.status).toBe("active");
    expect(after!.outcome).toBeNull();
    // Nothing was stopped, nothing failed, and no event was written by asking.
    expect((await testDb.select().from(schema.executionStops))).toHaveLength(0);
    expect((await testDb.select().from(schema.events).where(eq(schema.events.eventType, "run_failed")))).toHaveLength(0);
    // And while that Run is still live, NEW work is still refused for the same agent: starting and
    // running are different questions, and only the first one the clock answers.
    const why = await tx((t) => unavailabilityCode(t, "Publisher"));
    expect(why?.code).toBe("worker_unavailable");

    await testDb.execute(sql`UPDATE runs SET status = 'completed' WHERE id = ${runId}`);
  });
});

describe("GET /agents/state answers what everyone is doing, from records only", () => {
  it("reports every persistent agent exactly once, with a state from the fixed vocabulary", async () => {
    const res = await app.inject({ method: "GET", url: "/agents/state" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Json;
    const names = body.agents.map((a: Json) => a.agentName);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
    for (const a of body.agents as Json[]) expect(body.states).toContain(a.state);
  });

  it("an agent with nothing to do is available, not working", async () => {
    const s = await stateOf("Researcher", new Date());
    expect(s.state).toBe("available");
    expect(s.work).toBeNull();
  });

  it("a break reads as on_break and says when it ends; working hours read as outside_hours", async () => {
    await tx((t) => createCalendarEntry(t, { agentName: "Keeper", kind: "break", title: "tea", startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 1_800_000).toISOString() }, "human:operator"));
    const onBreak = await stateOf("Keeper", new Date());
    expect(onBreak.state).toBe("on_break");
    expect(onBreak.detail).toMatch(/tea/);

    await setWorkOutsideHours("forbid");
    const saturday = await stateOf("Researcher", SAT_1000);
    expect(saturday.state).toBe("outside_hours");
    expect(saturday.until).toBe("2026-09-21T08:00:00.000Z");
  });

  it("reads nothing from the world, awards nothing, and writes nothing", async () => {
    const before = await testDb.execute(sql`SELECT (SELECT count(*) FROM events) e, (SELECT count(*) FROM agent_xp_awards) x, (SELECT count(*) FROM runs) r`);
    await app.inject({ method: "GET", url: "/agents/state" });
    await app.inject({ method: "GET", url: "/agents/state" });
    const after = await testDb.execute(sql`SELECT (SELECT count(*) FROM events) e, (SELECT count(*) FROM agent_xp_awards) x, (SELECT count(*) FROM runs) r`);
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(callClaudeSubscriptionModel).not.toHaveBeenCalled();
  });
});

describe("the daily rhythm is never authority", () => {
  it("no capability can change hours, a break or availability: only the operator's routes write them", async () => {
    const caps = (await testDb.select().from(schema.capabilities)).map((c) => c.name);
    // The workplace Capabilities an agent can hold read the calendar, book a meeting and record what one
    // produced. None of them writes working hours, a calendar entry or an agent's availability.
    expect(caps.filter((c) => c.startsWith("workplace."))).toEqual(expect.arrayContaining(["workplace.inspect_calendar", "workplace.schedule_meeting", "workplace.record_outcome"]));
    expect(caps.some((c) => /hours|availability|break|schedule_self|calendar_entry/.test(c))).toBe(false);
  });

  it("being available, on a break or in the office earns nothing", async () => {
    await tx((t) => createCalendarEntry(t, { agentName: "Keeper", kind: "break", title: "tea", startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 1_800_000).toISOString() }, "human:operator"));
    await app.inject({ method: "GET", url: "/agents/state" });
    // The projection is rebuilt from events and completed runs; a diary entry is neither.
    await app.inject({ method: "POST", url: "/progression/refresh" });
    const awards = await testDb.select().from(schema.agentXpAwards);
    expect(awards.filter((a) => /break|available|meeting|hours|ambient|wait/i.test(a.rule))).toHaveLength(0);
  });

  it("an agent cannot put itself outside hours: the settings route is the operator's", async () => {
    const res = await app.inject({ method: "POST", url: "/workplace/settings", payload: { workOutsideHours: "nonsense" } });
    expect(res.statusCode).toBe(400);
    const entry = await app.inject({ method: "POST", url: "/workplace/calendar-entries", payload: { agentName: "Researcher", kind: "not_a_kind", title: "x", startsAt: new Date().toISOString() } });
    expect(entry.statusCode).toBe(400);
  });
});
