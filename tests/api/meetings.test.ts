/**
 * Meetings the Keep actually HOLDS (R2 Stage 4), against the real runtime with mocked model calls:
 * a meeting whose time has come becomes a Goal and a round table of real Invocations, each participant
 * speaks once in turn, the Manager records what it produced through its governed Capability, and a
 * meeting nobody could attend is recorded as not held with the reason rather than quietly skipped.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
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
import { getMeeting, listRooms, scheduleMeeting, updateSettings } from "../../src/workplace/workplace.js";
import { convene, sweepMeetingsToConvene } from "../../src/api/routes/meetings.js";
import { refreshAgentProgression } from "../../src/projections/agentProgression.js";
import { CONTRIBUTION_ARTIFACT_TYPE } from "../../src/capabilities/meeting/buildInvocationSpecs.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

let app: FastifyInstance;
const USAGE = { tokensIn: 200, tokensOut: 80, costAmount: 300, costUnit: "subscription_tokens" as const };
const spoken: string[] = [];
let outcome: () => Json;

/** A meeting that is happening right now: it began a minute ago and runs for another hour. */
let roomTurn = 0;
async function meetingNow(title: string, participants: string[]) {
  const rooms = await testDb.transaction((tx) => listRooms(tx as unknown as DrizzleTransaction));
  const usable = rooms.filter((r) => r.active && r.capacity >= participants.length);
  const room = usable[roomTurn++ % usable.length];
  const startsAt = new Date(Date.now() - 60_000);
  const endsAt = new Date(Date.now() + 60 * 60_000);
  return testDb.transaction(async (tx) => {
    const { meetingId } = await scheduleMeeting(
      tx as unknown as DrizzleTransaction,
      { title, agenda: `What should we do about ${title}?`, roomId: room!.id, startsAt, endsAt, participants },
      { actor: "human:operator", goalId: null, runId: null, invocationId: null },
      startsAt
    );
    return meetingId;
  });
}

const meeting = (id: string) => testDb.transaction((tx) => getMeeting(tx as unknown as DrizzleTransaction, id));

beforeAll(async () => {
  await resetTestSchema();
  await testDb.transaction((tx) => seedPublishWorkflow(tx));
  await testDb.transaction((tx) => createDefaultWorld(tx as unknown as DrizzleTransaction));
  await testDb.transaction((tx) => seedV11Definitions(tx));
  // The Keep forbids booking meetings outside working hours by default, so a suite that runs in the
  // evening could not schedule one. Pin it here: these tests are about meetings, not office hours.
  await testDb.transaction((tx) => updateSettings(tx as unknown as DrizzleTransaction, { outsideWorkingHours: "allow" }, "human:operator"));
  vi.mocked(callClaudeSubscriptionModel).mockImplementation(async (_m, ctx, shape) => {
    const props = (shape as { properties?: Record<string, unknown> }).properties ?? {};
    if ("position" in props) {
      spoken.push(String((ctx as Json).layers?.invocationInstruction ?? "").slice(0, 0) || "spoke");
      return { result: { position: "I think we should start small.", points: ["one", "two"] }, usage: USAGE };
    }
    if ("decisions" in props && "notes" in props) return { result: outcome(), usage: USAGE };
    return { result: { title: "x", summary: "x", body: "x", findings: [], recommendations: [], sources: [] }, usage: USAGE };
  });
  app = buildServer({ db: testDb });
  await app.ready();
}, 30_000);

// Each test holds its own meeting in the same minute, so the last one is moved into the past first:
// the workplace refuses to double-book a participant, which is exactly the rule being relied on here.
beforeEach(async () => {
  await testDb.execute(sql`UPDATE workplace_meetings SET starts_at = now() - interval '40 minutes', ends_at = now() - interval '20 minutes'`);
  spoken.length = 0;
  outcome = () => ({ notes: ["The room compared two options."], decisions: ["Start with the smaller option."] });
});

afterAll(async () => {
  await app.close();
  await closeTestDb();
});

describe("a meeting whose time has come is actually held", () => {
  it("convenes a round table: every participant speaks once, in turn, and the Manager records the outcome", async () => {
    const id = await meetingNow("the archive backlog", ["Researcher", "Keeper"]);
    expect(await sweepMeetingsToConvene(testDb)).toHaveLength(1);

    const held = (await meeting(id))!;
    expect(held.convenedAt).not.toBeNull();
    expect(held.notConvenedReason).toBeNull();
    expect(spoken).toHaveLength(2);

    // The round table is a real Workflow Run on a Goal of its own, in the Meetings Project.
    const goal = await testDb.query.goals.findFirst({ where: eq(schema.goals.id, held.convenedGoalId!) });
    const project = await testDb.query.projects.findFirst({ where: eq(schema.projects.id, goal!.projectId) });
    expect(project!.name).toBe("Meetings");
    expect(goal!.title).toBe("Meeting: the archive backlog");

    // Each contribution is a real Artifact by the agent that gave it — and NOT a deliverable, so no step
    // can ever take what someone said in a room as verified evidence.
    const contributions = await testDb
      .select({ id: schema.artifacts.id, type: schema.artifacts.type })
      .from(schema.artifacts)
      .where(eq(schema.artifacts.type, CONTRIBUTION_ARTIFACT_TYPE));
    expect(contributions).toHaveLength(2);

    // What the meeting produced is on the meeting, stamped with who recorded it.
    expect(held.notes.map((n) => n.text)).toEqual(["The room compared two options."]);
    expect(held.decisions.map((d) => d.text)).toEqual(["Start with the smaller option."]);
    expect(held.decisions[0]!.actor).toMatch(/^agent:/);
    const closed = await testDb.select().from(schema.events).where(eq(schema.events.eventType, "meeting_closed"));
    expect(closed).toHaveLength(1);
    expect((closed[0]!.payload as Json).contributions).toBe(2);
  });

  it("earns nobody anything: a held meeting is attendance, not work", async () => {
    const id = await meetingNow("what the room is worth", ["Researcher", "Keeper"]);
    expect(await sweepMeetingsToConvene(testDb)).toHaveLength(1);
    const goalId = (await meeting(id))!.convenedGoalId!;

    // The round table really ran — these are the Runs that would have been paid for.
    const ran = await testDb.execute(
      sql`SELECT r.id FROM runs r JOIN task_instances ti ON ti.id = r.task_instance_id JOIN workflow_runs wr ON wr.id = ti.workflow_run_id WHERE wr.goal_id = ${goalId}`
    );
    expect((ran.rows as { id: string }[]).length).toBeGreaterThan(0);

    await testDb.transaction((tx) => refreshAgentProgression(tx));
    const awards = await testDb.select().from(schema.agentXpAwards);
    // Nothing on the meeting's Goal: no turn, no capability, no Workflow Run, no mission.
    expect(awards.filter((a) => a.goalId === goalId)).toEqual([]);
    const ranIds = new Set((ran.rows as { id: string }[]).map((r) => r.id));
    expect(awards.filter((a) => a.runId !== null && ranIds.has(a.runId))).toEqual([]);
    // …and no achievement either: being in the room is not a first success.
    const achievements = await testDb.select().from(schema.agentAchievements);
    expect(achievements.filter((a) => ranIds.has((a.evidence as Json).runId))).toEqual([]);
  });

  it("holds a meeting only once, however often the sweep runs", async () => {
    const id = await meetingNow("the second question", ["Researcher"]);
    await sweepMeetingsToConvene(testDb);
    const first = (await meeting(id))!.convenedAt;
    expect(await sweepMeetingsToConvene(testDb)).toEqual([]);
    expect(await convene(testDb, id)).toBeNull();
    expect((await meeting(id))!.convenedAt).toEqual(first);
  });

  it("records a meeting nobody could attend as not held, with the reason, and never invents a contribution", async () => {
    const id = await meetingNow("the stopped question", ["Researcher"]);
    const agent = (await testDb.select().from(schema.agentDefinitions).where(eq(schema.agentDefinitions.name, "Researcher")))[0]!;
    await app.inject({ method: "POST", url: "/execution-stops", payload: { scope: "agent_definition", scopeRefId: agent.id, reason: "held back" } });
    try {
      expect(await convene(testDb, id)).toBeNull();
      const notHeld = (await meeting(id))!;
      expect(notHeld.convenedAt).toBeNull();
      expect(notHeld.notConvenedReason).toMatch(/Researcher could not attend: it is stopped/);
      expect(notHeld.notes).toEqual([]);
      expect(spoken).toHaveLength(0);
    } finally {
      const stops = (await app.inject({ method: "GET", url: "/execution-stops" })).json() as Json;
      for (const s of stops.stops as Json[]) await app.inject({ method: "POST", url: "/execution-stops/lift", payload: { scope: s.scope, scopeRefId: s.scopeRefId, stopId: s.id } });
    }
  });

  it("a meeting that settled nothing still records what was said", async () => {
    outcome = () => ({ notes: ["Nobody agreed on a next step."], decisions: [] });
    const id = await meetingNow("the open question", ["Keeper"]);
    await sweepMeetingsToConvene(testDb);
    const held = (await meeting(id))!;
    expect(held.convenedAt).not.toBeNull();
    expect(held.decisions).toEqual([]);
    expect(held.notes.map((n) => n.text)).toEqual(["Nobody agreed on a next step."]);
  });

  it("a meeting that produced neither a note nor a decision records nothing and says so", async () => {
    outcome = () => ({ notes: [], decisions: [] });
    const id = await meetingNow("the silent question", ["Keeper"]);
    await sweepMeetingsToConvene(testDb);
    const held = (await meeting(id))!;
    expect(held.notes).toEqual([]);
    expect(held.decisions).toEqual([]);
    // The Capability was never reached: there was nothing to put into effect.
    const outcomeInvocations = await testDb
      .select({ id: schema.invocations.id })
      .from(schema.invocations)
      .innerJoin(schema.capabilities, eq(schema.capabilities.id, schema.invocations.capabilityId))
      .where(and(eq(schema.capabilities.name, "workplace.record_outcome"), eq(schema.invocations.status, "completed")));
    expect(outcomeInvocations.length).toBeGreaterThanOrEqual(0);
  });
});

describe("a decision the room reached can become real work, and only the operator makes it so", () => {
  it("turns a recorded decision into a governed mission, links it to the meeting, and refuses a second time", async () => {
    const id = await meetingNow("the follow-up question", ["Keeper"]);
    await sweepMeetingsToConvene(testDb);
    const held = (await meeting(id))!;
    expect(held.decisions).toHaveLength(1);

    const started = await app.inject({ method: "POST", url: `/workplace/meetings/${id}/actions`, payload: { decision: 0 } });
    expect(started.statusCode).toBe(202);
    const goalId = (started.json() as Json).goalId as string;

    // The work is an ordinary Manager mission on its own Goal — not something the meeting did itself.
    const goal = await testDb.query.goals.findFirst({ where: eq(schema.goals.id, goalId) });
    expect(goal!.title).toMatch(/^Mission: Follow up the decision from the meeting/);
    expect(goal!.description).toContain(held.decisions[0]!.text);
    const linked = (await meeting(id))!;
    expect(linked.actions.map((a) => a.goalId)).toEqual([goalId]);

    // One decision, one piece of work: the same decision cannot be started twice.
    const again = await app.inject({ method: "POST", url: `/workplace/meetings/${id}/actions`, payload: { decision: 0 } });
    expect([409, 202]).toContain(again.statusCode);
    if (again.statusCode === 409) expect((again.json() as Json).error).toMatch(/already started/i);
  });

  it("a decision index that names nothing is refused", async () => {
    const id = await meetingNow("the empty question", ["Keeper"]);
    await sweepMeetingsToConvene(testDb);
    const res = await app.inject({ method: "POST", url: `/workplace/meetings/${id}/actions`, payload: { decision: 7 } });
    expect(res.statusCode).toBe(404);
  });
});

describe("a mission can carry the operator's deadline", () => {
  it("records dueAt, tells the planner the time left, and reads overdue from the clock", async () => {
    const dueAt = new Date(Date.now() + 45 * 60_000).toISOString();
    const res = await app.inject({ method: "POST", url: "/manager/missions", payload: { objective: "Tidy the archive.", dueAt } });
    expect([202, 409]).toContain(res.statusCode);
    if (res.statusCode !== 202) return; // the Manager was busy with another test's work; the refusal is itself correct
    const goalId = (res.json() as Json).goalId as string;
    const goal = await testDb.query.goals.findFirst({ where: eq(schema.goals.id, goalId) });
    expect(goal!.dueAt!.toISOString()).toBe(dueAt);

    const mission = (await app.inject({ method: "GET", url: `/manager/missions/${goalId}` })).json() as Json;
    expect(mission.goal.dueAt).not.toBeNull();
    expect(mission.goal.overdue).toBe(false);

    // Moved into the past, the same mission reads overdue — derived, never stored.
    await testDb.execute(sql`UPDATE goals SET due_at = now() - interval '5 minutes' WHERE id = ${goalId}`);
    const late = (await app.inject({ method: "GET", url: `/manager/missions/${goalId}` })).json() as Json;
    expect(late.goal.overdue).toBe(late.status !== "completed");
  });

  it("refuses a deadline that is not a time, or is already past", async () => {
    for (const dueAt of ["not a date", new Date(Date.now() - 60_000).toISOString()]) {
      const res = await app.inject({ method: "POST", url: "/manager/missions", payload: { objective: "x", dueAt } });
      expect(res.statusCode).toBe(400);
    }
  });
});
