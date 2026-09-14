/**
 * Step failure settlement (post-Phase 9, DURABLE_EXECUTION §4.2): a step whose
 * spec builder or execution throws is recorded as failed — budget holds
 * settled, Approvals represented honestly, the Workflow Run failed — instead of
 * rolling back and leaving the Workflow Run stuck with every later advance
 * repeating the throw. Transient database errors, and a Run this process is
 * still dispatching, are NOT settled.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeTestDb, resetTestSchema, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { callClaudeSubscriptionModel } from "../../src/router/providers/claudeSubscription.js";
import { advanceWorkflowRun, startWorkflowRun, type InvocationSpecBuilder } from "../../src/workflow/interpreter.js";
import { advanceWorkflowRunToBoundary } from "../helpers/driveToBoundary.js";
import { seedPublishWorkflow, DEFAULT_RESEARCH_REPORT_CONTEXT_BUDGET } from "../../src/definitions/seed.js";
import { buildResearchReportInvocationSpecs } from "../../src/capabilities/researchRetrieve/buildInvocationSpecs.js";
import { buildPublishReportInvocationSpecs } from "../../src/capabilities/publishReport/buildInvocationSpecs.js";
import * as toolBindingModule from "../../src/capabilities/publishReport/toolBinding.js";
import { resolveApproval } from "../../src/governance/approvals.js";
import { releaseDispatchSlot, STEP_EXECUTION_ERROR_REASON } from "../../src/execution/executor.js";

type Seed = Awaited<ReturnType<typeof seedPublishWorkflow>>;

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function mockLlmOnce(): void {
  vi.mocked(callClaudeSubscriptionModel).mockResolvedValueOnce({
    result: { report: "settlement report" },
    usage: { tokensIn: 100, tokensOut: 50, costAmount: 150, costUnit: "subscription_tokens" },
  });
}

/** The seeded two-step builder, with an optional injected failure for one step. */
function builderFor(tx: DrizzleTransaction, seed: Seed, failStep?: { taskDefinitionId: string; error: () => unknown }): InvocationSpecBuilder {
  return async (params) => {
    if (failStep && params.taskDefinitionId === failStep.taskDefinitionId) throw failStep.error();
    if (params.taskDefinitionId === seed.taskDefinitionId) {
      return buildResearchReportInvocationSpecs(
        tx,
        {
          agentDefinitionId: seed.agentDefinitionId,
          agentDefinitionVersion: seed.agentDefinitionVersion,
          query: "settlement query",
          contextBudget: DEFAULT_RESEARCH_REPORT_CONTEXT_BUDGET,
        },
        params
      );
    }
    return buildPublishReportInvocationSpecs(
      tx,
      {
        agentDefinitionId: seed.publisherAgentDefinitionId,
        agentDefinitionVersion: seed.publisherAgentDefinitionVersion,
        researchReportTaskDefinitionId: seed.taskDefinitionId,
        destinationRelativePath: "settlement/report.json",
      },
      params
    );
  };
}

async function driveToTaskBAwaitingApproval(tx: DrizzleTransaction, seed: Seed) {
  const builder = builderFor(tx, seed);
  const { workflowRunId } = await startWorkflowRun(tx, seed.workflowDefinitionId, seed.goalId);
  mockLlmOnce();
  await advanceWorkflowRunToBoundary(tx, workflowRunId, builder);
  expect(await advanceWorkflowRunToBoundary(tx, workflowRunId, builder)).toEqual({ status: "in_progress" });
  return { workflowRunId, builder };
}

async function taskBState(tx: DrizzleTransaction, seed: Seed, workflowRunId: string) {
  const taskInstance = await tx.query.taskInstances.findFirst({
    where: and(eq(schema.taskInstances.workflowRunId, workflowRunId), eq(schema.taskInstances.taskDefinitionId, seed.reviewAndPublishTaskDefinitionId)),
  });
  const run = await tx.query.runs.findFirst({ where: eq(schema.runs.taskInstanceId, taskInstance!.id) });
  const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, run!.id) });
  const approval = await tx.query.approvals.findFirst({ where: eq(schema.approvals.invocationId, invocation!.id) });
  const usd = await tx.query.budgetCounters.findFirst({
    where: and(eq(schema.budgetCounters.scopeRefId, run!.id), eq(schema.budgetCounters.resourceUnit, "usd")),
  });
  const workflowRun = await tx.query.workflowRuns.findFirst({ where: eq(schema.workflowRuns.id, workflowRunId) });
  const failedEvent = await tx.query.events.findFirst({
    where: and(eq(schema.events.invocationId, invocation!.id), eq(schema.events.eventType, "invocation_failed")),
  });
  return { taskInstance, run, invocation, approval, usd, workflowRun, failedEvent };
}

/** A second "report" Artifact on Task A's Run: the publish builder refuses to choose between them. */
async function corruptTaskAReport(tx: DrizzleTransaction, seed: Seed, workflowRunId: string) {
  const taskA = await tx.query.taskInstances.findFirst({
    where: and(eq(schema.taskInstances.workflowRunId, workflowRunId), eq(schema.taskInstances.taskDefinitionId, seed.taskDefinitionId)),
  });
  const runA = await tx.query.runs.findFirst({ where: eq(schema.runs.taskInstanceId, taskA!.id) });
  const [invocation] = await tx.select().from(schema.invocations).where(eq(schema.invocations.runId, runA!.id)).limit(1);
  await tx.insert(schema.artifacts).values({ type: "report", version: 1, producingInvocationId: invocation!.id, hash: "0".repeat(64), size: 1, inlineContent: "x" });
}

describe("a step that cannot be resumed is settled, not left stuck", () => {
  it("an APPROVED step whose builder throws: hold released, Invocation failed with the cause, Approval kept, Workflow Run failed, nothing published", async () => {
    await withRollback(async (tx) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const publishSpy = vi.spyOn(toolBindingModule, "publishReport");
      const seed = await seedPublishWorkflow(tx);
      const { workflowRunId, builder } = await driveToTaskBAwaitingApproval(tx, seed);
      const before = await taskBState(tx, seed, workflowRunId);
      expect(Number(before.usd!.reservedAmount)).toBeGreaterThan(0);

      await resolveApproval(tx, before.approval!.id, "approved", "reviewer");
      await corruptTaskAReport(tx, seed, workflowRunId);

      expect(await advanceWorkflowRunToBoundary(tx, workflowRunId, builder)).toEqual({ status: "failed" });

      const after = await taskBState(tx, seed, workflowRunId);
      expect(after.invocation!.status).toBe("failed");
      expect(after.approval!.status).toBe("approved");
      expect(after.run!.status).toBe("failed");
      expect(after.run!.outcome).toEqual({ status: "failed", reason: STEP_EXECUTION_ERROR_REASON });
      expect(after.taskInstance!.status).toBe("failed");
      expect(after.workflowRun!.status).toBe("failed");
      expect(Number(after.usd!.reservedAmount)).toBeCloseTo(0, 10);
      expect(Number(after.usd!.consumedAmount)).toBeCloseTo(0, 10);
      expect(after.failedEvent!.payload).toMatchObject({
        reason: expect.stringMatching(/^execution_error: .*exactly one "report"/),
        outcome: "not_performed",
        reservationSettlement: "released",
        approvalStatus: "approved",
      });
      expect(publishSpy).not.toHaveBeenCalled();

      // Settled once: a later advance is a no-op on the terminal Workflow Run.
      expect(await advanceWorkflowRunToBoundary(tx, workflowRunId, builder)).toEqual({ status: "failed" });
    });
  });

  it("a PENDING step whose builder throws: the Approval is closed as expired by the system, and the hold is released", async () => {
    await withRollback(async (tx) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const seed = await seedPublishWorkflow(tx);
      const { workflowRunId } = await driveToTaskBAwaitingApproval(tx, seed);
      const failing = builderFor(tx, seed, {
        taskDefinitionId: seed.reviewAndPublishTaskDefinitionId,
        error: () => new Error("builder cannot reconstruct the approved action"),
      });

      expect(await advanceWorkflowRunToBoundary(tx, workflowRunId, failing)).toEqual({ status: "failed" });

      const after = await taskBState(tx, seed, workflowRunId);
      expect(after.approval).toMatchObject({ status: "expired", resolvedBy: "system:execution_error" });
      expect(after.invocation!.status).toBe("failed");
      expect(Number(after.usd!.reservedAmount)).toBeCloseTo(0, 10);
      expect(after.failedEvent!.payload).toMatchObject({ approvalStatus: "expired", reservationSettlement: "released" });
      const expiredEvent = await tx.query.events.findFirst({
        where: and(eq(schema.events.invocationId, after.invocation!.id), eq(schema.events.eventType, "approval_expired")),
      });
      expect(expiredEvent).toBeDefined();
    });
  });

  it("a TRANSIENT database error is not settled: it propagates and the step is left exactly as it was", async () => {
    await withRollback(async (tx) => {
      const seed = await seedPublishWorkflow(tx);
      const { workflowRunId } = await driveToTaskBAwaitingApproval(tx, seed);
      const deadlock = Object.assign(new Error("Failed query: ..."), { cause: Object.assign(new Error("deadlock detected"), { code: "40P01" }) });
      const failing = builderFor(tx, seed, { taskDefinitionId: seed.reviewAndPublishTaskDefinitionId, error: () => deadlock });

      await expect(advanceWorkflowRun(tx, workflowRunId, failing)).rejects.toBe(deadlock);

      const after = await taskBState(tx, seed, workflowRunId);
      expect(after.invocation!.status).toBe("awaiting_approval");
      expect(after.approval!.status).toBe("pending");
      expect(after.workflowRun!.status).toBe("in_progress");
      expect(Number(after.usd!.reservedAmount)).toBeGreaterThan(0);
    });
  });
});

describe("a failing step with an LLM Invocation mid-dispatch", () => {
  async function driveTaskAToDispatch(tx: DrizzleTransaction, seed: Seed) {
    const { workflowRunId } = await startWorkflowRun(tx, seed.workflowDefinitionId, seed.goalId);
    const result = await advanceWorkflowRun(tx, workflowRunId, builderFor(tx, seed));
    expect(result.status).toBe("dispatch_required");
    const dispatch = (result as { dispatch: { invocationId: string; runId: string } }).dispatch;
    return { workflowRunId, dispatch };
  }

  it("is left alone while this process is still dispatching it: the error propagates and nothing changes", async () => {
    await withRollback(async (tx) => {
      const seed = await seedPublishWorkflow(tx);
      const { workflowRunId, dispatch } = await driveTaskAToDispatch(tx, seed);
      try {
        const boom = new Error("builder broke while the call was in flight");
        const failing = builderFor(tx, seed, { taskDefinitionId: seed.taskDefinitionId, error: () => boom });
        await expect(advanceWorkflowRun(tx, workflowRunId, failing)).rejects.toBe(boom);
        const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.id, dispatch.invocationId) });
        expect(invocation!.status).toBe("executing");
      } finally {
        releaseDispatchSlot(dispatch.invocationId);
      }
    });
  });

  it("with no live dispatcher, is settled as interrupted: charged at estimate, never re-dispatched", async () => {
    await withRollback(async (tx) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const seed = await seedPublishWorkflow(tx);
      const { workflowRunId, dispatch } = await driveTaskAToDispatch(tx, seed);
      releaseDispatchSlot(dispatch.invocationId); // the dispatcher died

      const failing = builderFor(tx, seed, { taskDefinitionId: seed.taskDefinitionId, error: () => new Error("builder broke") });
      expect(await advanceWorkflowRun(tx, workflowRunId, failing)).toEqual({ status: "failed" });

      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.id, dispatch.invocationId) });
      expect(invocation!.status).toBe("failed");
      const run = await tx.query.runs.findFirst({ where: eq(schema.runs.id, dispatch.runId) });
      expect(run!.outcome).toMatchObject({ reason: "invocation_interrupted" });
      const failed = await tx.query.events.findFirst({
        where: and(eq(schema.events.invocationId, dispatch.invocationId), eq(schema.events.eventType, "invocation_failed")),
      });
      expect(failed!.payload).toMatchObject({ outcome: "unknown", reservationSettlement: "charged_at_estimate" });
      expect(callClaudeSubscriptionModel).not.toHaveBeenCalled();
      const workflowRun = await tx.query.workflowRuns.findFirst({ where: eq(schema.workflowRuns.id, workflowRunId) });
      expect(workflowRun!.status).toBe("failed");
    });
  });
});
