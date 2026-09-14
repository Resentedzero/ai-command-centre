/**
 * `createApproval` / `resolveApproval` / `reauthorize` — Phase 9's Approval
 * lifecycle and re-authorization check.
 *
 * Zero budget coupling: this module never imports `./budget.ts` or
 * `./costClass.ts`, never queries `budget_counters`, and `reauthorize`
 * deliberately does NOT re-check budget — budget re-verification is the
 * Executor's job via a fresh `reserveBudget` call in Unit 6's chain (Phase
 * 20 risk #2's separation-of-concerns correction).
 *
 * `reauthorize`'s lookup path (from just an `invocationId`, per the
 * pre-dispatch schema ruling):
 *   1. `invocations` row by id -> runId, capabilityId, permission, current
 *      (mutable) proposedActionSnapshot.
 *   2. `runs` row by runId -> agentDefinitionId, agentDefinitionVersion.
 *   3. `approvals` row by invocationId -> the FROZEN proposedActionSnapshot
 *      taken at Approval-creation time. `approvals.invocation_id` carries a
 *      unique index (fix-round-1 addition), so "at most one Approval per
 *      invocation" is a structural DB invariant, not a convention — this
 *      lookup is deterministic by construction, never an arbitrary pick among
 *      several matching rows.
 *   4. If `approval.ttl` is set and has passed, return `false` immediately —
 *      a passive check at the re-authorization boundary. (The proactive expiry
 *      is `../workflow/expireStaleApprovals.ts`, via `expirePendingApproval`.)
 *   5. `capability_grants` rows matching (agentDefinitionId,
 *      agentDefinitionVersion, capabilityId), filtered in application code to
 *      those that are not revoked (`revokedAt === null`) and whose
 *      `permissions` array includes the invocation's `permission`. Matching
 *      against `scope` (Grants can vary by scope) is out of scope for this
 *      MVP unit per the brief's dispatch ruling — at least one qualifying row
 *      is sufficient.
 *   6. Returns `true` only if such a Grant exists AND the invocation's
 *      current `proposedActionSnapshot` deep-equals the approval's frozen
 *      one (the material-change invalidation rule). Otherwise `false`.
 *
 * Error handling: a missing `invocations`, `runs`, or `approvals` row for the
 * given `invocationId` is a caller error (the caller is re-authorizing
 * something that was never set up correctly) and `reauthorize` throws. By
 * contrast, `runs.agentDefinitionId`/`agentDefinitionVersion` being `null`
 * (both nullable columns) or `invocations.capabilityId`/`permission` being
 * `null` (the invocation never went through Policy) are NOT caller errors —
 * they simply mean no Grant can possibly match, so `reauthorize` fails
 * closed and returns `false` rather than throwing.
 *
 * Deliberately NOT checked: `approvals.status`. A `pending` or even
 * `rejected` Approval still yields `true` here if the Grant is valid,
 * unrevoked, covers the permission, the ttl hasn't passed, and the snapshot
 * is unchanged — status-checking is the CALLER's (the Executor's resume path)
 * responsibility, not `reauthorize`'s. `reauthorize`'s stated purpose (Phase
 * 9.5) is re-checking Grant validity immediately before execution, which is
 * orthogonal to how/whether the Approval itself was resolved. This is a
 * documented contract, not an oversight — see the "deliberately does not
 * consult status" test in approvals.test.ts.
 */
import { isDeepStrictEqual } from "node:util";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { approvals, capabilityGrants, invocations, runs } from "../db/schema.js";
import type { DrizzleTransaction } from "../events/emit.js";
import { emitEvent } from "../events/emit.js";
import type { ApprovalResolvedPayload } from "../events/types.js";
import type { RiskTier } from "./risk.js";

export async function createApproval(
  tx: DrizzleTransaction,
  invocationId: string,
  proposedActionSnapshot: Record<string, unknown>,
  riskTier: RiskTier,
  ttlSeconds: number
): Promise<{ id: string; status: "pending" }> {
  const invocation = await tx.query.invocations.findFirst({ where: eq(invocations.id, invocationId) });
  if (!invocation) {
    throw new Error(`createApproval: no invocation found for id "${invocationId}"`);
  }

  // Confirm the invocation's CURRENT (mutable) snapshot matches the one this
  // Approval is being created against, so reauthorize's material-change
  // check has a correct baseline from the moment of creation onward.
  await tx.update(invocations).set({ proposedActionSnapshot }).where(eq(invocations.id, invocationId));

  const ttl = new Date(Date.now() + ttlSeconds * 1000);

  const [row] = await tx
    .insert(approvals)
    .values({
      invocationId,
      proposedActionSnapshot,
      riskTier,
      status: "pending",
      ttl,
    })
    .returning();

  return { id: row!.id, status: "pending" };
}

/** No `approvals` row exists for the given id at all. Distinct from `ApprovalAlreadyResolvedError` so the API layer can map the two to 404 and 409 respectively. */
export class ApprovalNotFoundError extends Error {
  readonly approvalId: string;

  constructor(approvalId: string) {
    super(`resolveApproval: no approval found for id "${approvalId}"`);
    this.name = "ApprovalNotFoundError";
    this.approvalId = approvalId;
  }
}

/**
 * The Approval exists but was not `pending` when its conditional UPDATE ran —
 * it had already been resolved earlier, has expired, or (the case this error
 * was introduced for) it LOST a genuine concurrent race against another
 * resolution. Carries the status the row actually holds now, which for a race
 * is the WINNING decision, so the caller can report it accurately.
 */
export class ApprovalAlreadyResolvedError extends Error {
  readonly approvalId: string;
  readonly currentStatus: string;

  constructor(approvalId: string, currentStatus: string) {
    super(`resolveApproval: approval "${approvalId}" is already resolved (status: "${currentStatus}")`);
    this.name = "ApprovalAlreadyResolvedError";
    this.approvalId = approvalId;
    this.currentStatus = currentStatus;
  }
}

/**
 * Applies a human's approve/reject decision AND records Phase 9.5's explicit
 * "resolution event recorded" step — `approval_granted` on the approve path,
 * `approval_rejected` on the reject path, exactly one of the two, in the SAME
 * transaction as the `approvals.status` update. Without this the Activity
 * feed (Phase 18.1a, "a direct tail of Events") could not show the MVP's
 * flagship governance moment at all; it was the one step of the Phase 9.5
 * lifecycle with no event behind it (final-review Finding 1).
 *
 * ---------------------------------------------------------------------------
 * The status precondition is the UPDATE's own WHERE clause — the DATABASE
 * provides the concurrency guarantee (independent-review Important 1)
 * ---------------------------------------------------------------------------
 * `UPDATE ... WHERE id = $1 AND status = 'pending' RETURNING *` is what makes
 * "one Approval resolves exactly once" true, and it is deliberately NOT an
 * application-side read-then-write pre-check anywhere above this line. A
 * pre-check cannot be correct here no matter which layer performs it: two
 * concurrent requests can both read `pending` before either has written, and
 * the immutable Event log (Phase 8.7) would then record BOTH
 * `approval_granted` and `approval_rejected` for one already-executed action.
 *
 * Under Postgres's own row-level locking the conditional UPDATE closes that
 * window without any coordination between the two transactions: the second
 * transaction's UPDATE blocks on the row lock until the first COMMITs, then
 * re-evaluates its WHERE clause against the now-committed row version, matches
 * ZERO rows, and this function throws `ApprovalAlreadyResolvedError` — before
 * a single downstream statement (the correlation walk, the `emitEvent` call)
 * has run. Because that throw propagates out of the caller's
 * `db.transaction(...)`, the losing request's ENTIRE transaction is rolled
 * back, including any workflow advancement the caller had chained onto the
 * resolution. That whole-transaction rollback is precisely why this is a throw
 * rather than a returned "already resolved" value: a return would leave the
 * caller mid-transaction, having to remember to abort.
 *
 * Three outcomes, distinguishable by the caller:
 *   (a) no such Approval  -> `ApprovalNotFoundError` (the API layer's 404)
 *   (b) not `pending`     -> `ApprovalAlreadyResolvedError` (the 409)
 *   (c) success           -> `{ id, status }`, the unchanged success shape.
 * Note that (b) now also, correctly, covers an `expired` Approval: a TTL that
 * has already auto-resolved to reject (Phase 9.5) can no longer be resolved by
 * a human either.
 *
 * Envelope conventions follow the existing `invocation_started` /
 * `invocation_completed` / `invocation_failed` emissions verbatim
 * (`../execution/invocationLifecycle.ts`): `eventVersion: 1`,
 * `causationId: null`, `usage: null`, an `<eventType>:<id>` idempotency key,
 * and `goalId`/`workflowRunId` left null because no `emitEvent` call site
 * reachable from a Run populates them.
 *
 * Two deliberate departures from those call sites, both because this is the
 * one place a HUMAN, not the system, is acting:
 *   - `actor` is `resolvedBy` rather than `"system"`. Phase 8.7 makes the raw
 *     Event table the audit trail; an audit trail that records every approval
 *     as having been granted by "system" would be worse than useless. Callers
 *     must supply a value from Phase 8.1's actor vocabulary, and it must be
 *     one the SERVER decided — the HTTP layer passes its own fixed
 *     `V1_RESOLUTION_ACTOR` constant (`../api/routes/approvals.ts`) and never
 *     anything read out of a request body (independent-review Important 2).
 *   - `producer` is `"governance"` (this module), not `"executor"`.
 *
 * Correlation is resolved by walking approval -> invocation -> run, so the
 * event lands in the right Run's `sequenceNo` stream and the feed can
 * attribute it. Every link is NOT NULL and FK-constrained, so the walk cannot
 * actually fail — but it degrades to null correlation fields rather than
 * throwing if one ever did, because a best-effort CORRELATION lookup should
 * not be able to fail a governance decision.
 *
 * That is NOT a claim about the event write itself. `emitEvent` runs inside
 * the SAME transaction as the status update, so if it fails, the resolution
 * rolls back with it — which is the correct and intended boundary: a decision
 * whose audit record could not be written must not be allowed to stand. (An
 * earlier version of this comment described the opposite behavior; the comment
 * was wrong, not the code — independent-review Minor 2.)
 */
export async function resolveApproval(
  tx: DrizzleTransaction,
  approvalId: string,
  decision: "approved" | "rejected",
  resolvedBy: string
): Promise<{ id: string; status: "approved" | "rejected" }> {
  const now = new Date();
  const [row] = await tx
    .update(approvals)
    .set({ status: decision, resolvedAt: now, resolvedBy })
    // A pending Approval past its TTL is no longer resolvable (spec 9.5: it
    // auto-resolves to reject, recorded as `expired`). Part of the SAME
    // conditional UPDATE, so a human decision can never land on an expired
    // Approval — previously it could, recording `approval_granted` for work
    // `reauthorize` then refused on its TTL check.
    .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending"), or(isNull(approvals.ttl), gt(approvals.ttl, now))))
    .returning();

  if (!row) {
    // Zero rows matched, which is genuinely ambiguous: either there is no such
    // Approval, or there is one that is no longer resolvable. Read it back to
    // tell them apart — under READ COMMITTED this read takes a fresh snapshot,
    // so it sees the winning transaction's committed status.
    const existing = await tx.query.approvals.findFirst({ where: eq(approvals.id, approvalId) });
    if (!existing) {
      throw new ApprovalNotFoundError(approvalId);
    }
    // Still `pending` means its TTL has passed but the expiry sweep
    // (`../workflow/expireStaleApprovals.ts`) has not recorded it yet. Report
    // it as what it effectively is. Not recorded here: this throw rolls the
    // caller's transaction back, and the sweep owns the expiry and its re-drive.
    throw new ApprovalAlreadyResolvedError(approvalId, existing.status === "pending" ? "expired" : existing.status);
  }

  const invocation = await tx.query.invocations.findFirst({ where: eq(invocations.id, row.invocationId) });
  const run = invocation ? await tx.query.runs.findFirst({ where: eq(runs.id, invocation.runId) }) : undefined;

  const eventType = decision === "approved" ? "approval_granted" : "approval_rejected";
  const payload: ApprovalResolvedPayload = {
    approvalId: row.id,
    riskTier: row.riskTier,
    resolvedBy,
  };

  await emitEvent(tx, {
    // Keyed per approval AND decision. The conditional UPDATE above is now
    // what guarantees at most one resolution event per Approval — this key is
    // the belt-and-braces second line, not the guarantee itself. (Before that
    // UPDATE existed, this key was load-bearing for the repeat-same-decision
    // case and, by design, useless for the approve-then-reject case, which is
    // exactly the audit-log corruption independent-review Important 1 found.)
    idempotencyKey: `${eventType}:${row.id}`,
    eventType,
    eventVersion: 1,
    causationId: null,
    correlation: {
      goalId: null,
      workflowRunId: null,
      taskInstanceId: run?.taskInstanceId ?? null,
      runId: invocation?.runId ?? null,
      invocationId: invocation?.id ?? null,
    },
    actor: resolvedBy,
    producer: "governance",
    payload,
    usage: null,
  });

  return { id: row.id, status: decision as "approved" | "rejected" };
}

/**
 * Re-checks Grant validity and revocation status immediately before
 * execution (Phase 9.5). Always re-queries current Grant state from `tx` —
 * never trusts anything cached by the caller. Deliberately does NOT re-check
 * budget (see module header).
 */
export async function reauthorize(tx: DrizzleTransaction, invocationId: string): Promise<boolean> {
  const invocation = await tx.query.invocations.findFirst({ where: eq(invocations.id, invocationId) });
  if (!invocation) {
    throw new Error(`reauthorize: no invocation found for id "${invocationId}"`);
  }

  const run = await tx.query.runs.findFirst({ where: eq(runs.id, invocation.runId) });
  if (!run) {
    throw new Error(`reauthorize: no run found for invocation "${invocationId}"'s runId "${invocation.runId}"`);
  }

  const approval = await tx.query.approvals.findFirst({ where: eq(approvals.invocationId, invocationId) });
  if (!approval) {
    throw new Error(`reauthorize: no approval found for invocation "${invocationId}"`);
  }

  // Passive ttl-expiry check, independent of the sweep
  // (`expireStaleApprovals.ts`): an Approval whose ttl has already passed can
  // no longer authorize execution, even if the sweep has not reached it yet.
  if (approval.ttl !== null && approval.ttl.getTime() < Date.now()) {
    return false;
  }

  // Fail closed (not a caller error): an invocation that never went through
  // Policy, or a run with no bound agent definition, has no Grant to match.
  if (run.agentDefinitionId === null || run.agentDefinitionVersion === null) {
    return false;
  }
  if (invocation.capabilityId === null || invocation.permission === null) {
    return false;
  }

  const candidateGrants = await tx.query.capabilityGrants.findMany({
    where: and(
      eq(capabilityGrants.agentDefinitionId, run.agentDefinitionId),
      eq(capabilityGrants.agentDefinitionVersion, run.agentDefinitionVersion),
      eq(capabilityGrants.capabilityId, invocation.capabilityId)
    ),
  });

  const permission = invocation.permission;
  const matchingGrant = candidateGrants.find(
    (grant) => grant.revokedAt === null && Array.isArray(grant.permissions) && grant.permissions.includes(permission)
  );

  if (!matchingGrant) {
    return false;
  }

  return isDeepStrictEqual(invocation.proposedActionSnapshot, approval.proposedActionSnapshot);
}

// ---------------------------------------------------------------------------
// Grant revocation (frozen spec Phase 9.7)
// ---------------------------------------------------------------------------

/**
 * The actor recorded on Approvals closed because their Grant was revoked.
 * Server-side, never caller-supplied — see `V1_RESOLUTION_ACTOR`.
 */
export const GRANT_REVOCATION_ACTOR = "system:grant_revoked";

/**
 * Revokes a Capability Grant and, in the SAME transaction, closes every
 * still-pending Approval that was created under it.
 *
 * Spec 9.7: "Revoking a Grant auto-cancels its still-pending Approvals."
 * Without this, a revoked Grant's approvals would sit in the queue looking
 * actionable; approving one would do nothing (`reauthorize` rejects a revoked
 * Grant at resume time), which is misleading rather than unsafe.
 *
 * WHICH approvals: those whose invocation exercised this Grant's capability on
 * a Run bound to this Grant's exact agent definition AND version — the same
 * triple `resolveCapabilityGrant` resolves a Grant by — and that no OTHER
 * surviving Grant on that triple still authorizes.
 *
 * WHAT THIS DOES NOT DO: release the affected invocations' budget holds. This
 * module stays free of budget logic. Each affected invocation remains
 * `awaiting_approval` with its hold intact until its Run is re-driven, at which
 * point the Executor's resume path sees the `expired` Approval, releases the
 * hold, and fails the invocation and Run. `affectedRunIds` is returned so the
 * caller can re-drive them in the same transaction; no route calls this yet
 * (Grant control-plane routes are V1.1 per the roadmap), so any future caller
 * MUST re-drive those Runs or the holds stay reserved.
 *
 * "Cancelled" is recorded as status `expired`: the `approval_status` enum has
 * no `cancelled` member, and `expired` is already treated everywhere as a
 * terminal, non-approved outcome (the resume path releases the invocation's
 * reservation and fails it). `resolved_by` records WHY.
 *
 * Idempotent: revoking an already-revoked Grant revokes nothing and closes
 * nothing. The conditional UPDATEs carry the concurrency guarantee.
 */
export async function revokeCapabilityGrant(
  tx: DrizzleTransaction,
  grantId: string,
  revokedBy = "human:operator"
): Promise<{ revoked: boolean; cancelledApprovalIds: string[]; affectedRunIds: string[] }> {
  const target = await tx.query.capabilityGrants.findFirst({ where: eq(capabilityGrants.id, grantId) });
  if (!target) return { revoked: false, cancelledApprovalIds: [], affectedRunIds: [] };

  // Lock EVERY unrevoked Grant on the triple, in id order, BEFORE revoking.
  // Two concurrent revocations of different covering Grants then serialize
  // instead of each seeing the other as a survivor (leaving an approval pending)
  // or deadlocking. Under READ COMMITTED the waiter re-evaluates `revoked_at IS
  // NULL` once the first commits, so it sees only the true survivors.
  const lockedTriple = await tx
    .select({ id: capabilityGrants.id, permissions: capabilityGrants.permissions })
    .from(capabilityGrants)
    .where(
      and(
        eq(capabilityGrants.agentDefinitionId, target.agentDefinitionId),
        eq(capabilityGrants.agentDefinitionVersion, target.agentDefinitionVersion),
        eq(capabilityGrants.capabilityId, target.capabilityId),
        isNull(capabilityGrants.revokedAt)
      )
    )
    .orderBy(capabilityGrants.id)
    .for("update");

  const [grant] = await tx
    .update(capabilityGrants)
    .set({ revokedAt: new Date() })
    .where(and(eq(capabilityGrants.id, grantId), isNull(capabilityGrants.revokedAt)))
    .returning();

  if (!grant) return { revoked: false, cancelledApprovalIds: [], affectedRunIds: [] };

  const candidates = await tx
    .select({ approvalId: approvals.id, permission: invocations.permission, runId: invocations.runId })
    .from(approvals)
    .innerJoin(invocations, eq(approvals.invocationId, invocations.id))
    .innerJoin(runs, eq(invocations.runId, runs.id))
    .where(
      and(
        eq(approvals.status, "pending"),
        eq(invocations.capabilityId, grant.capabilityId),
        eq(runs.agentDefinitionId, grant.agentDefinitionId),
        eq(runs.agentDefinitionVersion, grant.agentDefinitionVersion)
      )
    );

  // An approval is cancelled only if NO surviving Grant would still authorize
  // it. `capability_grants` has no unique index on the (agent, version,
  // capability) triple, so another unrevoked Grant can cover the same
  // invocation — e.g. revoking a READ Grant must not cancel a pending WRITE
  // approval a separate WRITE Grant still governs. Same coverage rule as
  // `resolveCapabilityGrant`: unrevoked and including the permission.
  const survivors = lockedTriple.filter((g) => g.id !== grant.id);
  const stillCovered = (permission: string | null) =>
    permission !== null &&
    survivors.some((g) => Array.isArray(g.permissions) && g.permissions.includes(permission));

  const cancelledApprovalIds: string[] = [];
  const affectedRunIds = new Set<string>();
  for (const candidate of candidates) {
    if (stillCovered(candidate.permission)) continue;
    if (await expirePendingApproval(tx, candidate.approvalId, GRANT_REVOCATION_ACTOR)) {
      cancelledApprovalIds.push(candidate.approvalId);
      affectedRunIds.add(candidate.runId);
    }
  }

  await emitEvent(tx, {
    idempotencyKey: `capability_grant_revoked:${grant.id}`,
    eventType: "capability_grant_revoked",
    eventVersion: 1,
    causationId: null,
    correlation: { goalId: null, workflowRunId: null, taskInstanceId: null, runId: null, invocationId: null },
    actor: revokedBy,
    producer: "governance",
    payload: {
      grantId: grant.id,
      agentDefinitionId: grant.agentDefinitionId,
      agentDefinitionVersion: grant.agentDefinitionVersion,
      capabilityId: grant.capabilityId,
      cancelledApprovalIds,
    },
    usage: null,
  });

  return { revoked: true, cancelledApprovalIds, affectedRunIds: [...affectedRunIds] };
}

/**
 * Closes a still-pending Approval as `expired`, and records that transition as
 * an `approval_expired` event correlated exactly like `resolveApproval`'s
 * events — so an `approval_required` in the Activity feed always has a visible
 * end, whether the Approval was granted, rejected, or closed by a stop or a
 * revocation.
 *
 * Conditional on `pending`: an Approval already decided keeps its real
 * decision, and the call returns false.
 */
export async function expirePendingApproval(
  tx: DrizzleTransaction,
  approvalId: string,
  resolvedBy: string
): Promise<boolean> {
  const [row] = await tx
    .update(approvals)
    .set({ status: "expired", resolvedAt: new Date(), resolvedBy })
    .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")))
    .returning();
  if (!row) return false;

  const invocation = await tx.query.invocations.findFirst({ where: eq(invocations.id, row.invocationId) });
  const run = invocation ? await tx.query.runs.findFirst({ where: eq(runs.id, invocation.runId) }) : undefined;
  const payload: ApprovalResolvedPayload = { approvalId: row.id, riskTier: row.riskTier, resolvedBy };

  await emitEvent(tx, {
    idempotencyKey: `approval_expired:${row.id}`,
    eventType: "approval_expired",
    eventVersion: 1,
    causationId: null,
    correlation: {
      goalId: null,
      workflowRunId: null,
      taskInstanceId: run?.taskInstanceId ?? null,
      runId: invocation?.runId ?? null,
      invocationId: invocation?.id ?? null,
    },
    actor: resolvedBy,
    producer: "governance",
    payload,
    usage: null,
  });
  return true;
}
