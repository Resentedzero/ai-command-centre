/**
 * `executeRun` — Unit 6's thin Run/Invocation Executor (Phase 11.1), wiring
 * together Units 1-5 in the frozen authorization chain: Grant -> Tool
 * Binding resolution -> Policy -> Budget -> Approval -> Invocation
 * execution. See task-6-brief.md's pre-dispatch Rulings 1-8 for the exact
 * per-kind orchestration this file implements; inline comments below cite
 * the specific ruling/step a block satisfies rather than re-deriving it.
 *
 * Resumability (brief's "Tests required" + the overall-structure note):
 * `executeRun` is safe to call more than once for the same `runId` with the
 * SAME `invocationSpecs` array. On each call it walks `invocationSpecs` by
 * position (`seqNo = index + 1`) and, for each, looks up whether an
 * `invocations` row already exists for `(runId, seqNo)`:
 *   - `status: "completed"` -> already done, skip to the next spec.
 *   - `status: "awaiting_approval"` -> resume exactly at that point (re-check
 *     the Approval, `reauthorize`, fresh `reserveBudget`, execute) rather
 *     than restarting from index 0.
 *   - `status: "executing"` (Phase 9) -> an LLM Invocation committed before
 *     its provider call. If this process is dispatching it right now, return
 *     `in_flight` and change nothing; otherwise its dispatcher is gone, so
 *     settle it as interrupted (`failInterruptedInvocation` — never
 *     re-dispatched).
 *   - no row -> process it fresh from the top of its per-kind orchestration.
 *   - `proposed`/`failed` persisting under a non-terminal Run is still an
 *     inconsistency this unit refuses to guess about (see the throw at the
 *     bottom of `executeRun`'s loop). Neither can survive a crash: every
 *     transaction that writes them also writes the Run's terminal state or a
 *     later Invocation status before committing.
 *
 * Transaction boundaries (Phase 9 — durable execution; the authoritative
 * write-up is docs/architecture/DURABLE_EXECUTION.md): `executeRun` never makes
 * a provider call and never runs a tool's side effect. At an LLM or Tool
 * Invocation it commits the Invocation as `executing` and yields
 * `dispatch_required`; the caller dispatches with no transaction open and
 * records the outcome via `completeModelDispatch` / `completeToolDispatch`
 * (DURABLE_EXECUTION §2, §2.1). Deterministic and retrieval Invocations are
 * internal and still execute inside the caller's transaction.
 * `runs.status` is short-circuited at the top for the two terminal outcomes
 * ("failed"/"completed") so a call after the Run is already finished is a
 * cheap no-op read rather than re-walking every spec.
 *
 * Deferred spec positions (final-review Finding 4): `invocationSpecs` accepts
 * `PlannedInvocationSpec[]` — each position is EITHER a ready-made
 * `InvocationSpec` or a thunk resolved by `resolvePlannedSpec` below
 * immediately before that position is processed, against the artifact ids this
 * Run's EARLIER Invocations actually produced. That is the only way to satisfy
 * Phase 5.8 ("a prior Tool Invocation's structured output becomes a new
 * high-priority candidate for the next compilation"), since the whole plan is
 * otherwise materialized before the Run's first Invocation runs. It replaced a
 * capability module calling `executeRun` twice and reverting `runs.status`
 * in between to defeat the re-entry guard above.
 *
 * What this deliberately does NOT do: the plan's LENGTH and ORDER remain fixed
 * by the caller before `executeRun` starts, so a thunk changes WHAT an
 * already-decided position is, never WHETHER or HOW MANY positions exist.
 * Workflow topology stays the Workflow Interpreter's deterministic decision,
 * and this module gains no topology, capability, policy, or context-compilation
 * logic (Phase 4) — it passes opaque ids through and never reads an artifact's
 * content.
 *
 * Reservation bookkeeping across the awaiting_approval halt (a gap the
 * brief's interfaces don't cover): Unit 2's `budget.ts` states explicitly
 * there is no reservations ledger table — a `reservationId` is a
 * self-contained opaque string, not a row this unit can look up later by
 * invocationId. Since Ruling 4 step 9 requires releasing "the hold from step
 * 6" on a LATER, separate `executeRun` call, that string must be persisted
 * somewhere between the two calls. DECISION: `runs.budget_envelope` (jsonb,
 * otherwise untouched by any other unit — confirmed by grep), keyed by
 * seqNo: `{ pendingReservations: { [seqNo]: reservationId } }`. This is
 * pure Executor-internal bookkeeping, never read by Units 1-5, and
 * deliberately NOT `invocations.proposedActionSnapshot` — `reauthorize`
 * deep-equals that field against the Approval's frozen snapshot, so storing
 * anything extra there would break material-change detection.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, inArray, lt } from "drizzle-orm";
import { isTransientDatabaseError, sqlStateOf } from "../db/databaseErrors.js";
import { approvals, artifacts, invocations, runs, taskInstances, workflowRuns } from "../db/schema.js";
import type { DrizzleTransaction } from "../events/emit.js";
import { emitEvent } from "../events/emit.js";
import { correlationForRun, emitLifecycleEvent } from "../events/lifecycle.js";
import type { ApprovalRequiredPayload } from "../events/types.js";
import {
  chargeReservationAtEstimate,
  NOOP_RESERVATION_ID,
  reconcileBudget,
  releaseReservation,
  reserveBudget,
} from "../governance/budget.js";
import { createApproval, expirePendingApproval, reauthorize } from "../governance/approvals.js";
import {
  assertCapabilityGrantsNotStopped,
  assertNotStopped,
  ExecutionStoppedError,
  type ActiveStop,
} from "../governance/executionStop.js";
import { compileContext, measureArtifactReferences } from "../context/compiler.js";
import {
  authorizeRoute,
  emitModelInvocationCompleted,
  finalizeModelCall,
  type ModelDispatchOutcome,
} from "../router/modelRouter.js";
import { providerConsumptionFrom } from "../router/types.js";
import {
  authorizeInvocation,
  completeInvocation,
  failInvocation,
  markInvocationExecuting,
  proposeInvocation,
  resolveCapabilityGrant,
  resolveToolBindingTrustLevel,
} from "./invocationLifecycle.js";
import { persistInvocationResultAsArtifact } from "./invocationResults.js";
import type {
  DeterministicInvocationSpec,
  InvocationSpec,
  InvocationSpecContext,
  LlmInvocationSpec,
  PendingModelDispatch,
  PendingToolDispatch,
  PlannedInvocationSpec,
  PriorInvocationArtifact,
  RetrievalInvocationSpec,
  RunOutcome,
  ToolDispatchOutcome,
  ToolInvocationSpec,
} from "./types.js";

/** Documented MVP default (Ruling 4 step 8) — no product-specified approval TTL exists yet. */
const APPROVAL_TTL_SECONDS = 3600;

type RunRow = typeof runs.$inferSelect;

// ---------------------------------------------------------------------------
// runs.budget_envelope bookkeeping (see module header)
// ---------------------------------------------------------------------------

type BudgetEnvelope = { pendingReservations?: Record<string, string> };

async function getBudgetEnvelope(tx: DrizzleTransaction, runId: string): Promise<BudgetEnvelope> {
  const row = await tx.query.runs.findFirst({ where: eq(runs.id, runId) });
  return (row?.budgetEnvelope as BudgetEnvelope | null) ?? {};
}

async function savePendingReservation(
  tx: DrizzleTransaction,
  runId: string,
  seqNo: number,
  reservationId: string
): Promise<void> {
  const envelope = await getBudgetEnvelope(tx, runId);
  const pendingReservations = { ...(envelope.pendingReservations ?? {}), [String(seqNo)]: reservationId };
  await tx.update(runs).set({ budgetEnvelope: { ...envelope, pendingReservations } }).where(eq(runs.id, runId));
}

/**
 * Reads the pending reservationId WITHOUT clearing it — clearing only happens
 * via `clearPendingReservation`, called AFTER the reservation has actually
 * been released/reconciled. Splitting read from clear (rather than one
 * take-and-delete step) means that if `releaseReservation` throws (it does,
 * per `budget.ts`, if the `budget_counters` row has since been removed), the
 * envelope key is never lost before the release that was supposed to consume
 * it actually succeeds — there is no window where the hold is stranded with
 * no recorded handle to release it.
 */
async function peekPendingReservation(tx: DrizzleTransaction, runId: string, seqNo: number): Promise<string> {
  const envelope = await getBudgetEnvelope(tx, runId);
  const reservationId = envelope.pendingReservations?.[String(seqNo)];
  if (!reservationId) {
    throw new Error(
      `executeRun: no pending reservation recorded for run "${runId}" seqNo ${seqNo} — cannot resume awaiting_approval.`
    );
  }
  return reservationId;
}

async function clearPendingReservation(tx: DrizzleTransaction, runId: string, seqNo: number): Promise<void> {
  const envelope = await getBudgetEnvelope(tx, runId);
  const pendingReservations = { ...envelope.pendingReservations };
  delete pendingReservations[String(seqNo)];
  await tx.update(runs).set({ budgetEnvelope: { ...envelope, pendingReservations } }).where(eq(runs.id, runId));
}

/** Guards reconcileBudget/releaseReservation against Unit 2's deterministic no-op sentinel (they throw on it). */
function isRealReservation(reservationId: string): boolean {
  return reservationId !== NOOP_RESERVATION_ID;
}

/**
 * Records a Run halted by an emergency stop: its outcome names the stop, and
 * `run_halted` makes the halt visible in the event log, not only in
 * `runs.outcome` — otherwise a Run halted before proposing any Invocation simply
 * stops appearing in the Activity feed with no stated cause. Used wherever a
 * stop is caught, so the same stop leaves the same record whenever it lands.
 */
async function haltRunForStop(tx: DrizzleTransaction, runId: string, taskInstanceId: string, stop: ActiveStop): Promise<void> {
  await tx
    .update(runs)
    .set({
      status: "failed",
      completedAt: new Date(),
      outcome: { status: "failed", reason: "execution_stopped", stopScope: stop.scope, stopScopeRefId: stop.scopeRefId },
    })
    .where(eq(runs.id, runId));
  await emitEvent(tx, {
    idempotencyKey: `run_halted:${runId}`,
    eventType: "run_halted",
    eventVersion: 1,
    causationId: null,
    correlation: { goalId: null, workflowRunId: null, taskInstanceId, runId, invocationId: null },
    actor: "system",
    producer: "executor",
    payload: { reason: "execution_stopped", stopId: stop.id, stopScope: stop.scope, stopScopeRefId: stop.scopeRefId },
    usage: null,
  });
}

async function failRun(tx: DrizzleTransaction, runId: string): Promise<void> {
  await tx
    .update(runs)
    .set({ status: "failed", completedAt: new Date(), outcome: { status: "failed" } })
    .where(eq(runs.id, runId));
  // Spec §8.2 `run_failed`, same transaction. The cause is the
  // `invocation_failed` event earlier in this Run's own sequence.
  await emitLifecycleEvent(tx, {
    eventType: "run_failed",
    subjectId: runId,
    correlation: await correlationForRun(tx, runId),
    producer: "executor",
  });
}

// ---------------------------------------------------------------------------
// "tool" kind — Ruling 4
// ---------------------------------------------------------------------------

/**
 * Commits an authorized, reserved tool Invocation as `executing` and yields it
 * for dispatch (DURABLE_EXECUTION §2.1) — the same shape as an LLM Invocation.
 * The tool's side effect happens only after this commits, with no transaction
 * open, so a crash leaves a durable claim that the effect may have happened.
 * Recovery then settles it (charged at estimate, never repeated) instead of a
 * rolled-back transaction letting the next advance perform it a second time.
 */
async function yieldToolDispatch(
  tx: DrizzleTransaction,
  runRow: RunRow,
  seqNo: number,
  spec: ToolInvocationSpec,
  invocation: { id: string; idempotencyKey: string },
  reservationId: string
): Promise<RunOutcome> {
  await markInvocationExecuting(tx, invocation.id);
  await savePendingReservation(tx, runRow.id, seqNo, reservationId);
  // A Run resumed after its approval halt is running again. Without this it
  // kept reading `awaiting_approval` while its approved tool executed and after
  // it completed — committed now that the effect runs in a later transaction.
  await tx.update(runs).set({ status: "active" }).where(eq(runs.id, runRow.id));
  claimDispatchSlot(invocation.id);
  return {
    status: "dispatch_required",
    runId: runRow.id,
    dispatch: {
      kind: "tool",
      invocationId: invocation.id,
      runId: runRow.id,
      seqNo,
      idempotencyKey: invocation.idempotencyKey,
      reservationId,
      estimatedCost: spec.estimatedCost,
      capabilityId: spec.capabilityId,
      permission: spec.permission,
      toolBindingId: spec.toolBindingId,
      proposedActionSnapshot: spec.proposedActionSnapshot,
      execute: spec.execute,
    },
  };
}

/** Fresh processing of a "tool" spec that has no existing `invocations` row yet — Ruling 4 steps 1-8. */
async function processToolSpec(tx: DrizzleTransaction, runRow: RunRow, seqNo: number, spec: ToolInvocationSpec): Promise<RunOutcome> {
  const runId = runRow.id;

  // Step 1: propose + emit invocation_started (executor's own emitEvent call).
  const { invocationId, idempotencyKey } = await proposeInvocation(tx, {
    runId,
    seqNo,
    kind: "tool",
    costClass: spec.costClass,
    taskInstanceId: runRow.taskInstanceId,
    capabilityId: spec.capabilityId,
    permission: spec.permission,
    toolBindingId: spec.toolBindingId,
    proposedActionSnapshot: spec.proposedActionSnapshot,
    startedPayload: { capabilityId: spec.capabilityId, permission: spec.permission },
  });

  // Steps 2-3: resolve Grant, resolve Tool Binding's trustLevel.
  const grant = await resolveCapabilityGrant(tx, { runId, capabilityId: spec.capabilityId, permission: spec.permission });

  // Phase 9.7, capability_grant scope. Checked HERE rather than at the loop top
  // because this is the earliest point a Grant exists at all — only Tool
  // Invocations resolve one. Every broader scope (global, agent, workflow_run,
  // run) was already checked before this spec was even resolved. A null grant
  // is not skipped silently: Policy DENYs it immediately below.
  if (grant) {
    if (!grant.id) {
      // Fail closed. A Grant that cannot be identified cannot be checked
      // against a grant-scoped stop, so it must not be exercised.
      // `resolveCapabilityGrant` always sets `id`; this guards the type's
      // optionality rather than a known path.
      throw new Error(
        `executeRun: the resolved Capability Grant for capability "${spec.capabilityId}" carries no id;` +
          " refusing to dispatch without checking grant-scoped emergency stops."
      );
    }
    try {
      await assertNotStopped(tx, { capabilityGrantId: grant.id });
      // EVERY unrevoked Grant covering this action, not just the one resolved
      // above — a stop on any covering Grant must block.
      await assertCapabilityGrantsNotStopped(tx, {
        runId,
        capabilityId: spec.capabilityId,
        permission: spec.permission,
      });
    } catch (error) {
      // A lookup failure has aborted the transaction; writing here would only
      // replace the real error with "current transaction is aborted".
      if (error instanceof ExecutionStoppedError && !error.lookupFailed) {
        await failInvocation(tx, {
          invocationId,
          runId,
          taskInstanceId: runRow.taskInstanceId,
          reason: "execution_stopped",
        });
      }
      throw error;
    }
  }
  const { trustLevel, bindingTrustLevel } = await resolveToolBindingTrustLevel(tx, spec.toolBindingId);

  // Step 4: evaluatePolicy. Both trust values come from the tool_bindings row
  // resolved above, and the Grant's bar from the capability_grants row — never
  // from `spec.proposedActionSnapshot`, which is the only input here a model's
  // output can reach (Finding 2).
  const { decision, riskTier } = await authorizeInvocation(tx, {
    grant,
    permission: spec.permission,
    proposedActionSnapshot: spec.proposedActionSnapshot,
    trustLevel,
    bindingTrustLevel,
    audit: { runId, invocationId, capabilityId: spec.capabilityId, toolBindingId: spec.toolBindingId, checkpoint: "propose" },
  });

  // Step 5: DENY fails this invocation AND the whole Run.
  if (decision === "DENY") {
    await failInvocation(tx, { invocationId, runId, taskInstanceId: runRow.taskInstanceId, reason: "policy_denied" });
    await failRun(tx, runId);
    return { status: "failed", runId };
  }

  // Step 6: reserveBudget for ALLOW or REQUIRE_APPROVAL.
  //
  // `"usd"`: this path handles tool/metered-API/side-effect specs, whose
  // `estimatedCost` is a real monetary amount. The LLM path does not come
  // through here — `authorizeRoute` reserves in whatever unit the routed
  // tier's provider accounts in (which may be `subscription_tokens`).
  const reservation = await reserveBudget(tx, "run", runId, spec.costClass, "usd", spec.estimatedCost);
  if (!reservation.authorized) {
    // The Governor's outcome as a recorded fact, so no read model infers it from a reason a tool's own error could also carry.
    await failInvocation(tx, {
      invocationId,
      runId,
      taskInstanceId: runRow.taskInstanceId,
      reason: "insufficient_budget",
      details: { budgetAuthorization: { authorized: false, outcome: "denied", resourceUnit: "usd", estimatedAmount: spec.estimatedCost } },
    });
    await failRun(tx, runId);
    return { status: "failed", runId };
  }

  // Step 7: ALLOW -> commit `executing` and dispatch outside this transaction.
  if (decision === "ALLOW") {
    return yieldToolDispatch(tx, runRow, seqNo, spec, { id: invocationId, idempotencyKey }, reservation.reservationId);
  }

  // Step 8: REQUIRE_APPROVAL -> create Approval, halt at awaiting_approval.
  //
  // Final-review Finding 1: `approval_required` is emitted in the SAME
  // transaction that creates the Approval row — Phase 9.5's "Approval
  // created ... status: pending" step, which previously left no trace at all
  // in the event stream, making the whole REQUIRE_APPROVAL halt invisible to
  // the Activity feed (Phase 18.1a, "a direct tail of Events"). Envelope
  // conventions are identical to this unit's other emissions (see
  // `./invocationLifecycle.ts`): eventVersion 1, causationId null, usage
  // null, `<eventType>:<id>` idempotency key, goalId/workflowRunId null,
  // actor "system", producer "executor". Unlike the resolution events
  // (`../governance/approvals.ts`), the actor here really is the system — no
  // human has acted yet; that is the entire point of the halt.
  //
  // The payload names WHAT is gated (capability + permission) and the risk
  // tier Policy actually computed, so the feed can render the decision
  // without re-deriving any of it — Phase 9.5 requires the exact action be
  // identifiable, never just a category.
  const approval = await createApproval(tx, invocationId, spec.proposedActionSnapshot, riskTier, APPROVAL_TTL_SECONDS);
  const approvalRequiredPayload: ApprovalRequiredPayload = {
    approvalId: approval.id,
    riskTier,
    capabilityId: spec.capabilityId,
    permission: spec.permission,
  };
  await emitEvent(tx, {
    idempotencyKey: `approval_required:${approval.id}`,
    eventType: "approval_required",
    eventVersion: 1,
    causationId: null,
    correlation: {
      goalId: null,
      workflowRunId: null,
      taskInstanceId: runRow.taskInstanceId,
      runId,
      invocationId,
    },
    actor: "system",
    producer: "executor",
    payload: approvalRequiredPayload,
    usage: null,
  });
  await tx.update(invocations).set({ status: "awaiting_approval" }).where(eq(invocations.id, invocationId));
  await savePendingReservation(tx, runId, seqNo, reservation.reservationId);
  await tx.update(runs).set({ status: "awaiting_approval" }).where(eq(runs.id, runId));
  return { status: "awaiting_approval", runId };
}

/**
 * Resumes a "tool" spec whose invocation is currently `awaiting_approval` —
 * Ruling 4 step 9. Takes the full stored `invocations` row (not just its id)
 * so it can validate the resuming call's spec against it — see the
 * fix-round-1 (Important #3) comment below.
 */
async function resumeToolSpec(
  tx: DrizzleTransaction,
  runRow: RunRow,
  seqNo: number,
  spec: ToolInvocationSpec,
  storedInvocation: typeof invocations.$inferSelect
): Promise<RunOutcome> {
  const runId = runRow.id;
  const invocationId = storedInvocation.id;

  const approval = await tx.query.approvals.findFirst({ where: eq(approvals.invocationId, invocationId) });
  if (!approval) {
    throw new Error(`executeRun: invocation "${invocationId}" is awaiting_approval but has no approvals row.`);
  }

  if (approval.status === "pending") {
    return { status: "awaiting_approval", runId }; // still waiting — no-op
  }

  if (approval.status !== "approved") {
    // "rejected", or "expired" (set by the TTL sweep, `expireStaleApprovals.ts`,
    // spec §9.5) — both terminal non-approved outcomes, handled identically:
    // nothing ran, so the hold is released and the Invocation fails.
    const reservationId = await peekPendingReservation(tx, runId, seqNo);
    if (isRealReservation(reservationId)) {
      await releaseReservation(tx, reservationId);
    }
    await clearPendingReservation(tx, runId, seqNo);
    await failInvocation(tx, {
      invocationId,
      runId,
      taskInstanceId: runRow.taskInstanceId,
      reason: `approval_${approval.status}`,
    });
    await failRun(tx, runId);
    return { status: "failed", runId };
  }

  // Fix-round-1 (Important #3), extended in fix-round-2 (New Important):
  // validate the RESUMING call's spec against the invocation as originally
  // proposed, BEFORE reauthorize/execution. `reauthorize` only deep-equals
  // the invocation's stored proposedActionSnapshot against ITSELF (both
  // written from the ORIGINAL propose-time spec) — it can only ever fire on
  // external DB mutation between propose and resume, never on a caller
  // simply passing a materially different spec object on the resuming
  // `executeRun` call. That is the one mutation vector this unit's own
  // design actually exposes (the caller supplies a fresh `invocationSpecs`
  // array on every call), so `reauthorize` alone leaves Phase 9.5's
  // material-change invalidation inert against it.
  //
  // `costClass` is included here (fix-round-2): `invocations.costClass` is a
  // real, persisted column, and a mismatch here is not a mere sizing
  // question — `reserveBudget` short-circuits to `NOOP_RESERVATION_ID`
  // whenever `costClass === "deterministic"` (Unit 2's own documented
  // behavior), so a resuming spec that claims `costClass: "deterministic"`
  // against an invocation actually proposed with e.g. `"metered_api"` would
  // skip budget reservation/reconciliation entirely — an authorization
  // BYPASS, not just an inaccuracy, and the identical threat model this
  // check exists for, via a different field.
  //
  // `estimatedCost` is deliberately NOT validated here (accepted residual,
  // documented in the fix-round-2 report section): it is not persisted
  // anywhere in the schema (no `estimated_cost` column on `invocations`),
  // and `budget.ts` exports no way to decode the amount embedded in a
  // `reservationId` string to compare against (only
  // `reserveBudget`/`reconcileBudget`/`releaseReservation`/
  // `NOOP_RESERVATION_ID` are exported). A mismatched-but-still-real
  // `estimatedCost` on resume produces at most an incorrectly-SIZED
  // reservation — `reserveBudget`'s own limit check still runs against
  // whatever amount is given — not a bypass, unlike `costClass`.
  //
  // This checks the metadata fields Unit 6 controls against what was
  // actually proposed and approved; it does NOT (and cannot) validate the
  // `execute` closure itself against the snapshot — Ruling 1 mandates a
  // direct function reference with no Tool Adapter registry to validate a
  // closure's behavior against, so that remains a documented, out-of-scope
  // gap.
  if (
    spec.capabilityId !== storedInvocation.capabilityId ||
    spec.permission !== storedInvocation.permission ||
    spec.costClass !== storedInvocation.costClass ||
    // The binding authorized at propose time. A stored null (an invocation
    // proposed before the column existed) never matches, so it fails closed.
    spec.toolBindingId !== storedInvocation.toolBindingId ||
    !isDeepStrictEqual(spec.proposedActionSnapshot, storedInvocation.proposedActionSnapshot)
  ) {
    const mismatchedReservationId = await peekPendingReservation(tx, runId, seqNo);
    if (isRealReservation(mismatchedReservationId)) {
      await releaseReservation(tx, mismatchedReservationId);
    }
    await clearPendingReservation(tx, runId, seqNo);
    await failInvocation(tx, {
      invocationId,
      runId,
      taskInstanceId: runRow.taskInstanceId,
      reason: "resume_spec_mismatch",
    });
    await failRun(tx, runId);
    return { status: "failed", runId };
  }

  // approval.status === "approved": reauthorize (Unit 3), independently from a fresh reserveBudget (Unit 2) — two separate calls (Ruling 4 step 9).
  const reauthorized = await reauthorize(tx, invocationId);
  const originalReservationId = await peekPendingReservation(tx, runId, seqNo);

  if (!reauthorized) {
    if (isRealReservation(originalReservationId)) {
      await releaseReservation(tx, originalReservationId);
    }
    await clearPendingReservation(tx, runId, seqNo);
    await failInvocation(tx, { invocationId, runId, taskInstanceId: runRow.taskInstanceId, reason: "reauthorization_failed" });
    await failRun(tx, runId);
    return { status: "failed", runId };
  }

  // Policy again, against the PERSISTED Tool Binding's CURRENT trust (spec 9.5:
  // Grant validity is re-checked immediately before a gated side effect;
  // Phase 20 risk #7, trust-level drift). `reauthorize` confirms the Grant
  // still exists and the snapshot is unchanged, but not that the binding still
  // clears the Grant's trust bar — a binding downgraded, or a bar raised, while
  // the Approval was pending must not execute on the strength of the old trust.
  // Only DENY blocks: the action is already approved, so REQUIRE_APPROVAL is
  // satisfied, and a now-AUTONOMOUS Grant changes nothing.
  const currentGrant = await resolveCapabilityGrant(tx, {
    runId,
    capabilityId: spec.capabilityId,
    permission: spec.permission,
  });
  const currentTrust = await resolveToolBindingTrustLevel(tx, storedInvocation.toolBindingId!);
  const { decision: currentDecision } = await authorizeInvocation(tx, {
    grant: currentGrant,
    permission: spec.permission,
    proposedActionSnapshot: spec.proposedActionSnapshot,
    trustLevel: currentTrust.trustLevel,
    bindingTrustLevel: currentTrust.bindingTrustLevel,
    audit: {
      runId,
      invocationId,
      capabilityId: spec.capabilityId,
      toolBindingId: storedInvocation.toolBindingId!,
      checkpoint: "resume",
    },
  });
  if (currentDecision === "DENY") {
    if (isRealReservation(originalReservationId)) {
      await releaseReservation(tx, originalReservationId);
    }
    await clearPendingReservation(tx, runId, seqNo);
    await failInvocation(tx, {
      invocationId,
      runId,
      taskInstanceId: runRow.taskInstanceId,
      reason: "reauthorization_policy_denied",
    });
    await failRun(tx, runId);
    return { status: "failed", runId };
  }

  // Release the original hold (it served its purpose while awaiting approval)...
  if (isRealReservation(originalReservationId)) {
    await releaseReservation(tx, originalReservationId);
  }
  await clearPendingReservation(tx, runId, seqNo);
  // ...then a fresh, separate reservation immediately before execution.
  // `"usd"` for the same reason as the pre-approval reservation above.
  const freshReservation = await reserveBudget(tx, "run", runId, spec.costClass, "usd", spec.estimatedCost);
  if (!freshReservation.authorized) {
    await failInvocation(tx, {
      invocationId,
      runId,
      taskInstanceId: runRow.taskInstanceId,
      reason: "insufficient_budget_on_resume",
      details: { budgetAuthorization: { authorized: false, outcome: "denied", resourceUnit: "usd", estimatedAmount: spec.estimatedCost } },
    });
    await failRun(tx, runId);
    return { status: "failed", runId };
  }

  return yieldToolDispatch(tx, runRow, seqNo, spec, storedInvocation, freshReservation.reservationId);
}

// ---------------------------------------------------------------------------
// "llm" kind — Ruling 5
// ---------------------------------------------------------------------------

function toStructuredOutput(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}

async function processLlmSpec(tx: DrizzleTransaction, runRow: RunRow, seqNo: number, spec: LlmInvocationSpec): Promise<RunOutcome> {
  const runId = runRow.id;
  const taskInstanceId = runRow.taskInstanceId;

  // Step 1: propose, but do NOT emit invocation_started ourselves — authorizeRoute does (Ruling 3/5).
  const { invocationId } = await proposeInvocation(tx, {
    runId,
    seqNo,
    kind: "llm",
    costClass: "llm",
    taskInstanceId,
    capabilityId: null,
    permission: null,
    proposedActionSnapshot: null,
    emitStarted: false,
  });

  // Step 2: authorizeRoute (Unit 5).
  const route = await authorizeRoute(tx, {
    taskDifficulty: spec.taskDifficulty,
    riskTier: spec.riskTier,
    contextBudget: spec.contextBudget,
    runId,
    taskInstanceId,
    invocationId,
  });

  if ("authorized" in route) {
    // route === {authorized: false}: Unit 5 emits nothing on this path.
    // DECISION (documented, Ruling 5 step 2's "your call"): the Executor emits
    // invocation_failed itself here, for the same reason it owns every other
    // kind's failure event uniformly — consistent with `modelRouter.ts`'s own
    // header, which states failure-event emission is the Executor's job.
    // The reason comes from authorizeRoute, not a constant: a quota-guardrail
    // refusal and an exhausted budget are different operator situations, and
    // flattening both to "insufficient_budget" would hide which one happened.
    await failInvocation(tx, { invocationId, runId, taskInstanceId, reason: route.reason, details: { routingDecision: route.decision } });
    await failRun(tx, runId);
    return { status: "failed", runId };
  }

  // Step 3: compileContext (Unit 4). A throw here means nothing was dispatched,
  // so the reservation `authorizeRoute` made is released, not charged.
  let compiledContext;
  try {
    compiledContext = await compileContext(tx, {
      intent: spec.intent,
      expectedOutputShape: spec.expectedOutputShape,
      taskInstanceId,
      runId,
      candidateArtifactIds: spec.candidateArtifactIds,
      candidateToolCapabilityIds: spec.candidateToolCapabilityIds,
      // The Context Budget the Router authorized (the Task's, or the Governor's degraded one),
      // packed to the routed model's window (§10.7 Pass 2).
      budget: { ...route.contextBudget, maxInputTokens: route.effectiveMaxInputTokens },
    });
    // Spec §5.13/§5.16: the compiled context's lineage and size, recorded on
    // this Invocation — what went in, at what tier, and why anything was left
    // out. Content is never recorded, only ids and counts.
    await emitLifecycleEvent(tx, {
      eventType: "context_compiled",
      subjectId: invocationId,
      correlation: await correlationForRun(tx, runId, invocationId),
      producer: "context-compiler",
      payload: {
        intent: spec.intent,
        estimatedInputTokens: compiledContext.estimatedInputTokens,
        maxInputTokens: route.contextBudget.maxInputTokens,
        // Set when the Budget Governor tightened the Task's Context Budget for this call.
        ...(route.budgetOutcome !== "authorized" ? { budgetOutcome: route.budgetOutcome, taskMaxInputTokens: spec.contextBudget.maxInputTokens } : {}),
        effectiveMaxInputTokens: route.effectiveMaxInputTokens,
        contextWindowTokens: route.contextWindowTokens,
        included: compiledContext.provenance.included,
        excluded: compiledContext.provenance.excluded,
        instructionsPresent: compiledContext.layers.instructions.length > 0,
        // From provenance, not the rendered text: matching fence-like text in the
        // artifacts layer was fooled by a trusted artifact that merely contains it.
        untrustedDataFenced: compiledContext.provenance.included.some((entry) => !entry.trusted),
      },
    });
  } catch (error) {
    await releaseReservation(tx, route.reservationId);
    // DECISION (Ruling 5 step 4's "your call"): the Executor owns
    // invocation_failed uniformly across every kind — the Model Router never
    // emits it itself.
    await failInvocation(tx, {
      invocationId,
      runId,
      taskInstanceId,
      reason: error instanceof Error ? error.message : String(error),
      error,
    });
    await failRun(tx, runId);
    return { status: "failed", runId };
  }

  // Step 4: YIELD for dispatch (Phase 9). The provider call is NOT made here,
  // inside the caller's transaction. Instead the Invocation is committed as
  // `executing`, with its reservation recorded exactly where approval-halted
  // holds are (`pendingReservations`), and the caller dispatches with no
  // transaction open, then records the outcome via `completeModelDispatch`.
  //
  // Once this commits there is a durable record that a call may have been
  // made. If the process dies before the outcome is recorded, recovery
  // (`failInterruptedInvocation`) finds the `executing` row and settles it —
  // it is never re-dispatched.
  await markInvocationExecuting(tx, invocationId);
  await savePendingReservation(tx, runId, seqNo, route.reservationId);
  claimDispatchSlot(invocationId);
  return {
    status: "dispatch_required",
    runId,
    dispatch: { kind: "llm", invocationId, runId, route, compiledContext, expectedOutputShape: spec.expectedOutputShape },
  };
}

// ---------------------------------------------------------------------------
// Dispatch completion and interruption recovery (Phase 9)
// ---------------------------------------------------------------------------

/**
 * Invocations whose provider call THIS PROCESS is currently making.
 *
 * This is how `executeRun` tells an `executing` row that is genuinely in
 * flight (return `in_flight`, change nothing) from one whose dispatcher is gone
 * (settle it as interrupted). Process memory is the right authority for that
 * question precisely because it dies with the dispatcher: the application runs
 * as ONE process (spec §13.2), enforced at startup by
 * `acquireExecutorInstanceLock`, so an `executing` row absent from this set has
 * no live dispatcher anywhere.
 *
 * Entries are added in the same transaction that commits `executing`, and
 * removed by the driver once the outcome is recorded — or once it gives up, so
 * a dispatch that failed to record is recoverable rather than "in flight"
 * forever. A stale entry for a transaction that rolled back is inert: it names
 * a random id no committed row carries.
 */
const inFlightDispatches = new Set<string>();

/** The slots claimed inside the current `releasingDispatchClaimsOnFailure` call. */
const dispatchClaimScope = new AsyncLocalStorage<Set<string>>();

function claimDispatchSlot(invocationId: string): void {
  inFlightDispatches.add(invocationId);
  dispatchClaimScope.getStore()?.add(invocationId);
}

/**
 * Runs a transaction that may claim dispatch slots, releasing the slots it
 * claimed if it throws (DURABLE_EXECUTION §7 #4). A throw means this caller
 * will not dispatch them, including when COMMIT succeeded on the server but the
 * client saw an error. Without the release, that committed `executing` row
 * would read `in_flight` until a restart. With it, the row has no owner, so
 * the next advance settles it as interrupted, exactly as the startup sweep
 * would. Never dispatches or retries anything.
 */
export async function releasingDispatchClaimsOnFailure<T>(fn: () => Promise<T>): Promise<T> {
  const claimed = new Set<string>();
  try {
    return await dispatchClaimScope.run(claimed, fn);
  } catch (error) {
    for (const invocationId of claimed) inFlightDispatches.delete(invocationId);
    throw error;
  }
}

/** Called by the dispatch driver when it stops owning a dispatch, whatever the outcome. */
export function releaseDispatchSlot(invocationId: string): void {
  inFlightDispatches.delete(invocationId);
}

export function isDispatchInFlight(invocationId: string): boolean {
  return inFlightDispatches.has(invocationId);
}

async function lockRun(tx: DrizzleTransaction, runId: string): Promise<RunRow | undefined> {
  const [row] = await tx.select().from(runs).where(eq(runs.id, runId)).for("update");
  return row;
}

async function lockInvocation(tx: DrizzleTransaction, invocationId: string) {
  const [row] = await tx.select().from(invocations).where(eq(invocations.id, invocationId)).for("update");
  return row;
}

/**
 * Records the outcome of a dispatch `executeRun` yielded for, in a fresh
 * transaction. Settles that ONE Invocation — completed (reconciled, artifact
 * persisted) or failed (reservation released, Run failed) — and nothing else;
 * the caller then calls `executeRun` again to continue the Run.
 *
 * Deliberately independent of stops and pauses: the call has already happened,
 * so its real consumption and result must be recorded. A stop takes effect at
 * the NEXT Invocation boundary, as spec §9.7 requires.
 *
 * Lock order matches `executeRun`: the Run row, then the Invocation row.
 *
 * If the Invocation is no longer `executing`, recovery already settled it as
 * interrupted — its reservation charged in full and its Run failed. The late
 * outcome is then logged and NOT applied: applying it would reconcile the same
 * reservation twice.
 */
export async function completeModelDispatch(
  tx: DrizzleTransaction,
  dispatch: PendingModelDispatch,
  outcome: ModelDispatchOutcome
): Promise<"completed" | "failed" | "already_settled"> {
  const { invocationId, runId, route } = dispatch;

  const runRow = await lockRun(tx, runId);
  const invocation = await lockInvocation(tx, invocationId);
  if (!runRow || !invocation) {
    throw new Error(`completeModelDispatch: no run "${runId}" / invocation "${invocationId}" found.`);
  }
  if (invocation.status !== "executing") {
    // eslint-disable-next-line no-console
    console.error(
      `completeModelDispatch: invocation "${invocationId}" is "${invocation.status}", not "executing" — it was ` +
        "already settled (e.g. as interrupted). Discarding the late dispatch outcome rather than reconciling twice."
    );
    return "already_settled";
  }

  const recordedReservationId = await peekPendingReservation(tx, runId, invocation.seqNo);
  if (recordedReservationId !== route.reservationId) {
    throw new Error(
      `completeModelDispatch: invocation "${invocationId}"'s recorded reservation does not match the dispatched route's.`
    );
  }

  const taskInstanceId = runRow.taskInstanceId;
  // `finalizeModelCall` reconciles on success; a later throw in OUR code (a
  // plain TypeError from JSON.stringify on a cyclic result, which does not
  // abort the transaction) must not then settle the same reservation again —
  // reconcile/release/charge are not idempotent (budget.ts).
  let reconciled = false;
  try {
    const providerResult = await finalizeModelCall(tx, route, outcome);
    reconciled = true;
    await clearPendingReservation(tx, runId, invocation.seqNo);

    const { artifactId } = await persistInvocationResultAsArtifact(
      tx,
      invocationId,
      toStructuredOutput(providerResult.result)
    );
    // Only now, with the result persisted, is the Invocation's completion a
    // fact — so exactly ONE terminal event is ever recorded for it.
    await emitModelInvocationCompleted(
      tx,
      route,
      providerResult,
      measureArtifactReferences(dispatch.compiledContext.provenance.included, providerResult.result)
    );
    await completeInvocation(tx, { invocationId, runId, taskInstanceId, payload: { artifactId }, emitEvent: false });
    return "completed";
  } catch (error) {
    // A database error raised while recording has aborted this transaction:
    // rethrow it unchanged rather than mask it behind cleanup writes that cannot
    // succeed. The Invocation stays `executing` and is settled as interrupted.
    if (sqlStateOf(error) && !(!outcome.ok && error === outcome.error)) throw error;
    const settlement = await settleFailedDispatchReservation(tx, route.reservationId, outcome, reconciled);
    await clearPendingReservation(tx, runId, invocation.seqNo);
    await failInvocation(tx, {
      invocationId,
      runId,
      taskInstanceId,
      reason: error instanceof Error ? error.message : String(error),
      error,
      details: settlement,
    });
    // A stop caught just before dispatch is recorded like one caught at the
    // Invocation boundary: named in the outcome, with `run_halted`.
    if (!outcome.ok && error === outcome.error && error instanceof ExecutionStoppedError && !error.lookupFailed) {
      await haltRunForStop(tx, runId, taskInstanceId, error.stop);
    } else {
      await failRun(tx, runId);
    }
    return "failed";
  }
}

/**
 * Settles the reservation of a dispatch that ended in failure (Phase 9).
 *
 * - Already reconciled (the failure came after usage was recorded): nothing
 *   more to do — the real usage stands.
 * - The provider failed AND declared it consumed nothing (refused before
 *   sending, or refused outright): RELEASE.
 * - Otherwise — a provider failure of unknown consumption (a timeout, a crash
 *   mid-stream, missing usage), or a call that succeeded but could not be
 *   reconciled (a usage report in the wrong unit): CHARGE AT ESTIMATE. The work
 *   may have been done; releasing would let later work spend that capacity a
 *   second time. The same rule an interrupted Invocation gets.
 *
 * Returned as event details, so the counter movement is explained by the log.
 */
async function settleFailedDispatchReservation(
  tx: DrizzleTransaction,
  reservationId: string,
  outcome: { ok: true } | { ok: false; error: unknown },
  reconciled: boolean
): Promise<Record<string, unknown>> {
  if (reconciled) {
    return { reservationSettlement: "reconciled" };
  }
  if (!outcome.ok && providerConsumptionFrom(outcome.error) === "none") {
    await releaseReservation(tx, reservationId);
    return { reservationSettlement: "released", providerConsumption: "none" };
  }
  const charge = await chargeReservationAtEstimate(tx, reservationId);
  return { reservationSettlement: "charged_at_estimate", providerConsumption: "unknown", ...charge };
}

/** Throws `ExecutionStoppedError` if a stop applies to the Run at any scope above the Grant; returns the Run. */
async function assertRunNotStopped(tx: DrizzleTransaction, runId: string, what: string): Promise<typeof runs.$inferSelect> {
  const run = await tx.query.runs.findFirst({ where: eq(runs.id, runId) });
  if (!run) throw new Error(`${what} refused: run "${runId}" no longer exists.`);
  const taskInstance = await tx.query.taskInstances.findFirst({ where: eq(taskInstances.id, run.taskInstanceId) });
  const workflowRun = taskInstance?.workflowRunId
    ? await tx.query.workflowRuns.findFirst({ where: eq(workflowRuns.id, taskInstance.workflowRunId) })
    : undefined;

  await assertNotStopped(tx, {
    agentDefinitionId: run.agentDefinitionId,
    goalId: workflowRun?.goalId ?? null,
    workflowRunId: taskInstance?.workflowRunId ?? null,
    runId: run.id,
  });
  return run;
}

/** A stop refusal as a value; any other failure (a failed lookup aborts the transaction) propagates. */
function stopRefusal(error: unknown): ExecutionStoppedError {
  if (error instanceof ExecutionStoppedError && !error.lookupFailed) return error;
  throw error;
}

/**
 * Re-checks emergency stops immediately before a model dispatch (DURABLE_EXECUTION
 * §7 #11; spec §9.7). The Invocation-boundary check ran before context compilation
 * and the `executing` commit; a stop engaged since then is honoured here, before
 * any subscription quota or money is spent. Returns the refusal, or null to
 * proceed; the driver records a refusal as consuming nothing, so the reservation is
 * released and the Run is halted naming the stop.
 */
export async function modelDispatchRefusal(tx: DrizzleTransaction, dispatch: PendingModelDispatch): Promise<Error | null> {
  try {
    await assertRunNotStopped(tx, dispatch.runId, "model dispatch");
    return null;
  } catch (error) {
    return stopRefusal(error);
  }
}

/**
 * Re-checks, immediately before a tool's side effect, everything that could
 * have changed since its `executing` commit (spec §9.5 "immediately before
 * execution"; §9.7 stops): emergency stops at every scope, the Grant and Tool
 * Binding through Policy, and — for an approval-gated Invocation — the
 * Approval's re-authorization.
 *
 * Returns the refusal, or null to proceed, rather than throwing, so the driver's
 * short transaction COMMITS what the check recorded (its `policy_evaluated`) even
 * when the effect is refused. It throws only when the check itself fails. Either
 * way nothing was performed, so the driver records the refusal as consuming
 * nothing (the reservation is released). The window that remains is one commit
 * plus a round trip, and a stop engaged inside it takes effect at the next
 * Invocation (DURABLE_EXECUTION §6).
 */
export async function toolDispatchRefusal(tx: DrizzleTransaction, dispatch: PendingToolDispatch): Promise<Error | null> {
  let run: typeof runs.$inferSelect;
  try {
    run = await assertRunNotStopped(tx, dispatch.runId, "tool dispatch");
    await assertCapabilityGrantsNotStopped(tx, {
      runId: run.id,
      capabilityId: dispatch.capabilityId,
      permission: dispatch.permission,
    });
  } catch (error) {
    return stopRefusal(error);
  }

  const grant = await resolveCapabilityGrant(tx, {
    runId: run.id,
    capabilityId: dispatch.capabilityId,
    permission: dispatch.permission,
  });
  const trust = await resolveToolBindingTrustLevel(tx, dispatch.toolBindingId);
  const { decision } = await authorizeInvocation(tx, {
    grant,
    permission: dispatch.permission,
    proposedActionSnapshot: dispatch.proposedActionSnapshot,
    trustLevel: trust.trustLevel,
    bindingTrustLevel: trust.bindingTrustLevel,
    audit: {
      runId: run.id,
      invocationId: dispatch.invocationId,
      capabilityId: dispatch.capabilityId,
      toolBindingId: dispatch.toolBindingId,
      checkpoint: "pre_dispatch",
    },
  });
  if (decision === "DENY") {
    return dispatchRefusal("tool dispatch refused: Policy now denies this action (policy_denied_before_dispatch).", "policy_denied_before_dispatch");
  }

  const approval = await tx.query.approvals.findFirst({ where: eq(approvals.invocationId, dispatch.invocationId) });
  if (approval) {
    if (approval.status !== "approved" || !(await reauthorize(tx, dispatch.invocationId))) {
      return dispatchRefusal(
        "tool dispatch refused: the Approval no longer authorizes this action (reauthorization_failed_before_dispatch).",
        "reauthorization_failed_before_dispatch"
      );
    }
  } else if (decision !== "ALLOW") {
    return dispatchRefusal(
      "tool dispatch refused: this action now requires an Approval it does not have (approval_required_before_dispatch).",
      "approval_required_before_dispatch"
    );
  }
  return null;
}

/** A pre-dispatch refusal carrying a stable `code`, recorded as `errorCode` so no reader parses the sentence. */
function dispatchRefusal(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * Records the outcome of a tool dispatch `executeRun` yielded for, in a fresh
 * transaction — the tool counterpart of `completeModelDispatch`, with the same
 * lock order, the same `already_settled` rule, and the same settlement table
 * (DURABLE_EXECUTION §4.1):
 *   - success: the reservation is reconciled at its estimate (basis
 *     `estimate` — a tool reports no cost), the result persisted as an
 *     Artifact, the Invocation completed;
 *   - an error carrying `consumption: "none"` (the adapter or the pre-effect
 *     check proved nothing was performed): released;
 *   - any other error: charged at estimate — the effect may have happened.
 *
 * A database error raised while RECORDING has aborted this transaction; it is
 * rethrown unchanged rather than masked by cleanup writes that cannot succeed.
 * The Invocation then stays `executing` and is settled as interrupted.
 */
export async function completeToolDispatch(
  tx: DrizzleTransaction,
  dispatch: PendingToolDispatch,
  outcome: ToolDispatchOutcome
): Promise<"completed" | "failed" | "already_settled"> {
  const { invocationId, runId, seqNo, reservationId } = dispatch;

  const runRow = await lockRun(tx, runId);
  const invocation = await lockInvocation(tx, invocationId);
  if (!runRow || !invocation) {
    throw new Error(`completeToolDispatch: no run "${runId}" / invocation "${invocationId}" found.`);
  }
  if (invocation.status !== "executing") {
    // eslint-disable-next-line no-console
    console.error(
      `completeToolDispatch: invocation "${invocationId}" is "${invocation.status}", not "executing" — it was ` +
        "already settled (e.g. as interrupted). Discarding the late tool outcome rather than settling twice."
    );
    return "already_settled";
  }
  if ((await peekPendingReservation(tx, runId, seqNo)) !== reservationId) {
    throw new Error(`completeToolDispatch: invocation "${invocationId}"'s recorded reservation does not match the dispatch's.`);
  }

  const taskInstanceId = runRow.taskInstanceId;
  let reconciled = false;
  try {
    if (!outcome.ok) throw outcome.error;
    if (isRealReservation(reservationId)) {
      await reconcileBudget(tx, reservationId, dispatch.estimatedCost, "estimate");
    }
    reconciled = true; // releasing or charging from here on would settle the reservation twice.
    await clearPendingReservation(tx, runId, seqNo);
    const { artifactId } = await persistInvocationResultAsArtifact(tx, invocationId, outcome.result);
    await completeInvocation(tx, { invocationId, runId, taskInstanceId, payload: { artifactId } });
    return "completed";
  } catch (error) {
    const isToolError = !outcome.ok && error === outcome.error;
    if (!isToolError && sqlStateOf(error)) throw error;
    const settlement = isRealReservation(reservationId)
      ? await settleFailedDispatchReservation(tx, reservationId, outcome, reconciled)
      : { reservationSettlement: "none_recorded" };
    await clearPendingReservation(tx, runId, seqNo);
    await failInvocation(tx, {
      invocationId,
      runId,
      taskInstanceId,
      reason: error instanceof Error ? error.message : String(error),
      error,
      details: settlement,
    });
    // A stop caught by the pre-effect check is recorded exactly as one caught
    // at the Invocation boundary: named in the outcome, with `run_halted`.
    if (isToolError && error instanceof ExecutionStoppedError && !error.lookupFailed) {
      await haltRunForStop(tx, runId, taskInstanceId, error.stop);
    } else {
      await failRun(tx, runId);
    }
    return "failed";
  }
}

/** The `invocation_failed` reason recorded for an Invocation whose dispatcher died mid-call. */
export const INTERRUPTED_INVOCATION_REASON = "interrupted_outcome_unknown";

/**
 * Settles an Invocation left `executing` by a dispatcher that no longer exists
 * — a crash, a restart, or an outcome that could not be recorded.
 *
 * Its outcome is UNKNOWN: the provider may or may not have done the work, and a
 * `claude -p` call carries no idempotency key to ask. The resolution is
 * therefore the conservative one on every axis:
 *   - NEVER re-dispatched. Re-sending could do the work twice and spend twice;
 *     a retry is a new Run (spec §3b/§3d), an explicit decision, not a side
 *     effect of recovery.
 *   - The reservation is CHARGED at its full estimate, not released — see
 *     `chargeReservationAtEstimate` for why releasing would widen effective
 *     authorization.
 *   - The Invocation fails with `outcome: "unknown"` recorded, and its Run
 *     fails, naming the interrupted Invocation. The failure event carries no
 *     `usage`: none was observed, and inventing figures would put fiction in the
 *     immutable ledger. The counter, not the event, carries the charge.
 *
 * Returns false (changing nothing) unless the Invocation is still `executing`.
 * The caller must ensure no live dispatcher owns it (`isDispatchInFlight`).
 */
export async function failInterruptedInvocation(tx: DrizzleTransaction, invocationId: string): Promise<boolean> {
  const unlocked = await tx.query.invocations.findFirst({ where: eq(invocations.id, invocationId) });
  if (!unlocked) return false;

  const runRow = await lockRun(tx, unlocked.runId);
  const invocation = await lockInvocation(tx, invocationId);
  if (!runRow || !invocation || invocation.status !== "executing") return false;

  const envelope = await getBudgetEnvelope(tx, runRow.id);
  const reservationId = envelope.pendingReservations?.[String(invocation.seqNo)];
  let charge: { chargedAmount: string; resourceUnit: string } | null = null;
  if (reservationId && isRealReservation(reservationId)) {
    charge = await chargeReservationAtEstimate(tx, reservationId);
    await clearPendingReservation(tx, runRow.id, invocation.seqNo);
  }

  await failInvocation(tx, {
    invocationId,
    runId: runRow.id,
    taskInstanceId: runRow.taskInstanceId,
    reason: INTERRUPTED_INVOCATION_REASON,
    // The charge is recorded here, as a fact about this Invocation, because no
    // usage-bearing event exists for it: without it the counter movement could
    // not be explained from the log.
    details: charge
      ? { outcome: "unknown", reservationSettlement: "charged_at_estimate", ...charge }
      : { outcome: "unknown", reservationSettlement: "none_recorded" },
  });
  await tx
    .update(runs)
    .set({
      status: "failed",
      completedAt: new Date(),
      outcome: { status: "failed", reason: "invocation_interrupted", invocationId },
    })
    .where(eq(runs.id, runRow.id));
  await emitLifecycleEvent(tx, {
    eventType: "run_failed",
    subjectId: runRow.id,
    correlation: await correlationForRun(tx, runRow.id),
    producer: "executor",
    payload: { reason: "invocation_interrupted", invocationId },
  });
  return true;
}

// ---------------------------------------------------------------------------
// Step failure settlement (post-Phase 9)
// ---------------------------------------------------------------------------

/** The `runs.outcome.reason` of a Run failed because building or executing its step threw. */
export const STEP_EXECUTION_ERROR_REASON = "execution_error";

/**
 * Whether a throw while building or executing a step may be recorded as that
 * step's permanent failure (`settleRunAfterStepFailure`).
 *
 * Not for errors that say nothing about the step itself: a transient database
 * error (the same work may succeed on the next advance), or a stop lookup that
 * failed (the database is unreachable, and a stop must fail closed rather than
 * be recorded as a step failure). Those propagate and roll back, as before.
 */
export function isSettleableStepFailure(error: unknown): boolean {
  if (error instanceof ExecutionStoppedError && error.lookupFailed) return false;
  return !isTransientDatabaseError(error);
}

export type StepFailureSettlement = { kind: "terminal"; status: "failed" | "completed" } | { kind: "in_flight" };

/**
 * Records that a Run's step could not be built or executed — for example its
 * spec builder found ambiguous data, or a row it depends on is gone — so the
 * Run cannot stay stuck, holding budget, with every later advance repeating the
 * same throw.
 *
 * The caller rolled back the failed attempt (a savepoint), so nothing that
 * attempt did is left behind, and this transaction is still usable. Settlement:
 *   - A pending Approval for the Run is closed as `expired` (actor
 *     `system:execution_error`): its action can no longer run. An Approval
 *     already decided keeps its decision; the Invocation failure says why the
 *     approved action did not run.
 *   - An `awaiting_approval` Invocation never executed: its pre-approval hold
 *     is RELEASED, and it fails with the (redacted) error as its reason.
 *   - An `executing` Invocation this process is not dispatching is settled as
 *     interrupted (charged at estimate, never re-dispatched), which also fails
 *     the Run. One this process IS dispatching cannot be settled now: returns
 *     `in_flight`, changing nothing, and the caller rethrows.
 *   - Otherwise the Run fails with reason `execution_error`.
 *
 * Never performs or re-dispatches anything. A Run already terminal is left as
 * it is and its status returned.
 */
export async function settleRunAfterStepFailure(
  tx: DrizzleTransaction,
  runId: string,
  error: unknown
): Promise<StepFailureSettlement> {
  const runRow = await lockRun(tx, runId);
  if (!runRow) throw error;
  if (runRow.status === "failed" || runRow.status === "completed") {
    return { kind: "terminal", status: runRow.status };
  }

  const open = await tx
    .select()
    .from(invocations)
    .where(and(eq(invocations.runId, runId), inArray(invocations.status, ["proposed", "awaiting_approval", "executing"])))
    .orderBy(asc(invocations.seqNo))
    .for("update");
  if (open.some((i) => i.status === "executing" && isDispatchInFlight(i.id))) {
    return { kind: "in_flight" };
  }

  // Approvals first, before any event is written: `resolveApproval` takes the
  // approval row and then the Run's event lock, so the reverse order here could
  // deadlock with a concurrent decision (DURABLE_EXECUTION §6).
  const approvalStatusByInvocation = new Map<string, string>();
  for (const invocation of open.filter((i) => i.status === "awaiting_approval")) {
    const approval = await tx.query.approvals.findFirst({ where: eq(approvals.invocationId, invocation.id) });
    if (!approval) continue;
    if (approval.status === "pending" && (await expirePendingApproval(tx, approval.id, "system:execution_error"))) {
      approvalStatusByInvocation.set(invocation.id, "expired");
    } else {
      // Re-read, not the status read above: a decision racing this settlement
      // makes the conditional expire match nothing once it commits, and the
      // earlier read would record "pending" for an Approval actually approved.
      const current = await tx.query.approvals.findFirst({ where: eq(approvals.id, approval.id) });
      approvalStatusByInvocation.set(invocation.id, current?.status ?? approval.status);
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  for (const invocation of open.filter((i) => i.status !== "executing")) {
    const envelope = await getBudgetEnvelope(tx, runId);
    const reservationId = envelope.pendingReservations?.[String(invocation.seqNo)];
    let reservationSettlement = "none_recorded";
    if (reservationId) {
      if (isRealReservation(reservationId)) await releaseReservation(tx, reservationId);
      await clearPendingReservation(tx, runId, invocation.seqNo);
      reservationSettlement = "released";
    }
    await failInvocation(tx, {
      invocationId: invocation.id,
      runId,
      taskInstanceId: runRow.taskInstanceId,
      reason: `${STEP_EXECUTION_ERROR_REASON}: ${message}`,
      error,
      details: {
        outcome: "not_performed",
        reservationSettlement,
        ...(approvalStatusByInvocation.has(invocation.id) ? { approvalStatus: approvalStatusByInvocation.get(invocation.id) } : {}),
      },
    });
  }

  const executing = open.find((i) => i.status === "executing");
  if (executing) {
    await failInterruptedInvocation(tx, executing.id);
    return { kind: "terminal", status: "failed" };
  }

  await tx
    .update(runs)
    .set({ status: "failed", completedAt: new Date(), outcome: { status: "failed", reason: STEP_EXECUTION_ERROR_REASON } })
    .where(eq(runs.id, runId));
  await emitLifecycleEvent(tx, {
    eventType: "run_failed",
    subjectId: runId,
    correlation: await correlationForRun(tx, runId),
    producer: "executor",
    payload: { reason: STEP_EXECUTION_ERROR_REASON },
  });
  return { kind: "terminal", status: "failed" };
}

// ---------------------------------------------------------------------------
// "deterministic" / "retrieval" kinds — Ruling 6 (minimal, generic handling)
// ---------------------------------------------------------------------------

async function processGenericSpec(
  tx: DrizzleTransaction,
  runRow: RunRow,
  seqNo: number,
  spec: DeterministicInvocationSpec | RetrievalInvocationSpec
): Promise<RunOutcome> {
  const runId = runRow.id;

  const { invocationId } = await proposeInvocation(tx, {
    runId,
    seqNo,
    kind: spec.kind,
    costClass: spec.costClass,
    taskInstanceId: runRow.taskInstanceId,
  });

  try {
    const result = await spec.execute();
    if (result && Object.keys(result).length > 0) {
      await persistInvocationResultAsArtifact(tx, invocationId, result);
    }
    await completeInvocation(tx, { invocationId, runId, taskInstanceId: runRow.taskInstanceId });
    return { status: "completed", runId };
  } catch (error) {
    await failInvocation(tx, {
      invocationId,
      runId,
      taskInstanceId: runRow.taskInstanceId,
      reason: error instanceof Error ? error.message : String(error),
      error,
    });
    await failRun(tx, runId);
    return { status: "failed", runId };
  }
}

// ---------------------------------------------------------------------------
// executeRun
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Deferred spec resolution (final-review Finding 4) — see ./types.ts's
// `DeferredInvocationSpec` for the contract and the architectural bounds.
// ---------------------------------------------------------------------------

/**
 * The Run's own ledger of what its EARLIER Invocations produced (Phase 3a: "a
 * container/ledger holding an ordered sequence of Invocations"; Phase 5.6's Run
 * State: "only prior Invocation outputs within this Run").
 *
 * Generic and capability-agnostic by construction: it selects ids for one
 * `runId` below one `seqNo` and interprets nothing. The Executor never reads an
 * artifact's content — Phase 5.5 leaves reference-vs-content to the Context
 * Compiler, and Phase 4 keeps context compilation out of this module.
 *
 * Ordering is `invocations.seqNo` (Phase 3e's authoritative causal order) with
 * `artifacts.id` as a stable tiebreak for the case of one Invocation producing
 * several artifacts. Deliberately NOT `artifacts.createdAt`: that column is
 * `defaultNow()` and Postgres `now()` is transaction-stable, so every artifact
 * written inside one transaction (which is how this whole codebase's tests, and
 * one `advanceWorkflowRun` call, run) carries an identical timestamp.
 */
async function collectPriorArtifacts(tx: DrizzleTransaction, runId: string, seqNo: number): Promise<PriorInvocationArtifact[]> {
  return tx
    .select({ seqNo: invocations.seqNo, invocationId: invocations.id, artifactId: artifacts.id })
    .from(artifacts)
    .innerJoin(invocations, eq(artifacts.producingInvocationId, invocations.id))
    .where(and(eq(invocations.runId, runId), lt(invocations.seqNo, seqNo)))
    .orderBy(asc(invocations.seqNo), asc(artifacts.id));
}

/**
 * Resolves one plan position to a concrete spec, building the resolution
 * context lazily — the join above runs only for a position that is actually
 * deferred AND actually needs processing.
 *
 * `typeof planned === "function"` is a safe discriminator: all four
 * `InvocationSpec` variants are object literals, and `execute` is a PROPERTY of
 * a spec, never the spec itself. (Worth stating explicitly — it is a
 * structural-typing judgement rather than a tagged-union check.)
 */
async function resolvePlannedSpec(
  tx: DrizzleTransaction,
  runId: string,
  seqNo: number,
  planned: PlannedInvocationSpec
): Promise<InvocationSpec> {
  if (typeof planned !== "function") return planned;
  const ctx: InvocationSpecContext = { priorArtifacts: await collectPriorArtifacts(tx, runId, seqNo) };
  return planned(ctx);
}

function assertToolSpec(spec: InvocationSpec): asserts spec is ToolInvocationSpec {
  if (spec.kind !== "tool") {
    throw new Error(`executeRun: expected a "tool" spec while resuming an awaiting_approval invocation, got "${spec.kind}".`);
  }
}

async function processFreshSpec(tx: DrizzleTransaction, runRow: RunRow, seqNo: number, spec: InvocationSpec): Promise<RunOutcome> {
  switch (spec.kind) {
    case "tool":
      return processToolSpec(tx, runRow, seqNo, spec);
    case "llm":
      return processLlmSpec(tx, runRow, seqNo, spec);
    case "deterministic":
    case "retrieval":
      return processGenericSpec(tx, runRow, seqNo, spec);
  }
}

export async function executeRun(
  tx: DrizzleTransaction,
  runId: string,
  invocationSpecs: PlannedInvocationSpec[]
): Promise<RunOutcome> {
  // Locked: once the Run commits in several transactions (Phase 9), two callers
  // advancing the same Run must not both propose the same seqNo. The second
  // waits here, then sees the first's committed Invocations. Lock order across
  // the Executor is Run row, then Invocation row, then budget counters.
  const runRow = await lockRun(tx, runId);
  if (!runRow) {
    throw new Error(`executeRun: no run found for id "${runId}"`);
  }

  // Re-entry short-circuit: the Run already reached a terminal state.
  if (runRow.status === "failed") return { status: "failed", runId };
  if (runRow.status === "completed") return { status: "completed", runId };

  // Read once: stable for the life of the Run, and only needed to give the
  // containment check its goal and workflow_run scopes. Both are null for
  // standalone Task Instances, which simply cannot be stopped at those scopes.
  const boundRun: RunRow = runRow;
  const taskInstanceRow = await tx.query.taskInstances.findFirst({
    where: eq(taskInstances.id, boundRun.taskInstanceId),
  });
  const workflowRunRow = taskInstanceRow?.workflowRunId
    ? await tx.query.workflowRuns.findFirst({ where: eq(workflowRuns.id, taskInstanceRow.workflowRunId) })
    : undefined;

  /**
   * THE CONTAINMENT CHECK (Phase 9.7), called from the two places inside this
   * loop that can lead to dispatch — the fresh-spec path and the
   * awaiting_approval resume path.
   *
   * Placed at the LOOP TOP rather than at the three dispatch statements, for
   * two reasons. It covers every Invocation kind uniformly, including the
   * deterministic/retrieval path that has no other governance at all. And it
   * runs BEFORE `resolvePlannedSpec`, so a stopped Run never even resolves a
   * caller-supplied deferred-spec thunk — those thunks read and write the
   * database, so gating only the dispatch statement would leave real work
   * reachable under a stop.
   *
   * Re-queried on EVERY iteration, deliberately: `runRow` was read once before
   * the loop, so any stop expressed as state on that row would be invisible
   * mid-Run. This reads the control-plane table fresh each time, which under
   * READ COMMITTED observes a stop committed by another connection while this
   * Run is still in flight.
   *
   * Note the ordering above: a `completed` invocation `continue`s before
   * reaching this, so a stop never retroactively touches finished work.
   */
  async function assertRunNotStopped(): Promise<void> {
    // The agent binding is re-read every time rather than taken from
    // `boundRun`: a deferred spec resolved later in this same transaction can
    // rebind the Run, and an agent_definition stop must see the CURRENT
    // binding, not the one captured before the loop started.
    const current = await tx.query.runs.findFirst({ where: eq(runs.id, runId) });
    await assertNotStopped(tx, {
      agentDefinitionId: current?.agentDefinitionId ?? null,
      goalId: workflowRunRow?.goalId ?? null,
      workflowRunId: taskInstanceRow?.workflowRunId ?? null,
      runId,
    });
  }

  try {
    return await runInvocationLoop(boundRun);
  } catch (error) {
    // A stop is a REFUSAL, not a crash: record it as a terminal Run outcome
    // naming which stop halted it, rather than letting it propagate out of the
    // Executor into the interpreter and API as an unhandled error. Any other
    // error still propagates unchanged.
    if (!(error instanceof ExecutionStoppedError)) throw error;
    // A failed lookup is NOT an operator stop. It has aborted the Postgres
    // transaction, so nothing can be written — and recording it as a "global"
    // stop would invent an audit entry. Rethrow: the transaction rolls back
    // with nothing dispatched, which is still fail-closed.
    if (error.lookupFailed) throw error;
    try {
      await haltRunForStop(tx, runId, boundRun.taskInstanceId, error.stop);
    } catch {
      // Defensive: if recording the outcome itself fails, surface the stop —
      // the real cause — rather than the write error. The transaction then
      // rolls back with nothing dispatched; still fail-closed.
      throw error;
    }
    return { status: "failed", runId };
  }

  async function runInvocationLoop(run: RunRow): Promise<RunOutcome> {
  for (let i = 0; i < invocationSpecs.length; i++) {
    const seqNo = i + 1;
    const planned = invocationSpecs[i]!;

    const existing = await tx.query.invocations.findFirst({
      where: and(eq(invocations.runId, runId), eq(invocations.seqNo, seqNo)),
    });

    if (existing) {
      if (existing.status === "completed") {
        // Never re-execute an already-completed invocation — and note this
        // `continue` comes BEFORE any deferred-spec resolution, so a completed
        // position's thunk is never called either. That ordering is what keeps
        // the deferred-spec primitive incapable of defeating either re-entry
        // guard (this one, or the terminal `runs.status` check above); it is
        // pinned by tests/execution/deferredInvocationSpecs.test.ts.
        continue;
      }
      if (existing.status === "awaiting_approval") {
        try {
          await assertRunNotStopped();
          // The capability_grant scope too: without it a Grant-scoped stop
          // engaged while this invocation waited would be bypassed the moment
          // someone approved. Keyed on the STORED (approved) capability and
          // permission; resumeToolSpec rejects a resuming spec that differs.
          if (existing.capabilityId && existing.permission) {
            await assertCapabilityGrantsNotStopped(tx, {
              runId,
              capabilityId: existing.capabilityId,
              permission: existing.permission,
            });
          }
        } catch (error) {
          // This invocation already HOLDS a budget reservation, taken before
          // the approval halt. A stop here must release it and terminate the
          // invocation, exactly as every other refusal on the resume path does
          // — otherwise the hold is stranded forever: the Run is about to become
          // terminal, and nothing else ever reads pendingReservations.
          //
          // Skipped for a lookup failure, which has aborted the transaction: no
          // write could succeed, and the whole transaction rolls back anyway.
          if (error instanceof ExecutionStoppedError && !error.lookupFailed) {
            // A still-PENDING approval for this invocation can now never take
            // effect — its Run is about to become terminal. Close it so it
            // leaves the approvals queue instead of waiting forever for a
            // decision nothing will act on. Conditional on `pending`, so an
            // already-resolved approval keeps its real decision.
            //
            // Done FIRST, before any event is emitted: `resolveApproval` locks
            // the approval row and then the Run's event advisory lock, so taking
            // the approval row here only after that advisory lock would let a
            // concurrent approve deadlock with this stop.
            const pendingApproval = await tx.query.approvals.findFirst({
              where: and(eq(approvals.invocationId, existing.id), eq(approvals.status, "pending")),
            });
            if (pendingApproval) {
              await expirePendingApproval(tx, pendingApproval.id, "system:execution_stop");
            }
            const reservationId = await peekPendingReservation(tx, runId, seqNo);
            if (isRealReservation(reservationId)) {
              await releaseReservation(tx, reservationId);
            }
            await clearPendingReservation(tx, runId, seqNo);
            await failInvocation(tx, {
              invocationId: existing.id,
              runId,
              taskInstanceId: run.taskInstanceId,
              reason: "execution_stopped",
            });
          }
          throw error;
        }
        const spec = await resolvePlannedSpec(tx, runId, seqNo, planned);
        assertToolSpec(spec); // only "tool" specs ever reach awaiting_approval
        const outcome = await resumeToolSpec(tx, run, seqNo, spec, existing);
        if (outcome.status !== "completed") return outcome;
        continue; // resumed and completed — proceed to the next spec, not restart from 0
      }
      if (existing.status === "executing") {
        // Checked BEFORE any containment check: the call already happened (or
        // is happening), so a stop cannot un-send it — it applies at the next
        // Invocation boundary.
        if (isDispatchInFlight(existing.id)) {
          return { status: "in_flight", runId };
        }
        // No live dispatcher owns it: interrupted, outcome unknown.
        await failInterruptedInvocation(tx, existing.id);
        return { status: "failed", runId };
      }
      // A committed "proposed" or "failed" Invocation on a Run that is still
      // executing should be unreachable: proposing and settling happen in the
      // same transaction as the step, and a failed Invocation fails its Run.
      // Fail loudly rather than re-running or skipping something whose side
      // effects are unknown. (`executing` is handled above.)
      throw new Error(
        `executeRun: invocation for run "${runId}" seqNo ${seqNo} is in unexpected status "${existing.status}" ` +
          "for a Run that is still executing (invariant violation)."
      );
    }

    await assertRunNotStopped();
    const spec = await resolvePlannedSpec(tx, runId, seqNo, planned);
    const outcome = await processFreshSpec(tx, run, seqNo, spec);
    if (outcome.status !== "completed") return outcome;
  }

  await tx
    .update(runs)
    .set({ status: "completed", completedAt: new Date(), outcome: { status: "completed" } })
    .where(eq(runs.id, runId));
  await emitLifecycleEvent(tx, {
    eventType: "run_completed",
    subjectId: runId,
    correlation: await correlationForRun(tx, runId),
    producer: "executor",
  });
  return { status: "completed", runId };
  }
}
