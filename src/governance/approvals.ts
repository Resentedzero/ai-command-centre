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
 *      a passive check at the re-authorization boundary (NOT the proactive
 *      background TTL-expiry sweep, which stays out of scope for this unit).
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
 * is unchanged — status-checking is the CALLER's (the future Executor's)
 * responsibility, not `reauthorize`'s. `reauthorize`'s stated purpose (Phase
 * 9.5) is re-checking Grant validity immediately before execution, which is
 * orthogonal to how/whether the Approval itself was resolved. This is a
 * documented contract, not an oversight — see the "deliberately does not
 * consult status" test in approvals.test.ts.
 */
import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import { approvals, capabilityGrants, invocations, runs } from "../db/schema.js";
import type { DrizzleTransaction } from "../events/emit.js";
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

export async function resolveApproval(
  tx: DrizzleTransaction,
  approvalId: string,
  decision: "approved" | "rejected",
  resolvedBy: string
): Promise<{ id: string; status: "approved" | "rejected" }> {
  const [row] = await tx
    .update(approvals)
    .set({ status: decision, resolvedAt: new Date(), resolvedBy })
    .where(eq(approvals.id, approvalId))
    .returning();

  if (!row) {
    throw new Error(`resolveApproval: no approval found for id "${approvalId}"`);
  }

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

  // Passive ttl-expiry check (not the proactive background sweep, which
  // stays out of scope): an Approval whose ttl has already passed can no
  // longer authorize execution.
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
