/**
 * Retries end to end (operator decision D1, 2026-09-15; spec §3d, §10.4): through the
 * HTTP API against the seeded Research-and-Publish workflow, with every provider adapter
 * mocked. A retryable failure of Task A's LLM Invocation creates a new Run on the same
 * Task Instance; a validation failure escalates it one tier; anything else, or a third
 * failed Run, fails the Task Instance and the Workflow Run as before.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeTestDb, resetTestSchema, testDb } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import { seedPublishWorkflow } from "../../src/definitions/seed.js";
import { findSeededPublishWorkflow, type SeededWorkflowRefs } from "../../src/definitions/lookupSeed.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { callClaudeSubscriptionModel } from "../../src/router/providers/claudeSubscription.js";
import { callAnthropicModel } from "../../src/router/providers/anthropic.js";
import { callOpenAiModel } from "../../src/router/providers/openai.js";
import { buildServer } from "../../src/api/server.js";

let app: FastifyInstance;
let refs: SeededWorkflowRefs;

beforeAll(async () => {
  await resetTestSchema();
  await testDb.transaction((tx) => seedPublishWorkflow(tx));
  refs = (await testDb.transaction((tx) => findSeededPublishWorkflow(tx)))!;
  app = buildServer({ db: testDb });
  await app.ready();
}, 30000);

afterAll(async () => {
  await app.close();
  await closeTestDb();
});

afterEach(() => {
  vi.resetAllMocks();
  expect(callAnthropicModel).not.toHaveBeenCalled();
  expect(callOpenAiModel).not.toHaveBeenCalled();
});

const report = { result: { report: "retried report" }, usage: { tokensIn: 100, tokensOut: 50, costAmount: 150, costUnit: "subscription_tokens" as const } };
const providerError = (message: string, fields: Record<string, unknown>) => Object.assign(new Error(message), fields);
const unknownConsumption = () => providerError("the CLI exceeded its timeout", { code: "timeout", consumption: "unknown" });

async function startGoal(title: string) {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const res = await app.inject({ method: "POST", url: "/goals", payload: { title } });
    expect(res.statusCode).toBe(201);
    return res.json() as { goalId: string; workflowRunId: string; status: string };
  } finally {
    consoleError.mockRestore();
  }
}

async function taskA(workflowRunId: string) {
  const row = await testDb.query.taskInstances.findFirst({
    where: and(eq(schema.taskInstances.workflowRunId, workflowRunId), eq(schema.taskInstances.taskDefinitionId, refs.taskDefinitionId)),
  });
  const runs = await testDb.query.runs.findMany({
    where: eq(schema.runs.taskInstanceId, row!.id),
    orderBy: [asc(schema.runs.startedAt), asc(schema.runs.id)],
  });
  return { taskInstance: row!, runs };
}

async function runEvents(runId: string, eventType: string) {
  return testDb.query.events.findMany({ where: and(eq(schema.events.runId, runId), eq(schema.events.eventType, eventType)) });
}

describe("retry policy through the API", () => {
  it("a provider failure of unknown consumption is retried as a new Run on the same Task Instance, which then completes", async () => {
    vi.mocked(callClaudeSubscriptionModel).mockRejectedValueOnce(unknownConsumption()).mockResolvedValueOnce(report);

    const created = await startGoal("Retry once");
    // Task A completed on its second Run; the Workflow Run went on to Task B's approval gate.
    expect(created.status).toBe("in_progress");
    expect(callClaudeSubscriptionModel).toHaveBeenCalledTimes(2);

    const { taskInstance, runs } = await taskA(created.workflowRunId);
    expect(taskInstance.status).toBe("completed");
    expect(runs.map((r) => r.status)).toEqual(["failed", "completed"]);
    expect(runs[1]!.minimumModelTier).toBeNull();

    // The retry is recorded on its own run_started; the Task Instance never recorded a failure.
    const [started] = await runEvents(runs[1]!.id, "run_started");
    expect(started!.payload).toEqual({ attempt: 2, retryOfRunId: runs[0]!.id, cause: "provider_outcome_unknown", minimumModelTier: null });
    const taskInstanceFailures = await testDb.query.events.findMany({
      where: and(eq(schema.events.taskInstanceId, taskInstance.id), eq(schema.events.eventType, "task_instance_failed")),
    });
    expect(taskInstanceFailures).toEqual([]);

    // The detail view keeps the current Run and lists every attempt.
    const detail = await app.inject({ method: "GET", url: `/workflow-runs/${created.workflowRunId}` });
    const step = (detail.json() as { steps: { run: { id: string } | null; attempts: { id: string; status: string }[] }[] }).steps[0]!;
    expect(step.run!.id).toBe(runs[1]!.id);
    expect(step.attempts.map((a) => [a.id, a.status])).toEqual([
      [runs[0]!.id, "failed"],
      [runs[1]!.id, "completed"],
    ]);
  });

  it("stops after two retries: three failed Runs fail the Task Instance and the Workflow Run", async () => {
    vi.mocked(callClaudeSubscriptionModel).mockRejectedValue(unknownConsumption());

    const created = await startGoal("Retry exhausted");
    expect(created.status).toBe("failed");
    expect(callClaudeSubscriptionModel).toHaveBeenCalledTimes(3);

    const { taskInstance, runs } = await taskA(created.workflowRunId);
    expect(runs.map((r) => r.status)).toEqual(["failed", "failed", "failed"]);
    expect(taskInstance.status).toBe("failed");
    const [third] = await runEvents(runs[2]!.id, "run_started");
    expect(third!.payload).toMatchObject({ attempt: 3, retryOfRunId: runs[1]!.id });
  });

  it("a validation failure is retried one tier up, and the Router records the floor it applied", async () => {
    vi.mocked(callClaudeSubscriptionModel)
      .mockRejectedValueOnce(providerError("structured-output validation failed", { code: "schema_validation" }))
      .mockResolvedValueOnce(report);

    const created = await startGoal("Escalate once");
    expect(created.status).toBe("in_progress");

    const { runs } = await taskA(created.workflowRunId);
    expect(runs.map((r) => r.status)).toEqual(["failed", "completed"]);
    const [firstRoute] = (await runEvents(runs[0]!.id, "invocation_started")).filter((e) => e.payload && "resultingTier" in e.payload);
    expect(firstRoute!.payload).toMatchObject({ defaultTier: "CHEAP", escalationFloor: null, resultingTier: "CHEAP" });

    expect(runs[1]!.minimumModelTier).toBe("MID");
    const [started] = await runEvents(runs[1]!.id, "run_started");
    expect(started!.payload).toMatchObject({ cause: "output_validation_failed", minimumModelTier: "MID" });
    const [secondRoute] = (await runEvents(runs[1]!.id, "invocation_started")).filter((e) => e.payload && "resultingTier" in e.payload);
    expect(secondRoute!.payload).toMatchObject({ defaultTier: "CHEAP", escalationFloor: "MID", resultingTier: "MID" });
    expect(vi.mocked(callClaudeSubscriptionModel).mock.calls.map((call) => call[0])).toEqual(["claude-haiku-4-5-20251001", "claude-sonnet-5"]);
  });

  it("an LLM Invocation interrupted by a dead process: the sweep leaves the step unfinished and the re-drive retries it", async () => {
    const { advanceWorkflowRun, startWorkflowRun } = await import("../../src/workflow/interpreter.js");
    const { dispatchAndRecord } = await import("../../src/workflow/advanceWorkflowRunUntilBlocked.js");
    const { releaseDispatchSlot } = await import("../../src/execution/executor.js");
    const { buildInvocationSpecsFromDefinitions } = await import("../../src/workflow/buildInvocationSpecsFromDefinitions.js");
    const { recoverInterruptedInvocations, redriveInProgressWorkflowRuns } = await import("../../src/workflow/recoverInterruptedInvocations.js");
    const { transactionRunner } = await import("../../src/db/transactionRunner.js");
    const runInTx = transactionRunner(testDb);

    const workflowRunId = await runInTx(async (tx) => {
      const [goal] = await tx.insert(schema.goals).values({ projectId: refs.projectId, title: "Crash mid-call", status: "active" }).returning();
      return (await startWorkflowRun(tx, refs.workflowDefinitionId, goal!.id)).workflowRunId;
    });
    // Drive to Task A's model dispatch, performing the tool on the way, then "crash": the claim is committed, never dispatched.
    for (;;) {
      const advanced = await runInTx((tx) => advanceWorkflowRun(tx, workflowRunId, buildInvocationSpecsFromDefinitions(tx)));
      if (advanced.status !== "dispatch_required") throw new Error(`expected a dispatch, got ${advanced.status}`);
      if (advanced.dispatch.kind === "llm") {
        releaseDispatchSlot(advanced.dispatch.invocationId);
        break;
      }
      await dispatchAndRecord(runInTx, advanced.dispatch);
    }

    const recovery = await recoverInterruptedInvocations(runInTx);
    expect(recovery.failed).toEqual([]);
    const afterSweep = await taskA(workflowRunId);
    expect(afterSweep.runs.map((r) => r.status)).toEqual(["failed"]);
    expect(afterSweep.taskInstance.status).not.toBe("failed");
    expect((await testDb.query.workflowRuns.findFirst({ where: eq(schema.workflowRuns.id, workflowRunId) }))!.status).toBe("in_progress");
    expect(callClaudeSubscriptionModel).not.toHaveBeenCalled();

    vi.mocked(callClaudeSubscriptionModel).mockResolvedValueOnce(report);
    await redriveInProgressWorkflowRuns(runInTx, buildInvocationSpecsFromDefinitions);
    const afterRedrive = await taskA(workflowRunId);
    expect(afterRedrive.runs.map((r) => r.status)).toEqual(["failed", "completed"]);
    expect(afterRedrive.taskInstance.status).toBe("completed");
    const [started] = await runEvents(afterRedrive.runs[1]!.id, "run_started");
    expect(started!.payload).toMatchObject({ attempt: 2, cause: "provider_outcome_unknown" });
  });

  it("a provider failure that consumed nothing is not retried", async () => {
    vi.mocked(callClaudeSubscriptionModel).mockRejectedValueOnce(
      providerError("the Claude subscription login has expired", { code: "auth_expired", consumption: "none" })
    );

    const created = await startGoal("No retry");
    expect(created.status).toBe("failed");
    expect(callClaudeSubscriptionModel).toHaveBeenCalledTimes(1);
    const { taskInstance, runs } = await taskA(created.workflowRunId);
    expect(runs.map((r) => r.status)).toEqual(["failed"]);
    expect(taskInstance.status).toBe("failed");
  });
});
