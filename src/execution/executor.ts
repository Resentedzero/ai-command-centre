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
 *   - no row -> process it fresh from the top of its per-kind orchestration.
 *   - any other status is an inconsistency this unit does not attempt to
 *     recover from (see the throw at the bottom of `executeRun`'s loop) —
 *     recovering from a mid-execution process crash is out of this unit's
 *     scope.
 * `runs.status` is short-circuited at the top for the two terminal outcomes
 * ("failed"/"completed") so a call after the Run is already finished is a
 * cheap no-op read rather than re-walking every spec.
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
import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import { approvals, invocations, runs } from "../db/schema.js";
import type { DrizzleTransaction } from "../events/emit.js";
import { NOOP_RESERVATION_ID, reconcileBudget, releaseReservation, reserveBudget } from "../governance/budget.js";
import { createApproval, reauthorize } from "../governance/approvals.js";
import { compileContext } from "../context/compiler.js";
import { authorizeRoute, callModel } from "../router/modelRouter.js";
import {
  authorizeInvocation,
  completeInvocation,
  failInvocation,
  proposeInvocation,
  resolveCapabilityGrant,
  resolveToolBindingTrustLevel,
} from "./invocationLifecycle.js";
import { persistInvocationResultAsArtifact } from "./invocationResults.js";
import type {
  DeterministicInvocationSpec,
  InvocationSpec,
  LlmInvocationSpec,
  RetrievalInvocationSpec,
  RunOutcome,
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

async function failRun(tx: DrizzleTransaction, runId: string): Promise<void> {
  await tx
    .update(runs)
    .set({ status: "failed", completedAt: new Date(), outcome: { status: "failed" } })
    .where(eq(runs.id, runId));
}

// ---------------------------------------------------------------------------
// "tool" kind — Ruling 4
// ---------------------------------------------------------------------------

/**
 * Executes an already-authorized-and-reserved tool spec, then finalizes:
 * reconcile budget, persist result as artifact, mark completed — or, on a
 * thrown error, release the reservation and fail the invocation + Run
 * (Ruling 4 step 7 / the tail of step 9).
 *
 * Actual-cost-vs-estimated-cost simplification (undocumented by the brief,
 * a Unit 6 decision): `ToolInvocationSpec.execute()` returns only
 * `Record<string, unknown>` — no channel exists for it to report an actual
 * cost distinct from the estimate. `reconcileBudget` is therefore always
 * called with the SAME `estimatedCost` that was reserved. This is
 * conservative (never under- or over-reports consumption relative to what
 * was held) and is the only option the current `execute()` signature allows;
 * a future unit wanting true actual-cost reconciliation would need to widen
 * that return type.
 *
 * Fix-round-1 (Important #2): `reconcileBudget`/`releaseReservation` are NOT
 * idempotent (per `budget.ts`'s own header) — calling both on the same
 * reservationId double-decrements `reserved_amount` with nothing to detect
 * it. This is reachable: `persistInvocationResultAsArtifact`'s
 * `JSON.stringify` throws a plain `TypeError` (not a DB error, so it does
 * NOT abort the transaction) on a tool result containing a cycle or a
 * `BigInt`, which would happen AFTER `reconcileBudget` already succeeded —
 * so the catch below must not blindly release just because it's in the catch
 * block. Guarded with the `reconciled` flag: once `reconcileBudget` has run
 * (or was skipped because the reservation was a NOOP, which never gets
 * released either way), the catch never attempts a second release.
 */
async function executeToolAndFinalize(
  tx: DrizzleTransaction,
  runRow: RunRow,
  spec: ToolInvocationSpec,
  invocationId: string,
  reservationId: string,
  estimatedCost: number
): Promise<RunOutcome> {
  const runId = runRow.id;
  let reconciled = false;
  try {
    const result = await spec.execute();

    if (isRealReservation(reservationId)) {
      await reconcileBudget(tx, reservationId, estimatedCost);
    }
    reconciled = true; // from here on, releasing reservationId would double-decrement reserved_amount.

    const { artifactId } = await persistInvocationResultAsArtifact(tx, invocationId, result);
    await completeInvocation(tx, {
      invocationId,
      runId,
      taskInstanceId: runRow.taskInstanceId,
      payload: { artifactId },
    });
    return { status: "completed", runId };
  } catch (error) {
    if (!reconciled && isRealReservation(reservationId)) {
      await releaseReservation(tx, reservationId);
    }
    await failInvocation(tx, {
      invocationId,
      runId,
      taskInstanceId: runRow.taskInstanceId,
      reason: error instanceof Error ? error.message : String(error),
    });
    await failRun(tx, runId);
    return { status: "failed", runId };
  }
}

/** Fresh processing of a "tool" spec that has no existing `invocations` row yet — Ruling 4 steps 1-8. */
async function processToolSpec(tx: DrizzleTransaction, runRow: RunRow, seqNo: number, spec: ToolInvocationSpec): Promise<RunOutcome> {
  const runId = runRow.id;

  // Step 1: propose + emit invocation_started (executor's own emitEvent call).
  const { invocationId } = await proposeInvocation(tx, {
    runId,
    seqNo,
    kind: "tool",
    costClass: spec.costClass,
    taskInstanceId: runRow.taskInstanceId,
    capabilityId: spec.capabilityId,
    permission: spec.permission,
    proposedActionSnapshot: spec.proposedActionSnapshot,
    startedPayload: { capabilityId: spec.capabilityId, permission: spec.permission },
  });

  // Steps 2-3: resolve Grant, resolve Tool Binding's trustLevel.
  const grant = await resolveCapabilityGrant(tx, { runId, capabilityId: spec.capabilityId, permission: spec.permission });
  const trustLevel = await resolveToolBindingTrustLevel(tx, spec.toolBindingId);

  // Step 4: evaluatePolicy.
  const { decision, riskTier } = await authorizeInvocation(tx, {
    grant,
    permission: spec.permission,
    proposedActionSnapshot: spec.proposedActionSnapshot,
    trustLevel,
  });

  // Step 5: DENY fails this invocation AND the whole Run.
  if (decision === "DENY") {
    await failInvocation(tx, { invocationId, runId, taskInstanceId: runRow.taskInstanceId, reason: "policy_denied" });
    await failRun(tx, runId);
    return { status: "failed", runId };
  }

  // Step 6: reserveBudget for ALLOW or REQUIRE_APPROVAL.
  const reservation = await reserveBudget(tx, "run", runId, spec.costClass, spec.estimatedCost);
  if (!reservation.authorized) {
    await failInvocation(tx, { invocationId, runId, taskInstanceId: runRow.taskInstanceId, reason: "insufficient_budget" });
    await failRun(tx, runId);
    return { status: "failed", runId };
  }

  // Step 7: ALLOW -> execute immediately, no re-check.
  if (decision === "ALLOW") {
    return executeToolAndFinalize(tx, runRow, spec, invocationId, reservation.reservationId, spec.estimatedCost);
  }

  // Step 8: REQUIRE_APPROVAL -> create Approval, halt at awaiting_approval.
  await createApproval(tx, invocationId, spec.proposedActionSnapshot, riskTier, APPROVAL_TTL_SECONDS);
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
    // "rejected" (Ruling 4 step 9's explicit case), or "expired" — a status this
    // unit never sets itself (the proactive TTL-expiry sweep is out of scope
    // per approvals.ts's own header) but handled defensively as an equally
    // terminal non-approved outcome, rather than silently falling through to
    // the approved-path logic below.
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

  // Release the original hold (it served its purpose while awaiting approval)...
  if (isRealReservation(originalReservationId)) {
    await releaseReservation(tx, originalReservationId);
  }
  await clearPendingReservation(tx, runId, seqNo);
  // ...then a fresh, separate reservation immediately before execution.
  const freshReservation = await reserveBudget(tx, "run", runId, spec.costClass, spec.estimatedCost);
  if (!freshReservation.authorized) {
    await failInvocation(tx, {
      invocationId,
      runId,
      taskInstanceId: runRow.taskInstanceId,
      reason: "insufficient_budget_on_resume",
    });
    await failRun(tx, runId);
    return { status: "failed", runId };
  }

  return executeToolAndFinalize(tx, runRow, spec, invocationId, freshReservation.reservationId, spec.estimatedCost);
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
    await failInvocation(tx, { invocationId, runId, taskInstanceId, reason: "insufficient_budget" });
    await failRun(tx, runId);
    return { status: "failed", runId };
  }

  // Steps 3-4: compileContext (Unit 4) -> callModel (Unit 5).
  //
  // Fix-round-1 (Important #1 + the analogous gap it exposed for this path,
  // fixed here for consistency with Important #2's tool-path fix): the
  // budget reservation `authorizeRoute` made lives on `route.reservationId`.
  // `callModel`'s OWN success path (inside modelRouter.ts) reconciles it,
  // unconditionally, before returning. So:
  //   - a throw from `compileContext`, or from `callModel` itself (e.g. the
  //     provider call throwing), means callModel never returned, so no
  //     reconcile ran yet -> releasing here is correct and was the original
  //     Important #1 leak (nothing released it before this fix).
  //   - a throw from callModel's OWN post-reconcile `emitEvent` call would be
  //     a DB error that aborts the whole transaction outright, so this catch
  //     effectively can't observe a "reconciled but transaction still alive"
  //     state from THAT source.
  //   - BUT a throw from `persistInvocationResultAsArtifact` (a plain
  //     TypeError from JSON.stringify on a cyclic/BigInt result — NOT a DB
  //     error, does NOT abort the transaction) happens in OUR code, AFTER
  //     `callModel` already returned successfully and therefore already
  //     reconciled. Releasing in that case would double-decrement
  //     reserved_amount (budget.ts: reconcileBudget/releaseReservation are
  //     NOT idempotent) — the identical bug class as Important #2. Guarded
  //     the same way: a `reconciled` flag set immediately after `callModel`
  //     returns, checked in the catch before releasing.
  let reconciled = false;
  try {
    const compiledContext = await compileContext(tx, {
      intent: spec.intent,
      taskInstanceId,
      candidateArtifactIds: spec.candidateArtifactIds,
      candidateToolCapabilityIds: spec.candidateToolCapabilityIds,
      budget: spec.contextBudget,
    });

    const { result } = await callModel(tx, route, compiledContext, spec.expectedOutputShape);
    reconciled = true; // callModel's success path already reconciled route.reservationId.

    const { artifactId } = await persistInvocationResultAsArtifact(tx, invocationId, toStructuredOutput(result));
    // emitEvent: false — callModel already emitted invocation_completed (Ruling 3).
    await completeInvocation(tx, { invocationId, runId, taskInstanceId, payload: { artifactId }, emitEvent: false });
    return { status: "completed", runId };
  } catch (error) {
    if (!reconciled) {
      await releaseReservation(tx, route.reservationId);
    }
    // DECISION (Ruling 5 step 4's "your call"): same reasoning as the
    // authorizeRoute-failure branch above — the Executor owns invocation_failed
    // uniformly across every kind, since callModel never emits it itself.
    await failInvocation(tx, {
      invocationId,
      runId,
      taskInstanceId,
      reason: error instanceof Error ? error.message : String(error),
    });
    await failRun(tx, runId);
    return { status: "failed", runId };
  }
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
    });
    await failRun(tx, runId);
    return { status: "failed", runId };
  }
}

// ---------------------------------------------------------------------------
// executeRun
// ---------------------------------------------------------------------------

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
  invocationSpecs: InvocationSpec[]
): Promise<RunOutcome> {
  const runRow = await tx.query.runs.findFirst({ where: eq(runs.id, runId) });
  if (!runRow) {
    throw new Error(`executeRun: no run found for id "${runId}"`);
  }

  // Re-entry short-circuit: the Run already reached a terminal state.
  if (runRow.status === "failed") return { status: "failed", runId };
  if (runRow.status === "completed") return { status: "completed", runId };

  for (let i = 0; i < invocationSpecs.length; i++) {
    const seqNo = i + 1;
    const spec = invocationSpecs[i]!;

    const existing = await tx.query.invocations.findFirst({
      where: and(eq(invocations.runId, runId), eq(invocations.seqNo, seqNo)),
    });

    if (existing) {
      if (existing.status === "completed") {
        continue; // never re-execute an already-completed invocation
      }
      if (existing.status === "awaiting_approval") {
        assertToolSpec(spec); // only "tool" specs ever reach awaiting_approval
        const outcome = await resumeToolSpec(tx, runRow, seqNo, spec, existing);
        if (outcome.status !== "completed") return outcome;
        continue; // resumed and completed — proceed to the next spec, not restart from 0
      }
      // "proposed"/"failed" rows persisting here indicate a mid-execution crash
      // recovery scenario, which is explicitly out of this unit's scope (see
      // module header) — fail loudly rather than silently re-running or
      // silently skipping something whose side effects are unknown.
      throw new Error(
        `executeRun: invocation for run "${runId}" seqNo ${seqNo} is in unexpected status "${existing.status}"; ` +
          "crash-recovery for non-terminal, non-awaiting_approval invocations is out of scope for this unit."
      );
    }

    const outcome = await processFreshSpec(tx, runRow, seqNo, spec);
    if (outcome.status !== "completed") return outcome;
  }

  await tx
    .update(runs)
    .set({ status: "completed", completedAt: new Date(), outcome: { status: "completed" } })
    .where(eq(runs.id, runId));
  return { status: "completed", runId };
}
