/**
 * Test drivers for code that calls `executeRun` / `advanceWorkflowRun`
 * directly inside ONE rolled-back test transaction.
 *
 * Since Phase 9 both yield `dispatch_required` at every LLM Invocation instead
 * of calling the provider inside the transaction. These helpers perform the
 * yield the way production does — `dispatchAndRecord` (the production driver's
 * own dispatch step) against a savepoint runner over the test transaction —
 * and re-enter until a non-dispatch outcome, so a test observes the same
 * "run to the next real boundary" result a single call used to return.
 *
 * Only the TRANSACTION BOUNDARY differs from production (savepoints, not
 * commits). Lock release during dispatch is covered by real-commit tests.
 */
import type { DrizzleTransaction } from "../../src/events/emit.js";
import { transactionRunner } from "../../src/db/transactionRunner.js";
import { executeRun } from "../../src/execution/executor.js";
import type { PlannedInvocationSpec, RunOutcome } from "../../src/execution/types.js";
import { advanceWorkflowRun, type AdvanceResult, type InvocationSpecBuilder } from "../../src/workflow/interpreter.js";
import { dispatchAndRecord } from "../../src/workflow/advanceWorkflowRunUntilBlocked.js";

export async function executeRunToBoundary(
  tx: DrizzleTransaction,
  runId: string,
  invocationSpecs: PlannedInvocationSpec[]
): Promise<Exclude<RunOutcome, { status: "dispatch_required" }>> {
  for (;;) {
    const outcome = await executeRun(tx, runId, invocationSpecs);
    if (outcome.status !== "dispatch_required") return outcome;
    await dispatchAndRecord(transactionRunner(tx), outcome.dispatch);
  }
}

export async function advanceWorkflowRunToBoundary(
  tx: DrizzleTransaction,
  workflowRunId: string,
  buildInvocationSpecs: InvocationSpecBuilder
): Promise<Exclude<AdvanceResult, { status: "dispatch_required" }>> {
  for (;;) {
    const result = await advanceWorkflowRun(tx, workflowRunId, buildInvocationSpecs);
    if (result.status !== "dispatch_required") return result;
    await dispatchAndRecord(transactionRunner(tx), result.dispatch);
  }
}
