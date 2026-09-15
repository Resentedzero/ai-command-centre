/**
 * Durable execution (Phase 9).
 *
 * Proves the two properties the transaction split exists for:
 *   1. NO database lock or open transaction is held while a provider call is in
 *      flight (real commits, probed from a second connection mid-dispatch).
 *   2. An Invocation interrupted while `executing` is settled conservatively:
 *      never re-dispatched, reservation charged at its estimate, Run failed, and
 *      the failure carried up to its Workflow step — via the lazy path in
 *      `executeRun` and the startup sweep alike.
 *
 * Only the provider adapters are mocked.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { resetTestSchema, closeTestDb, withRollback, testDb, testPool } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { callClaudeSubscriptionModel } from "../../src/router/providers/claudeSubscription.js";
import {
  completeModelDispatch,
  executeRun,
  failInterruptedInvocation,
  INTERRUPTED_INVOCATION_REASON,
  isDispatchInFlight,
  releaseDispatchSlot,
  releasingDispatchClaimsOnFailure,
} from "../../src/execution/executor.js";
import type { PendingModelDispatch, RunOutcome } from "../../src/execution/types.js";
import { transactionRunner, type TransactionRunner } from "../../src/db/transactionRunner.js";
import { advanceWorkflowRunUntilBlocked, dispatchAndRecord } from "../../src/workflow/advanceWorkflowRunUntilBlocked.js";
import { provisionRunBudgets } from "../../src/governance/runBudgetPolicy.js";
import {
  recoverInterruptedInvocations,
  redriveInProgressWorkflowRuns,
} from "../../src/workflow/recoverInterruptedInvocations.js";
import { pauseWorkflowRun, startWorkflowRun } from "../../src/workflow/interpreter.js";
import { providerConsumptionFrom } from "../../src/router/types.js";
import { acquireExecutorInstanceLock } from "../../src/execution/executorInstanceLock.js";
import { engageStop } from "../../src/governance/executionStop.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

afterEach(() => {
  vi.clearAllMocks();
});

const USAGE = { tokensIn: 40, tokensOut: 10, costAmount: 50, costUnit: "subscription_tokens" as const };
/** The simple llm spec below routes CHEAP on subscription_tokens: maxInputTokens + expectedOutputTokens. */
const ESTIMATE = 1_050;

/** A funded Run inside a Workflow Run, so step settlement can be observed. */
async function seedWorkflowRun(tx: DrizzleTransaction) {
  const [project] = await tx.insert(schema.projects).values({ name: "p-" + randomUUID() }).returning();
  const [workflowDefinition] = await tx
    .insert(schema.workflowDefinitions)
    .values({ name: "wf-" + randomUUID(), version: 1, graphDefinition: {} })
    .returning();
  const [goal] = await tx.insert(schema.goals).values({ projectId: project!.id, title: "g", status: "active" }).returning();
  const [workflowRun] = await tx
    .insert(schema.workflowRuns)
    .values({ workflowDefinitionId: workflowDefinition!.id, workflowDefinitionVersion: 1, goalId: goal!.id, status: "in_progress" })
    .returning();
  const [taskDefinition] = await tx
    .insert(schema.taskDefinitions)
    .values({ name: "t-" + randomUUID(), kind: "standalone", version: 1 })
    .returning();
  const [taskInstance] = await tx
    .insert(schema.taskInstances)
    .values({
      taskDefinitionId: taskDefinition!.id,
      taskDefinitionVersion: 1,
      projectId: project!.id,
      workflowRunId: workflowRun!.id,
      status: "pending",
      input: {},
    })
    .returning();
  const [run] = await tx.insert(schema.runs).values({ taskInstanceId: taskInstance!.id, status: "active" }).returning();
  for (const [unit, limit] of [
    ["usd", "1000.00"],
    ["subscription_tokens", "200000"],
  ] as const) {
    await tx.insert(schema.budgetCounters).values({
      scope: "run",
      scopeRefId: run!.id,
      resourceUnit: unit,
      limitAmount: limit,
      reservedAmount: "0",
      consumedAmount: "0",
    });
  }
  return { runId: run!.id, taskInstanceId: taskInstance!.id, workflowRunId: workflowRun!.id, goalId: goal!.id };
}

function llmSpec() {
  return {
    kind: "llm" as const,
    costClass: "llm" as const,
    intent: "synthesize" as const,
    candidateArtifactIds: [],
    candidateToolCapabilityIds: [],
    contextBudget: {
      maxInputTokens: 1_000,
      maxArtifactTokens: 500,
      maxRetrievedItems: 5,
      maxToolSchemaTokens: 500,
      compressionThreshold: 500,
      freshnessRequirementSeconds: 0,
      expectedOutputTokens: 50,
    },
    taskDifficulty: "simple" as const,
    riskTier: "low" as const,
    expectedOutputShape: { sum: "number" },
  };
}

function expectDispatch(outcome: RunOutcome): PendingModelDispatch {
  if (outcome.status !== "dispatch_required") {
    throw new Error(`expected dispatch_required, got "${outcome.status}"`);
  }
  if (outcome.dispatch.kind !== "llm") throw new Error("expected an llm dispatch");
  return outcome.dispatch;
}

async function tokenCounter(tx: DrizzleTransaction, runId: string) {
  const row = await tx.query.budgetCounters.findFirst({
    where: and(eq(schema.budgetCounters.scopeRefId, runId), eq(schema.budgetCounters.resourceUnit, "subscription_tokens")),
  });
  return { reserved: Number(row!.reservedAmount), consumed: Number(row!.consumedAmount) };
}

/**
 * From a SECOND connection, tries to take every lock the old single-transaction
 * design held across the provider call — without waiting. Each probe reports
 * whether it would have blocked.
 */
async function probeLocks(runId: string) {
  const probe = await testPool.connect();
  const blocked: string[] = [];
  try {
    await probe.query("BEGIN");
    for (const [name, query] of [
      ["runs row", "SELECT id FROM runs WHERE id = $1 FOR UPDATE NOWAIT"],
      ["budget counters", "SELECT id FROM budget_counters WHERE scope_ref_id = $1 FOR UPDATE NOWAIT"],
      ["invocations", "SELECT id FROM invocations WHERE run_id = $1 FOR UPDATE NOWAIT"],
    ] as const) {
      await probe.query("SAVEPOINT p");
      try {
        await probe.query(query, [runId]);
        await probe.query("RELEASE SAVEPOINT p");
      } catch {
        blocked.push(name);
        await probe.query("ROLLBACK TO SAVEPOINT p");
      }
    }
    const advisory = await probe.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok", [runId]);
    if (!advisory.rows[0]!.ok) blocked.push("event advisory lock");
    const status = await probe.query<{ status: string }>("SELECT status FROM invocations WHERE run_id = $1", [runId]);
    return { blocked, committedStatus: status.rows[0]?.status };
  } finally {
    await probe.query("ROLLBACK");
    probe.release();
  }
}

describe("no lock is held during a provider call (real commits)", () => {
  it("control: the probe does detect locks held by an open transaction", async () => {
    const { runId } = await testDb.transaction((tx) => seedWorkflowRun(tx));
    const result = await testDb.transaction(async (tx) => {
      await tx.select().from(schema.runs).where(eq(schema.runs.id, runId)).for("update");
      return probeLocks(runId);
    });
    expect(result.blocked).toContain("runs row");
  });

  it("the Invocation is committed `executing` and nothing is locked while the provider runs", async () => {
    const { runId } = await testDb.transaction((tx) => seedWorkflowRun(tx));
    const runInTx = transactionRunner(testDb);

    let duringDispatch: Awaited<ReturnType<typeof probeLocks>> | undefined;
    let clientsCheckedOut: number | undefined;
    vi.mocked(callClaudeSubscriptionModel).mockImplementationOnce(async () => {
      // No connection is checked out at all: this also catches a call made inside a
      // check transaction that takes no lock the probe could see.
      clientsCheckedOut = testPool.totalCount - testPool.idleCount;
      duringDispatch = await probeLocks(runId);
      return { result: { sum: 1 }, usage: USAGE };
    });

    const dispatch = expectDispatch(await runInTx((tx) => executeRun(tx, runId, [llmSpec()])));
    await dispatchAndRecord(runInTx, dispatch);

    expect(clientsCheckedOut).toBe(0);
    expect(duringDispatch).toEqual({ blocked: [], committedStatus: "executing" });
    expect(isDispatchInFlight(dispatch.invocationId)).toBe(false);

    const final = await runInTx((tx) => executeRun(tx, runId, [llmSpec()]));
    expect(final).toEqual({ status: "completed", runId });
    const counter = await runInTx((tx) => tokenCounter(tx, runId));
    expect(counter).toEqual({ reserved: 0, consumed: USAGE.costAmount });
  });
});

describe("in-flight dispatch", () => {
  it("a second caller reaching an Invocation this process is dispatching changes nothing", async () => {
    await withRollback(async (tx) => {
      const { runId } = await seedWorkflowRun(tx);
      const dispatch = expectDispatch(await executeRun(tx, runId, [llmSpec()]));

      expect(await executeRun(tx, runId, [llmSpec()])).toEqual({ status: "in_flight", runId });
      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.id, dispatch.invocationId) });
      expect(invocation!.status).toBe("executing");
      expect(await tokenCounter(tx, runId)).toEqual({ reserved: ESTIMATE, consumed: 0 });

      vi.mocked(callClaudeSubscriptionModel).mockResolvedValueOnce({ result: { sum: 1 }, usage: USAGE });
      await dispatchAndRecord(transactionRunner(tx), dispatch);
      expect(await executeRun(tx, runId, [llmSpec()])).toEqual({ status: "completed", runId });
      expect(callClaudeSubscriptionModel).toHaveBeenCalledTimes(1);
    });
  });
});

describe("the stop re-check just before a model dispatch (DURABLE_EXECUTION §7 #11)", () => {
  // Every scope the re-check covers for an unbound Run (the agent scope is covered by toolDispatch.test.ts).
  it.each(["global", "goal", "workflow_run", "run"] as const)("a %s stop engaged after the executing commit prevents the provider call; the hold is released and the Run halted", async (scope) => {
    await withRollback(async (tx) => {
      const { runId, workflowRunId, goalId } = await seedWorkflowRun(tx);
      const dispatch = expectDispatch(await executeRun(tx, runId, [llmSpec()]));
      expect(await tokenCounter(tx, runId)).toEqual({ reserved: ESTIMATE, consumed: 0 });

      const scopeRefId = { global: undefined, goal: goalId, workflow_run: workflowRunId, run: runId }[scope];
      await engageStop(tx, { scope, ...(scopeRefId ? { scopeRefId } : {}), reason: "incident" });
      await dispatchAndRecord(transactionRunner(tx), dispatch);

      expect(callClaudeSubscriptionModel).not.toHaveBeenCalled();
      expect(await tokenCounter(tx, runId)).toEqual({ reserved: 0, consumed: 0 });
      const failed = await tx.query.events.findFirst({ where: eq(schema.events.idempotencyKey, `invocation_failed:${dispatch.invocationId}`) });
      expect(failed!.payload).toMatchObject({ reservationSettlement: "released", providerConsumption: "none" });
      const run = await tx.query.runs.findFirst({ where: eq(schema.runs.id, runId) });
      expect(run!.outcome).toMatchObject({ reason: "execution_stopped", stopScope: scope });
      const halted = await tx.query.events.findFirst({ where: eq(schema.events.idempotencyKey, `run_halted:${runId}`) });
      expect(halted?.payload).toMatchObject({ reason: "execution_stopped", stopScope: scope });
    });
  });
});

describe("a failed stop lookup just before a model dispatch fails closed", () => {
  it("no provider call, the hold released, the Run failed (not halted: no stop was found)", async () => {
    // Real transactions, not the savepoint harness: Postgres answers COMMIT of an aborted transaction with a
    // silent ROLLBACK, where RELEASE SAVEPOINT throws, so savepoints would mask a check that swallowed the failure.
    const { runId } = await testDb.transaction((tx) => seedWorkflowRun(tx));
    const runInTx = transactionRunner(testDb);
    const dispatch = expectDispatch(await runInTx((tx) => executeRun(tx, runId, [llmSpec()])));

    await testDb.execute(sql.raw("ALTER TABLE execution_stops RENAME TO execution_stops_unavailable"));
    try {
      await dispatchAndRecord(runInTx, dispatch);
    } finally {
      await testDb.execute(sql.raw("ALTER TABLE execution_stops_unavailable RENAME TO execution_stops"));
    }

    expect(callClaudeSubscriptionModel).not.toHaveBeenCalled();
    expect(await runInTx((tx) => tokenCounter(tx, runId))).toEqual({ reserved: 0, consumed: 0 });
    const failed = await testDb.query.events.findFirst({ where: eq(schema.events.idempotencyKey, `invocation_failed:${dispatch.invocationId}`) });
    expect(failed!.payload).toMatchObject({ reservationSettlement: "released", providerConsumption: "none" });
    const run = await testDb.query.runs.findFirst({ where: eq(schema.runs.id, runId) });
    expect(run!.status).toBe("failed");
    expect(await testDb.query.events.findFirst({ where: eq(schema.events.idempotencyKey, `run_halted:${runId}`) })).toBeUndefined();
  });
});

describe("interrupted Invocations", () => {
  async function assertSettledAsInterrupted(tx: DrizzleTransaction, runId: string, invocationId: string) {
    const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.id, invocationId) });
    expect(invocation!.status).toBe("failed");

    const failed = await tx.query.events.findFirst({
      where: eq(schema.events.idempotencyKey, `invocation_failed:${invocationId}`),
    });
    // The charge itself is recorded as a fact, so the counter movement is explained by the log.
    expect(failed!.payload).toEqual({
      reason: INTERRUPTED_INVOCATION_REASON,
      outcome: "unknown",
      reservationSettlement: "charged_at_estimate",
      chargedAmount: String(ESTIMATE),
      resourceUnit: "subscription_tokens",
    });
    // No usage was observed, so none is invented in the immutable ledger.
    expect(failed!.costAmount).toBeNull();

    // Charged at the full estimate, not released.
    expect(await tokenCounter(tx, runId)).toEqual({ reserved: 0, consumed: ESTIMATE });

    const run = await tx.query.runs.findFirst({ where: eq(schema.runs.id, runId) });
    expect(run!.status).toBe("failed");
    expect(run!.outcome).toEqual({ status: "failed", reason: "invocation_interrupted", invocationId });
    expect((run!.budgetEnvelope as { pendingReservations?: Record<string, string> }).pendingReservations).toEqual({});
  }

  it("lazy path: executeRun settles an `executing` row with no live dispatcher, and never re-dispatches it", async () => {
    await withRollback(async (tx) => {
      const { runId } = await seedWorkflowRun(tx);
      const dispatch = expectDispatch(await executeRun(tx, runId, [llmSpec()]));
      releaseDispatchSlot(dispatch.invocationId); // the dispatcher is gone

      expect(await executeRun(tx, runId, [llmSpec()])).toEqual({ status: "failed", runId });
      expect(callClaudeSubscriptionModel).not.toHaveBeenCalled();
      await assertSettledAsInterrupted(tx, runId, dispatch.invocationId);

      // Terminal: a further call is a no-op, still with no dispatch.
      expect(await executeRun(tx, runId, [llmSpec()])).toEqual({ status: "failed", runId });
      expect(callClaudeSubscriptionModel).not.toHaveBeenCalled();
    });
  });

  it("startup sweep: settles every orphaned `executing` row and carries the failure to its Workflow step", async () => {
    await withRollback(async (tx) => {
      const { runId, taskInstanceId, workflowRunId } = await seedWorkflowRun(tx);
      const dispatch = expectDispatch(await executeRun(tx, runId, [llmSpec()]));
      releaseDispatchSlot(dispatch.invocationId);

      const recovered = await recoverInterruptedInvocations(transactionRunner(tx));
      expect(recovered).toEqual({ recovered: [dispatch.invocationId], failed: [] });
      await assertSettledAsInterrupted(tx, runId, dispatch.invocationId);

      // An interrupted LLM Invocation is retryable (retry policy, 2026-09-15), so the step
      // is left unfinished for the re-drive to start its retry.
      const taskInstance = await tx.query.taskInstances.findFirst({ where: eq(schema.taskInstances.id, taskInstanceId) });
      expect(taskInstance!.status).toBe("pending");
      const workflowRun = await tx.query.workflowRuns.findFirst({ where: eq(schema.workflowRuns.id, workflowRunId) });
      expect(workflowRun!.status).toBe("in_progress");

      // Idempotent: nothing left to recover, nothing charged twice.
      expect(await recoverInterruptedInvocations(transactionRunner(tx))).toEqual({ recovered: [], failed: [] });
      expect(await tokenCounter(tx, runId)).toEqual({ reserved: 0, consumed: ESTIMATE });
      expect(callClaudeSubscriptionModel).not.toHaveBeenCalled();
    });
  });

  it("startup sweep: with the step's attempts exhausted, the interrupted Run fails its step and Workflow Run", async () => {
    await withRollback(async (tx) => {
      const { runId, taskInstanceId, workflowRunId } = await seedWorkflowRun(tx);
      // Two earlier failed attempts: this Run is the third and last (2 retries).
      await tx.insert(schema.runs).values([
        { taskInstanceId, status: "failed" },
        { taskInstanceId, status: "failed" },
      ]);
      const dispatch = expectDispatch(await executeRun(tx, runId, [llmSpec()]));
      releaseDispatchSlot(dispatch.invocationId);

      expect(await recoverInterruptedInvocations(transactionRunner(tx))).toEqual({ recovered: [dispatch.invocationId], failed: [] });
      const taskInstance = await tx.query.taskInstances.findFirst({ where: eq(schema.taskInstances.id, taskInstanceId) });
      expect(taskInstance!.status).toBe("failed");
      const workflowRun = await tx.query.workflowRuns.findFirst({ where: eq(schema.workflowRuns.id, workflowRunId) });
      expect(workflowRun!.status).toBe("failed");
    });
  });

  it("the startup sweep leaves a dispatch this process still owns alone", async () => {
    await withRollback(async (tx) => {
      const { runId } = await seedWorkflowRun(tx);
      const dispatch = expectDispatch(await executeRun(tx, runId, [llmSpec()]));

      expect(await recoverInterruptedInvocations(transactionRunner(tx))).toEqual({ recovered: [], failed: [] });
      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.id, dispatch.invocationId) });
      expect(invocation!.status).toBe("executing");
      releaseDispatchSlot(dispatch.invocationId);
    });
  });

  it("a late outcome for an already-settled Invocation is discarded, never reconciled a second time", async () => {
    await withRollback(async (tx) => {
      const { runId } = await seedWorkflowRun(tx);
      const dispatch = expectDispatch(await executeRun(tx, runId, [llmSpec()]));
      releaseDispatchSlot(dispatch.invocationId);
      expect(await failInterruptedInvocation(tx, dispatch.invocationId)).toBe(true);

      const late = await completeModelDispatch(tx, dispatch, {
        ok: true,
        providerResult: { result: { sum: 1 }, usage: USAGE },
      });
      expect(late).toBe("already_settled");
      expect(await tokenCounter(tx, runId)).toEqual({ reserved: 0, consumed: ESTIMATE });
      expect(await failInterruptedInvocation(tx, dispatch.invocationId)).toBe(false);
    });
  });
});

describe("an ambiguous COMMIT (DURABLE_EXECUTION §7 #4)", () => {
  it("a dispatch whose transaction reports an error after committing is given up: the next advance settles it as interrupted, not in_flight until a restart", async () => {
    const workflowRunId = await testDb.transaction(async (tx) => {
      const [project] = await tx.insert(schema.projects).values({ name: "p-" + randomUUID() }).returning();
      const [taskDefinition] = await tx.insert(schema.taskDefinitions).values({ name: "t-" + randomUUID(), kind: "workflow", version: 1 }).returning();
      const [definition] = await tx
        .insert(schema.workflowDefinitions)
        .values({
          name: "wf-" + randomUUID(),
          version: 1,
          graphDefinition: { kind: "linear", steps: [{ taskDefinitionId: taskDefinition!.id, taskDefinitionVersion: 1 }] },
        })
        .returning();
      const [goal] = await tx.insert(schema.goals).values({ projectId: project!.id, title: "g", status: "active" }).returning();
      return (await startWorkflowRun(tx, definition!.id, goal!.id)).workflowRunId;
    });
    const makeBuilder = (tx: DrizzleTransaction) => async (params: { taskInstanceId: string }) => {
      const run = await tx.query.runs.findFirst({ where: eq(schema.runs.taskInstanceId, params.taskInstanceId) });
      await provisionRunBudgets(tx, run!.id);
      return [llmSpec()];
    };
    // The COMMIT that makes the Invocation `executing` succeeds, but the client sees a connection error.
    let resetAfterCommit = true;
    const runner: TransactionRunner = async (fn) => {
      const result = await testDb.transaction(fn);
      if (resetAfterCommit && (result as { status?: string } | undefined)?.status === "dispatch_required") {
        resetAfterCommit = false;
        throw new Error("Connection terminated unexpectedly");
      }
      return result;
    };

    await expect(advanceWorkflowRunUntilBlocked(runner, workflowRunId, makeBuilder)).rejects.toThrow(/Connection terminated/);
    const [claimed] = await testDb
      .select({ id: schema.invocations.id, status: schema.invocations.status, runId: schema.invocations.runId })
      .from(schema.invocations)
      .innerJoin(schema.runs, eq(schema.runs.id, schema.invocations.runId))
      .innerJoin(schema.taskInstances, eq(schema.taskInstances.id, schema.runs.taskInstanceId))
      .where(eq(schema.taskInstances.workflowRunId, workflowRunId));
    expect(claimed!.status).toBe("executing");
    expect(isDispatchInFlight(claimed!.id)).toBe(false);

    expect(await advanceWorkflowRunUntilBlocked(runner, workflowRunId, makeBuilder)).toEqual({ status: "failed" });
    expect(callClaudeSubscriptionModel).not.toHaveBeenCalled();
    const invocation = await testDb.query.invocations.findFirst({ where: eq(schema.invocations.id, claimed!.id) });
    expect(invocation!.status).toBe("failed");
    const run = await testDb.query.runs.findFirst({ where: eq(schema.runs.id, claimed!.runId) });
    expect(run!.outcome).toMatchObject({ reason: "invocation_interrupted" });
  });

  it("gives up only the claims made inside the failed call, never another request's", async () => {
    await withRollback(async (tx) => {
      const other = expectDispatch(await executeRun(tx, (await seedWorkflowRun(tx)).runId, [llmSpec()]));
      const mine = await seedWorkflowRun(tx);
      let mineId: string | undefined;
      await expect(
        releasingDispatchClaimsOnFailure(async () => {
          mineId = expectDispatch(await executeRun(tx, mine.runId, [llmSpec()])).invocationId;
          throw new Error("reset");
        })
      ).rejects.toThrow("reset");

      expect(isDispatchInFlight(mineId!)).toBe(false);
      expect(isDispatchInFlight(other.invocationId)).toBe(true);
      releaseDispatchSlot(other.invocationId);
    });
  });
});

describe("stops and dispatch", () => {
  it("a stop engaged mid-dispatch still records the call's real outcome, then blocks the next Invocation", async () => {
    await withRollback(async (tx) => {
      const { runId } = await seedWorkflowRun(tx);
      const plan = [llmSpec(), llmSpec()];
      const dispatch = expectDispatch(await executeRun(tx, runId, plan));

      // Engaged while the provider call is in flight (after the pre-dispatch stop
      // re-check passed): the call's real outcome is still recorded.
      vi.mocked(callClaudeSubscriptionModel).mockImplementationOnce(async () => {
        await engageStop(tx, { scope: "run", scopeRefId: runId });
        return { result: { sum: 1 }, usage: USAGE };
      });
      await dispatchAndRecord(transactionRunner(tx), dispatch);

      const first = await tx.query.invocations.findFirst({ where: eq(schema.invocations.id, dispatch.invocationId) });
      expect(first!.status).toBe("completed");
      expect(await tokenCounter(tx, runId)).toEqual({ reserved: 0, consumed: USAGE.costAmount });

      expect(await executeRun(tx, runId, plan)).toEqual({ status: "failed", runId });
      expect(callClaudeSubscriptionModel).toHaveBeenCalledTimes(1);
      const run = await tx.query.runs.findFirst({ where: eq(schema.runs.id, runId) });
      expect(run!.outcome).toMatchObject({ reason: "execution_stopped", stopScope: "run" });
    });
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("concurrency across real transactions", () => {
  it("a second request on another connection sees a live dispatch as in_flight, then the Run completes once", async () => {
    const { runId } = await testDb.transaction((tx) => seedWorkflowRun(tx));
    const runInTx = transactionRunner(testDb);
    const providerMayReturn = deferred();
    vi.mocked(callClaudeSubscriptionModel).mockImplementationOnce(async () => {
      await providerMayReturn.promise;
      return { result: { sum: 1 }, usage: USAGE };
    });

    const dispatch = expectDispatch(await runInTx((tx) => executeRun(tx, runId, [llmSpec()])));
    const firstRequest = dispatchAndRecord(runInTx, dispatch);

    expect(await runInTx((tx) => executeRun(tx, runId, [llmSpec()]))).toEqual({ status: "in_flight", runId });

    providerMayReturn.resolve();
    await firstRequest;
    expect(await runInTx((tx) => executeRun(tx, runId, [llmSpec()]))).toEqual({ status: "completed", runId });
    expect(callClaudeSubscriptionModel).toHaveBeenCalledTimes(1);
  });

  it("a pause racing an advance that finishes the Workflow Run cannot overwrite its terminal status", async () => {
    const { workflowRunId } = await testDb.transaction((tx) => seedWorkflowRun(tx));
    const locked = deferred();
    const mayCommit = deferred();

    const finishing = testDb.transaction(async (tx) => {
      await tx.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, workflowRunId)).for("update");
      await tx.update(schema.workflowRuns).set({ status: "completed" }).where(eq(schema.workflowRuns.id, workflowRunId));
      locked.resolve();
      await mayCommit.promise;
    });
    await locked.promise;

    // Reads `in_progress` (the finish is uncommitted), then its UPDATE blocks on the row lock.
    const pausing = testDb.transaction((tx) => pauseWorkflowRun(tx, workflowRunId));
    await sleep(200);
    mayCommit.resolve();
    await finishing;

    await expect(pausing).rejects.toThrow(/stopped being "in_progress"/);
    const row = await testDb.query.workflowRuns.findFirst({ where: eq(schema.workflowRuns.id, workflowRunId) });
    expect(row!.status).toBe("completed");
  });
});

describe("recovery robustness", () => {
  it("one Invocation that cannot be settled is reported and skipped; the rest are still recovered", async () => {
    await withRollback(async (tx) => {
      const bad = await seedWorkflowRun(tx);
      const good = await seedWorkflowRun(tx);
      const badDispatch = expectDispatch(await executeRun(tx, bad.runId, [llmSpec()]));
      const goodDispatch = expectDispatch(await executeRun(tx, good.runId, [llmSpec()]));
      releaseDispatchSlot(badDispatch.invocationId);
      releaseDispatchSlot(goodDispatch.invocationId);
      // Corrupt the bad Run's recorded reservation handle.
      await tx
        .update(schema.runs)
        .set({ budgetEnvelope: { pendingReservations: { "1": "res_not-a-valid-reservation" } } })
        .where(eq(schema.runs.id, bad.runId));

      const report = await recoverInterruptedInvocations(transactionRunner(tx));
      expect(report.recovered).toEqual([goodDispatch.invocationId]);
      expect(report.failed.map((f) => f.invocationId)).toEqual([badDispatch.invocationId]);

      const badInvocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.id, badDispatch.invocationId) });
      expect(badInvocation!.status).toBe("executing"); // left for an operator, not half-settled
    });
  });

  it("startup re-drive continues an in-progress Workflow Run and leaves a paused one untouched", async () => {
    await withRollback(async (tx) => {
      const [project] = await tx.insert(schema.projects).values({ name: "p-" + randomUUID() }).returning();
      const [taskDefinition] = await tx
        .insert(schema.taskDefinitions)
        .values({ name: "t-" + randomUUID(), kind: "workflow", version: 1 })
        .returning();
      const [definition] = await tx
        .insert(schema.workflowDefinitions)
        .values({
          name: "wf-" + randomUUID(),
          version: 1,
          graphDefinition: { kind: "linear", steps: [{ taskDefinitionId: taskDefinition!.id, taskDefinitionVersion: 1 }] },
        })
        .returning();
      const goal = async () =>
        (await tx.insert(schema.goals).values({ projectId: project!.id, title: "g", status: "active" }).returning())[0]!.id;

      // Started, but its process died before advancing it at all.
      const { workflowRunId: stranded } = await startWorkflowRun(tx, definition!.id, await goal());
      const { workflowRunId: paused } = await startWorkflowRun(tx, definition!.id, await goal());
      await pauseWorkflowRun(tx, paused);

      const execute = vi.fn(async () => ({}));
      const report = await redriveInProgressWorkflowRuns(transactionRunner(tx), () => async () => [
        { kind: "deterministic" as const, costClass: "deterministic" as const, execute },
      ]);

      expect(report.redriven).toContainEqual({ workflowRunId: stranded, status: "completed" });
      expect(report.redriven.map((r) => r.workflowRunId)).not.toContain(paused);
      expect(execute).toHaveBeenCalledTimes(1);
      const pausedRow = await tx.query.workflowRuns.findFirst({ where: eq(schema.workflowRuns.id, paused) });
      expect(pausedRow!.status).toBe("paused");
    });
  });
});

describe("failed-dispatch consumption classification", () => {
  it("only failures that provably sent nothing (or were refused outright) release; everything else is charged", async () => {
    const { ClaudeSubscriptionError } = await vi.importActual<
      typeof import("../../src/router/providers/claudeSubscription.js")
    >("../../src/router/providers/claudeSubscription.js");

    for (const code of ["cli_unavailable", "misconfigured", "input_too_large", "auth_expired", "quota_exhausted"] as const) {
      expect(providerConsumptionFrom(new ClaudeSubscriptionError(code, "x")), code).toBe("none");
    }
    for (const code of ["timeout", "nonzero_exit", "parse_error", "no_result", "schema_validation", "usage_missing"] as const) {
      expect(providerConsumptionFrom(new ClaudeSubscriptionError(code, "x")), code).toBe("unknown");
    }
    // Unmarked errors default to the conservative reading.
    expect(providerConsumptionFrom(new Error("anything"))).toBe("unknown");
    expect(providerConsumptionFrom(Object.assign(new Error("x"), { consumption: "maybe" }))).toBe("unknown");
  });
});

describe("executor instance lock", () => {
  it("admits exactly one executing process per database, and frees on release", async () => {
    const first = await acquireExecutorInstanceLock(testPool);
    try {
      await expect(acquireExecutorInstanceLock(testPool)).rejects.toThrow(/already holds the executor instance lock/);
    } finally {
      await first.query("select pg_advisory_unlock_all()");
      first.release();
    }
    const again = await acquireExecutorInstanceLock(testPool);
    await again.query("select pg_advisory_unlock_all()");
    again.release();
  });
});
