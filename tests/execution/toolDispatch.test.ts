/**
 * Crash-safe tool side effects (DURABLE_EXECUTION §2.1, spec §12).
 *
 * A tool's `execute` runs only after its Invocation is COMMITTED as `executing`,
 * with no transaction open, and only after a pre-effect authorization re-check.
 * So:
 *   - a crash before the outcome is recorded leaves a durable claim; recovery
 *     settles it (charged at estimate) and the effect is never performed again;
 *   - two execution paths cannot both perform it: the second sees `in_flight`;
 *   - a stop or a trust downgrade that lands after the claim still prevents it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { closeTestDb, resetTestSchema, testDb, testPool, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { completeToolDispatch, executeRun, releaseDispatchSlot, settleRunAfterStepFailure } from "../../src/execution/executor.js";
import type { PendingToolDispatch, RunOutcome, ToolExecutionContext, ToolInvocationSpec } from "../../src/execution/types.js";
import { transactionRunner } from "../../src/db/transactionRunner.js";
import { dispatchAndRecord } from "../../src/workflow/advanceWorkflowRunUntilBlocked.js";
import { recoverInterruptedInvocations } from "../../src/workflow/recoverInterruptedInvocations.js";
import { engageStop, liftStop } from "../../src/governance/executionStop.js";
import { resolveApproval } from "../../src/governance/approvals.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ESTIMATE = 3;

/** An AUTONOMOUS tool Grant on a funded Run inside a Workflow Run. */
async function seedToolRun(tx: DrizzleTransaction, autonomyState: "AUTONOMOUS" | "ALWAYS_APPROVE" = "AUTONOMOUS") {
  const [capability] = await tx.insert(schema.capabilities).values({ name: "cap-" + randomUUID(), staticRiskTag: "low" }).returning();
  const [binding] = await tx
    .insert(schema.toolBindings)
    .values({ capabilityId: capability!.id, kind: "internal", config: {}, trustLevel: 2, version: 1 })
    .returning();
  const [agent] = await tx
    .insert(schema.agentDefinitions)
    .values({ name: "agent-" + randomUUID(), version: 1, role: "tester", objective: "test", instructions: "n/a" })
    .returning();
  const [grant] = await tx.insert(schema.capabilityGrants).values({
    agentDefinitionId: agent!.id,
    agentDefinitionVersion: 1,
    capabilityId: capability!.id,
    permissions: ["WRITE"],
    maxTrustLevelRequired: 1,
    autonomyState,
  }).returning();
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
  const [taskDefinition] = await tx.insert(schema.taskDefinitions).values({ name: "t-" + randomUUID(), kind: "standalone", version: 1 }).returning();
  const [taskInstance] = await tx
    .insert(schema.taskInstances)
    .values({ taskDefinitionId: taskDefinition!.id, taskDefinitionVersion: 1, projectId: project!.id, workflowRunId: workflowRun!.id, status: "active", input: {} })
    .returning();
  const [run] = await tx
    .insert(schema.runs)
    .values({ taskInstanceId: taskInstance!.id, agentDefinitionId: agent!.id, agentDefinitionVersion: 1, status: "active" })
    .returning();
  await tx.insert(schema.budgetCounters).values({ scope: "run", scopeRefId: run!.id, resourceUnit: "usd", limitAmount: "100.00", reservedAmount: "0", consumedAmount: "0" });
  return {
    runId: run!.id,
    capabilityId: capability!.id,
    toolBindingId: binding!.id,
    workflowRunId: workflowRun!.id,
    goalId: goal!.id,
    agentDefinitionId: agent!.id,
    grantId: grant!.id,
  };
}

function toolSpec(ids: { capabilityId: string; toolBindingId: string }, execute: ToolInvocationSpec["execute"]): ToolInvocationSpec {
  return {
    kind: "tool",
    costClass: "external_side_effect",
    capabilityId: ids.capabilityId,
    permission: "WRITE",
    proposedActionSnapshot: { action: "write-thing" },
    toolBindingId: ids.toolBindingId,
    estimatedCost: ESTIMATE,
    execute,
  };
}

function expectToolDispatch(outcome: RunOutcome): PendingToolDispatch {
  if (outcome.status !== "dispatch_required" || outcome.dispatch.kind !== "tool") {
    throw new Error(`expected a tool dispatch, got "${outcome.status}"`);
  }
  return outcome.dispatch;
}

async function usd(tx: DrizzleTransaction, runId: string) {
  const row = await tx.query.budgetCounters.findFirst({
    where: and(eq(schema.budgetCounters.scopeRefId, runId), eq(schema.budgetCounters.resourceUnit, "usd")),
  });
  return { reserved: Number(row!.reservedAmount), consumed: Number(row!.consumedAmount) };
}

async function failedPayload(tx: DrizzleTransaction, invocationId: string) {
  const event = await tx.query.events.findFirst({
    where: and(eq(schema.events.invocationId, invocationId), eq(schema.events.eventType, "invocation_failed")),
  });
  return event?.payload as Record<string, unknown> | undefined;
}

describe("the effect happens only after a durable claim", () => {
  it("execute runs with the Invocation already COMMITTED as executing, no lock held, and receives its persisted idempotency key", async () => {
    const ids = await testDb.transaction((tx) => seedToolRun(tx));
    const runInTx = transactionRunner(testDb);
    const seen: { status?: string; runLockFree?: boolean; clientsCheckedOut?: number; ctx?: ToolExecutionContext } = {};
    const execute = vi.fn(async (ctx: ToolExecutionContext) => {
      // No connection checked out: the effect is not running inside the re-check's transaction.
      seen.clientsCheckedOut = testPool.totalCount - testPool.idleCount;
      const probe = await testPool.connect();
      try {
        const status = await probe.query<{ status: string }>("SELECT status FROM invocations WHERE id = $1", [ctx.invocationId]);
        seen.status = status.rows[0]?.status;
        await probe.query("BEGIN");
        await probe.query("SELECT id FROM runs WHERE id = $1 FOR UPDATE NOWAIT", [ids.runId]);
        seen.runLockFree = true;
        await probe.query("ROLLBACK");
      } finally {
        probe.release();
      }
      seen.ctx = ctx;
      return { wrote: true };
    });

    const dispatch = expectToolDispatch(await runInTx((tx) => executeRun(tx, ids.runId, [toolSpec(ids, execute)])));
    expect(execute).not.toHaveBeenCalled();
    await dispatchAndRecord(runInTx, dispatch);

    expect(seen.status).toBe("executing");
    expect(seen.runLockFree).toBe(true);
    expect(seen.clientsCheckedOut).toBe(0);
    const invocation = await testDb.query.invocations.findFirst({ where: eq(schema.invocations.id, dispatch.invocationId) });
    expect(seen.ctx).toEqual({ invocationId: invocation!.id, idempotencyKey: invocation!.idempotencyKey });
    expect(invocation!.status).toBe("completed");
    expect(await runInTx((tx) => executeRun(tx, ids.runId, [toolSpec(ids, execute)]))).toEqual({ status: "completed", runId: ids.runId });
    expect(await usd(testDb as unknown as DrizzleTransaction, ids.runId)).toEqual({ reserved: 0, consumed: ESTIMATE });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("an approved tool", () => {
  it("returns its Run to active when the dispatch is claimed, not left reading awaiting_approval", async () => {
    await withRollback(async (tx) => {
      const ids = await seedToolRun(tx, "ALWAYS_APPROVE");
      const execute = vi.fn(async () => ({ wrote: true }));
      expect((await executeRun(tx, ids.runId, [toolSpec(ids, execute)])).status).toBe("awaiting_approval");
      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, ids.runId) });
      const approval = await tx.query.approvals.findFirst({ where: eq(schema.approvals.invocationId, invocation!.id) });
      await resolveApproval(tx, approval!.id, "approved", "reviewer");

      const dispatch = expectToolDispatch(await executeRun(tx, ids.runId, [toolSpec(ids, execute)]));
      releaseDispatchSlot(dispatch.invocationId);
      const run = await tx.query.runs.findFirst({ where: eq(schema.runs.id, ids.runId) });
      expect(run!.status).toBe("active");
    });
  });
});

describe("interruption: a claimed effect is never performed twice", () => {
  it("a dispatcher that died before recording: the next advance settles it as interrupted and does not call execute again", async () => {
    await withRollback(async (tx) => {
      const ids = await seedToolRun(tx);
      const execute = vi.fn(async () => ({ wrote: true }));
      const dispatch = expectToolDispatch(await executeRun(tx, ids.runId, [toolSpec(ids, execute)]));
      releaseDispatchSlot(dispatch.invocationId); // crashed: claimed, maybe performed, never recorded

      expect(await executeRun(tx, ids.runId, [toolSpec(ids, execute)])).toEqual({ status: "failed", runId: ids.runId });

      expect(execute).not.toHaveBeenCalled();
      expect(await failedPayload(tx, dispatch.invocationId)).toMatchObject({
        reason: "interrupted_outcome_unknown",
        outcome: "unknown",
        reservationSettlement: "charged_at_estimate",
      });
      expect(await usd(tx, ids.runId)).toEqual({ reserved: 0, consumed: ESTIMATE });
    });
  });

  it("the startup sweep settles an interrupted tool Invocation the same way", async () => {
    await withRollback(async (tx) => {
      const ids = await seedToolRun(tx);
      const dispatch = expectToolDispatch(await executeRun(tx, ids.runId, [toolSpec(ids, vi.fn(async () => ({})))]));
      releaseDispatchSlot(dispatch.invocationId);

      expect(await recoverInterruptedInvocations(transactionRunner(tx))).toEqual({ recovered: [dispatch.invocationId], failed: [] });
      const workflowRun = await tx.query.workflowRuns.findFirst({ where: eq(schema.workflowRuns.id, ids.workflowRunId) });
      expect(workflowRun!.status).toBe("failed");
    });
  });

  it("a late outcome for an already-settled tool Invocation is discarded: nothing is settled twice", async () => {
    await withRollback(async (tx) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const ids = await seedToolRun(tx);
      const dispatch = expectToolDispatch(await executeRun(tx, ids.runId, [toolSpec(ids, vi.fn(async () => ({})))]));
      releaseDispatchSlot(dispatch.invocationId);
      await executeRun(tx, ids.runId, [toolSpec(ids, vi.fn(async () => ({})))]); // settles as interrupted
      const afterSettlement = await usd(tx, ids.runId);

      expect(await completeToolDispatch(tx, dispatch, { ok: true, result: { late: true } })).toBe("already_settled");
      expect(await usd(tx, ids.runId)).toEqual(afterSettlement);
    });
  });
});

describe("the pre-effect re-check", () => {
  it.each(["global", "agent_definition", "capability_grant", "goal", "workflow_run", "run"] as const)("a %s stop engaged after the claim prevents the effect; the hold is released, because nothing was performed", async (scope) => {
    await withRollback(async (tx) => {
      const ids = await seedToolRun(tx);
      const execute = vi.fn(async () => ({ wrote: true }));
      const dispatch = expectToolDispatch(await executeRun(tx, ids.runId, [toolSpec(ids, execute)]));

      const scopeRefId = {
        global: undefined,
        agent_definition: ids.agentDefinitionId,
        capability_grant: ids.grantId,
        goal: ids.goalId,
        workflow_run: ids.workflowRunId,
        run: ids.runId,
      }[scope];
      const target = { scope, ...(scopeRefId ? { scopeRefId } : {}) };
      await engageStop(tx, { ...target, reason: "incident" });
      try {
        await dispatchAndRecord(transactionRunner(tx), dispatch);
      } finally {
        await liftStop(tx, target);
      }

      expect(execute).not.toHaveBeenCalled();
      expect(await failedPayload(tx, dispatch.invocationId)).toMatchObject({ reservationSettlement: "released", providerConsumption: "none" });
      expect(await usd(tx, ids.runId)).toEqual({ reserved: 0, consumed: 0 });
      // Recorded exactly as a stop caught at the Invocation boundary is.
      const run = await tx.query.runs.findFirst({ where: eq(schema.runs.id, ids.runId) });
      expect(run!.outcome).toMatchObject({ reason: "execution_stopped", stopScope: scope });
      const halted = await tx.query.events.findFirst({ where: eq(schema.events.idempotencyKey, `run_halted:${ids.runId}`) });
      expect(halted?.payload).toMatchObject({ reason: "execution_stopped", stopScope: scope });
    });
  });

  it("a Tool Binding downgraded below the Grant's trust bar after the claim prevents the effect", async () => {
    await withRollback(async (tx) => {
      const ids = await seedToolRun(tx);
      const execute = vi.fn(async () => ({ wrote: true }));
      const dispatch = expectToolDispatch(await executeRun(tx, ids.runId, [toolSpec(ids, execute)]));

      await tx.update(schema.toolBindings).set({ trustLevel: 0 }).where(eq(schema.toolBindings.id, ids.toolBindingId));
      await dispatchAndRecord(transactionRunner(tx), dispatch);

      expect(execute).not.toHaveBeenCalled();
      expect(await failedPayload(tx, dispatch.invocationId)).toMatchObject({
        reason: expect.stringMatching(/policy_denied_before_dispatch/),
        reservationSettlement: "released",
      });
      // The refused evaluation is still recorded: the check commits it before the Invocation fails.
      const preDispatch = await tx.query.events.findFirst({
        where: eq(schema.events.idempotencyKey, `policy_evaluated:${dispatch.invocationId}:pre_dispatch`),
      });
      expect(preDispatch?.payload).toMatchObject({ checkpoint: "pre_dispatch", decision: "DENY", bindingTrustLevel: 0 });
    });
  });

  it("an execute() error of unknown effect is charged at estimate; one proving nothing was performed is released", async () => {
    await withRollback(async (tx) => {
      const unknown = await seedToolRun(tx);
      const refused = await seedToolRun(tx);
      const boom = vi.fn(async () => {
        throw new Error("connection reset mid-write");
      });
      const noEffect = vi.fn(async () => {
        throw Object.assign(new Error("destination refused"), { consumption: "none" as const });
      });

      await dispatchAndRecord(transactionRunner(tx), expectToolDispatch(await executeRun(tx, unknown.runId, [toolSpec(unknown, boom)])));
      await dispatchAndRecord(transactionRunner(tx), expectToolDispatch(await executeRun(tx, refused.runId, [toolSpec(refused, noEffect)])));

      expect(await usd(tx, unknown.runId)).toEqual({ reserved: 0, consumed: ESTIMATE });
      expect(await usd(tx, refused.runId)).toEqual({ reserved: 0, consumed: 0 });
    });
  });
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe("concurrency across real transactions", () => {
  it("step-failure settlement racing an approve records the Approval's real decision, not the stale pending it read", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const ids = await testDb.transaction((tx) => seedToolRun(tx, "ALWAYS_APPROVE"));
    const spec = toolSpec(ids, vi.fn(async () => ({})));
    expect((await testDb.transaction((tx) => executeRun(tx, ids.runId, [spec]))).status).toBe("awaiting_approval");
    const invocation = await testDb.query.invocations.findFirst({ where: eq(schema.invocations.runId, ids.runId) });
    const approval = await testDb.query.approvals.findFirst({ where: eq(schema.approvals.invocationId, invocation!.id) });

    const approved = deferred();
    const mayCommit = deferred();
    const approving = testDb.transaction(async (tx) => {
      await resolveApproval(tx, approval!.id, "approved", "reviewer");
      approved.resolve();
      await mayCommit.promise;
    });
    await approved.promise;

    // Reads `pending`, then its conditional expire blocks on the decided row.
    const settling = testDb.transaction((tx) => settleRunAfterStepFailure(tx, ids.runId, new Error("builder broke")));
    await new Promise((r) => setTimeout(r, 200));
    mayCommit.resolve();
    await approving;
    await settling;

    const failed = await testDb.query.events.findFirst({
      where: and(eq(schema.events.invocationId, invocation!.id), eq(schema.events.eventType, "invocation_failed")),
    });
    expect(failed!.payload).toMatchObject({ approvalStatus: "approved" });
    consoleError.mockRestore();
  });

  it("a second request on another connection sees the claimed effect as in_flight; the effect happens exactly once", async () => {
    const ids = await testDb.transaction((tx) => seedToolRun(tx));
    const runInTx = transactionRunner(testDb);
    const mayFinish = deferred();
    const started = deferred();
    const execute = vi.fn(async () => {
      started.resolve();
      await mayFinish.promise;
      return { wrote: true };
    });

    const dispatch = expectToolDispatch(await runInTx((tx) => executeRun(tx, ids.runId, [toolSpec(ids, execute)])));
    const first = dispatchAndRecord(runInTx, dispatch);
    await started.promise;

    expect(await runInTx((tx) => executeRun(tx, ids.runId, [toolSpec(ids, execute)]))).toEqual({ status: "in_flight", runId: ids.runId });

    mayFinish.resolve();
    await first;
    expect(await runInTx((tx) => executeRun(tx, ids.runId, [toolSpec(ids, execute)]))).toEqual({ status: "completed", runId: ids.runId });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
