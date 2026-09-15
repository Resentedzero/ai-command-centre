/**
 * `advanceWorkflowRunUntilBlocked` — the Workflow Run DRIVER: loops
 * `advanceWorkflowRun` so one request drives a run as far as automatically
 * possible, and (Phase 9) is the one place provider calls are dispatched and
 * tool side effects are performed — both with no transaction open.
 *
 * ---------------------------------------------------------------------------
 * Transaction boundaries (Phase 9 — durable execution)
 * ---------------------------------------------------------------------------
 * This function OPENS transactions (via the injected `TransactionRunner`); it
 * does not run inside one. Every `advanceWorkflowRun` call is its own short
 * transaction, and every provider call happens BETWEEN transactions:
 *
 *   tx: advanceWorkflowRun ... -> LLM Invocation committed `executing`, yields
 *   (no tx) dispatchModelCall — may take minutes; holds NO database lock
 *   tx: completeModelDispatch — reconcile, persist, complete (or fail)
 *   tx: advanceWorkflowRun ... continues the Run from the next Invocation
 *
 * Previously one request was one transaction end to end, so a multi-minute
 * `claude -p` call held the run's event advisory lock, its budget counter row
 * locks (and would have held the DAY counter every Run shares), the shared
 * quota-state row, and the workflow_runs row — blocking pause, stops' run-scope
 * events, and every other Run's reservations for the whole call. And a crash
 * mid-call rolled back all evidence the call was made, while its real
 * consumption stood. Now the `executing` row survives a crash and is settled by
 * `failInterruptedInvocation` (never re-dispatched).
 *
 * Each builder is created PER TRANSACTION (`makeBuilder(tx)`): builders and the
 * specs they return close over the transaction they were built in, so a spec
 * must never outlive it. The builder contract already requires determinism
 * across calls, which is what makes rebuilding per transaction safe.
 *
 * ---------------------------------------------------------------------------
 * Bound and termination
 * ---------------------------------------------------------------------------
 * Each Run of a step contributes at most ONE counted `advanceWorkflowRun` call:
 * the one in which it stops yielding (completes, fails and is retried or not, or
 * halts for approval), or a cheap no-op re-check of a step still waiting. A step
 * has at most `MAX_RUN_ATTEMPTS` Runs (`../governance/retryPolicy.ts`), so
 * `steps.length × MAX_RUN_ATTEMPTS` counted calls always suffice, and a terminal
 * status returns immediately.
 *
 * A `dispatch_required` yield is NOT counted: it is bounded separately, because
 * each one settles an `executing` Invocation that can never yield again, and a
 * Run has finitely many Invocations.
 *
 * Stops early on "completed", "failed" or "paused". Exhausting the bound while
 * still "in_progress" is the expected outcome for a run at a human-approval
 * gate (or one whose current Invocation another request is dispatching).
 */
import { and, eq } from "drizzle-orm";
import { workflowDefinitions, workflowRuns } from "../db/schema.js";
import type { DrizzleTransaction } from "../events/emit.js";
import type { TransactionRunner } from "../db/transactionRunner.js";
import {
  completeModelDispatch,
  completeToolDispatch,
  modelDispatchRefusal,
  releaseDispatchSlot,
  releasingDispatchClaimsOnFailure,
  toolDispatchRefusal,
} from "../execution/executor.js";
import type { PendingDispatch, PendingToolDispatch, ToolDispatchOutcome } from "../execution/types.js";
import { dispatchModelCall } from "../router/modelRouter.js";
import { MAX_RUN_ATTEMPTS } from "../governance/retryPolicy.js";
import { advanceWorkflowRun, type InvocationSpecBuilder } from "./interpreter.js";
import { isLinearGraphDefinition } from "./graphTypes.js";

type DriverResult = { status: "in_progress" | "completed" | "failed" | "paused" };

/** Builds the step's spec builder against ONE transaction — see module header. */
export type InvocationSpecBuilderFactory = (tx: DrizzleTransaction) => InvocationSpecBuilder;

async function getWorkflowRunStepCount(tx: DrizzleTransaction, workflowRunId: string): Promise<number> {
  const workflowRun = await tx.query.workflowRuns.findFirst({ where: eq(workflowRuns.id, workflowRunId) });
  if (!workflowRun) {
    throw new Error(`advanceWorkflowRunUntilBlocked: no workflow_runs row found for id "${workflowRunId}"`);
  }

  const definition = await tx.query.workflowDefinitions.findFirst({
    where: and(
      eq(workflowDefinitions.id, workflowRun.workflowDefinitionId),
      eq(workflowDefinitions.version, workflowRun.workflowDefinitionVersion)
    ),
  });
  if (!definition) {
    throw new Error(
      `advanceWorkflowRunUntilBlocked: no workflow_definitions row found for id "${workflowRun.workflowDefinitionId}" ` +
        `version ${workflowRun.workflowDefinitionVersion}`
    );
  }
  if (!isLinearGraphDefinition(definition.graphDefinition)) {
    throw new Error(
      `advanceWorkflowRunUntilBlocked: workflow_definitions "${definition.id}" v${definition.version} has a ` +
        "graph_definition that is not a valid LinearGraphDefinition (fail closed)."
    );
  }

  return definition.graphDefinition.steps.length;
}

/**
 * Makes ONE external call — a provider call or a tool's side effect — with no
 * transaction open, then records its outcome in a fresh one. Exactly one
 * dispatch: no retry, no fallback.
 *
 * The dispatch slot is released whatever happens. If the outcome could not be
 * recorded (the error propagates), the Invocation stays `executing` with no
 * live owner, so the next caller to reach it settles it as interrupted instead
 * of treating it as in flight forever.
 */
export async function dispatchAndRecord(runInTx: TransactionRunner, dispatch: PendingDispatch): Promise<void> {
  try {
    if (dispatch.kind === "llm") {
      const refusal = await refusalBeforeDispatch(runInTx, (tx) => modelDispatchRefusal(tx, dispatch));
      const outcome = refusal ?? (await dispatchModelCall(dispatch.route, dispatch.compiledContext, dispatch.expectedOutputShape));
      await runInTx((tx) => completeModelDispatch(tx, dispatch, outcome));
    } else {
      const outcome = await performToolDispatch(runInTx, dispatch);
      await runInTx((tx) => completeToolDispatch(tx, dispatch, outcome));
    }
  } finally {
    releaseDispatchSlot(dispatch.invocationId);
  }
}

/**
 * Runs a pre-dispatch check in its own short transaction. The check returns its
 * refusal instead of throwing, so the transaction commits what it recorded
 * (`policy_evaluated`). A refusal — or the check itself failing — means the call
 * or effect was never attempted, so it is returned as an outcome consuming
 * nothing (its reservation is released when recorded); null means proceed.
 */
async function refusalBeforeDispatch(
  runInTx: TransactionRunner,
  check: (tx: DrizzleTransaction) => Promise<Error | null>
): Promise<{ ok: false; error: Error & { consumption: "none" } } | null> {
  let refusal: Error | null;
  try {
    refusal = await runInTx(check);
  } catch (error) {
    refusal = error instanceof Error ? error : new Error(String(error));
  }
  return refusal === null ? null : { ok: false, error: Object.assign(refusal, { consumption: "none" as const }) };
}

/**
 * Re-checks authorization in its own short transaction, then runs the tool
 * with none open (DURABLE_EXECUTION §2.1). A refusal means the effect was never
 * attempted, so it is marked as consuming nothing and its reservation is
 * released when recorded. Never throws.
 */
async function performToolDispatch(runInTx: TransactionRunner, dispatch: PendingToolDispatch): Promise<ToolDispatchOutcome> {
  const refusal = await refusalBeforeDispatch(runInTx, (tx) => toolDispatchRefusal(tx, dispatch));
  if (refusal) return refusal;
  try {
    const result = await dispatch.execute({ invocationId: dispatch.invocationId, idempotencyKey: dispatch.idempotencyKey });
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error };
  }
}

export async function advanceWorkflowRunUntilBlocked(
  runInTx: TransactionRunner,
  workflowRunId: string,
  makeBuilder: InvocationSpecBuilderFactory
): Promise<DriverResult> {
  // Each Run of a step, first attempt or retry, contributes at most one counted call.
  const maxCountedCalls = (await runInTx((tx) => getWorkflowRunStepCount(tx, workflowRunId))) * MAX_RUN_ATTEMPTS;

  let result: DriverResult = { status: "in_progress" };
  let countedCalls = 0;
  while (countedCalls < maxCountedCalls) {
    // A throw (even after a COMMIT the client could not confirm) gives up any dispatch it claimed.
    const advanced = await releasingDispatchClaimsOnFailure(() =>
      runInTx((tx) => advanceWorkflowRun(tx, workflowRunId, makeBuilder(tx)))
    );

    if (advanced.status === "dispatch_required") {
      await dispatchAndRecord(runInTx, advanced.dispatch);
      continue;
    }

    result = advanced;
    if (result.status === "completed" || result.status === "failed" || result.status === "paused") {
      return result;
    }
    countedCalls++;
  }
  return result;
}
