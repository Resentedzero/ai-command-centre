/**
 * Startup recovery (Phase 9): settle Invocations a dead process left
 * `executing`, then re-drive Workflow Runs a dead process left mid-advance.
 *
 * Both run while this process holds the executor instance lock
 * (`../execution/executorInstanceLock.ts`), so nothing else is executing.
 *
 * ---------------------------------------------------------------------------
 * recoverInterruptedInvocations — before the API accepts requests
 * ---------------------------------------------------------------------------
 * Nothing can be in flight at startup, so every `executing` row is interrupted
 * by definition. Each is settled by `failInterruptedInvocation` (never
 * re-dispatched; reservation charged at its estimate; Run failed), and the
 * failure is carried up to its Workflow step and Workflow Run — otherwise a
 * recovered Workflow Run would sit `in_progress` with nothing left to drive it.
 *
 * One transaction per Invocation, and a row that cannot be settled (corrupt
 * reservation data, a vanished budget counter) is logged and SKIPPED rather
 * than aborting startup: one bad row must never keep the whole system down, and
 * it would fail identically on every restart. Skipped rows are returned so the
 * caller can surface them. Lock order matches the interpreter: workflow_runs,
 * then runs, then invocations.
 *
 * `executeRun` performs the same settlement lazily when it meets an
 * `executing` row this process is not dispatching, so recovery does not depend
 * on this sweep having run — the sweep makes it prompt and visible.
 *
 * ---------------------------------------------------------------------------
 * redriveInProgressWorkflowRuns — after the API is listening
 * ---------------------------------------------------------------------------
 * A request commits in several transactions, so a process can die between
 * them: after an Approval commits but before its step advances, or after a
 * dispatch is recorded but before the Run continues. Such a Workflow Run is
 * `in_progress` with nothing driving it, and no route can restart it (approve
 * answers "already resolved"; resume only accepts `paused`).
 *
 * Re-driving it continues work its original request already authorized, through
 * the ordinary driver — every Grant, Policy, Budget, stop and approval check
 * runs again, exactly as for a live request. A Run genuinely waiting on a human
 * is a cheap no-op; a paused Workflow Run is untouched. Interrupted dispatches
 * were already settled above and are never re-sent, so a crash loop cannot turn
 * into a spend loop. Runs sequentially: the system executes one Run at a time
 * anyway, and this is background work.
 */
import { eq } from "drizzle-orm";
import { invocations, runs, taskInstances, workflowRuns } from "../db/schema.js";
import type { TransactionRunner, WorkflowRunnerFactory } from "../db/transactionRunner.js";
import { failInterruptedInvocation, isDispatchInFlight } from "../execution/executor.js";
import { settleWorkflowStepForFailedRun } from "./interpreter.js";
import { advanceWorkflowRunUntilBlocked, type InvocationSpecBuilderFactory } from "./advanceWorkflowRunUntilBlocked.js";

export type RecoveryReport = { recovered: string[]; failed: { invocationId: string; error: string }[] };

export async function recoverInterruptedInvocations(runInTx: TransactionRunner): Promise<RecoveryReport> {
  const executing = await runInTx((tx) =>
    tx.select({ id: invocations.id, runId: invocations.runId }).from(invocations).where(eq(invocations.status, "executing"))
  );

  const report: RecoveryReport = { recovered: [], failed: [] };
  for (const { id, runId } of executing) {
    if (isDispatchInFlight(id)) continue;

    try {
      const settled = await runInTx(async (tx) => {
        const run = await tx.query.runs.findFirst({ where: eq(runs.id, runId) });
        const taskInstance = run
          ? await tx.query.taskInstances.findFirst({ where: eq(taskInstances.id, run.taskInstanceId) })
          : undefined;
        if (taskInstance?.workflowRunId) {
          // Lock order: workflow_runs before the runs row failInterruptedInvocation takes.
          await tx.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.id, taskInstance.workflowRunId)).for("update");
        }

        if (!(await failInterruptedInvocation(tx, id))) return false;
        await settleWorkflowStepForFailedRun(tx, runId);
        return true;
      });
      if (settled) report.recovered.push(id);
    } catch (error) {
      report.failed.push({ invocationId: id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
}

export async function redriveInProgressWorkflowRuns(
  runInTx: TransactionRunner,
  makeBuilder: InvocationSpecBuilderFactory,
  // Production passes a relaying runner per Workflow Run (see src/api/start.ts),
  // so re-driven work reaches live subscribers as it commits.
  runnerFor: WorkflowRunnerFactory = async () => runInTx
): Promise<{ redriven: { workflowRunId: string; status: string }[]; failed: { workflowRunId: string; error: string }[] }> {
  const inProgress = await runInTx((tx) =>
    tx.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.status, "in_progress"))
  );

  const report = { redriven: [] as { workflowRunId: string; status: string }[], failed: [] as { workflowRunId: string; error: string }[] };
  for (const { id } of inProgress) {
    try {
      const result = await advanceWorkflowRunUntilBlocked(await runnerFor(id), id, makeBuilder);
      report.redriven.push({ workflowRunId: id, status: result.status });
    } catch (error) {
      report.failed.push({ workflowRunId: id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
}
