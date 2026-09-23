/**
 * V1.1 autonomous agents (`agent_objective`) through the real HTTP API, Interpreter,
 * Executor, Router, Compiler, Policy, Budget Governor and stops. Every model call is a
 * scripted mock; no provider is reached.
 *
 * Proves: multiple agent-chosen iterations; explicit finish stops the remaining planned
 * iterations (R1); the iteration ceiling, active-time limit and budget headroom end the
 * loop with a recorded reason; refusals (not allowed, over the call limit, no Grant, bad
 * intent) are recorded and the loop continues; Policy, Approvals and stops stay
 * authoritative; no automatic retry; exact Agent version attribution; compact context;
 * R4 events; a readable deliverable with its evidence basis.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeTestDb, resetTestSchema, testDb } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import { seedPublishWorkflow, seedV11Definitions, type SeedPublishWorkflowResult } from "../../src/definitions/seed.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { callClaudeSubscriptionModel } from "../../src/router/providers/claudeSubscription.js";
import { callAnthropicModel } from "../../src/router/providers/anthropic.js";
import { buildServer } from "../../src/api/server.js";
import { engageStop } from "../../src/governance/executionStop.js";
import {
  computeActiveSeconds,
  carriesRecordedEvidence,
  decisionSchema,
  effectiveLimits,
  parseDecision,
  parseObjectiveParameters,
  positions,
} from "../../src/capabilities/agentObjective/buildInvocationSpecs.js";
import { loopActionFor, parseLoopActionInput } from "../../src/capabilities/shared/loopActions.js";
import { refreshAgentPerformance } from "../../src/projections/agentPerformance.js";
import { refreshAgentProgression } from "../../src/projections/agentProgression.js";
import { createHash, randomUUID } from "node:crypto";

let app: FastifyInstance;
let seed: SeedPublishWorkflowResult;
let ids: { objectiveTask: string; researchCapability: string; publishCapability: string; checkpointCapability: string; webCapability: string };

// ---------------------------------------------------------------------------
// Scripted model
// ---------------------------------------------------------------------------

type Kind = "decide" | "work" | "deliverable" | "web";
type Script = {
  decisions: Record<string, unknown>[];
  usage?: (kind: Kind, n: number) => number;
  before?: (kind: Kind, n: number) => Promise<void>;
  fail?: (kind: Kind, n: number) => boolean;
  /** The body the n-th deliverable write returns, when a test needs a document of a particular size. */
  deliverableBody?: (n: number) => string;
};
let script: Script = { decisions: [] };
let calls: { decide: number; work: number; deliverable: number; web: number } = { decide: 0, work: 0, deliverable: 0, web: 0 };

const think = (intent: string, instruction = "work on it") => ({
  assessment: "progressing",
  done: false,
  action: { type: "think", intent, capability: "", input: { query: "" }, instruction, useArtifacts: [] },
  ledgerNote: `${intent} next`,
});
const tool = (capability: string, input: Record<string, unknown>) => ({
  assessment: "need evidence",
  done: false,
  action: { type: "tool", intent: "", capability, input, instruction: "", useArtifacts: [] },
  ledgerNote: `use ${capability}`,
});
const gate = (question: string) => ({
  assessment: "unsure",
  done: false,
  action: { type: "gate", intent: "", capability: "", input: { query: "" }, instruction: question, useArtifacts: [] },
  ledgerNote: "ask the operator",
});
const finish = () => ({
  assessment: "objective met",
  done: true,
  action: { type: "finish", intent: "", capability: "", input: { query: "" }, instruction: "", useArtifacts: [] },
  ledgerNote: "done",
});

/** A finish that cites results as the evidence its criteria are met (R2 Stage 4). */
const finishCiting = (evidence: string[]) => ({ ...finish(), assessment: "the criteria are met by the cited results", evidence });

/** The result artifact the loop recorded for its latest completed iteration. */
async function latestResultId(): Promise<string> {
  const events = await testDb.query.events.findMany({ where: eq(schema.events.eventType, "agent_loop_iteration_recorded") });
  const withResult = events.filter((e) => typeof (e.payload as { resultArtifactId?: unknown }).resultArtifactId === "string");
  return (withResult.sort((a, b) => b.globalSeq - a.globalSeq)[0]!.payload as { resultArtifactId: string }).resultArtifactId;
}

function installModel() {
  vi.mocked(callClaudeSubscriptionModel).mockImplementation(async (_model, _ctx, shape) => {
    const props = (shape as { properties?: Record<string, unknown> }).properties ?? {};
    // A live-web search asks for its own shape (an answer, when it was true, and sources).
    const kind: Kind = "action" in props ? "decide" : "asOfDate" in props ? "web" : "keyPoints" in props ? "work" : "deliverable";
    const n = ++calls[kind];
    await script.before?.(kind, n);
    if (script.fail?.(kind, n)) throw Object.assign(new Error("provider timed out"), { code: "timeout" });
    const amount = script.usage?.(kind, n) ?? 400;
    const usage = { tokensIn: amount - 100, tokensOut: 100, costAmount: amount, costUnit: "subscription_tokens" as const };
    if (kind === "decide") return { result: script.decisions[n - 1] ?? finish(), usage };
    if (kind === "web") {
      return {
        result: {
          answer: "The current release is 2.1.273.",
          asOfDate: "2026-09-16",
          findings: ["published earlier today"],
          sources: [{ url: "https://example.org/releases", title: "Release notes" }],
        },
        // What the provider reports about the search it performed, as the real adapter does.
        usage: {
          ...usage,
          toolActivity: { webSearchRequests: 2, queries: ["current release version"], sources: [{ url: "https://example.org/releases", title: "Release notes" }] },
        },
      };
    }
    if (kind === "work") return { result: { summary: `result ${n}`, content: `## Result ${n}\n\n- point`, keyPoints: ["point"] }, usage };
    return {
      result: { title: "AI automation opportunities", summary: "Three candidates.", body: script.deliverableBody?.(n) ?? "## Candidates\n\n| Idea | Fit |\n| --- | --- |\n| Invoicing | high |", findings: ["f"], recommendations: ["r"], sources: [] },
      usage,
    };
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function post(url: string, payload: unknown) {
  const res = await app.inject({ method: "POST", url, payload: payload as Record<string, unknown> });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

let seq = 0;
async function objectiveWorkflow(options: {
  autonomy?: string;
  parameters?: Record<string, unknown>;
  profile?: Record<string, unknown>;
  withCheckpoint?: boolean;
  withResearchGrant?: boolean;
  withWebGrant?: boolean;
}) {
  const name = `Architect-${++seq}`;
  const grants = [
    ...(options.withResearchGrant === false ? [] : [{ capabilityId: ids.researchCapability, permissions: ["READ"], autonomyState: options.autonomy ?? "AUTONOMOUS", maxTrustLevelRequired: 1 }]),
    ...(options.withCheckpoint ? [{ capabilityId: ids.checkpointCapability, permissions: ["EXECUTE"], autonomyState: "ALWAYS_APPROVE", maxTrustLevelRequired: 1 }] : []),
    ...(options.withWebGrant ? [{ capabilityId: ids.webCapability, permissions: ["READ"], autonomyState: "AUTONOMOUS", maxTrustLevelRequired: 1 }] : []),
  ];
  const agent = await post("/agent-definitions", {
    name,
    role: "Idea Architect",
    objective: "Develop opportunities",
    instructions: "Explore, challenge, decide.",
    ...(options.profile ? { executionProfile: options.profile } : {}),
    grants,
  });
  expect(agent.status).toBe(201);
  const workflow = await post("/workflow-definitions", {
    name: `${name} objective`,
    graphDefinition: {
      kind: "linear",
      steps: [
        {
          stepId: "objective",
          label: "Work on the objective",
          taskDefinitionId: ids.objectiveTask,
          taskDefinitionVersion: 1,
          agentDefinitionId: agent.body.id,
          agentDefinitionVersion: 1,
          parameters: options.parameters ?? { intents: ["brainstorm", "analyse"], tools: [{ capability: "research.retrieve", maxCalls: 2 }] },
        },
      ],
    },
  });
  expect(workflow.status).toBe(201);
  return { agentId: agent.body.id as string, workflowId: workflow.body.id as string };
}

async function startGoal(workflowId: string, title = "Find AI automation opportunities for small businesses") {
  const res = await post("/goals", { title, workflowDefinitionId: workflowId, projectId: seed.projectId });
  expect(res.status).toBe(201);
  return res.body as { goalId: string; workflowRunId: string; status: string };
}

async function runOf(workflowRunId: string) {
  const wr = await testDb.query.workflowRuns.findFirst({ where: eq(schema.workflowRuns.id, workflowRunId) });
  const [taskInstanceId] = (wr!.variables as { stepTaskInstanceIds: string[] }).stepTaskInstanceIds;
  const runs = await testDb.query.runs.findMany({ where: eq(schema.runs.taskInstanceId, taskInstanceId!) });
  const run = runs[0]!;
  const invocations = await testDb.query.invocations.findMany({ where: eq(schema.invocations.runId, run.id), orderBy: asc(schema.invocations.seqNo) });
  const events = await testDb.query.events.findMany({ where: eq(schema.events.runId, run.id), orderBy: asc(schema.events.sequenceNo) });
  const loopEvents = events.filter((e) => e.eventType === "agent_loop_iteration_recorded");
  const deliverable = (
    await testDb
      .select({ artifact: schema.artifacts })
      .from(schema.artifacts)
      .innerJoin(schema.invocations, eq(schema.artifacts.producingInvocationId, schema.invocations.id))
      .where(and(eq(schema.invocations.runId, run.id), eq(schema.artifacts.type, "deliverable")))
  )[0]?.artifact;
  return { workflowRun: wr!, runs, run, invocations, events, loopEvents, deliverable, content: deliverable ? JSON.parse(deliverable.inlineContent!) : null };
}

beforeAll(async () => {
  await resetTestSchema();
  seed = await testDb.transaction((tx) => seedPublishWorkflow(tx));
  await testDb.transaction((tx) => seedV11Definitions(tx));
  const cap = async (name: string) => (await testDb.query.capabilities.findFirst({ where: eq(schema.capabilities.name, name) }))!.id;
  ids = {
    objectiveTask: (await testDb.query.taskDefinitions.findFirst({ where: eq(schema.taskDefinitions.name, "Autonomous Objective") }))!.id,
    researchCapability: await cap("research.retrieve"),
    publishCapability: await cap("publish.report"),
    checkpointCapability: await cap("review.checkpoint"),
    webCapability: await cap("research.web"),
  };
  app = buildServer({ db: testDb });
  await app.ready();
  installModel();
}, 30000);

afterEach(() => {
  script = { decisions: [] };
  calls = { decide: 0, work: 0, deliverable: 0, web: 0 };
  vi.useRealTimers();
});

afterAll(async () => {
  await app.close();
  await closeTestDb();
});

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

describe("bounded autonomy rules", () => {
  it("limits come from the operator's ceilings and can only be lowered", () => {
    expect(effectiveLimits({}, {})).toEqual({ maxIterations: 12, maxActiveSeconds: 900 });
    expect(effectiveLimits({ maxIterations: 5 }, { loop: { maxIterations: 8, maxActiveSeconds: 300 } })).toEqual({ maxIterations: 5, maxActiveSeconds: 300 });
    expect(parseObjectiveParameters({ loop: { maxIterations: 13 }, intents: ["plan"] })).toMatchObject({ ok: false });
    expect(parseObjectiveParameters({ intents: ["plan"], tools: [{ capability: "publish.report", maxCalls: 1 }] })).toMatchObject({ ok: false });
    expect(parseObjectiveParameters({ intents: [] })).toMatchObject({ ok: false });
    expect(parseObjectiveParameters({ intents: ["hack"] })).toMatchObject({ ok: false });
  });

  it("approval waits do not count toward active execution time", () => {
    const start = new Date("2031-01-01T10:00:00Z");
    const now = new Date("2031-01-01T11:00:00Z");
    expect(computeActiveSeconds(start, [], now)).toBe(3600);
    expect(computeActiveSeconds(start, [{ createdAt: new Date("2031-01-01T10:05:00Z"), resolvedAt: new Date("2031-01-01T10:55:00Z") }], now)).toBe(600);
    // A wait still open at `now` counts as waiting up to now.
    expect(computeActiveSeconds(start, [{ createdAt: new Date("2031-01-01T10:10:00Z"), resolvedAt: null }], now)).toBe(600);
  });

  it("a decision can only fill a loop action's declared fields: Policy's risk inputs are unreachable", () => {
    const action = loopActionFor("research.retrieve")!;
    expect(parseLoopActionInput(action, { query: "invoicing" })).toEqual({ ok: true, input: { query: "invoicing" } });
    expect(parseLoopActionInput(action, { query: "x", amountOrScope: 1, isNovelAction: false })).toMatchObject({ ok: false });
    expect(action.toSnapshot({ query: "x" })).toEqual({ query: "x" });
    expect(parseDecision({ action: { type: "self_promote" } })).toMatchObject({ ok: false });
    // The decision schema itself only admits the step's allowed actions.
    const schema = decisionSchema({ intents: ["brainstorm"], tools: ["research.retrieve"] }) as { properties: { action: { properties: Record<string, { enum?: string[] }> } } };
    expect(schema.properties.action.properties.intent!.enum).toEqual(["brainstorm", ""]);
    expect(schema.properties.action.properties.capability!.enum).toEqual(["research.retrieve", ""]);
  });
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

describe("an autonomous agent works on an objective", () => {
  it("chooses several governed actions, finishes, stops the remaining iterations and produces a deliverable", async () => {
    const { agentId, workflowId } = await objectiveWorkflow({});
    script = { decisions: [think("brainstorm"), tool("research.retrieve", { query: "small business admin pain points" }), think("analyse"), finish()] };
    const started = await startGoal(workflowId);
    expect(started.status).toBe("completed");

    const r = await runOf(started.workflowRunId);
    const N = 12;
    expect(r.runs).toHaveLength(1);
    expect(r.run).toMatchObject({ status: "completed", agentDefinitionId: agentId, agentDefinitionVersion: 1, attempt: 1 });

    // Four iterations ran; iteration 4's act was skipped by the finish; iterations 5..12 never happened (R1).
    const bySeq = new Map(r.invocations.map((i) => [i.seqNo, i]));
    expect([1, 2, 3].map((s) => bySeq.get(s)?.kind)).toEqual(["llm", "llm", "deterministic"]);
    expect([4, 5, 6].map((s) => bySeq.get(s)?.kind)).toEqual(["llm", "tool", "deterministic"]);
    expect([7, 8, 9].map((s) => bySeq.get(s)?.kind)).toEqual(["llm", "llm", "deterministic"]);
    expect(bySeq.get(positions.decide(4))?.kind).toBe("llm");
    expect(bySeq.has(positions.act(4))).toBe(false);
    expect(bySeq.get(positions.record(4))?.kind).toBe("deterministic");
    for (let s = positions.decide(5); s <= positions.record(N); s++) expect(bySeq.has(s)).toBe(false);
    expect([positions.conclude(N), positions.write(N), positions.persist(N)].map((s) => bySeq.get(s)?.kind)).toEqual(["deterministic", "llm", "deterministic"]);
    expect(r.invocations.every((i) => i.status === "completed")).toBe(true);
    expect(calls).toEqual({ decide: 4, work: 2, deliverable: 1, web: 0 });

    // The tool went through the governance chain with a snapshot holding only the declared field.
    const toolInvocation = bySeq.get(5)!;
    expect(toolInvocation.proposedActionSnapshot).toEqual({ query: "small business admin pain points" });
    expect(r.events.filter((e) => e.eventType === "policy_evaluated" && e.invocationId === toolInvocation.id).length).toBeGreaterThan(0);

    // R4: one event per iteration, then the terminal one; structured, no prompt text.
    expect(r.loopEvents.map((e) => (e.payload as { iteration: number | null }).iteration)).toEqual([1, 2, 3, 4, null]);
    expect(r.loopEvents[1]!.payload).toMatchObject({ action: { type: "tool", capability: "research.retrieve" }, outcome: { status: "completed" }, maxIterations: 12 });
    expect(r.loopEvents[3]!.payload).toMatchObject({ action: { type: "finish" }, outcome: { status: "finished" }, finished: true });
    expect(r.loopEvents[4]!.payload).toMatchObject({ terminal: { status: "complete", reason: "agent_finished" }, iterations: 4 });
    const sequence = r.loopEvents.map((e) => e.sequenceNo);
    expect([...sequence].sort((a, b) => a - b)).toEqual(sequence);

    // Compact context: the 4th decision saw the latest ledger, not a transcript of earlier outputs.
    const ledger3 = await testDb.query.artifacts.findFirst({ where: eq(schema.artifacts.producingInvocationId, bySeq.get(positions.record(3))!.id) });
    const decide4 = r.events.find((e) => e.eventType === "context_compiled" && e.invocationId === bySeq.get(positions.decide(4))!.id)!;
    const included = (decide4.payload as { included: { id: string; kind: string; trusted: boolean }[] }).included.filter((x) => x.kind !== "task_state");
    expect(included.map((x) => x.id)).toEqual([ledger3!.id]);
    expect(included[0]!.trusted).toBe(false);
    expect(JSON.parse(ledger3!.inlineContent!)).toMatchObject({ format: "agent_ledger/v1", iteration: 3, entries: [{ iteration: 1 }, { iteration: 2 }, { iteration: 3 }] });

    // The deliverable: readable document, completion and an honest evidence basis.
    expect(r.content).toMatchObject({ format: "deliverable/v1", title: "AI automation opportunities", completion: { status: "complete", reason: "agent_finished" } });
    expect(r.content.basis).toMatchObject({ externalResearch: false, evidence: [{ capability: "research.retrieve", evidenceClass: "fixture", calls: 1 }] });
    expect(r.workflowRun.status).toBe("completed");
    expect(callAnthropicModel).not.toHaveBeenCalled();
  });

  it("treats a decision that says the objective is met as a finish, without buying another iteration", async () => {
    const { workflowId } = await objectiveWorkflow({});
    // The agent marks the objective met while still naming a further action: the loop must
    // not pay for an iteration the agent has already said it does not need (R2 Stage 1).
    script = { decisions: [think("brainstorm"), { ...think("analyse"), done: true }, think("analyse")] };
    const started = await startGoal(workflowId);

    const r = await runOf(started.workflowRunId);
    expect(calls.decide).toBe(2);
    expect(r.loopEvents.at(-1)!.payload).toMatchObject({ terminal: { status: "complete", reason: "agent_finished" }, iterations: 2 });
    expect(r.content.completion).toMatchObject({ status: "complete", reason: "agent_finished", evidence: { verified: [] } });
  });

  it("searches the live web as a governed model call, carrying only the tool its Grant authorized", async () => {
    const { workflowId } = await objectiveWorkflow({
      withWebGrant: true,
      parameters: { intents: ["analyse"], tools: [{ capability: "research.web", maxCalls: 1 }] },
    });
    script = { decisions: [tool("research.web", { query: "what is the current release" }), finish()] };
    const started = await startGoal(workflowId);

    const r = await runOf(started.workflowRunId);
    // The work ran as an LLM Invocation, not a Tool Invocation: there is no binding to run,
    // because the search happens inside the model call. It still names the Capability.
    const act = r.invocations.find((i) => i.seqNo === positions.act(1))!;
    expect(act.kind).toBe("llm");
    expect(act.capabilityId).toBe(ids.webCapability);
    expect(calls.web).toBe(1);

    // Governed exactly like a tool use: one Policy decision, recorded against the Capability.
    const decisions = r.events.filter((e) => e.eventType === "policy_evaluated" && (e.payload as { capabilityId?: string }).capabilityId === ids.webCapability);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.payload).toMatchObject({ decision: "ALLOW", toolBindingId: null });
    expect(r.loopEvents[0]!.payload).toMatchObject({ action: { type: "tool", capability: "research.web" }, outcome: { status: "completed" } });
    // The deliverable must record that a live web search informed it. A capability whose
    // work happens inside a model call has no tool binding, so it would otherwise be
    // invisible to the evidence basis and the document would under-report its own evidence.
    expect(r.content.basis).toMatchObject({ externalResearch: true, evidence: [{ capability: "research.web", evidenceClass: "external", calls: 1 }] });

    // The search itself is visible in the event log: which Invocation searched, what it
    // asked, and which sources came back. Without this the search leaves no trace at all.
    const completed = r.events.find((e) => e.eventType === "invocation_completed" && e.invocationId === act.id)!;
    expect(completed.payload).toMatchObject({
      toolActivity: { webSearchRequests: 2, queries: ["current release version"], sources: [{ url: "https://example.org/releases", title: "Release notes" }] },
    });
  });

  it("refuses a live-web search once its Grant is revoked, and keeps working", async () => {
    // Saving the workflow already requires the Grant (R3), so the Grant is revoked after the
    // save: the loop must refuse the search at run time rather than reaching the provider.
    const { workflowId, agentId } = await objectiveWorkflow({
      withWebGrant: true,
      withResearchGrant: false,
      parameters: { intents: ["analyse"], tools: [{ capability: "research.web", maxCalls: 1 }] },
    });
    const grant = await testDb.query.capabilityGrants.findFirst({ where: eq(schema.capabilityGrants.agentDefinitionId, agentId) });
    script = {
      decisions: [tool("research.web", { query: "what is the current release" }), think("analyse"), finish()],
      before: async (kind, n) => {
        if (kind === "decide" && n === 1) await app.inject({ method: "POST", url: `/capability-grants/${grant!.id}/revoke` });
      },
    };
    const started = await startGoal(workflowId);

    const r = await runOf(started.workflowRunId);
    // No model call was made for the search, and the loop carried on to its next action.
    expect(calls.web).toBe(0);
    expect(r.loopEvents[0]!.payload).toMatchObject({ action: { type: "tool", capability: "research.web" }, outcome: { status: "refused" } });
    expect(r.loopEvents[1]!.payload).toMatchObject({ action: { type: "think", intent: "analyse" }, outcome: { status: "completed" } });
    expect(r.workflowRun.status).toBe("completed");
  });

  it("finishes deliberately on evidence it cites, and records what code verified", async () => {
    const { workflowId } = await objectiveWorkflow({});
    script = {
      decisions: [tool("research.retrieve", { query: "small business admin pain points" }), finish()],
      // The citation is decided once the result exists, exactly as a model would read its id from the ledger.
      before: async (kind, n) => {
        if (kind === "decide" && n === 2) script.decisions[1] = finishCiting([await latestResultId()]);
      },
    };
    const started = await startGoal(workflowId);

    const r = await runOf(started.workflowRunId);
    const terminal = r.loopEvents.at(-1)!.payload as { terminal: { status: string; reason: string; evidence: { verified: unknown[]; rejected: unknown[]; claim: string } } };
    expect(terminal.terminal).toMatchObject({ status: "complete", reason: "evidence_sufficient", evidence: { rejected: [], claim: "the criteria are met by the cited results" } });
    expect(terminal.terminal.evidence.verified).toEqual([{ artifactId: expect.any(String), hash: expect.stringMatching(/^[0-9a-f]{64}$/), capability: "research.retrieve", iteration: 1, runId: r.run.id }]);
    // The deliverable carries the same record, so the document says why it is finished.
    expect(r.content.completion).toEqual({ status: "complete", reason: "evidence_sufficient", evidence: terminal.terminal.evidence });
  });

  it("does not count a finish as evidence-based when what it cites cannot be verified", async () => {
    const { workflowId } = await objectiveWorkflow({});
    const invented = "00000000-0000-4000-8000-000000000000";
    script = { decisions: [tool("research.retrieve", { query: "anything" }), finishCiting([invented])] };
    const started = await startGoal(workflowId);

    const r = await runOf(started.workflowRunId);
    // Still the agent's own decision, and recorded as one — but never as evidence-based.
    expect(r.loopEvents.at(-1)!.payload).toMatchObject({ terminal: { status: "complete", reason: "agent_finished", evidence: { verified: [], rejected: [invented] } } });
    expect(r.content.completion.reason).not.toBe("evidence_sufficient");
  });

  it("never presents a limit as a finish, whatever the agent claimed along the way", async () => {
    const { workflowId } = await objectiveWorkflow({ parameters: { loop: { maxIterations: 1 }, intents: ["analyse"], tools: [{ capability: "research.retrieve", maxCalls: 1 }] } });
    script = { decisions: [tool("research.retrieve", { query: "anything" })] };
    const started = await startGoal(workflowId);

    const r = await runOf(started.workflowRunId);
    const terminal = (r.loopEvents.at(-1)!.payload as { terminal: Record<string, unknown> }).terminal;
    expect(terminal).toEqual({ status: "incomplete", reason: "max_iterations" });
    expect(r.content.completion).toEqual({ status: "incomplete", reason: "max_iterations" });
  });

  it("stops at its iteration ceiling and says so", async () => {
    const { workflowId } = await objectiveWorkflow({ parameters: { loop: { maxIterations: 2 }, intents: ["brainstorm"] } });
    script = { decisions: [think("brainstorm"), think("brainstorm"), think("brainstorm")] };
    const started = await startGoal(workflowId);
    const r = await runOf(started.workflowRunId);
    expect(calls.decide).toBe(2);
    expect(r.loopEvents.at(-1)!.payload).toMatchObject({ terminal: { status: "incomplete", reason: "max_iterations" }, iterations: 2 });
    expect(r.content.completion).toEqual({ status: "incomplete", reason: "max_iterations" });
    expect(r.run.status).toBe("completed");
  });

  it("records what it may not do as refusals and keeps working: not allowed, bad intent, over the call limit, no Grant", async () => {
    const { workflowId, agentId } = await objectiveWorkflow({ parameters: { intents: ["brainstorm"], tools: [{ capability: "research.retrieve", maxCalls: 1 }] } });
    // The Grant is revoked after the workflow was saved: the loop must refuse the tool at run time.
    const grant = await testDb.query.capabilityGrants.findFirst({ where: eq(schema.capabilityGrants.agentDefinitionId, agentId) });
    script = {
      decisions: [
        tool("publish.report", { query: "" }),
        think("critique"),
        tool("research.retrieve", { query: "first" }),
        tool("research.retrieve", { query: "second" }),
        finish(),
      ],
      before: async (kind, n) => {
        if (kind === "decide" && n === 4) await app.inject({ method: "POST", url: `/capability-grants/${grant!.id}/revoke` });
      },
    };
    const started = await startGoal(workflowId);
    const r = await runOf(started.workflowRunId);
    const outcomes = r.loopEvents.slice(0, -1).map((e) => (e.payload as { outcome: { status: string; reason?: string } }).outcome);
    expect(outcomes[0]).toMatchObject({ status: "refused", reason: expect.stringContaining("not an allowed action") });
    expect(outcomes[1]).toMatchObject({ status: "refused", reason: expect.stringContaining("not allowed") });
    expect(outcomes[2]).toMatchObject({ status: "completed" });
    expect(outcomes[3]).toMatchObject({ status: "refused", reason: expect.stringMatching(/already used 1 of 1|no Grant/) });
    expect(r.invocations.filter((i) => i.kind === "tool")).toHaveLength(1);
    expect(r.run.status).toBe("completed");
  });

  it("an approval-gated tool pauses the loop until a human approves, then the loop continues", async () => {
    const { workflowId } = await objectiveWorkflow({ autonomy: "ALWAYS_APPROVE" });
    script = { decisions: [tool("research.retrieve", { query: "pricing" }), finish()] };
    const started = await startGoal(workflowId);
    expect(started.status).toBe("in_progress");
    const pending = await testDb
      .select({ approval: schema.approvals })
      .from(schema.approvals)
      .innerJoin(schema.invocations, eq(schema.approvals.invocationId, schema.invocations.id))
      .innerJoin(schema.runs, eq(schema.invocations.runId, schema.runs.id))
      .where(and(eq(schema.approvals.status, "pending"), eq(schema.runs.status, "awaiting_approval")));
    expect(pending).toHaveLength(1);
    expect(pending[0]!.approval.proposedActionSnapshot).toEqual({ query: "pricing" });
    expect(calls.decide).toBe(1);

    const approved = await app.inject({ method: "POST", url: `/approvals/${pending[0]!.approval.id}/approve` });
    expect(approved.json()).toMatchObject({ approvalStatus: "approved", workflowStatus: "completed" });
    const r = await runOf(started.workflowRunId);
    expect(calls.decide).toBe(2);
    expect(r.content.completion).toMatchObject({ status: "complete", reason: "agent_finished", evidence: { verified: [] } });
  });

  it("the agent can ask the operator through an approval gate; a rejection ends the run", async () => {
    const { workflowId } = await objectiveWorkflow({ withCheckpoint: true, parameters: { intents: ["brainstorm"], escalateWhen: "unsure about scope" } });
    script = { decisions: [gate("Should I include regulated industries?")] };
    const started = await startGoal(workflowId);
    expect(started.status).toBe("in_progress");
    const [row] = await testDb
      .select({ approval: schema.approvals })
      .from(schema.approvals)
      .innerJoin(schema.invocations, eq(schema.approvals.invocationId, schema.invocations.id))
      .where(eq(schema.approvals.status, "pending"));
    expect(row!.approval.proposedActionSnapshot).toMatchObject({ question: "Should I include regulated industries?" });
    const rejected = await app.inject({ method: "POST", url: `/approvals/${row!.approval.id}/reject` });
    expect(rejected.json()).toMatchObject({ approvalStatus: "rejected", workflowStatus: "failed" });
    const r = await runOf(started.workflowRunId);
    expect(r.runs).toHaveLength(1);
  });

  it("an emergency stop halts the loop at the next boundary", async () => {
    const { workflowId } = await objectiveWorkflow({});
    script = {
      decisions: [think("brainstorm"), think("analyse"), finish()],
      before: async (kind, n) => {
        if (kind === "work" && n === 1) {
          const wr = await testDb.query.workflowRuns.findFirst({ orderBy: (w, { desc }) => desc(w.createdAt) });
          await testDb.transaction((tx) => engageStop(tx, { scope: "workflow_run", scopeRefId: wr!.id, reason: "operator test" }));
        }
      },
    };
    const started = await startGoal(workflowId);
    expect(started.status).toBe("failed");
    const r = await runOf(started.workflowRunId);
    expect(r.events.map((e) => e.eventType)).toContain("run_halted");
    expect(calls.decide).toBe(1);
    expect(r.deliverable).toBeUndefined();
  });

  it("ends cleanly when the budget has no headroom for another iteration", async () => {
    const { workflowId } = await objectiveWorkflow({});
    script = { decisions: [think("brainstorm"), think("analyse"), finish()], usage: (kind, n) => (kind === "work" && n === 1 ? 32_000 : 400) };
    const started = await startGoal(workflowId);
    const r = await runOf(started.workflowRunId);
    expect(calls.decide).toBe(1);
    expect(r.content.completion).toEqual({ status: "incomplete", reason: "budget_headroom" });
    expect(r.run.status).toBe("completed");
  });

  it("ends cleanly when its active time is used up", async () => {
    const { workflowId } = await objectiveWorkflow({ parameters: { loop: { maxActiveSeconds: 60 }, intents: ["brainstorm"] } });
    vi.useFakeTimers({ toFake: ["Date"], now: new Date() });
    script = {
      decisions: [think("brainstorm"), think("brainstorm"), finish()],
      before: async (kind, n) => {
        if (kind === "work" && n === 1) vi.setSystemTime(new Date(Date.now() + 5 * 60_000));
      },
    };
    const started = await startGoal(workflowId);
    vi.useRealTimers();
    const r = await runOf(started.workflowRunId);
    expect(calls.decide).toBe(1);
    expect(r.content.completion).toEqual({ status: "incomplete", reason: "active_time_limit" });
  });

  it("a failed model call fails the run and is not retried automatically", async () => {
    const { workflowId } = await objectiveWorkflow({});
    script = { decisions: [think("brainstorm")], fail: (kind) => kind === "work" };
    const started = await startGoal(workflowId);
    expect(started.status).toBe("failed");
    const r = await runOf(started.workflowRunId);
    expect(r.runs).toHaveLength(1);
    expect(r.deliverable).toBeUndefined();
  });

  it("refuses at save time what could never run: an ungranted tool, a tool with no loop action, a raised ceiling", async () => {
    const agent = await post("/agent-definitions", { name: "NoKeys", role: "r", objective: "o", instructions: "i" });
    const step = (parameters: Record<string, unknown>) => ({
      name: "Never",
      graphDefinition: { kind: "linear", steps: [{ taskDefinitionId: ids.objectiveTask, taskDefinitionVersion: 1, agentDefinitionId: agent.body.id, agentDefinitionVersion: 1, parameters }] },
    });
    expect((await post("/workflow-definitions", step({ intents: ["plan"], tools: [{ capability: "research.retrieve", maxCalls: 2 }] }))).body.error).toMatch(/holds no Grant/);
    expect((await post("/workflow-definitions", step({ intents: ["plan"], tools: [{ capability: "publish.report", maxCalls: 1 }] }))).body.error).toMatch(/no loop action/);
    expect((await post("/workflow-definitions", step({ intents: ["plan"], loop: { maxIterations: 50 } }))).body.error).toMatch(/1 to 12/);
  });

  // -------------------------------------------------------------------------
  // R2 Stage 5: two agents, collaborating only through explicit runtime objects
  // -------------------------------------------------------------------------
  describe("two agents collaborate through an explicit artifact handoff, and nothing else", () => {
    const researchGrant = () => ({ capabilityId: ids.researchCapability, permissions: ["READ"], autonomyState: "AUTONOMOUS", maxTrustLevelRequired: 1 });

    async function agent(name: string, grants: Record<string, unknown>[] = []): Promise<string> {
      // Each agent's instructions carry a marker, so a leak of one agent's prompt into the other's context is detectable.
      const res = await post("/agent-definitions", { name: `${name}-${++seq}`, role: name, objective: "o", instructions: `Work as ${name}. MARKER-${name}`, grants });
      expect(res.status).toBe(201);
      return res.body.id as string;
    }

    /** Researcher (holds research.retrieve) -> Analyst (holds nothing), handing over exactly one deliverable by reference. */
    async function mission(options: { analyst?: Record<string, unknown>; analystGrants?: Record<string, unknown>[] } = {}) {
      const researcher = await agent("Researcher", [researchGrant()]);
      const analyst = await agent("Analyst", options.analystGrants ?? []);
      const res = await post("/workflow-definitions", {
        name: `Mission-${++seq}`,
        graphDefinition: {
          kind: "linear",
          steps: [
            {
              stepId: "research",
              label: "Research",
              taskDefinitionId: ids.objectiveTask,
              taskDefinitionVersion: 1,
              agentDefinitionId: researcher,
              agentDefinitionVersion: 1,
              parameters: { tools: [{ capability: "research.retrieve", maxCalls: 1 }] },
            },
            {
              stepId: "analysis",
              label: "Analysis",
              taskDefinitionId: ids.objectiveTask,
              taskDefinitionVersion: 1,
              agentDefinitionId: analyst,
              agentDefinitionVersion: 1,
              parameters: { intents: ["analyse"], inputs: [{ fromStepId: "research", artifactType: "deliverable" }], ...(options.analyst ?? {}) },
            },
          ],
        },
      });
      return { researcher, analyst, status: res.status, error: res.body.error as string | undefined, workflowId: res.body.id as string };
    }

    async function stepsOf(workflowRunId: string) {
      const wr = await testDb.query.workflowRuns.findFirst({ where: eq(schema.workflowRuns.id, workflowRunId) });
      const slots = (wr!.variables as { stepTaskInstanceIds: (string | null)[] }).stepTaskInstanceIds;
      const steps = await Promise.all(
        slots.map(async (taskInstanceId) => {
          if (!taskInstanceId) return null;
          const taskInstance = (await testDb.query.taskInstances.findFirst({ where: eq(schema.taskInstances.id, taskInstanceId) }))!;
          const run = (await testDb.query.runs.findMany({ where: eq(schema.runs.taskInstanceId, taskInstanceId) }))[0]!;
          const invocations = await testDb.query.invocations.findMany({ where: eq(schema.invocations.runId, run.id) });
          const events = await testDb.query.events.findMany({ where: eq(schema.events.runId, run.id), orderBy: asc(schema.events.sequenceNo) });
          const produced = await testDb
            .select({ artifact: schema.artifacts })
            .from(schema.artifacts)
            .innerJoin(schema.invocations, eq(schema.artifacts.producingInvocationId, schema.invocations.id))
            .where(eq(schema.invocations.runId, run.id));
          const deliverable = produced.map((p) => p.artifact).find((a) => a.type === "deliverable");
          const loop = events.filter((e) => e.eventType === "agent_loop_iteration_recorded");
          return {
            taskInstance,
            run,
            invocations,
            events,
            loop,
            produced: produced.map((p) => p.artifact.id),
            deliverable,
            content: deliverable ? JSON.parse(deliverable.inlineContent!) : null,
            terminal: (loop.at(-1)?.payload as { terminal?: Record<string, unknown> } | undefined)?.terminal,
            tokens: events.filter((e) => e.eventType === "invocation_completed" && e.costAmount !== null).reduce((t, e) => t + Number(e.costAmount), 0),
          };
        })
      );
      return { workflowRun: wr!, research: steps[0]!, analysis: steps[1] };
    }

    async function latestDeliverableId(): Promise<string> {
      const rows = await testDb.query.artifacts.findMany({ where: eq(schema.artifacts.type, "deliverable") });
      return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!.id;
    }

    it("hands over one hashed artifact by reference; the analyst sees only it, finishes on it, and each agent is charged for its own work", async () => {
      const m = await mission();
      expect(m.status).toBe(201);
      let handoff = "";
      script = {
        decisions: [tool("research.retrieve", { query: "invoicing pain points" }), finish(), finish(), finish()],
        before: async (kind, n) => {
          if (kind === "decide" && n === 2) script.decisions[1] = finishCiting([await latestResultId()]);
          if (kind === "decide" && n === 3) {
            handoff = await latestDeliverableId();
            // Asking for the same artifact twice must not put it into context twice.
            const analyse = think("analyse");
            script.decisions[2] = { ...analyse, action: { ...analyse.action, useArtifacts: [handoff, handoff] } };
          }
          if (kind === "decide" && n === 4) script.decisions[3] = finishCiting([handoff]);
        },
        usage: (kind, n) => (kind === "decide" ? (n <= 2 ? 1_000 : 500) : kind === "deliverable" ? (n === 1 ? 3_000 : 2_000) : 700),
      };
      vi.mocked(callClaudeSubscriptionModel).mockClear();
      const started = await startGoal(m.workflowId);
      expect(started.status).toBe("completed");
      const { research, analysis } = await stepsOf(started.workflowRunId);

      // Two distinct persistent identities, each Run attributed to its own Agent Definition version.
      expect(research.run).toMatchObject({ agentDefinitionId: m.researcher, agentDefinitionVersion: 1, status: "completed" });
      expect(analysis!.run).toMatchObject({ agentDefinitionId: m.analyst, agentDefinitionVersion: 1, status: "completed" });

      // (3) The handoff is the researcher's deliverable: immutable, content-hashed, produced by the researcher's Run.
      const handed = (await testDb.query.artifacts.findFirst({ where: eq(schema.artifacts.id, handoff) }))!;
      expect(research.deliverable!.id).toBe(handoff);
      expect(handed.hash).toBe(createHash("sha256").update(handed.inlineContent!).digest("hex"));

      // (1, 4) What the analyst's contexts contained: the handoff and its own records — nothing else the researcher made.
      const includedIds = analysis!.events
        .filter((e) => e.eventType === "context_compiled")
        .map((e) => (e.payload as { included: { id?: string; kind: string }[] }).included.filter((x) => x.kind !== "task_state" && x.id).map((x) => x.id!));
      const allIncluded = new Set(includedIds.flat());
      expect(allIncluded.has(handoff)).toBe(true);
      for (const id of research.produced.filter((id) => id !== handoff)) expect(allIncluded.has(id)).toBe(false);
      for (const id of allIncluded) expect([handoff, ...analysis!.produced]).toContain(id);
      // Unrelated deliverables from earlier missions in this suite exist — and are never included.
      const unrelated = (await testDb.query.artifacts.findMany({ where: eq(schema.artifacts.type, "deliverable") })).filter(
        (a) => a.id !== handoff && a.id !== analysis!.deliverable!.id
      );
      expect(unrelated.length).toBeGreaterThan(0);
      for (const a of unrelated) expect(allIncluded.has(a.id)).toBe(false);
      // (10) No compiled context carries the same artifact twice, however often it was requested.
      for (const list of includedIds) expect(new Set(list).size).toBe(list.length);

      // No hidden shared context: no call made for the analyst carried the researcher's prompt or its raw results.
      const analystCalls = vi
        .mocked(callClaudeSubscriptionModel)
        .mock.calls.map((c) => JSON.stringify(c[1]))
        .filter((ctx) => ctx.includes("MARKER-Analyst"));
      expect(analystCalls.length).toBe(4); // two decisions, one analysis, one write
      for (const ctx of analystCalls) {
        expect(ctx).not.toContain("MARKER-Researcher");
        // The researcher's raw search results and its decisions never arrive. Their ids may: the handed-off
        // document records its own provenance (which results its author cited) — a reference, not the content.
        expect(ctx).not.toContain("A synthesized summary of information relevant to");
        expect(ctx).not.toContain("use research.retrieve");
      }
      // Control: those same strings DID reach the researcher, so their absence above is isolation, not a vacuous check.
      const researcherCalls = vi
        .mocked(callClaudeSubscriptionModel)
        .mock.calls.map((c) => JSON.stringify(c[1]))
        .filter((ctx) => ctx.includes("MARKER-Researcher"));
      expect(researcherCalls.some((ctx) => ctx.includes("A synthesized summary of information relevant to"))).toBe(true);
      expect(researcherCalls.some((ctx) => ctx.includes("use research.retrieve"))).toBe(true);

      // (5) The analyst finished deliberately, on the evidence it was handed — with hash and producer lineage.
      expect(analysis!.terminal).toMatchObject({ status: "complete", reason: "evidence_sufficient" });
      expect((analysis!.terminal!.evidence as { verified: unknown[] }).verified).toEqual([
        { artifactId: handoff, hash: handed.hash, capability: "handoff", iteration: 0, runId: research.run.id, fromStep: "research" },
      ]);
      // The upstream evidence basis carries through: the analyst's document says research was done, and by what.
      expect(analysis!.content.basis.evidence).toEqual([{ capability: "research.retrieve", evidenceClass: "fixture", calls: 1 }]);

      // (9) Tokens land on the Run — and so the agent — that spent them.
      expect(research.tokens).toBe(1_000 + 1_000 + 3_000);
      expect(analysis!.tokens).toBe(500 + 700 + 500 + 2_000);
    });

    it("R2: an agent endorses only a deliverable the runtime proves it received from another agent, and earns nothing for it", async () => {
      // The seed creates the Capability and its binding, held by no agent.
      const seeded = await testDb.query.capabilities.findFirst({ where: eq(schema.capabilities.name, "peer.endorse") });
      expect(await testDb.query.capabilityGrants.findFirst({ where: eq(schema.capabilityGrants.capabilityId, seeded!.id) })).toBeUndefined();
      const capability = { body: { id: seeded!.id } };
      const m = await mission({
        analystGrants: [{ capabilityId: capability.body.id, permissions: ["CREATE"], autonomyState: "AUTONOMOUS", maxTrustLevelRequired: 1 }],
        analyst: { tools: [{ capability: "peer.endorse", maxCalls: 3 }] },
      });
      expect(m.status).toBe(201);
      let handoff = "";
      const neverReceived = randomUUID();
      script = {
        decisions: [tool("research.retrieve", { query: "invoicing pain points" }), finish(), finish(), finish(), finish(), finish()],
        before: async (kind, n) => {
          if (kind === "decide" && n === 2) script.decisions[1] = finishCiting([await latestResultId()]);
          if (kind === "decide" && n === 3) {
            handoff = await latestDeliverableId();
            script.decisions[2] = tool("peer.endorse", { artifactId: neverReceived, reason: "claims to be useful" });
          }
          if (kind === "decide" && n === 4) script.decisions[3] = tool("peer.endorse", { artifactId: handoff, reason: "the evidence held up" });
          if (kind === "decide" && n === 5) script.decisions[4] = finishCiting([handoff]);
        },
      };
      const started = await startGoal(m.workflowId);
      expect(started.status).toBe("completed");
      const { research, analysis } = await stepsOf(started.workflowRunId);

      const outcomes = analysis!.loop.filter((e) => (e.payload as { action?: { capability?: string } }).action?.capability === "peer.endorse").map((e) => (e.payload as { outcome: unknown }).outcome);
      expect(outcomes[0]).toMatchObject({ status: "refused", reason: expect.stringMatching(/does not exist|never received/) });
      expect(outcomes[1]).toMatchObject({ status: "completed" });

      // The snapshot's facts come from the record, not the decision.
      const handed = (await testDb.query.artifacts.findFirst({ where: eq(schema.artifacts.id, handoff) }))!;
      const endorsements = analysis!.invocations.filter((i) => i.capabilityId === capability.body.id);
      expect(endorsements).toHaveLength(1);
      const researcherName = (await testDb.query.agentDefinitions.findFirst({ where: eq(schema.agentDefinitions.id, m.researcher) }))!.name;
      const analystName = (await testDb.query.agentDefinitions.findFirst({ where: eq(schema.agentDefinitions.id, m.analyst) }))!.name;
      expect(endorsements[0]!.proposedActionSnapshot).toMatchObject({ artifactId: handoff, artifactHash: handed.hash, endorserRunId: analysis!.run.id, endorsedAgentName: researcherName });
      expect(research.run.id).not.toBe(analysis!.run.id);

      await testDb.transaction((tx) => refreshAgentProgression(tx));
      const recorded = await testDb.query.agentEndorsements.findFirst({ where: eq(schema.agentEndorsements.invocationId, endorsements[0]!.id) });
      expect(recorded).toMatchObject({ endorserName: analystName, endorsedName: researcherName, verified: true, excludedReason: null });
      const analystAwards = await testDb.query.agentXpAwards.findMany({ where: eq(schema.agentXpAwards.agentName, analystName) });
      expect(analystAwards.some((a) => JSON.stringify(a.evidence).includes("peer.endorse"))).toBe(false);
    });

    it("one agent's Grant never becomes another's: refused at save time, and refused at run time", async () => {
      // The researcher in the same workflow holds research.retrieve; the analyst does not, and cannot borrow it.
      const saved = await mission({ analyst: { tools: [{ capability: "research.retrieve", maxCalls: 1 }] } });
      expect(saved.status).toBe(400);
      expect(saved.error).toMatch(/holds no Grant for "research\.retrieve"/);

      const m = await mission();
      script = { decisions: [tool("research.retrieve", { query: "x" }), finish(), tool("research.retrieve", { query: "borrowed" }), finish()] };
      const started = await startGoal(m.workflowId);
      const { research, analysis } = await stepsOf(started.workflowRunId);

      expect(research.invocations.filter((i) => i.kind === "tool")).toHaveLength(1);
      // (7) The refusal is visible, in the analyst's lineage — no tool call, no Policy evaluation, nothing borrowed.
      expect(analysis!.loop[0]!.payload).toMatchObject({ action: { type: "tool", capability: "research.retrieve" }, outcome: { status: "refused" } });
      expect(analysis!.invocations.filter((i) => i.kind === "tool")).toHaveLength(0);
      expect(analysis!.events.filter((e) => e.eventType === "policy_evaluated")).toHaveLength(0);
    });

    it("cites only what was explicitly handed AND verified upstream: everything else is rejected, never laundered", async () => {
      // The researcher gathers a result but finishes WITHOUT verified evidence (it cites nothing).
      const m = await mission();
      let handoff = "";
      let upstreamResult = "";
      let unrelated = "";
      script = {
        decisions: [tool("research.retrieve", { query: "x" }), finish(), finish()],
        before: async (kind, n) => {
          if (kind === "decide" && n === 2) upstreamResult = await latestResultId();
          if (kind === "decide" && n === 3) {
            handoff = await latestDeliverableId();
            const others = (await testDb.query.artifacts.findMany({ where: eq(schema.artifacts.type, "deliverable") })).filter((a) => a.id !== handoff);
            // Another mission's document when one exists; otherwise a well-formed id this workflow never produced.
            unrelated = others[0]?.id ?? "00000000-0000-4000-8000-000000000001";
            // The analyst cites the handoff, an upstream search result it learned of from provenance, and a stranger's document.
            script.decisions[2] = finishCiting([handoff, upstreamResult, unrelated]);
          }
        },
      };
      const started = await startGoal(m.workflowId);
      const { research, analysis } = await stepsOf(started.workflowRunId);

      expect(research.terminal).toMatchObject({ reason: "agent_finished" }); // gathered, but never verified upstream
      // (8) Nothing becomes evidence-based downstream: an unverified handoff, an unhanded upstream result, an unrelated document.
      expect(analysis!.terminal).toMatchObject({ status: "complete", reason: "agent_finished" });
      const evidence = analysis!.terminal!.evidence as { verified: unknown[]; rejected: string[] };
      expect(evidence.verified).toEqual([]);
      expect([...evidence.rejected].sort()).toEqual([handoff, upstreamResult, unrelated].sort());
    });

    it("never accepts a forged basis: only a code-written deliverable that finished on verified evidence counts", () => {
      const verified = { format: "deliverable/v1", completion: { status: "complete", reason: "evidence_sufficient" }, basis: { evidence: [{ capability: "research.search", evidenceClass: "external", calls: 1 }] } };
      expect(carriesRecordedEvidence({ type: "deliverable" }, verified)).toBe(true);
      // A report stores model JSON as given: the same keys, injected, must not count.
      expect(carriesRecordedEvidence({ type: "report" }, verified)).toBe(false);
      // Evidence gathered but the upstream step stopped at a limit, or finished citing nothing.
      expect(carriesRecordedEvidence({ type: "deliverable" }, { ...verified, completion: { status: "incomplete", reason: "max_iterations" } })).toBe(false);
      expect(carriesRecordedEvidence({ type: "deliverable" }, { ...verified, completion: { status: "complete", reason: "agent_finished" } })).toBe(false);
      expect(carriesRecordedEvidence({ type: "deliverable" }, { ...verified, basis: { evidence: [] } })).toBe(false);
    });

    it("a handed document too large for the old decision budget reaches every downstream decision as content, not a bare reference", async () => {
      const m = await mission();
      let handoff = "";
      script = {
        decisions: [tool("research.retrieve", { query: "x" }), finish(), think("analyse"), finish()],
        before: async (kind, n) => {
          if (kind === "decide" && n === 2) script.decisions[1] = finishCiting([await latestResultId()]);
          if (kind === "decide" && n === 3) handoff = await latestDeliverableId();
          if (kind === "decide" && n === 4) script.decisions[3] = finishCiting([handoff]);
        },
        // ~2,300 tokens: over a decision's old 1,800-token artifact cap, within the step's 3,000.
        deliverableBody: (n) => (n === 1 ? `## Evidence\n\n${"The cited sources define the topic and describe its uses. ".repeat(160)}` : "## Answer"),
      };
      const started = await startGoal(m.workflowId);
      const { analysis } = await stepsOf(started.workflowRunId);

      const decides = analysis!.events.filter((e) => e.eventType === "context_compiled" && (e.payload as { intent: string }).intent === "decide");
      expect(decides).toHaveLength(2);
      for (const d of decides) {
        const entry = (d.payload as { included: { id?: string; kind: string }[] }).included.find((x) => x.id === handoff);
        expect(entry?.kind).toBe("artifact_content");
      }
      expect(analysis!.terminal).toMatchObject({ status: "complete", reason: "evidence_sufficient" });
    });

    it("a downstream limit is still incomplete, never a finish", async () => {
      const m = await mission({ analyst: { loop: { maxIterations: 1 } } });
      script = { decisions: [tool("research.retrieve", { query: "x" }), finish(), think("analyse")] };
      const started = await startGoal(m.workflowId);
      const { analysis } = await stepsOf(started.workflowRunId);
      expect(analysis!.terminal).toEqual({ status: "incomplete", reason: "max_iterations" });
      expect(analysis!.content.completion).toEqual({ status: "incomplete", reason: "max_iterations" });
    });

    it("a downstream failure is not hidden by upstream success, in the lineage or in performance", async () => {
      const m = await mission();
      script = { decisions: [tool("research.retrieve", { query: "x" }), finish()], fail: (kind, n) => kind === "decide" && n === 3 };
      const started = await startGoal(m.workflowId);
      expect(started.status).toBe("failed");
      const { workflowRun, research, analysis } = await stepsOf(started.workflowRunId);

      expect(workflowRun.status).toBe("failed");
      expect(research.run.status).toBe("completed");
      expect(analysis!.run.status).toBe("failed");
      expect(analysis!.taskInstance.status).toBe("failed");
      expect(analysis!.events.some((e) => e.eventType === "invocation_failed")).toBe(true);
      expect(analysis!.deliverable).toBeUndefined();

      // Performance is per agent: the researcher's success does not lift the analyst, whose failure counts against it.
      await testDb.transaction((tx) => refreshAgentPerformance(tx));
      const rows = await testDb.query.agentPerformance.findMany();
      const of = (agentId: string) => rows.filter((row) => row.agentDefinitionId === agentId);
      expect(of(m.researcher).map((row) => [row.sampleCount, Number(row.successRate)])).toEqual([[1, 1]]);
      expect(of(m.analyst).map((row) => [row.sampleCount, Number(row.successRate)])).toEqual([[1, 0]]);
    });
  });

  it("Policy stays authoritative: a binding below the Grant's trust bar denies the tool and fails closed", async () => {
    const { workflowId } = await objectiveWorkflow({});
    // A newer binding at trust 0 is selected; the Grant requires 1 (runs last: it changes resolution for later tests).
    expect((await post("/tool-bindings", { capabilityId: ids.researchCapability, kind: "internal", config: { function: "research.retrieve.synthetic" }, trustLevel: 0, previousVersion: 1 })).status).toBe(201);
    script = { decisions: [tool("research.retrieve", { query: "x" }), finish()] };
    const started = await startGoal(workflowId);
    expect(started.status).toBe("failed");
    const r = await runOf(started.workflowRunId);
    const denied = r.events.find((e) => e.eventType === "policy_evaluated" && (e.payload as { decision?: string }).decision === "DENY");
    expect(denied).toBeTruthy();
    expect(r.runs).toHaveLength(1);
    expect(r.deliverable).toBeUndefined();
  });
});
