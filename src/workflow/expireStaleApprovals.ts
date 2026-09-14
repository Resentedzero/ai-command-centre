/**
 * `expireStaleApprovals` — the Approval TTL sweep (spec §9.5: "Unresolved
 * Approvals past a TTL auto-resolve to reject (`expired`)").
 *
 * For each `pending` Approval whose TTL has passed:
 *   1. Record the expiry (`expirePendingApproval`: status `expired`, event
 *      `approval_expired`, actor `system:approval_ttl`), in its own transaction.
 *   2. Re-drive its Workflow Run through the ordinary driver. `resumeToolSpec`
 *      then treats the expired Approval exactly like a rejection: the
 *      pre-approval budget hold is RELEASED (nothing ran), the Invocation fails
 *      with `approval_expired`, and the Run, Task Instance and Workflow Run fail
 *      with their lifecycle events.
 *
 * Without step 2 the hold would stay reserved and the Workflow Run would sit
 * `in_progress` until some unrelated request happened to touch it.
 *
 * Refusal of a late human decision is NOT this sweep's job: `resolveApproval`'s
 * conditional UPDATE already refuses any past-TTL Approval, and
 * `GET /approvals` already hides one. The sweep makes the expiry a recorded
 * fact and finishes the work it implies.
 *
 * One Approval's failure is reported and does not stop the rest. An Approval
 * whose Task Instance is standalone (no Workflow Run) is expired but not
 * re-driven — nothing drives standalone Runs; its hold is released whenever
 * its Run is next executed.
 */
import { and, eq, isNotNull, lt } from "drizzle-orm";
import { approvals, invocations, runs, taskInstances } from "../db/schema.js";
import type { TransactionRunner } from "../db/transactionRunner.js";
import { expirePendingApproval } from "../governance/approvals.js";
import { advanceWorkflowRunUntilBlocked, type InvocationSpecBuilderFactory } from "./advanceWorkflowRunUntilBlocked.js";

export const APPROVAL_TTL_ACTOR = "system:approval_ttl";

export type ApprovalExpiryReport = {
  expired: string[];
  failed: { approvalId: string; error: string }[];
};

export async function expireStaleApprovals(
  runInTx: TransactionRunner,
  makeBuilder: InvocationSpecBuilderFactory,
  now: Date = new Date()
): Promise<ApprovalExpiryReport> {
  const stale = await runInTx((tx) =>
    tx
      .select({ id: approvals.id })
      .from(approvals)
      .where(and(eq(approvals.status, "pending"), isNotNull(approvals.ttl), lt(approvals.ttl, now)))
  );

  const report: ApprovalExpiryReport = { expired: [], failed: [] };
  for (const { id } of stale) {
    try {
      const workflowRunId = await runInTx(async (tx) => {
        if (!(await expirePendingApproval(tx, id, APPROVAL_TTL_ACTOR))) return undefined;
        const [row] = await tx
          .select({ workflowRunId: taskInstances.workflowRunId })
          .from(approvals)
          .innerJoin(invocations, eq(approvals.invocationId, invocations.id))
          .innerJoin(runs, eq(invocations.runId, runs.id))
          .innerJoin(taskInstances, eq(runs.taskInstanceId, taskInstances.id))
          .where(eq(approvals.id, id));
        return row?.workflowRunId ?? null;
      });
      if (workflowRunId === undefined) continue; // resolved concurrently — nothing to do
      report.expired.push(id);
      if (workflowRunId) {
        await advanceWorkflowRunUntilBlocked(runInTx, workflowRunId, makeBuilder);
      }
    } catch (error) {
      report.failed.push({ approvalId: id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
}
