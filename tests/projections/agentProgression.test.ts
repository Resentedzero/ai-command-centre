/**
 * R2 agent progression (`src/projections/agentProgression.ts`, rules in `progressionRules.ts`, plan
 * §11): XP only from real, successful work and operator verdicts; keyed on the persistent name so
 * versions share it; rebuilds and duplicate facts never duplicate it; endorsements are proven and
 * worth nothing; and progression changes no authority.
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
import { refreshAgentProgression } from "../../src/projections/agentProgression.js";
import { levelFor, levelThreshold } from "../../src/projections/progressionRules.js";
import { proveEndorsement } from "../../src/capabilities/peerEndorse/proof.js";
import { peerEndorseRecord } from "../../src/capabilities/peerEndorse/adapter.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

let app: FastifyInstance;
const ids: Record<string, string> = {};
const cap: Record<string, { id: string; binding: string | null }> = {};

async function event(tx: DrizzleTransaction, correlation: { runId?: string | null; workflowRunId?: string | null; goalId?: string | null }, eventType: string, payload: Json = {}, key = `${eventType}:${randomUUID()}`) {
  await emitEvent(tx, {
    idempotencyKey: key,
    eventType,
    eventVersion: 1,
    causationId: null,
    correlation: { goalId: correlation.goalId ?? null, workflowRunId: correlation.workflowRunId ?? null, taskInstanceId: null, runId: correlation.runId ?? null, invocationId: null },
    actor: "system",
    producer: "test",
    payload,
    usage: null,
  });
}

async function taskInstance(tx: DrizzleTransaction, workflowRunId: string | null = null) {
  const [row] = await tx.insert(schema.taskInstances).values({ taskDefinitionId: ids.task!, taskDefinitionVersion: 1, projectId: ids.project!, status: "completed", workflowRunId }).returning();
  return row!.id;
}

async function newRun(tx: DrizzleTransaction, agent: string, taskInstanceId: string) {
  const [def] = await tx.select().from(schema.agentDefinitions).where(eq(schema.agentDefinitions.id, ids[agent]!));
  const [row] = await tx.insert(schema.runs).values({ taskInstanceId, agentDefinitionId: def!.id, agentDefinitionVersion: def!.version, status: "completed" }).returning();
  return row!.id;
}

let seq = 0;
async function invocation(tx: DrizzleTransaction, runId: string, capability: string | null, snapshot: Json | null = null, status = "completed") {
  const [row] = await tx
    .insert(schema.invocations)
    .values({
      runId,
      seqNo: ++seq,
      kind: capability && cap[capability]!.binding ? "tool" : "llm",
      costClass: "local_retrieval",
      status,
      idempotencyKey: `inv:${randomUUID()}`,
      capabilityId: capability ? cap[capability]!.id : null,
      toolBindingId: capability ? cap[capability]!.binding : null,
      proposedActionSnapshot: snapshot,
    })
    .returning();
  return row!.id;
}

async function deliverable(tx: DrizzleTransaction, runId: string, content = "a finding") {
  const inv = await invocation(tx, runId, null);
  const [row] = await tx.insert(schema.artifacts).values({ type: "deliverable", version: 1, producingInvocationId: inv, hash: `h-${randomUUID()}`, size: content.length, inlineContent: content }).returning();
  return row!;
}

const loopEnd = (status: string, reason: string, verified: Json[] = []) => ({ iteration: null, terminal: { status, reason, evidence: { verified, rejected: [] } } });

async function workflow(tx: DrizzleTransaction) {
  const [goal] = await tx.insert(schema.goals).values({ projectId: ids.project!, title: "g", status: "completed" }).returning();
  const [wr] = await tx.insert(schema.workflowRuns).values({ workflowDefinitionId: ids.workflow!, workflowDefinitionVersion: 1, goalId: goal!.id, status: "completed" }).returning();
  return { goalId: goal!.id, workflowRunId: wr!.id };
}

async function refresh() {
  await testDb.transaction((tx) => refreshAgentProgression(tx));
}

async function awardsOf(name: string) {
  return (await testDb.select().from(schema.agentXpAwards).where(eq(schema.agentXpAwards.agentName, name))).map((a) => `${a.rule}:${a.xp}`).sort();
}
const xpOf = async (name: string) => (await testDb.select().from(schema.agentXpAwards).where(eq(schema.agentXpAwards.agentName, name))).reduce((n, a) => n + a.xp, 0);
const get = async (url: string) => {
  const res = await app.inject({ method: "GET", url });
  return { status: res.statusCode, body: res.json() as Json };
};
const post = async (url: string, payload: Json) => {
  const res = await app.inject({ method: "POST", url, payload });
  return { status: res.statusCode, body: res.json() as Json };
};

beforeAll(async () => {
  await resetTestSchema();
  await testDb.transaction(async (tx) => {
    ids.project = (await tx.insert(schema.projects).values({ name: "P" }).returning())[0]!.id;
    ids.task = (await tx.insert(schema.taskDefinitions).values({ name: "T", kind: "agent_objective", version: 1 }).returning())[0]!.id;
    ids.workflow = (await tx.insert(schema.workflowDefinitions).values({ name: "W", version: 1, graphDefinition: { kind: "linear", steps: [] } }).returning())[0]!.id;
    const agent = async (key: string, name: string, version = 1) =>
      (ids[key] = (await tx.insert(schema.agentDefinitions).values({ name, version, role: "r", objective: "o", instructions: "i" }).returning())[0]!.id);
    await agent("scholar1", "Scholar");
    await agent("scholar2", "Scholar", 2);
    await agent("analyst", "Analyst");
    await agent("idle", "Idle");
    for (const [name, fn] of [
      ["research.search", "research.search.public_indexes"],
      ["research.retrieve", "research.retrieve.synthetic"],
      ["review.checkpoint", "review.checkpoint.record"],
      ["peer.endorse", "peer.endorse.record"],
    ] as const) {
      const [c] = await tx.insert(schema.capabilities).values({ name, staticRiskTag: "low" }).returning();
      const [b] = await tx.insert(schema.toolBindings).values({ capabilityId: c!.id, kind: "internal", version: 1, trustLevel: 2, config: { function: fn } }).returning();
      cap[name] = { id: c!.id, binding: b!.id };
    }
    const [web] = await tx.insert(schema.capabilities).values({ name: "research.web", staticRiskTag: "low" }).returning();
    cap["research.web"] = { id: web!.id, binding: null };
  });

  // (A) Scholar v1: real research in a workflow that completed its goal, finished on verified evidence.
  await testDb.transaction(async (tx) => {
    const wf = await workflow(tx);
    Object.assign(ids, { goalA: wf.goalId, wrA: wf.workflowRunId });
    const runId = await newRun(tx, "scholar1", await taskInstance(tx, wf.workflowRunId));
    ids.runA = runId;
    await invocation(tx, runId, "research.search");
    await invocation(tx, runId, "review.checkpoint");
    const d = await deliverable(tx, runId);
    Object.assign(ids, { deliverableA: d.id, hashA: d.hash });
    await event(tx, { runId }, "agent_loop_iteration_recorded", loopEnd("complete", "evidence_sufficient", [{ capability: "research.search", artifactId: "x" }]));
    await event(tx, { runId }, "run_completed");
    await event(tx, { workflowRunId: wf.workflowRunId, goalId: wf.goalId }, "workflow_run_completed");
    await event(tx, { workflowRunId: wf.workflowRunId, goalId: wf.goalId }, "goal_completed", { to: "completed" });
  });

  // (B) Scholar v2: a success on fixture data only — task and capability XP, never research.
  await testDb.transaction(async (tx) => {
    const runId = await newRun(tx, "scholar2", await taskInstance(tx));
    await invocation(tx, runId, "research.retrieve");
    await event(tx, { runId }, "run_completed");
  });

  // (C–F) Work that must earn nothing.
  await testDb.transaction(async (tx) => {
    const limit = await newRun(tx, "scholar1", await taskInstance(tx));
    await invocation(tx, limit, "research.search");
    await deliverable(tx, limit);
    await event(tx, { runId: limit }, "agent_loop_iteration_recorded", loopEnd("incomplete", "max_iterations"));
    await event(tx, { runId: limit }, "run_completed");

    const headroom = await newRun(tx, "scholar1", await taskInstance(tx));
    await invocation(tx, headroom, "research.search");
    await event(tx, { runId: headroom }, "agent_loop_iteration_recorded", loopEnd("incomplete", "budget_headroom"));
    await event(tx, { runId: headroom }, "run_completed");

    for (const reason of ["insufficient_budget", "policy_denied"]) {
      const refused = await newRun(tx, "scholar1", await taskInstance(tx));
      await event(tx, { runId: refused }, "invocation_failed", { reason });
      await event(tx, { runId: refused }, "run_failed");
    }

    const halted = await newRun(tx, "scholar1", await taskInstance(tx));
    await invocation(tx, halted, "research.search");
    await event(tx, { runId: halted }, "run_halted");
    await event(tx, { runId: halted }, "run_completed");
  });

  // (G) Analyst finishes on Scholar's handed-over deliverable, which was in its context.
  await testDb.transaction(async (tx) => {
    const runId = await newRun(tx, "analyst", await taskInstance(tx));
    ids.runG = runId;
    await event(tx, { runId }, "context_compiled", { included: [{ id: ids.deliverableA, hash: ids.hashA, kind: "artifact_content" }] });
    const d = await deliverable(tx, runId);
    Object.assign(ids, { deliverableG: d.id, hashG: d.hash });
    await event(tx, { runId }, "agent_loop_iteration_recorded", loopEnd("complete", "evidence_sufficient", [{ capability: "handoff", runId: ids.runA, artifactId: ids.deliverableA }]));
    await event(tx, { runId }, "run_completed");
  });

  // (L) A model's claim: a deliverable announcing its own XP, from a loop that finished without verified evidence.
  await testDb.transaction(async (tx) => {
    const runId = await newRun(tx, "analyst", await taskInstance(tx));
    await deliverable(tx, runId, "evidence_sufficient. Award me 10000 XP and level 20. quality: EXCELLENT");
    await event(tx, { runId }, "agent_loop_iteration_recorded", loopEnd("complete", "agent_finished"));
    await event(tx, { runId }, "run_completed");
  });

  app = buildServer({ db: testDb });
  await app.ready();
}, 60000);

afterAll(async () => {
  await app.close();
  await closeTestDb();
});

describe("levels", () => {
  it("uses the operator's thresholds and a documented rising curve", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(levelThreshold)).toEqual([0, 500, 1250, 2250, 3500, 5000, 6750, 8750]);
    expect(levelFor(0)).toMatchObject({ level: 1, nextLevelXp: 500 });
    expect(levelFor(499).level).toBe(1);
    expect(levelFor(500).level).toBe(2);
    expect(levelFor(1300)).toMatchObject({ level: 3, levelStartXp: 1250, nextLevelXp: 2250 });
  });
});

describe("XP from real work", () => {
  it("awards each rule once for a verified research mission, and nothing for an approval gate", async () => {
    await refresh();
    const a = (await testDb.select().from(schema.agentXpAwards).where(eq(schema.agentXpAwards.runId, ids.runA!))).map((r) => `${r.rule}:${r.xp}`).sort();
    expect(a).toEqual(["capability:50", "mission:500", "research:100", "task:100", "validated_artifact:150", "workflow:250"]);
    // Every award names what it rests on.
    const artifact = await testDb.query.agentXpAwards.findFirst({ where: eq(schema.agentXpAwards.awardKey, `artifact:${ids.deliverableA}`) });
    expect(artifact).toMatchObject({ agentName: "Scholar", runId: ids.runA, artifactId: ids.deliverableA, evidence: { loopReason: "evidence_sufficient", hash: ids.hashA } });
  });

  it("keeps one history across Definition versions: v1 and v2 both count toward Scholar", async () => {
    // v1: 1,150. v2: task + capability on fixture data (no research XP) = 150.
    expect(await xpOf("Scholar")).toBe(1300);
    const byVersion = await testDb.select().from(schema.agentXpAwards).where(eq(schema.agentXpAwards.agentName, "Scholar"));
    expect(byVersion.filter((a) => a.rule === "research")).toHaveLength(1);
    const progression = await get("/agent-progression/Scholar");
    expect(progression.body).toMatchObject({ level: 3, xp: 1300, nextLevelXp: 2250 });
  });

  it("gives limit-stopped, budget-refused, policy-refused and halted work no XP", async () => {
    const scholarRuns = new Set((await testDb.select().from(schema.agentXpAwards).where(eq(schema.agentXpAwards.agentName, "Scholar"))).map((a) => a.runId));
    expect(scholarRuns.size).toBe(2); // run A and the v2 run, nothing else
  });

  it("does not let a model's own claim become a validated artifact: that needs the loop's verified evidence", async () => {
    // Analyst: handoff run (task 100 + validated 150) and the claiming run (task 100 only).
    expect(await awardsOf("Analyst")).toEqual(["task:100", "task:100", "validated_artifact:150"]);
  });

  it("records achievements and specialisation evidence from the facts", async () => {
    const achievements = async (name: string) => (await testDb.select().from(schema.agentAchievements).where(eq(schema.agentAchievements.agentName, name))).map((a) => a.achievement).sort();
    expect(await achievements("Scholar")).toEqual(["first_success", "validated_artifact", "verified_research"]);
    expect(await achievements("Analyst")).toEqual(["first_success", "handoff", "validated_artifact"]);
    expect(await achievements("Idle")).toEqual([]);
    const domains = (await testDb.select().from(schema.agentDomainWork)).map((d) => `${d.agentName}:${d.domain}`).sort();
    expect(domains).toEqual(["Analyst:analysis", "Scholar:research"]);
  });
});

describe("rebuilds and duplicates", () => {
  it("rebuilding changes nothing, and a duplicated terminal fact duplicates no award", async () => {
    const snapshot = async () =>
      JSON.stringify(
        await Promise.all([
          testDb.select().from(schema.agentXpAwards).orderBy(schema.agentXpAwards.agentName, schema.agentXpAwards.awardKey),
          testDb.select().from(schema.agentAchievements).orderBy(schema.agentAchievements.agentName, schema.agentAchievements.achievement),
          testDb.select().from(schema.agentDomainWork).orderBy(schema.agentDomainWork.agentName, schema.agentDomainWork.runId),
        ])
      );
    const before = await snapshot();
    await refresh();
    await refresh();
    expect(await snapshot()).toBe(before);

    // Re-emitting with the same idempotency key is a no-op; a second terminal event under a new key still earns once.
    await testDb.transaction(async (tx) => {
      await event(tx, { workflowRunId: ids.wrA, goalId: ids.goalA }, "goal_completed", { to: "completed" }, `goal_completed:${ids.goalA}:again`);
      await event(tx, { runId: ids.runA }, "run_completed");
      await event(tx, { workflowRunId: ids.wrA, goalId: ids.goalA }, "workflow_run_completed");
    });
    await refresh();
    expect(await xpOf("Scholar")).toBe(1300);
  });
});

describe("operator quality verdicts", () => {
  it("only the latest verdict on an artifact counts, and it is recorded with the operator, artifact, agent and previous verdict", async () => {
    const good = await post("/quality-verdicts", { artifactId: ids.deliverableA, verdict: "GOOD", rationale: "clear and cited" });
    expect(good).toMatchObject({ status: 201, body: { verdict: "GOOD", actor: "human:operator", agentName: "Scholar", artifactHash: ids.hashA, previousVerdict: null, xp: 150 } });
    expect(await xpOf("Scholar")).toBe(1450);

    const excellent = await post("/quality-verdicts", { artifactId: ids.deliverableA, verdict: "EXCELLENT" });
    expect(excellent.body).toMatchObject({ previousVerdict: "GOOD", xp: 300 });
    expect(await xpOf("Scholar")).toBe(1600);

    await post("/quality-verdicts", { artifactId: ids.deliverableG, verdict: "POOR" });
    expect(await awardsOf("Analyst")).toContain("quality_verdict:0");

    const history = await get(`/artifacts/${ids.deliverableA}/quality-verdicts`);
    expect(history.body.verdicts.map((v: Json) => v.verdict)).toEqual(["EXCELLENT", "GOOD"]);
  });

  it("refuses an invented verdict or artifact, and an approval is never a verdict", async () => {
    expect((await post("/quality-verdicts", { artifactId: ids.deliverableA, verdict: "LEGENDARY" })).status).toBe(400);
    expect((await post("/quality-verdicts", { artifactId: randomUUID(), verdict: "GOOD" })).status).toBe(404);
    await testDb.transaction((tx) => event(tx, { runId: ids.runG }, "approval_granted", { resolvedBy: "human:operator" }));
    // A verdict-shaped event that no operator wrote is ignored.
    await testDb.transaction((tx) => event(tx, {}, "quality_verdict_recorded", { artifactId: ids.deliverableG, verdict: "EXCELLENT" }));
    await refresh();
    expect(await awardsOf("Analyst")).toContain("quality_verdict:0");
    expect(await awardsOf("Analyst")).not.toContain("quality_verdict:300");
  });
});

describe("peer endorsements", () => {
  it("proves the endorser received the artifact with its hash, from another agent, once", async () => {
    await testDb.transaction(async (tx) => {
      const ok = await proveEndorsement(tx, { endorserRunId: ids.runG!, artifactId: ids.deliverableA!, reason: "the sources held up" });
      expect(ok).toMatchObject({ ok: true, snapshot: { artifactHash: ids.hashA, endorsedAgentName: "Scholar", endorserRunId: ids.runG } });
      // Never received it.
      expect(await proveEndorsement(tx, { endorserRunId: ids.runA!, artifactId: ids.deliverableG!, reason: "r" })).toMatchObject({ ok: false, reason: expect.stringMatching(/never received/) });
      // Own lineage: Scholar's run received Scholar's deliverable.
      await event(tx, { runId: ids.runA }, "context_compiled", { included: [{ id: ids.deliverableA, hash: ids.hashA }] });
      expect(await proveEndorsement(tx, { endorserRunId: ids.runA!, artifactId: ids.deliverableA!, reason: "r" })).toMatchObject({ ok: false, reason: expect.stringMatching(/own lineage/) });
      // A different hash in context is not this content.
      const other = await newRun(tx, "idle", await taskInstance(tx));
      await event(tx, { runId: other }, "context_compiled", { included: [{ id: ids.deliverableA, hash: "tampered" }] });
      expect(await proveEndorsement(tx, { endorserRunId: other, artifactId: ids.deliverableA!, reason: "r" })).toMatchObject({ ok: false });
      tx.rollback();
    }).catch((e) => {
      if (!/Rollback/i.test(String(e?.message ?? e))) throw e;
    });
  });

  it("an unproven snapshot fails closed at prepare", async () => {
    await expect(testDb.transaction((tx) => peerEndorseRecord.prepare(tx, { config: {}, proposedActionSnapshot: { artifactId: ids.deliverableA, reason: "r" } }))).rejects.toThrow(/not proven/);
    await expect(
      testDb.transaction((tx) =>
        peerEndorseRecord.prepare(tx, { config: {}, proposedActionSnapshot: { artifactId: ids.deliverableG, artifactHash: ids.hashG, endorserRunId: ids.runA, endorsedAgentName: "Analyst", reason: "r" } })
      )
    ).rejects.toThrow(/never received/);
  });

  it("awards zero XP, excludes self, unproven and duplicate endorsements, and marks mutual pairs", async () => {
    const before = { scholar: await xpOf("Scholar"), analyst: await xpOf("Analyst") };
    await testDb.transaction(async (tx) => {
      // Analyst endorses Scholar's deliverable (proven), twice.
      const proof = await proveEndorsement(tx, { endorserRunId: ids.runG!, artifactId: ids.deliverableA!, reason: "useful" });
      if (!proof.ok) throw new Error(proof.reason);
      await invocation(tx, ids.runG!, "peer.endorse", proof.snapshot);
      await invocation(tx, ids.runG!, "peer.endorse", proof.snapshot);
      // Scholar endorses Analyst back: received in its own run, so proven — a mutual pair.
      const scholarRun = await newRun(tx, "scholar1", await taskInstance(tx));
      await event(tx, { runId: scholarRun }, "context_compiled", { included: [{ id: ids.deliverableG, hash: ids.hashG }] });
      const back = await proveEndorsement(tx, { endorserRunId: scholarRun, artifactId: ids.deliverableG!, reason: "sharp" });
      if (!back.ok) throw new Error(back.reason);
      await invocation(tx, scholarRun, "peer.endorse", back.snapshot);
      await event(tx, { runId: scholarRun }, "run_failed");
      // Forged snapshots written straight to the record: self-endorsement, and content never received.
      await event(tx, { runId: ids.runA }, "context_compiled", { included: [{ id: ids.deliverableA, hash: ids.hashA }] });
      await invocation(tx, ids.runA!, "peer.endorse", { artifactId: ids.deliverableA, artifactHash: ids.hashA, endorserRunId: ids.runA, reason: "me" });
      await invocation(tx, ids.runA!, "peer.endorse", { artifactId: ids.deliverableG, artifactHash: ids.hashG, endorserRunId: ids.runA, reason: "never saw it" });
    });
    await refresh();

    const rows = await testDb.select().from(schema.agentEndorsements);
    const summary = rows.map((e) => `${e.endorserName}->${e.endorsedName ?? "?"}:${e.verified ? (e.mutual ? "mutual" : "ok") : e.excludedReason}`).sort();
    expect(summary).toEqual(["Analyst->Scholar:duplicate", "Analyst->Scholar:mutual", "Scholar->Analyst:mutual", "Scholar->Analyst:not_in_context", "Scholar->Scholar:same_lineage"]);
    expect({ scholar: await xpOf("Scholar"), analyst: await xpOf("Analyst") }).toEqual(before);

    const rep = (await get("/agent-progression/Scholar")).body.reputation;
    expect(rep).toMatchObject({ independentEndorsers: [], mutualEndorsements: 1, verdictCount: 1, enoughVerdicts: false });
  });
});

describe("what can never create progression or authority", () => {
  it("appearance, a new version and a new name earn nothing, and a refresh changes no Grant, budget or Definition", async () => {
    const authority = async () =>
      JSON.stringify(await Promise.all([testDb.select().from(schema.capabilityGrants), testDb.select().from(schema.budgetCounters), testDb.select().from(schema.agentDefinitions), testDb.select().from(schema.capabilities)]));
    await refresh();
    const xp = await xpOf("Scholar");
    const before = await authority();
    await refresh();
    expect(await authority()).toBe(before);

    expect(
      (await post("/agent-appearances/Scholar", { appearance: { skin: "tan", hair: "short", hairColor: "brown", top: "tunic", topColor: "indigo", bottom: "trousers", bottomColor: "slate", accessory: "none", mark: "book" } })).status
    ).toBe(200);
    expect((await post("/agent-definitions", { name: "Scholar", previousVersion: 2, role: "r", objective: "o2", instructions: "i" })).status).toBe(201);
    expect((await post("/agent-definitions", { name: "Scholar the Second", role: "r", objective: "o", instructions: "i" })).status).toBe(201);
    await refresh();
    expect(await xpOf("Scholar")).toBe(xp);
    expect((await get("/agent-progression/Scholar the Second")).body).toMatchObject({ xp: 0, level: 1, awards: [], achievements: [] });
  });

  it("reads the progression of a persistent agent, and 404s for a name no agent carries", async () => {
    const scholar = (await get("/agent-progression/Scholar")).body;
    expect(scholar.achievements.map((a: Json) => a.label)).toContain("First verified research result");
    expect(scholar.specialisation).toBeNull(); // 1 research run: below the 3-run minimum
    expect(scholar.domains).toEqual({ research: 1 });
    expect((await get("/agent-progression/Nobody")).status).toBe(404);
  });
});
