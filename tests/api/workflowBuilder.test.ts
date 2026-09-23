/**
 * V1.1 Workflow Builder over the Registry and the existing interpreter:
 * - R3: each kind validates its step parameters when the workflow is saved;
 * - stable step ids and explicit forward data flow (`inputs`);
 * - `agent_task` produces a deliverable from exactly the selected earlier output;
 * - `operator_checkpoint` is an ordinary governed Approval pinned to output hashes,
 *   only for an Agent holding `review.checkpoint` at ALWAYS_APPROVE;
 * - R2: `POST /goals` with `async: true` answers 202 and the run continues;
 * - `?dryRun=1` validates without writing anything.
 * Every model call is mocked.
 */
import { resolveStepInputArtifacts } from "../../src/capabilities/shared/stepInputs.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeTestDb, resetTestSchema, rewriteArtifactForTest, testDb } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import { seedPublishWorkflow, seedV11Definitions, type SeedPublishWorkflowResult } from "../../src/definitions/seed.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { callClaudeSubscriptionModel } from "../../src/router/providers/claudeSubscription.js";
import { callAnthropicModel } from "../../src/router/providers/anthropic.js";
import { buildServer } from "../../src/api/server.js";

let app: FastifyInstance;
let seed: SeedPublishWorkflowResult;
let ids: { agentTask: string; gate: string; reviewer: string; analyst: string; checkpointCapability: string };

const USAGE = { tokensIn: 120, tokensOut: 80, costAmount: 200, costUnit: "subscription_tokens" as const };
const DELIVERABLE = {
  title: "Analysis of the evidence",
  summary: "Two **options** stand out.",
  body: "## Options\n\n| Option | Fit |\n| --- | --- |\n| A | high |",
  findings: ["Evidence is thin"],
  recommendations: ["Gather more"],
  sources: [{ label: "Fixture result", ref: "internal.local/1" }],
};

async function post(url: string, payload: unknown) {
  const res = await app.inject({ method: "POST", url, payload: payload as Record<string, unknown> });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

async function waitFor<T>(probe: () => Promise<T | null | undefined | false>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("waitFor: timed out");
}

function step(stepId: string, taskDefinitionId: string, agentDefinitionId: string, parameters?: Record<string, unknown>) {
  return { stepId, label: stepId, taskDefinitionId, taskDefinitionVersion: 1, agentDefinitionId, agentDefinitionVersion: 1, ...(parameters ? { parameters } : {}) };
}

function graph(...steps: ReturnType<typeof step>[]) {
  return { kind: "linear", description: "Research, analyse, approve", steps };
}

beforeAll(async () => {
  await resetTestSchema();
  seed = await testDb.transaction((tx) => seedPublishWorkflow(tx));
  await testDb.transaction((tx) => seedV11Definitions(tx));
  const byName = async (name: string) => (await testDb.query.taskDefinitions.findFirst({ where: eq(schema.taskDefinitions.name, name) }))!.id;
  app = buildServer({ db: testDb });
  await app.ready();
  const analyst = await post("/agent-definitions", { name: "Analyst", role: "Analyst", objective: "Turn evidence into analysis", instructions: "Be rigorous." });
  ids = {
    agentTask: await byName("Agent Task"),
    gate: await byName("Approval Gate"),
    reviewer: (await testDb.query.agentDefinitions.findFirst({ where: eq(schema.agentDefinitions.name, "Reviewer") }))!.id,
    analyst: analyst.body.id as string,
    checkpointCapability: (await testDb.query.capabilities.findFirst({ where: eq(schema.capabilities.name, "review.checkpoint") }))!.id,
  };
  vi.mocked(callClaudeSubscriptionModel).mockImplementation(async (_model, _ctx, shape) => {
    const props = (shape as { properties?: Record<string, unknown> }).properties ?? {};
    if ("report" in props) return { result: { report: "# Evidence\n\n- fixture item" }, usage: USAGE };
    if ("body" in props) return { result: DELIVERABLE, usage: USAGE };
    throw new Error(`unexpected output shape ${JSON.stringify(shape)}`);
  });
}, 30000);

afterAll(async () => {
  await app.close();
  await closeTestDb();
});

describe("R3: step parameters are validated when a workflow is saved", () => {
  const research = () => step("research", seed.taskDefinitionId, seed.agentDefinitionId);
  const analyse = (parameters: Record<string, unknown>) => step("analyse", ids.agentTask, ids.analyst, parameters);

  it.each([
    ["an agent task without an instruction", () => graph(research(), analyse({ inputs: [{ fromStepId: "research", artifactType: "report" }] })), /instruction/],
    ["an unknown agent task parameter", () => graph(research(), analyse({ instruction: "x", budget: 9 })), /unknown parameter/],
    ["an input from a later step", () => graph(analyse({ instruction: "x", inputs: [{ fromStepId: "research" }] }), research()), /earlier step/],
    ["an input naming no step", () => graph(research(), analyse({ instruction: "x", inputs: [{ fromStepId: "nowhere" }] })), /names no step/],
    ["an unknown artifact type", () => graph(research(), analyse({ instruction: "x", inputs: [{ fromStepId: "research", artifactType: "secrets" }] })), /artifactType/],
    ["a duplicate step id", () => graph(research(), { ...research(), taskDefinitionId: ids.agentTask, agentDefinitionId: ids.analyst, parameters: { instruction: "x" } }), /used by an earlier step/],
    ["a malformed step id", () => graph({ ...research(), stepId: "has space" }), /stepId/],
    ["a gate whose agent holds no checkpoint grant", () => graph(research(), step("gate", ids.gate, ids.analyst, { question: "Go?", inputs: [{ fromStepId: "research", artifactType: "report" }] })), /must hold "review.checkpoint"/],
    ["a gate pinning nothing", () => graph(research(), step("gate", ids.gate, ids.reviewer, { question: "Go?" })), /at least one/],
    [
      "a publish step before its source",
      () =>
        graph(
          { ...step("publish", seed.reviewAndPublishTaskDefinitionId, seed.publisherAgentDefinitionId, { sourceTaskDefinitionId: seed.taskDefinitionId }) },
          research()
        ),
      /earlier step/,
    ],
  ])("refuses %s", async (_label, build, message) => {
    const res = await post("/workflow-definitions", { name: "Invalid", graphDefinition: build() });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(message);
  });

  it("refuses a gate whose checkpoint grant does not always ask", async () => {
    const lax = await post("/agent-definitions", {
      name: "LaxReviewer",
      role: "r",
      objective: "o",
      instructions: "i",
      grants: [{ capabilityId: ids.checkpointCapability, permissions: ["EXECUTE"], autonomyState: "AUTONOMOUS", maxTrustLevelRequired: 1 }],
    });
    expect(lax.status).toBe(201);
    const res = await post("/workflow-definitions", {
      name: "Invalid",
      graphDefinition: graph(research(), step("gate", ids.gate, lax.body.id as string, { question: "Go?", inputs: [{ fromStepId: "research", artifactType: "report" }] })),
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/must be ALWAYS_APPROVE/);
  });

  it("dryRun validates a good workflow without writing a row or an event", async () => {
    const eventsBefore = (await testDb.select().from(schema.events)).length;
    const res = await app.inject({
      method: "POST",
      url: "/workflow-definitions?dryRun=1",
      payload: { name: "Dry", graphDefinition: graph(research(), analyse({ instruction: "Analyse", inputs: [{ fromStepId: "research", artifactType: "report" }] })) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: true, name: "Dry", version: 1 });
    expect(await testDb.query.workflowDefinitions.findMany({ where: eq(schema.workflowDefinitions.name, "Dry") })).toEqual([]);
    expect((await testDb.select().from(schema.events)).length).toBe(eventsBefore);
  });
});

describe("a custom multi-agent workflow runs through the existing interpreter", () => {
  it("research → analyse (explicit input) → approval gate: async start, deliverable with basis, pinned approval, completion", async () => {
    const saved = await post("/workflow-definitions", {
      name: "Research-Analyse-Approve",
      graphDefinition: graph(
        step("research", seed.taskDefinitionId, seed.agentDefinitionId),
        step("analyse", ids.agentTask, ids.analyst, { instruction: "Analyse the evidence for the goal.", inputs: [{ fromStepId: "research", artifactType: "report" }] }),
        step("gate", ids.gate, ids.reviewer, { question: "Continue with this analysis?", inputs: [{ fromStepId: "analyse" }] })
      ),
    });
    expect(saved.status).toBe(201);

    expect((await post("/goals", { title: "x", workflowDefinitionId: saved.body.id, projectId: seed.projectId, async: "yes" })).status).toBe(400);

    const started = await post("/goals", { title: "Find automation opportunities", workflowDefinitionId: saved.body.id, projectId: seed.projectId, async: true });
    expect(started.status).toBe(202);
    expect(started.body.status).toBe("in_progress");
    const workflowRunId = started.body.workflowRunId as string;

    const approval = await waitFor(async () => {
      const rows = await testDb
        .select({ approval: schema.approvals })
        .from(schema.approvals)
        .innerJoin(schema.invocations, eq(schema.approvals.invocationId, schema.invocations.id))
        .innerJoin(schema.runs, eq(schema.invocations.runId, schema.runs.id))
        .innerJoin(schema.taskInstances, eq(schema.runs.taskInstanceId, schema.taskInstances.id))
        .where(and(eq(schema.taskInstances.workflowRunId, workflowRunId), eq(schema.approvals.status, "pending")));
      return rows[0]?.approval;
    });

    // The analyse step consumed exactly the research step's report, fenced as untrusted data.
    const run = await testDb.query.workflowRuns.findFirst({ where: eq(schema.workflowRuns.id, workflowRunId) });
    const [researchTi, analyseTi] = (run!.variables as { stepTaskInstanceIds: string[] }).stepTaskInstanceIds;
    const researchRun = await testDb.query.runs.findFirst({ where: eq(schema.runs.taskInstanceId, researchTi!) });
    const report = (
      await testDb
        .select({ id: schema.artifacts.id })
        .from(schema.artifacts)
        .innerJoin(schema.invocations, eq(schema.artifacts.producingInvocationId, schema.invocations.id))
        .where(and(eq(schema.invocations.runId, researchRun!.id), eq(schema.artifacts.type, "report")))
    )[0]!;
    const analyseRun = await testDb.query.runs.findFirst({ where: eq(schema.runs.taskInstanceId, analyseTi!) });
    expect(analyseRun).toMatchObject({ status: "completed", agentDefinitionId: ids.analyst, agentDefinitionVersion: 1 });
    const compiled = await testDb.query.events.findFirst({ where: and(eq(schema.events.runId, analyseRun!.id), eq(schema.events.eventType, "context_compiled")) });
    expect((compiled!.payload as { included: { id: string; trusted: boolean }[] }).included).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: report.id, trusted: false })])
    );
    const writeCall = vi.mocked(callClaudeSubscriptionModel).mock.calls.find((c) => "body" in ((c[2] as { properties?: object }).properties ?? {}))!;
    expect(writeCall[1].layers.invocationInstruction).toContain("Analyse the evidence for the goal.");
    expect(writeCall[1].layers.artifacts).toContain("untrusted_data_");

    const deliverable = (
      await testDb
        .select({ artifact: schema.artifacts })
        .from(schema.artifacts)
        .innerJoin(schema.invocations, eq(schema.artifacts.producingInvocationId, schema.invocations.id))
        .where(and(eq(schema.invocations.runId, analyseRun!.id), eq(schema.artifacts.type, "deliverable")))
    )[0]!.artifact;
    const content = JSON.parse(deliverable.inlineContent!);
    expect(content).toMatchObject({ format: "deliverable/v1", title: "Analysis of the evidence", findings: ["Evidence is thin"] });
    // Recorded by code from the tools that actually ran: fixture data, no external research.
    expect(content.basis).toEqual({
      externalResearch: false,
      evidence: [{ capability: "research.retrieve", evidenceClass: "fixture", calls: 1 }],
      note: "Includes fixture (test) data, which is not real research.",
    });

    // The gate is an ordinary Approval pinned to the deliverable's exact bytes.
    expect(approval.proposedActionSnapshot).toMatchObject({
      question: "Continue with this analysis?",
      artifactId: deliverable.id,
      artifactHash: deliverable.hash,
      artifacts: [{ stepId: "analyse", id: deliverable.id, hash: deliverable.hash, type: "deliverable" }],
    });

    const approved = await app.inject({ method: "POST", url: `/approvals/${approval.id}/approve` });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ approvalStatus: "approved", workflowStatus: "completed" });
    const events = await testDb.query.events.findMany({ where: eq(schema.events.workflowRunId, workflowRunId) });
    expect(events.map((e) => e.eventType)).toEqual(expect.arrayContaining(["approval_required", "approval_granted", "workflow_run_completed"]));
    expect(callAnthropicModel).not.toHaveBeenCalled();

    // Handoff integrity: provenance is not enough. An artifact whose stored content no longer hashes to
    // the hash recorded with it can never be handed to a downstream step, even though it still hangs off
    // the right completed run. (Only reachable by writing around the immutability trigger, as here.)
    await rewriteArtifactForTest(report.id, JSON.stringify({ format: "report/v1", title: "Rewritten" }));
    await expect(
      testDb.transaction((tx) =>
        resolveStepInputArtifacts(tx as unknown as Parameters<typeof resolveStepInputArtifacts>[0], analyseTi!, [{ fromStepId: "research", artifactType: "report" }])
      )
    ).rejects.toThrow(/no longer matches its recorded hash/);
  });
});
