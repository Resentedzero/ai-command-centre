/**
 * `buildInvocationSpecsFromDefinitions`: a workflow step is planned entirely from
 * persisted Definitions (graph step -> Agent + parameters -> Task Definition kind
 * -> registered plan), and every missing link fails closed. Binding an Agent
 * authorizes nothing: its Tool Invocations still need a Grant through Policy.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { closeTestDb, resetTestSchema, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { advanceWorkflowRunToBoundary } from "../helpers/driveToBoundary.js";
import { startWorkflowRun } from "../../src/workflow/interpreter.js";
import { isLinearGraphDefinition } from "../../src/workflow/graphTypes.js";
import { buildInvocationSpecsFromDefinitions } from "../../src/workflow/buildInvocationSpecsFromDefinitions.js";
import { registerInternalToolFunction, resolveToolInvocation } from "../../src/capabilities/toolAdapters.js";
import { registerTaskPlanBuilder, RESEARCH_REPORT_TASK_KIND } from "../../src/capabilities/taskPlans.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const CAPABILITY = "test.definitions.echo";
registerInternalToolFunction(CAPABILITY, {
  capabilityName: CAPABILITY,
  prepare: async (_tx, { proposedActionSnapshot }) => ({ inputs: proposedActionSnapshot, costClass: "local_retrieval", estimatedCost: 0 }),
  execute: async ({ inputs }) => ({ echoed: inputs }),
});
registerTaskPlanBuilder("test_echo", async (tx, ctx) => [
  await resolveToolInvocation(tx, { capabilityName: CAPABILITY, permission: "READ", proposedActionSnapshot: { label: ctx.parameters.label } }),
]);

type SetUpOptions = { withAgent?: boolean; grant?: boolean; kind?: string; defaultContextBudget?: Record<string, unknown> };

async function setUp(tx: DrizzleTransaction, { withAgent = true, grant = true, kind = "test_echo", defaultContextBudget = {} }: SetUpOptions = {}) {
  const [project] = await tx.insert(schema.projects).values({ name: "p-" + randomUUID() }).returning();
  const [goal] = await tx.insert(schema.goals).values({ projectId: project!.id, title: "Echo a label", status: "active" }).returning();
  const [capability] = await tx.insert(schema.capabilities).values({ name: CAPABILITY, description: "echo", staticRiskTag: "low" }).returning();
  await tx.insert(schema.toolBindings).values({ capabilityId: capability!.id, kind: "internal", config: { function: CAPABILITY }, trustLevel: 2, version: 1 });
  const [agent] = await tx
    .insert(schema.agentDefinitions)
    .values({ name: "Echoer-" + randomUUID(), version: 1, role: "Echoer", objective: "Echo", instructions: "Echo the label." })
    .returning();
  if (grant) {
    await tx.insert(schema.capabilityGrants).values({
      agentDefinitionId: agent!.id,
      agentDefinitionVersion: 1,
      capabilityId: capability!.id,
      permissions: ["READ"],
      maxTrustLevelRequired: 1,
      autonomyState: "AUTONOMOUS",
    });
  }
  const [taskDefinition] = await tx.insert(schema.taskDefinitions).values({ name: "t-" + randomUUID(), kind, defaultContextBudget, version: 1 }).returning();
  const step = {
    taskDefinitionId: taskDefinition!.id,
    taskDefinitionVersion: 1,
    ...(withAgent ? { agentDefinitionId: agent!.id, agentDefinitionVersion: 1 } : {}),
    parameters: { label: "hello" },
  };
  const [workflowDefinition] = await tx
    .insert(schema.workflowDefinitions)
    .values({ name: "wf-" + randomUUID(), version: 1, graphDefinition: { kind: "linear", steps: [step] } })
    .returning();
  const { workflowRunId } = await startWorkflowRun(tx, workflowDefinition!.id, goal!.id);
  return { workflowRunId, agent: agent! };
}

async function stepState(tx: DrizzleTransaction, workflowRunId: string) {
  const taskInstance = await tx.query.taskInstances.findFirst({ where: eq(schema.taskInstances.workflowRunId, workflowRunId) });
  const run = await tx.query.runs.findFirst({ where: eq(schema.runs.taskInstanceId, taskInstance!.id) });
  const invocations = await tx.query.invocations.findMany({ where: eq(schema.invocations.runId, run!.id) });
  return { run: run!, invocations };
}

/** The step failure the Interpreter settled, as logged. */
function loggedStepErrors(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.flat().map((a) => (a instanceof Error ? a.message : String(a))).join("\n");
}

describe("planning a workflow step from its Definitions", () => {
  it("binds the step's Agent to its Run and runs its kind's registered plan with the step's parameters", async () => {
    await withRollback(async (tx) => {
      const { workflowRunId, agent } = await setUp(tx);
      const result = await advanceWorkflowRunToBoundary(tx, workflowRunId, buildInvocationSpecsFromDefinitions(tx));
      expect(result.status).toBe("completed");

      const { run, invocations } = await stepState(tx, workflowRunId);
      expect(run).toMatchObject({ agentDefinitionId: agent.id, agentDefinitionVersion: 1, status: "completed" });
      expect(invocations).toHaveLength(1);
      const artifact = await tx.query.artifacts.findFirst({ where: eq(schema.artifacts.producingInvocationId, invocations[0]!.id) });
      expect(JSON.parse(artifact!.inlineContent!)).toEqual({ echoed: { label: "hello" } });
    });
  });

  it("fails closed when the step binds no Agent Definition", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await withRollback(async (tx) => {
      const { workflowRunId } = await setUp(tx, { withAgent: false });
      expect((await advanceWorkflowRunToBoundary(tx, workflowRunId, buildInvocationSpecsFromDefinitions(tx))).status).toBe("failed");
      expect((await stepState(tx, workflowRunId)).invocations).toHaveLength(0);
      expect(loggedStepErrors(errors)).toMatch(/binds no Agent Definition/);
    });
  });

  it("an Agent bound by the graph but holding no Grant is denied by Policy: the graph cannot authorize", async () => {
    await withRollback(async (tx) => {
      const { workflowRunId } = await setUp(tx, { grant: false });
      expect((await advanceWorkflowRunToBoundary(tx, workflowRunId, buildInvocationSpecsFromDefinitions(tx))).status).toBe("failed");
      const { invocations } = await stepState(tx, workflowRunId);
      expect(invocations).toHaveLength(1);
      const failed = await tx.query.events.findFirst({ where: eq(schema.events.idempotencyKey, `invocation_failed:${invocations[0]!.id}`) });
      expect(JSON.stringify(failed?.payload)).toContain("policy_denied");
    });
  });

  it("fails closed for a Task Definition kind with no registered plan", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await withRollback(async (tx) => {
      const { workflowRunId } = await setUp(tx, { kind: "no_such_kind" });
      expect((await advanceWorkflowRunToBoundary(tx, workflowRunId, buildInvocationSpecsFromDefinitions(tx))).status).toBe("failed");
      expect(loggedStepErrors(errors)).toMatch(/No task plan is registered for Task Definition kind "no_such_kind"/);
    });
  });

  it("a research_report step requires its Task Definition's complete context budget, never a default", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await withRollback(async (tx) => {
      const { workflowRunId } = await setUp(tx, { kind: RESEARCH_REPORT_TASK_KIND, defaultContextBudget: { maxInputTokens: 100 } });
      expect((await advanceWorkflowRunToBoundary(tx, workflowRunId, buildInvocationSpecsFromDefinitions(tx))).status).toBe("failed");
      expect(loggedStepErrors(errors)).toMatch(/default_context_budget\.maxArtifactTokens/);
    });
  });
});

describe("graph step shape", () => {
  const base = { taskDefinitionId: "t", taskDefinitionVersion: 1 };
  it("accepts a step with or without an Agent binding and parameters", () => {
    expect(isLinearGraphDefinition({ kind: "linear", steps: [base] })).toBe(true);
    expect(isLinearGraphDefinition({ kind: "linear", steps: [{ ...base, agentDefinitionId: "a", agentDefinitionVersion: 2, parameters: { x: 1 } }] })).toBe(true);
  });
  it("rejects half an Agent binding, a mistyped one, or non-object parameters", () => {
    for (const step of [
      { ...base, agentDefinitionId: "a" },
      { ...base, agentDefinitionVersion: 1 },
      { ...base, agentDefinitionId: 1, agentDefinitionVersion: 1 },
      { ...base, parameters: [] },
      { ...base, parameters: null },
    ]) {
      expect(isLinearGraphDefinition({ kind: "linear", steps: [step] })).toBe(false);
    }
  });
});
