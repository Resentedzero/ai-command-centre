/**
 * Living workplace (plan §13), backend: the workspace configuration persists, is validated and
 * changes no authority; archiving moves finished work out of current lists without deleting or
 * altering anything it recorded; history filters work; and each active Run reports what it is doing.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeTestDb, resetTestSchema, testDb } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import { emitEvent, type DrizzleTransaction } from "../../src/events/emit.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { buildServer } from "../../src/api/server.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

let app: FastifyInstance;
const ids: Record<string, string> = {};

async function call(method: "GET" | "POST", url: string, payload?: Json) {
  const res = await app.inject({ method, url, payload });
  return { status: res.statusCode, body: res.json() as Json };
}

async function event(tx: DrizzleTransaction, c: { runId?: string; goalId?: string; workflowRunId?: string; invocationId?: string }, eventType: string, payload: Json = {}) {
  await emitEvent(tx, {
    idempotencyKey: `${eventType}:${randomUUID()}`,
    eventType,
    eventVersion: 1,
    causationId: null,
    correlation: { goalId: c.goalId ?? null, workflowRunId: c.workflowRunId ?? null, taskInstanceId: null, runId: c.runId ?? null, invocationId: c.invocationId ?? null },
    actor: "system",
    producer: "test",
    payload,
    usage: null,
  });
}

/** Everything that is runtime history or authority. World edits and archiving must leave all of it untouched except the archive's own event. */
async function authorityAndHistory() {
  const tables = [
    schema.agentDefinitions,
    schema.capabilityGrants,
    schema.capabilities,
    schema.budgetCounters,
    schema.runs,
    schema.invocations,
    schema.taskInstances,
    schema.workflowRuns,
    schema.artifacts,
    schema.approvals,
    schema.agentXpAwards,
    schema.agentPerformance,
    schema.agentAppearances,
  ];
  return JSON.stringify(await Promise.all(tables.map((t) => testDb.select().from(t))));
}
const eventsExcept = async (types: string[]) => (await testDb.select().from(schema.events)).filter((e) => !types.includes(e.eventType)).map((e) => e.id).sort();

async function goalWithRun(tx: DrizzleTransaction, key: string, goalStatus: string, runStatus: string, wrStatus: string, agentKey = "scholar") {
  const [goal] = await tx.insert(schema.goals).values({ projectId: ids.project!, title: `Goal ${key}`, status: goalStatus }).returning();
  const [wr] = await tx.insert(schema.workflowRuns).values({ workflowDefinitionId: ids.workflow!, workflowDefinitionVersion: 1, goalId: goal!.id, status: wrStatus }).returning();
  const [ti] = await tx.insert(schema.taskInstances).values({ taskDefinitionId: ids.task!, taskDefinitionVersion: 1, projectId: ids.project!, status: runStatus, workflowRunId: wr!.id }).returning();
  const [run] = await tx.insert(schema.runs).values({ taskInstanceId: ti!.id, agentDefinitionId: ids[agentKey]!, agentDefinitionVersion: 1, status: runStatus }).returning();
  ids[`goal_${key}`] = goal!.id;
  ids[`wr_${key}`] = wr!.id;
  ids[`run_${key}`] = run!.id;
  return { goalId: goal!.id, wrId: wr!.id, runId: run!.id, tiId: ti!.id };
}

beforeAll(async () => {
  await resetTestSchema();
  await testDb.transaction(async (tx) => {
    ids.project = (await tx.insert(schema.projects).values({ name: "P" }).returning())[0]!.id;
    ids.task = (await tx.insert(schema.taskDefinitions).values({ name: "Autonomous Objective", kind: "agent_objective", version: 1 }).returning())[0]!.id;
    ids.workflow = (await tx.insert(schema.workflowDefinitions).values({ name: "Research mission", version: 1, graphDefinition: { kind: "linear", steps: [] } }).returning())[0]!.id;
    ids.scholar = (await tx.insert(schema.agentDefinitions).values({ name: "Scholar", version: 1, role: "r", objective: "o", instructions: "i" }).returning())[0]!.id;
    ids.keeper = (await tx.insert(schema.agentDefinitions).values({ name: "Keeper", version: 1, role: "r", objective: "o", instructions: "i" }).returning())[0]!.id;
    const [cap] = await tx.insert(schema.capabilities).values({ name: "research.search", staticRiskTag: "low" }).returning();
    ids.capability = cap!.id;
    await tx.insert(schema.capabilityGrants).values({ agentDefinitionId: ids.scholar!, agentDefinitionVersion: 1, capabilityId: cap!.id, permissions: ["READ"], autonomyState: "AUTONOMOUS", maxTrustLevelRequired: 1 });

    const done = await goalWithRun(tx, "done", "completed", "completed", "completed");
    const inv = (await tx.insert(schema.invocations).values({ runId: done.runId, seqNo: 1, kind: "llm", costClass: "llm", status: "completed", idempotencyKey: `i:${randomUUID()}` }).returning())[0]!;
    ids.doneArtifact = (await tx.insert(schema.artifacts).values({ type: "deliverable", version: 1, producingInvocationId: inv.id, hash: "h", size: 1, inlineContent: "x" }).returning())[0]!.id;
    await event(tx, { runId: done.runId }, "run_completed");
    await goalWithRun(tx, "halted", "failed", "failed", "failed");
    await event(tx, { runId: ids.run_halted }, "run_halted", { reason: "execution_stopped", stopScope: "global" });
    await goalWithRun(tx, "waiting", "active", "awaiting_approval", "in_progress");

    // An active Keeper Think step: a tool call finished, the model call is running.
    const active = await goalWithRun(tx, "active", "active", "active", "in_progress", "keeper");
    await tx.insert(schema.invocations).values({ runId: active.runId, seqNo: 1, kind: "tool", costClass: "local_retrieval", status: "completed", idempotencyKey: `i:${randomUUID()}`, capabilityId: cap!.id });
    const llm = (await tx.insert(schema.invocations).values({ runId: active.runId, seqNo: 3, kind: "llm", costClass: "llm", status: "executing", idempotencyKey: `i:${randomUUID()}` }).returning())[0]!;
    await tx.insert(schema.invocations).values({ runId: active.runId, seqNo: 4, kind: "deterministic", costClass: "deterministic", status: "pending", idempotencyKey: `i:${randomUUID()}` });
    await event(tx, { runId: active.runId, invocationId: llm.id }, "context_compiled", { intent: "write", included: [] });
  });
  app = buildServer({ db: testDb });
  await app.ready();
}, 60000);

afterAll(async () => {
  await app.close();
  await closeTestDb();
});

describe("workspace configuration", () => {
  it("starts empty, is created from the current keep once, and persists across a restart", async () => {
    expect((await call("GET", "/world")).body).toMatchObject({ workspace: null, buildings: [], purposes: expect.arrayContaining(["common", "rest", "social", "waiting", "work"]) });
    const created = await call("POST", "/world");
    expect(created.status).toBe(201);
    const world = created.body.world;
    expect(world.workspace).toMatchObject({ name: "The Keep", width: 1440, height: 1024 });
    expect(world.areas.map((a: Json) => a.purpose)).toEqual(expect.arrayContaining(["common", "rest", "social", "waiting", "work", "corridor"]));
    expect(world.workstations.map((w: Json) => w.activity)).toEqual(expect.arrayContaining(["think", "research", "analysis", "writing", "publishing", "generic"]));
    expect((await call("POST", "/world")).status).toBe(409);

    // A second server instance reads the same world: it lives in Postgres, not in the process.
    const other = buildServer({ db: testDb });
    await other.ready();
    const reread = (await other.inject({ method: "GET", url: "/world" })).json() as Json;
    await other.close();
    expect(reread.areas).toHaveLength(world.areas.length);
    ids.building = world.buildings[0].id;
    ids.plaza = world.areas.find((a: Json) => a.purpose === "common").id;
    ids.workArea = world.areas.find((a: Json) => a.name === "Runtime room").id;
  });

  it("adds, renames, moves and deactivates buildings, areas and workstations, and keeps every change", async () => {
    const annex = await call("POST", "/world/buildings", { name: "Annex", x: 0, y: 0, w: 60, h: 60 });
    expect(annex.status).toBe(200);
    const room = await call("POST", "/world/areas", { buildingId: annex.body.saved.id, name: "Quiet room", purpose: "work", x: 4, y: 4, w: 50, h: 50 });
    expect(room.status).toBe(200);
    const desk = await call("POST", "/world/workstations", { areaId: room.body.saved.id, name: "Desk", activity: "writing", x: 20, y: 40 });
    expect(desk.status).toBe(200);
    expect((await call("POST", `/world/workstations/${desk.body.saved.id}`, { name: "Standing desk", x: 30 })).body.saved).toMatchObject({ name: "Standing desk", x: 30, y: 40, activity: "writing" });
    expect((await call("POST", `/world/areas/${room.body.saved.id}`, { purpose: "work", name: "Study" })).body.saved.name).toBe("Study");
    expect((await call("POST", "/world/workspace", { name: "Our keep" })).body.saved.name).toBe("Our keep");
    expect((await call("POST", `/world/workstations/${desk.body.saved.id}`, { active: false })).body.saved.active).toBe(false);

    const world = (await call("GET", "/world")).body;
    expect(world.workspace.name).toBe("Our keep");
    expect(world.workstations.find((w: Json) => w.id === desk.body.saved.id)).toMatchObject({ name: "Standing desk", x: 30, active: false });
    expect(world.areas.find((a: Json) => a.id === room.body.saved.id).name).toBe("Study");
  });

  it("refuses invalid configuration and changes nothing when it does", async () => {
    const before = JSON.stringify((await call("GET", "/world")).body);
    const refusals: [string, Json, number][] = [
      ["/world/areas", { buildingId: ids.building, name: "Outside", purpose: "common", x: 1400, y: 1000, w: 100, h: 100 }, 400],
      ["/world/areas", { buildingId: ids.building, name: "Bad", purpose: "throne_room", x: 100, y: 100, w: 50, h: 50 }, 400],
      ["/world/areas", { buildingId: ids.building, name: "Sneaky", purpose: "work", x: 100, y: 100, w: 50, h: 50, grants: ["PUBLISH"] }, 400],
      ["/world/workstations", { areaId: ids.plaza, name: "Couch desk", activity: "think", x: 600, y: 900 }, 400],
      ["/world/workstations", { areaId: ids.workArea, name: "Far desk", activity: "think", x: 10, y: 10 }, 400],
      ["/world/workstations", { areaId: ids.workArea, name: "Magic desk", activity: "grant_admin", x: 600, y: 500 }, 400],
      [`/world/areas/${ids.plaza}`, { active: false }, 409],
      [`/world/buildings/${ids.building}`, { w: 100 }, 400],
      [`/world/areas/${randomUUID()}`, { name: "x" }, 404],
      ["/world/buildings", { name: "", x: 0, y: 0, w: 40, h: 40 }, 400],
    ];
    for (const [url, body, status] of refusals) expect([url, (await call("POST", url, body)).status]).toEqual([url, status]);
    expect(JSON.stringify((await call("GET", "/world")).body)).toBe(before);
  });

  it("keeps parents and children consistent: no active child under an inactive parent, no desk outside a work area, no 500 on a bad id", async () => {
    const annex = (await call("POST", "/world/buildings", { name: "Shed", x: 1300, y: 30, w: 60, h: 60 })).body.saved;
    const room = (await call("POST", "/world/areas", { buildingId: annex.id, name: "Shed room", purpose: "work", x: 1304, y: 34, w: 50, h: 50 })).body.saved;
    const desk = (await call("POST", "/world/workstations", { areaId: room.id, name: "Shed desk", activity: "generic", x: 1320, y: 60 })).body.saved;
    expect((await call("POST", `/world/buildings/${annex.id}`, { active: false })).status).toBe(409); // active area inside
    expect((await call("POST", `/world/areas/${room.id}`, { active: false })).status).toBe(409); // active desk inside
    expect((await call("POST", `/world/areas/${room.id}`, { purpose: "rest" })).status).toBe(409); // desks need a work area
    expect((await call("POST", `/world/workstations/${desk.id}`, { active: false })).status).toBe(200);
    expect((await call("POST", `/world/areas/${room.id}`, { active: false })).status).toBe(200);
    expect((await call("POST", `/world/buildings/${annex.id}`, { active: false })).status).toBe(200);
    expect((await call("POST", `/world/areas/${room.id}`, { active: true })).status).toBe(409); // building inactive
    expect((await call("POST", "/world/areas", { buildingId: annex.id, name: "Ghost", purpose: "common", x: 1304, y: 34, w: 20, h: 20 })).status).toBe(409);
    expect((await call("POST", `/world/workstations/${desk.id}`, { active: true })).status).toBe(409); // area inactive
    expect((await call("POST", "/world/areas", { buildingId: "not-a-uuid", name: "X", purpose: "common", x: 100, y: 100, w: 20, h: 20 })).status).toBe(400);
    expect((await call("POST", "/world/workstations", { areaId: 42, name: "X", activity: "generic", x: 100, y: 100 })).status).toBe(400);
  });

  it("never changes an agent's authority, history or progression", async () => {
    const before = await authorityAndHistory();
    const eventsBefore = (await testDb.select().from(schema.events)).length;
    const lab = await call("POST", "/world/areas", { buildingId: ids.building, name: "Lab", purpose: "work", x: 1010, y: 840, w: 300, h: 140 });
    await call("POST", "/world/workstations", { areaId: lab.body.saved.id, name: "Bench", activity: "research", x: 1100, y: 900 });
    await call("POST", `/world/areas/${lab.body.saved.id}`, { name: "Research lab" });
    expect(await authorityAndHistory()).toBe(before);
    expect((await testDb.select().from(schema.events)).length).toBe(eventsBefore);
  });

  it("applies a template as a new current world, retiring (not deleting) the old one, and keeps desks' facing", async () => {
    const before = await authorityAndHistory();
    const eventsBefore = (await testDb.select().from(schema.events)).length;
    const offered = (await call("GET", "/world")).body;
    expect(offered.templates.map((t: Json) => t.id)).toEqual(["keep", "scholars", "garrison"]);
    expect(offered.facings).toEqual(["up", "down", "left", "right"]);
    const workspacesBefore = await testDb.select().from(schema.worldWorkspaces);

    const applied = await call("POST", "/world/templates/scholars");
    expect(applied.status).toBe(201);
    const world = applied.body.world;
    expect(world.workspace).toMatchObject({ name: "Scholars' Keep", template: "scholars" });
    const living = world.areas.filter((a: Json) => ["common", "rest", "social"].includes(a.purpose));
    expect(living.length).toBeGreaterThanOrEqual(3);
    expect((await call("GET", "/world")).body.workspace.id).toBe(world.workspace.id);
    const workspacesAfter = await testDb.select().from(schema.worldWorkspaces);
    expect(workspacesAfter).toHaveLength(workspacesBefore.length + 1);
    expect(workspacesAfter.filter((w) => w.active)).toHaveLength(1);

    // Edits reach only the current world; a desk turns to face its work.
    const desk = world.workstations[0];
    expect((await call("POST", `/world/workstations/${desk.id}`, { facing: "left" })).body.saved.facing).toBe("left");
    expect((await call("POST", `/world/workstations/${desk.id}`, { facing: "sideways" })).status).toBe(400);
    expect((await call("POST", `/world/areas/${ids.plaza}`, { name: "Old plaza" })).status).toBe(404);
    expect((await call("POST", "/world/templates/castle-in-the-sky")).status).toBe(404);

    // Back to The Keep: space only, no authority or history touched. The one thing a template switch DOES
    // record is where the meeting rooms now stand — a room whose drawn area this world lacks is re-placed,
    // and a workplace change is never silent.
    expect((await call("POST", "/world/templates/keep")).status).toBe(201);
    expect(await authorityAndHistory()).toBe(before);
    const newEvents = (await testDb.select().from(schema.events).orderBy(schema.events.globalSeq)).slice(eventsBefore);
    expect([...new Set(newEvents.map((e) => e.eventType))]).toEqual(["workplace_room_changed"]);
    const settings = (await call("GET", "/workplace/settings")).body;
    expect(settings.offTheMap).toEqual([]);
  });
});

describe("archive and history", () => {
  it("refuses to archive work in progress", async () => {
    expect((await call("POST", `/goals/${ids.goal_active}/archive`)).status).toBe(409);
    expect((await call("POST", `/goals/${randomUUID()}/archive`)).status).toBe(404);
  });

  it("archives a finished goal without deleting or altering anything it recorded, and keeps it inspectable", async () => {
    const before = await authorityAndHistory();
    const eventsBefore = await eventsExcept(["goal_archived"]);
    const res = await call("POST", `/goals/${ids.goal_done}/archive`);
    expect(res).toMatchObject({ status: 200, body: { id: ids.goal_done, archivedBy: "human:operator" } });
    expect(await authorityAndHistory()).toBe(before);
    expect(await eventsExcept(["goal_archived"])).toEqual(eventsBefore);
    const archivedEvent = await testDb.query.events.findFirst({ where: eq(schema.events.eventType, "goal_archived") });
    expect(archivedEvent).toMatchObject({ goalId: ids.goal_done, actor: "human:operator" });
    expect((await call("POST", `/goals/${ids.goal_done}/archive`)).status).toBe(409);

    // Out of current work…
    const goals = (await call("GET", "/goals")).body.projects.flatMap((p: Json) => p.goals).map((g: Json) => g.id);
    expect(goals).not.toContain(ids.goal_done);
    expect(goals).toContain(ids.goal_active);
    expect((await call("GET", "/workflow-runs")).body.workflowRuns.map((w: Json) => w.id)).not.toContain(ids.wr_done);
    // …but all of it is still there.
    expect((await call("GET", "/goals?archived=include")).body.projects.flatMap((p: Json) => p.goals).map((g: Json) => g.id)).toContain(ids.goal_done);
    expect((await call("GET", "/workflow-runs?archived=include")).body.workflowRuns.map((w: Json) => w.id)).toContain(ids.wr_done);
    expect((await call("GET", `/workflow-runs/${ids.wr_done}`)).status).toBe(200);
    expect((await call("GET", `/artifacts/${ids.doneArtifact}`)).status).toBe(200);
    expect((await call("GET", `/keeper/explanations?subject=workflow_run:${ids.wr_done}&intent=run_outcome`)).body.facts.length).toBeGreaterThan(0);
  });

  it("history lists every goal with its lifecycle as recorded, and filters it", async () => {
    const all = (await call("GET", "/history")).body;
    const byId = Object.fromEntries(all.goals.map((g: Json) => [g.id, g]));
    expect(byId[ids.goal_done!]).toMatchObject({ lifecycle: "completed", archivedBy: "human:operator", agents: ["Scholar"], workflowRuns: [{ workflow: "Research mission v1" }] });
    expect(byId[ids.goal_halted!].lifecycle).toBe("stopped");
    expect(byId[ids.goal_waiting!].lifecycle).toBe("awaiting_approval");
    expect(byId[ids.goal_active!]).toMatchObject({ lifecycle: "active", agents: ["Keeper"] });
    expect(all.filters).toMatchObject({ agents: ["Keeper", "Scholar"], workflows: ["Research mission"] });

    const idsOf = async (query: string) => (await call("GET", `/history?${query}`)).body.goals.map((g: Json) => g.id).sort();
    expect(await idsOf("archived=only")).toEqual([ids.goal_done]);
    expect(await idsOf("archived=exclude")).not.toContain(ids.goal_done);
    expect(await idsOf("lifecycle=stopped")).toEqual([ids.goal_halted]);
    expect(await idsOf("agent=Keeper")).toEqual([ids.goal_active]);
    expect((await idsOf("workflow=Research%20mission")).length).toBe(4);
    expect(await idsOf("q=halted")).toEqual([ids.goal_halted]);
    expect(await idsOf(`to=${encodeURIComponent("2000-01-01")}`)).toEqual([]);
    expect((await call("GET", "/history?lifecycle=cancelled")).status).toBe(400);
    expect((await call("GET", "/history?from=not-a-date")).status).toBe(400);
  });

  it("unarchives back into current work", async () => {
    expect((await call("POST", `/goals/${ids.goal_done}/unarchive`)).status).toBe(200);
    expect((await call("GET", "/goals")).body.projects.flatMap((p: Json) => p.goals).map((g: Json) => g.id)).toContain(ids.goal_done);
    expect((await call("POST", `/goals/${ids.goal_done}/unarchive`)).status).toBe(409);
  });
});

describe("a backlog of finished work", () => {
  const OLD = 60;
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3_600_000);
  beforeAll(async () => {
    await testDb.transaction(async (tx) => {
      for (let i = 0; i < OLD; i++) {
        const [goal] = await tx.insert(schema.goals).values({ projectId: ids.project!, title: `Old goal ${i}`, status: i % 5 === 0 ? "failed" : "completed", createdAt: tenDaysAgo }).returning();
        await tx.insert(schema.workflowRuns).values({ workflowDefinitionId: ids.workflow!, workflowDefinitionVersion: 1, goalId: goal!.id, status: i % 5 === 0 ? "failed" : "completed", createdAt: tenDaysAgo, completedAt: tenDaysAgo });
      }
      // Unfinished but old: always current.
      await goalWithRun(tx, "oldActive", "active", "active", "paused");
      await tx.update(schema.goals).set({ createdAt: tenDaysAgo }).where(eq(schema.goals.id, ids.goal_oldActive!));
      await tx.update(schema.workflowRuns).set({ createdAt: tenDaysAgo }).where(eq(schema.workflowRuns.id, ids.wr_oldActive!));
    });
  });

  it("is history without anyone archiving it: the current-work window leaves out old finished work, never unfinished work", async () => {
    const goalIds = async (q: string) => (await call("GET", `/goals${q}`)).body.projects.flatMap((p: Json) => p.goals).map((g: Json) => g.id as string);
    const all = await goalIds("");
    const current = await goalIds("?within=24");
    expect(all.length).toBeGreaterThanOrEqual(OLD + 5);
    expect(current).toEqual(expect.arrayContaining([ids.goal_done, ids.goal_halted, ids.goal_active, ids.goal_oldActive]));
    expect(current.length).toBe(all.length - OLD);
    const runs = (await call("GET", "/workflow-runs?within=24")).body.workflowRuns.map((w: Json) => w.id);
    expect(runs).toContain(ids.wr_oldActive);
    expect(runs).toContain(ids.wr_done);
    expect(runs.length).toBe(5);
    expect((await call("GET", "/goals?within=-1")).status).toBe(400);
    expect((await call("GET", "/workflow-runs?within=abc")).status).toBe(400);
    // Nothing old is lost: History has every run, filterable.
    const history = (await call("GET", "/history/workflow-runs?status=failed")).body;
    expect(history.workflowRuns.length).toBe(OLD / 5 + 1);
    expect((await call("GET", "/history/workflow-runs?q=Old%20goal%207")).body.workflowRuns).toHaveLength(1);
    expect((await call("GET", "/history/workflow-runs?status=cancelled")).status).toBe(400);
  });

  it("archives the whole backlog in one confirmed action, exactly the count the operator saw, deleting nothing", async () => {
    const before = await authorityAndHistory();
    const archivedBefore = (await testDb.select().from(schema.events)).filter((e) => e.eventType === "goal_archived").length;
    const dry = await call("POST", "/history/archive", { finishedBeforeHours: 24, dryRun: true });
    expect(dry).toMatchObject({ status: 200, body: { dryRun: true, count: OLD } });
    expect((await call("POST", "/history/archive", { finishedBeforeHours: 24, dryRun: false })).status).toBe(400);
    expect((await call("POST", "/history/archive", { finishedBeforeHours: 24, dryRun: false, expectedCount: OLD - 1 })).status).toBe(409);
    expect((await call("POST", "/history/archive", { finishedBeforeHours: -3, dryRun: true })).status).toBe(400);
    const done = await call("POST", "/history/archive", { finishedBeforeHours: 24, dryRun: false, expectedCount: OLD });
    expect(done).toMatchObject({ status: 200, body: { dryRun: false, count: OLD } });
    expect(await authorityAndHistory()).toBe(before);
    expect((await testDb.select().from(schema.events)).filter((e) => e.eventType === "goal_archived").length).toBe(archivedBefore + OLD);
    expect((await call("POST", "/history/archive", { finishedBeforeHours: 24, dryRun: true })).body.count).toBe(0);
    // Unfinished and recent work stayed current; the archived backlog is all still in History.
    expect((await call("GET", "/history?archived=only")).body.goals).toHaveLength(OLD);
  });
});

describe("what each active run is doing", () => {
  it("reports the latest non-bookkeeping invocation's kind, status, capability and compiled intent", async () => {
    const agents = (await call("GET", "/agents/active")).body.agents as Json[];
    const keeper = agents.find((a) => a.runId === ids.run_active);
    expect(keeper).toMatchObject({ agentName: "Keeper", taskStatus: "active", workflowRunId: ids.wr_active, goalId: ids.goal_active, activity: { invocationKind: "llm", invocationStatus: "executing", capability: null, intent: "write", taskKind: "agent_objective" } });
    const waiting = agents.find((a) => a.runId === ids.run_waiting);
    expect(waiting).toMatchObject({ taskStatus: "awaiting_approval", activity: null });
  });
});
