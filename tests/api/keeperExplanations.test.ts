/**
 * R2 Stage 6 — Keeper explanations (`GET /keeper/explanations`, `src/keeper/explainIntent.ts`):
 * every supported intent answers from its authoritative record as FACT / DERIVED / UNKNOWN with
 * links; unknowns stay unknown; context is bounded to the subject; model-written claims are never
 * facts; nothing is written, and no credential or unrelated record is read.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeTestDb, resetTestSchema, testDb } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import { emitEvent, type DrizzleTransaction } from "../../src/events/emit.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { buildServer } from "../../src/api/server.js";
import { refreshAgentProgression } from "../../src/projections/agentProgression.js";
import { refreshAgentPerformance } from "../../src/projections/agentPerformance.js";
import { INTENTS, agentNamedIn, classifyQuestion } from "../../src/keeper/intents.js";
import { LIMITS } from "../../src/keeper/explainIntent.js";
import { recordText, unsupportedNumbers } from "../../src/capabilities/keeperAnswer/buildInvocationSpecs.js";
import { systemInspectRead } from "../../src/capabilities/systemInspect/adapter.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

let app: FastifyInstance;
const ids: Record<string, string> = {};
const SECRET = "sk-keeper-test-SECRET-4711";

async function event(tx: DrizzleTransaction, runId: string | null, eventType: string, payload: Json = {}, extra: { workflowRunId?: string; goalId?: string; actor?: string } = {}) {
  await emitEvent(tx, {
    idempotencyKey: `${eventType}:${randomUUID()}`,
    eventType,
    eventVersion: 1,
    causationId: null,
    correlation: { goalId: extra.goalId ?? null, workflowRunId: extra.workflowRunId ?? null, taskInstanceId: null, runId, invocationId: null },
    actor: extra.actor ?? "system",
    producer: "test",
    payload,
    usage: null,
  });
}

let seq = 0;
async function run(tx: DrizzleTransaction, agentKey: string, workflowRunId: string | null, status = "completed") {
  const [ti] = await tx.insert(schema.taskInstances).values({ taskDefinitionId: ids.task!, taskDefinitionVersion: 1, projectId: ids.project!, status, workflowRunId }).returning();
  const def = (await tx.query.agentDefinitions.findFirst({ where: eq(schema.agentDefinitions.id, ids[agentKey]!) }))!;
  const [r] = await tx.insert(schema.runs).values({ taskInstanceId: ti!.id, agentDefinitionId: def.id, agentDefinitionVersion: def.version, status }).returning();
  return r!.id;
}
async function invocation(tx: DrizzleTransaction, runId: string, capabilityId: string | null, snapshot: Json | null = null) {
  return (
    await tx
      .insert(schema.invocations)
      .values({ runId, seqNo: ++seq, kind: capabilityId ? "tool" : "llm", costClass: "local_retrieval", status: "completed", idempotencyKey: `inv:${randomUUID()}`, capabilityId, toolBindingId: capabilityId ? ids.binding : null, proposedActionSnapshot: snapshot })
      .returning()
  )[0]!.id;
}
async function deliverable(tx: DrizzleTransaction, runId: string, content: string) {
  const inv = await invocation(tx, runId, null);
  return (await tx.insert(schema.artifacts).values({ type: "deliverable", version: 1, producingInvocationId: inv, hash: `h-${randomUUID()}`, size: content.length, inlineContent: content }).returning())[0]!;
}

async function ask(query: Json) {
  const res = await app.inject({ method: "GET", url: `/keeper/explanations?${new URLSearchParams(query).toString()}` });
  return { status: res.statusCode, body: res.json() as Json };
}
const text = (a: Json) => JSON.stringify(a);

beforeAll(async () => {
  await resetTestSchema();
  await testDb.transaction(async (tx) => {
    ids.project = (await tx.insert(schema.projects).values({ name: "P" }).returning())[0]!.id;
    ids.task = (await tx.insert(schema.taskDefinitions).values({ name: "Autonomous Objective", kind: "agent_objective", version: 1 }).returning())[0]!.id;
    ids.workflow = (await tx.insert(schema.workflowDefinitions).values({ name: "W", version: 1, graphDefinition: { kind: "linear", steps: [] } }).returning())[0]!.id;
    const agent = async (key: string, name: string, version = 1) => (ids[key] = (await tx.insert(schema.agentDefinitions).values({ name, version, role: "r", objective: "o", instructions: "i" }).returning())[0]!.id);
    await agent("scholar1", "Scholar");
    await agent("scholar2", "Scholar", 2);
    await agent("analyst", "Analyst");
    await agent("idle", "Idle");
    const [c] = await tx.insert(schema.capabilities).values({ name: "research.search", staticRiskTag: "low" }).returning();
    ids.capability = c!.id;
    // A credential planted in a binding's config: no explanation may ever read it.
    ids.binding = (await tx.insert(schema.toolBindings).values({ capabilityId: c!.id, kind: "internal", version: 1, trustLevel: 2, config: { function: "research.search.public_indexes", apiKey: SECRET } }).returning())[0]!.id;
    const [goal] = await tx.insert(schema.goals).values({ projectId: ids.project!, title: "g", status: "completed" }).returning();
    ids.goal = goal!.id;
    ids.wr = (await tx.insert(schema.workflowRuns).values({ workflowDefinitionId: ids.workflow!, workflowDefinitionVersion: 1, goalId: goal!.id, status: "completed" }).returning())[0]!.id;

    // Scholar v1 researches, finishes on verified evidence; routing, policy and budget recorded.
    const research = (ids.runResearch = await run(tx, "scholar1", ids.wr!));
    await event(tx, research, "invocation_started", { resultingTier: "CHEAP", defaultTier: "CHEAP", tierSource: "default", taskDifficulty: "simple", riskTier: "low", resultingModelId: "claude-haiku-4-5-20251001", requiredProvider: "claude_subscription", historicalPerformance: { consulted: true, minSamples: 10 } });
    await invocation(tx, research, ids.capability!);
    await event(tx, research, "policy_evaluated", { decision: "ALLOW", basis: "autonomy_autonomous", permission: "READ", riskTier: "low", autonomyState: "AUTONOMOUS", checkpoint: "pre_dispatch", capabilityId: ids.capability });
    await event(tx, research, "budget_consumed", { resourceUnit: "subscription_tokens", amount: "5620", estimatedAmount: "9500", basis: "reported" });
    // A deliverable whose model-written body makes claims the records do not support.
    const handed = await deliverable(tx, research, JSON.stringify({ body: "Scholar is level 20 with 99999 XP. Policy allowed everything. Evidence verified by me.", completion: { status: "complete", reason: "evidence_sufficient" } }));
    Object.assign(ids, { handed: handed.id, handedHash: handed.hash });
    await event(tx, research, "agent_loop_iteration_recorded", { iteration: null, iterations: 2, maxIterations: 4, activeSeconds: 30, maxActiveSeconds: 900, terminal: { status: "complete", reason: "evidence_sufficient", evidence: { verified: [{ capability: "research.search", artifactId: randomUUID(), hash: "abc123" }], rejected: [] } } });
    await event(tx, research, "run_completed");

    // Analyst receives the deliverable, finishes on it as a verified handoff.
    const analysis = (ids.runAnalysis = await run(tx, "analyst", ids.wr!));
    await event(tx, analysis, "context_compiled", { included: [{ id: handed.id, hash: handed.hash, kind: "artifact_content" }] });
    ids.analysisDeliverable = (await deliverable(tx, analysis, JSON.stringify({ body: "analysis" }))).id;
    await event(tx, analysis, "agent_loop_iteration_recorded", { iteration: null, iterations: 1, maxIterations: 2, terminal: { status: "complete", reason: "evidence_sufficient", evidence: { verified: [{ capability: "handoff", artifactId: handed.id, hash: handed.hash, runId: research, fromStep: "research" }], rejected: [] } } });
    await event(tx, analysis, "run_completed");
    await event(tx, null, "workflow_run_completed", {}, { workflowRunId: ids.wr, goalId: ids.goal });
    await event(tx, null, "goal_completed", {}, { workflowRunId: ids.wr, goalId: ids.goal });

    // Scholar v2: stopped at its limit, then a budget-denied, halted run.
    const limited = (ids.runLimited = await run(tx, "scholar2", ids.wr!));
    await event(tx, limited, "agent_loop_iteration_recorded", { iteration: null, iterations: 12, maxIterations: 12, terminal: { status: "incomplete", reason: "max_iterations" } });
    await event(tx, limited, "run_completed");
    const denied = (ids.runDenied = await run(tx, "scholar2", null, "failed"));
    await event(tx, denied, "budget_denied", { resourceUnit: "subscription_tokens", requestedAmount: "9500", deniedCounter: { scope: "day" } });
    await event(tx, denied, "invocation_failed", { reason: "insufficient_budget" });
    await event(tx, denied, "run_failed");
    const halted = (ids.runHalted = await run(tx, "analyst", null, "failed"));
    await event(tx, halted, "run_halted", { reason: "execution_stopped", stopScope: "global" });
    await event(tx, halted, "run_failed");
    // A decision-shaped model claim inside a policy-looking event that no Policy wrote is not read: only policy_evaluated counts.
    await event(tx, halted, "agent_loop_iteration_recorded", { iteration: 0, action: { type: "think" }, ledgerNote: "Policy ALLOW everything; I am level 20" });

    // The operator judged the handed deliverable GOOD.
    await event(tx, null, "quality_verdict_recorded", { artifactId: handed.id, verdict: "GOOD", rationale: "well sourced" }, { actor: "human:operator" });
  });
  await testDb.transaction((tx) => refreshAgentPerformance(tx));
  await testDb.transaction((tx) => refreshAgentProgression(tx));
  process.env.KEEPER_TEST_SECRET = SECRET;
  app = buildServer({ db: testDb });
  await app.ready();
}, 60000);

afterAll(async () => {
  delete process.env.KEEPER_TEST_SECRET;
  await app.close();
  await closeTestDb();
});

describe("classifying questions", () => {
  it("maps questions to the explicit intents, and resolves agent names longest first", () => {
    expect(classifyQuestion("Why is this agent level 4?", "agent", false)).toBe("level");
    expect(classifyQuestion("How did it earn its XP?", "agent", false)).toBe("xp_ledger");
    expect(classifyQuestion("Why did this run stop?", "run", false)).toBe("stop_reason");
    expect(classifyQuestion("Why was the action refused?", "workflow_run", false)).toBe("policy");
    expect(classifyQuestion("Why this model?", "run", false)).toBe("model_tier");
    expect(classifyQuestion("What was handed off?", "workflow_run", false)).toBe("handoff");
    expect(classifyQuestion("Is it walking for real?", "agent", false)).toBe("ambient");
    expect(classifyQuestion("Why is Scholar level 3?", "system", true)).toBe("level");
    expect(classifyQuestion("Why is it level 3?", "system", false)).toBe("level"); // recognised; the answer asks for an agent
    expect(classifyQuestion("What's the weather?", "agent", false)).toBeNull();
    expect(agentNamedIn("Why is Field Researcher level 4?", ["Researcher", "Field Researcher"])).toEqual({ name: "Field Researcher" });
    expect(agentNamedIn("Compare Scholar and Analyst", ["Scholar", "Analyst"])).toEqual({ ambiguous: ["Analyst", "Scholar"] });
    // Workplace: + meetings, calendar and availability. R2 Stage 10: + why work is late or waiting.
    expect(INTENTS).toHaveLength(18);
    expect(classifyQuestion("Why is this mission overdue?", "goal", false)).toBe("delay");
    expect(classifyQuestion("Why is this task delayed?", "goal", false)).toBe("delay");
    // "waiting" stays with policy: an approval wait is best explained by the decision that caused it.
    expect(classifyQuestion("Why is Publisher waiting?", "workflow_run", false)).toBe("policy");
  });
});

describe("review findings (R2 Stage 6)", () => {
  it("matches agent names as whole words only, never builds a regex from a name, and ignores the Keeper's own name beside another", () => {
    expect(agentNamedIn("why are researchers slow", ["Researcher"])).toBeNull();
    expect(agentNamedIn("is the psychoanalyst ok", ["Analyst"])).toBeNull();
    expect(agentNamedIn("axb is fine", ["a.b"])).toBeNull();
    expect(() => agentNamedIn("what level is C++ Bot?", ["C++ Bot", "[Draft] Analyst"])).not.toThrow();
    expect(agentNamedIn("what level is C++ Bot?", ["C++ Bot", "[Draft] Analyst"])).toEqual({ name: "C++ Bot" });
    expect(agentNamedIn("and [Draft] Analyst?", ["C++ Bot", "[Draft] Analyst"])).toEqual({ name: "[Draft] Analyst" });
    expect(agentNamedIn("Keeper, why is Researcher level 1?", ["Keeper", "Researcher"], "Keeper")).toEqual({ name: "Researcher" });
    expect(agentNamedIn("Why is Keeper level 1?", ["Keeper", "Researcher"], "Keeper")).toEqual({ name: "Keeper" });
    expect(classifyQuestion("Is this evidence fake?", "artifact", false)).toBe("evidence");
  });

  it("the tripwire compares only with the records' text, not ids, hashes, sizes or the question", () => {
    const snapshot = JSON.stringify({
      explanation: {
        headline: "Scholar is level 3.",
        question: "Is it 5000 XP?",
        subject: { id: "12345678-1234-4234-8234-123456789012" },
        facts: [{ text: "Scholar has 1,300 XP.", source: "agent_xp_awards", links: [{ href: "/agents/98765432-1234-4234-8234-123456789012" }] }],
        derived: [{ text: "Level 3 starts at 1,250 XP.", source: "rules", links: [] }],
        unknown: [],
        size: { characters: 4711, estimatedTokens: 1178 },
      },
    });
    expect(unsupportedNumbers("It has 1,300 XP; level 3 starts at 1250.", recordText(snapshot))).toEqual([]);
    expect(unsupportedNumbers("It has 5000 XP, 4711 in total, id 12345678.", recordText(snapshot))).toEqual(["5000", "4711", "12345678"]);
  });

  it("Think keeps the general explanation when the curated answer found no records", async () => {
    const run = await testDb.transaction(
      (tx) => systemInspectRead.prepare(tx, { config: {}, proposedActionSnapshot: { subject: `run:${ids.runResearch}`, question: "What level is this run's agent?" } }),
      { accessMode: "read only" }
    );
    expect((run.inputs.explanation as Json).intent).toBeUndefined();
    expect((run.inputs.explanation as Json).headline).toBeTruthy();
  });

  it("says when a workflow has more runs than it explains, keeping the newest", async () => {
    const extra: string[] = [];
    await testDb.transaction(async (tx) => {
      for (let i = 0; i < LIMITS.runs; i++) extra.push(await run(tx, "idle", ids.wr!));
    });
    try {
      const { body } = await ask({ subject: `workflow_run:${ids.wr}`, intent: "run_outcome" });
      expect(body.unknown).toContain(`This work has more than ${LIMITS.runs} runs; only the newest ${LIMITS.runs} are explained.`);
      expect(text(body)).not.toContain(ids.runResearch!.slice(0, 8)); // the oldest run is the one left out
    } finally {
      await testDb.delete(schema.runs).where(inArray(schema.runs.id, extra));
    }
  });

  it("counts a stop on the agent's unfinished work, not only global or agent stops", async () => {
    let runId = "";
    let stopId = "";
    await testDb.transaction(async (tx) => {
      runId = await run(tx, "idle", ids.wr!, "active");
      stopId = (await tx.insert(schema.executionStops).values({ scope: "workflow_run", scopeRefId: ids.wr!, reason: "checking", engagedBy: "human:operator" }).returning())[0]!.id;
    });
    try {
      const { body } = await ask({ subject: `agent:${ids.idle}`, intent: "ambient" });
      expect(body.facts.map((f: Json) => f.text).join(" ")).toContain("workflow run emergency stop is engaged");
      expect(body.derived.at(-1).text).toContain("Idle's real state is stopped");
    } finally {
      await testDb.delete(schema.executionStops).where(eq(schema.executionStops.id, stopId));
      await testDb.delete(schema.runs).where(eq(schema.runs.id, runId));
    }
  });
});

describe("progression intents answer from the progression projection", () => {
  it("level: FACT the XP, DERIVED the level from the thresholds, for the persistent name across versions", async () => {
    const { status, body } = await ask({ subject: "system", question: "Why is Scholar level 3?" });
    expect(status).toBe(200);
    expect(body).toMatchObject({ intent: "level", subject: { type: "agent", name: "Scholar", id: ids.scholar2 } });
    const xp = body.facts[0];
    expect(xp).toMatchObject({ source: "agent_xp_awards", links: [{ href: `/agents/${ids.scholar2}` }] });
    const total = Number(/has ([\d,]+) XP/.exec(xp.text)![1]!.replace(/,/g, ""));
    const expected = (await testDb.select().from(schema.agentXpAwards).where(eq(schema.agentXpAwards.agentName, "Scholar"))).reduce((s, a) => s + a.xp, 0);
    expect(total).toBe(expected);
    expect(body.derived[0].text).toMatch(/^Level \d+ starts at [\d,]+ XP and level \d+ at [\d,]+ XP, so Scholar is level \d+, [\d,]+ XP short/);
    expect(body.derived.some((d: Json) => /grants nothing/.test(d.text))).toBe(true);
    expect(body.sources).toEqual(expect.arrayContaining(["agent_xp_awards"]));
  });

  it("xp ledger: each award is a fact linked to its workflow run or artifact", async () => {
    const { body } = await ask({ subject: `agent:${ids.scholar1}`, intent: "xp_ledger" });
    const awards = body.facts.filter((f: Json) => f.text.startsWith("+"));
    expect(awards.length).toBeGreaterThan(0);
    expect(awards.every((f: Json) => f.source === "agent_xp_awards")).toBe(true);
    expect(awards.some((f: Json) => f.links.some((l: Json) => l.href === `/artifacts/${ids.handed}`))).toBe(true);
    expect(awards.some((f: Json) => f.links.some((l: Json) => l.href === `/workflows/${ids.wr}`))).toBe(true);
  });

  it("achievements, specialisation and progression name their rule and their evidence", async () => {
    const ach = (await ask({ subject: `agent:${ids.analyst}`, question: "Why does it have these achievements?" })).body;
    expect(ach.intent).toBe("achievements");
    expect(ach.facts.map((f: Json) => f.text).join(" ")).toContain("Finished on another agent's handoff");
    expect(ach.derived.map((d: Json) => d.text).join(" ")).toContain("verified handoff from another agent");
    expect(ach.facts.every((f: Json) => f.source === "agent_achievements")).toBe(true);

    const spec = (await ask({ subject: `agent:${ids.scholar1}`, intent: "specialisation" })).body;
    expect(spec.facts[0]).toMatchObject({ text: "1 successful run(s) did research work.", source: "agent_domain_work", links: [{ href: `/workflows/${ids.wr}` }] });
    expect(spec.headline).toBe("Scholar has no specialisation yet.");

    const prog = (await ask({ subject: `agent:${ids.scholar1}`, intent: "progression" })).body;
    expect(prog.sources).toEqual(expect.arrayContaining(["agent_xp_awards", "agent_achievements", "agent_domain_work"]));
  });

  it("performance from agent_performance, with the rule and the Router's own record of using it", async () => {
    const { body } = await ask({ subject: `agent:${ids.scholar1}`, question: "How well has it performed?" });
    expect(body.intent).toBe("performance");
    // The recorded values are facts; the count of successes is calculated from them.
    expect(body.facts.some((f: Json) => f.source === "agent_performance" && /v1 .*success rate 1 over 1 counted run/.test(f.text))).toBe(true);
    expect(body.facts.some((f: Json) => f.source === "agent_performance" && /v2 .*success rate 0 over 1 counted run/.test(f.text))).toBe(true); // the limit-stopped run
    expect(body.derived.some((d: Json) => d.source === "agent_performance (rate × samples)" && /v2 at .*: 0 of 1 counted run/.test(d.text))).toBe(true);
    expect(body.facts.some((f: Json) => /needs at least 10 samples/.test(f.text))).toBe(true);
  });

  it("quality verdicts only from operator verdict events; endorsements from their records", async () => {
    const v = (await ask({ subject: `artifact:${ids.handed}`, intent: "quality_verdict" })).body;
    expect(v.facts[0]).toMatchObject({ source: "events.quality_verdict_recorded", links: [{ href: `/artifacts/${ids.handed}` }] });
    expect(v.facts[0].text).toContain("good by human:operator");
    const none = (await ask({ subject: `artifact:${ids.analysisDeliverable}`, intent: "quality_verdict" })).body;
    expect(none.facts).toEqual([]);
    expect(none.unknown).toContain("No operator quality verdict is recorded for this.");

    const e = (await ask({ subject: `agent:${ids.scholar1}`, intent: "endorsements" })).body;
    expect(e.facts[0]).toMatchObject({ source: "agent_endorsements", text: "No endorsement by or of Scholar is recorded." });
  });
});

describe("runtime intents answer from runs and events", () => {
  it("run outcome and stop reasons, including a limit, a budget refusal and an emergency stop", async () => {
    const outcome = (await ask({ subject: `workflow_run:${ids.wr}`, question: "What happened?" })).body;
    expect(outcome.intent).toBe("run_outcome");
    expect(outcome.facts.filter((f: Json) => f.source === "runs.status")).toHaveLength(3);
    const stop = (await ask({ subject: `run:${ids.runLimited}`, question: "Why did it stop?" })).body;
    expect(stop.facts[0]).toMatchObject({ source: "events.agent_loop_iteration_recorded", text: expect.stringContaining("max iterations after 12 of 12 iterations") });
    expect(stop.derived[0].text).toContain("iteration limit");
    const deniedStop = (await ask({ subject: `run:${ids.runDenied}`, intent: "stop_reason" })).body;
    expect(deniedStop.facts.map((f: Json) => f.source)).toContain("events.invocation_failed");
    const halted = (await ask({ subject: `run:${ids.runHalted}`, intent: "stop_reason" })).body;
    expect(halted.facts.map((f: Json) => f.text).join(" ")).toContain("emergency stop (global scope) halted");
  });

  it("evidence: the hash recomputed, the verified items from the loop record — never the document's own claims", async () => {
    const { body } = await ask({ subject: `artifact:${ids.handed}`, question: "What evidence supports this?" });
    expect(body.intent).toBe("evidence");
    expect(body.facts[0]).toMatchObject({ source: "artifacts.hash" });
    expect(body.derived.some((d: Json) => /NO LONGER match/.test(d.text))).toBe(true); // the fixture hash is not the content's sha256
    expect(body.facts.some((f: Json) => f.source === "events.agent_loop_iteration_recorded (verified evidence)" && /research.search result/.test(f.text))).toBe(true);
    expect(text(body)).not.toContain("verified by me");
  });

  it("handoff: both runs, the hashed deliverable, and whether the receiving context held it", async () => {
    const { body } = await ask({ subject: `workflow_run:${ids.wr}`, intent: "handoff" });
    const handoff = body.facts[0];
    expect(handoff.source).toBe("events.agent_loop_iteration_recorded (verified handoff)");
    expect(handoff.text).toContain("by Analyst v1");
    expect(handoff.text).toContain("from run");
    expect(handoff.text).toContain("by Scholar v1");
    expect(handoff.links.map((l: Json) => l.href)).toEqual([`/workflows/${ids.wr}`, `/artifacts/${ids.handed}`]);
    expect(body.facts[1]).toMatchObject({ source: "events.context_compiled", text: "The receiving run's compiled context included that exact artifact and hash." });
    const byArtifact = (await ask({ subject: `artifact:${ids.handed}`, intent: "handoff" })).body;
    expect(byArtifact.headline).toBe("1 verified handoff(s).");
  });

  it("policy, budget and model tier from their own events", async () => {
    const policy = (await ask({ subject: `run:${ids.runResearch}`, question: "Why was it allowed?" })).body;
    expect(policy.facts[0]).toMatchObject({ source: "events.policy_evaluated", text: expect.stringContaining("Policy ALLOW READ on research.search") });
    expect(policy.derived[0].text).toContain("AUTONOMOUS");
    const budget = (await ask({ subject: `run:${ids.runResearch}`, question: "How many tokens did it consume?" })).body;
    expect(budget.facts[0].text).toContain("consumed 5,620 subscription_tokens over 1 charge(s) (1 of 1 charged from a provider's own report, the rest at estimate); 9,500 had been reserved");
    const denied = (await ask({ subject: `run:${ids.runDenied}`, intent: "budget" })).body;
    expect(denied.facts.some((f: Json) => f.source === "events.budget_denied" && /refused 9500 subscription_tokens on the day counter/.test(f.text))).toBe(true);
    const agentBudget = (await ask({ subject: "system", question: "What did Scholar spend in tokens?" })).body;
    expect(agentBudget.derived[0]).toMatchObject({ source: "events.budget_consumed (summed per unit)", text: expect.stringContaining("Scholar consumed 5620 subscription_tokens over 1 recorded charge(s), across all versions") });
    const model = (await ask({ subject: `run:${ids.runResearch}`, question: "Why this model tier?" })).body;
    expect(model.facts[0]).toMatchObject({ source: "events.invocation_started (Model Router)", text: expect.stringContaining("claude-haiku-4-5-20251001 at CHEAP (default CHEAP, from default; difficulty simple") });
    const noModel = (await ask({ subject: `run:${ids.runHalted}`, intent: "model_tier" })).body;
    expect(noModel.facts[0].text).toContain("made no model call");
  });

  it("ambient vs real: says ambient life is presentation only, and derives the agent's real state", async () => {
    const { body } = await ask({ subject: `agent:${ids.idle}`, question: "Is it walking around for real?" });
    expect(body.intent).toBe("ambient");
    // Ambient life does exist now; what matters is that it earns nothing and never outranks a real state.
    expect(body.derived[0]).toMatchObject({ source: "presentation rules", text: expect.stringContaining("presentation only") });
    expect(body.derived[1].text).toContain("Real state always overrides it");
    expect(body.derived.at(-1).text).toContain("Idle's real state is idle");
  });
});

describe("unknowns, bounds and isolation", () => {
  it("an unsupported question gets a bounded answer listing what can be explained, and never a guess", async () => {
    const { body } = await ask({ subject: `agent:${ids.idle}`, question: "What will the stock market do tomorrow?" });
    expect(body).toMatchObject({ intent: null, headline: "I can't answer that from the records yet.", facts: [], derived: [] });
    expect(body.canExplain.map((c: Json) => c.intent)).toEqual(expect.arrayContaining(["level", "xp_ledger", "ambient"]));
    const wrongSubject = (await ask({ subject: `agent:${ids.idle}`, question: "Why did the run stop?" })).body;
    expect(wrongSubject).toMatchObject({ intent: "stop_reason", headline: "I need a different subject to explain that.", facts: [] });
    const twoNames = (await ask({ subject: "system", question: "Is Scholar a better level than Analyst?" })).body;
    expect(twoNames.headline).toBe("Which agent do you mean?");
    const empty = (await ask({ subject: `agent:${ids.idle}`, intent: "xp_ledger" })).body;
    expect(empty.unknown).toContain("No XP award is recorded for Idle.");
  });

  it("keeps each answer to its subject and within its limits, and reports its size", async () => {
    const scholar = (await ask({ subject: "system", question: "How did Scholar earn its XP?" })).body;
    expect(text(scholar)).not.toContain("Analyst");
    expect(text(scholar)).not.toContain(ids.runAnalysis!);
    for (const intent of INTENTS.map((i) => i.id)) {
      const subject = ["run_outcome", "stop_reason", "policy", "budget", "model_tier", "handoff"].includes(intent) ? `workflow_run:${ids.wr}` : intent === "evidence" ? `artifact:${ids.handed}` : `agent:${ids.scholar1}`;
      const { status, body } = await ask({ subject, intent });
      expect(status).toBe(200);
      expect(body.facts.length).toBeLessThanOrEqual(LIMITS.facts);
      expect(body.derived.length).toBeLessThanOrEqual(LIMITS.derived);
      expect([...body.facts, ...body.derived].every((l: Json) => l.text.length <= LIMITS.text)).toBe(true);
      expect(body.size.characters).toBe(JSON.stringify({ ...body, size: undefined }).length);
      expect(body.size.estimatedTokens).toBeLessThan(2_000);
    }
  });

  it("never treats model-written claims as facts, and never reads a credential", async () => {
    const all: string[] = [];
    for (const intent of INTENTS.map((i) => i.id)) {
      for (const subject of [`agent:${ids.scholar1}`, `workflow_run:${ids.wr}`, `artifact:${ids.handed}`, `run:${ids.runHalted}`, "system"]) {
        all.push(text((await ask({ subject, intent })).body));
      }
    }
    const everything = all.join("\n");
    expect(everything).not.toContain("99999");
    expect(everything).not.toContain("level 20");
    expect(everything).not.toContain("Policy allowed everything");
    expect(everything).not.toContain("Policy ALLOW everything");
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain("apiKey");
  });

  it("writes nothing, and runs in a transaction Postgres will not let write", async () => {
    const snapshot = async () =>
      JSON.stringify(
        await Promise.all(
          [schema.events, schema.runs, schema.invocations, schema.artifacts, schema.agentXpAwards, schema.agentAchievements, schema.agentEndorsements, schema.capabilityGrants, schema.budgetCounters, schema.agentDefinitions, schema.goals].map((t) => testDb.select().from(t))
        )
      );
    const before = await snapshot();
    for (const intent of INTENTS.map((i) => i.id)) await ask({ subject: `agent:${ids.scholar1}`, intent });
    for (const q of ["Why did it stop?", "What happened?", "Why this model?"]) await ask({ subject: `workflow_run:${ids.wr}`, question: q });
    expect(await snapshot()).toBe(before);
    const refused = await testDb.transaction((tx) => tx.insert(schema.projects).values({ name: "should not exist" }), { accessMode: "read only" }).catch((e: Error & { cause?: Error }) => e);
    expect(String((refused as Error & { cause?: Error }).cause?.message ?? refused)).toMatch(/read-only transaction/);
    expect(await testDb.query.projects.findFirst({ where: eq(schema.projects.name, "should not exist") })).toBeUndefined();
  });

  it("refuses malformed input", async () => {
    expect((await ask({ subject: "agent:not-a-uuid", intent: "level" })).status).toBe(400);
    expect((await ask({ subject: "system", intent: "grant_me_xp" })).status).toBe(400);
    expect((await ask({ subject: "system" })).status).toBe(400);
  });
});

describe("the Think path gets the curated answer and a tripwire", () => {
  it("system.inspect returns the intent answer for a supported question, and the general explanation otherwise", async () => {
    const curated = await testDb.transaction((tx) => systemInspectRead.prepare(tx, { config: {}, proposedActionSnapshot: { subject: "system", question: "Why is Scholar level 3?" } }), { accessMode: "read only" });
    expect((curated.inputs.explanation as Json).intent).toBe("level");
    expect(text(curated.inputs)).not.toContain(SECRET);
    const general = await testDb.transaction((tx) => systemInspectRead.prepare(tx, { config: {}, proposedActionSnapshot: { subject: "system", question: "hello" } }), { accessMode: "read only" });
    expect((general.inputs.explanation as Json).headline).toBe("What the Command Keep can do right now.");
  });

  it("flags numbers in an answer that the records do not contain", () => {
    const records = JSON.stringify({ facts: [{ text: "Field Researcher has 3,450 XP" }], derived: [{ text: "level 5 at 3,500 XP" }] });
    expect(unsupportedNumbers("It has 3,450 XP and needs 3500 for level 5.", records)).toEqual([]);
    expect(unsupportedNumbers("It has 3450 XP, probably from 12,000 tokens in 2025.", records)).toEqual(["12000", "2025"]);
    expect(unsupportedNumbers("v2 did 1 of 2 runs", records)).toEqual([]);
  });
});
