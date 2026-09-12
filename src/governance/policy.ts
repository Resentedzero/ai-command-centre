/**
 * `evaluatePolicy` / `validateCapabilityGrant` — Phase 9's Policy engine.
 *
 * This module has ZERO knowledge of budget: it never imports `./budget.ts`
 * or `./costClass.ts`, has no budget-named parameter anywhere, and never
 * queries `budget_counters`. Policy answers "is this agent authorized to
 * attempt this action, at this risk level, via this trust level" — nothing
 * about affordability. Budget is Unit 2's (and, at re-authorization time,
 * Unit 6's Executor's) concern, kept structurally separate per Phase 20 risk
 * #2.
 *
 * Structural ceiling (Phase 9.4): a Grant requesting SPEND/TRADE/PUBLISH/
 * DELETE with autonomyState "AUTONOMOUS" must never be allowed to exist —
 * enforced entirely in `validateCapabilityGrant`. `evaluatePolicy` itself
 * contains no branch naming any of those four permissions; it reads
 * `autonomyState` generically (ALWAYS_APPROVE/CONDITIONAL -> REQUIRE_APPROVAL,
 * AUTONOMOUS -> ALLOW) regardless of which permission is being exercised.
 * The ceiling is a property of what Grants are allowed to exist, not runtime
 * policy logic.
 *
 * Design decision (undocumented by the brief, made here): `evaluatePolicy`
 * additionally denies when the requested `permission` is not present in
 * `grant.permissions` — a Grant that doesn't cover the permission being
 * exercised does not authorize the action, regardless of its autonomyState.
 * This is a generic `.includes()` check across all permission types, not a
 * permission-type-specific branch, so it does not violate the structural
 * ceiling rule above.
 *
 * `evaluatePolicy` looks up the capability's `staticRiskTag` via `tx` (using
 * `grant.capabilityId`) to feed `computeRiskTier` — this is the only reason
 * `tx` is used. When `grant` is `null`, or when the permission isn't covered,
 * there is no `capabilityId` to look up, so `tx` is never touched at all:
 * this is what makes "never reaches risk computation" a structural property
 * of the DENY-on-null-grant path, not just an implementation choice.
 *
 * Fix-round-1 addition: `proposedActionSnapshot.amountOrScope`/`isNovelAction`
 * are read via `readAmountOrScope`/`readIsNovelAction`, which distinguish
 * "field absent" (fine, defaults to `null`/`false`) from "field present but
 * the wrong type" (fails closed via throw) — see those functions' docs.
 */
import { eq } from "drizzle-orm";
import { capabilities } from "../db/schema.js";
import type { DrizzleTransaction } from "../events/emit.js";
import { computeRiskTier, type RiskTier } from "./risk.js";

export type PolicyDecision = "ALLOW" | "DENY" | "REQUIRE_APPROVAL";

export type CapabilityPermission = "READ" | "WRITE" | "CREATE" | "PUBLISH" | "SPEND" | "TRADE" | "DELETE" | "EXECUTE" | "SEND";

export type CapabilityGrant = {
  agentDefinitionId: string;
  agentDefinitionVersion: number;
  capabilityId: string;
  permissions: CapabilityPermission[];
  autonomyState: "ALWAYS_APPROVE" | "CONDITIONAL" | "AUTONOMOUS";
};

/** Permission types subject to Phase 9.4's structural autonomy ceiling. */
const AUTONOMY_CEILING_PERMISSIONS: ReadonlySet<CapabilityPermission> = new Set(["SPEND", "TRADE", "PUBLISH", "DELETE"]);

/**
 * Enforces Phase 9.4's structural ceiling: a Grant requesting SPEND/TRADE/
 * PUBLISH/DELETE with autonomyState "AUTONOMOUS" is rejected at validation
 * time. Applies only to the four named permission types — READ/WRITE/CREATE/
 * EXECUTE/SEND may be AUTONOMOUS freely.
 */
export function validateCapabilityGrant(grant: CapabilityGrant): { valid: true } | { valid: false; reason: string } {
  if (grant.autonomyState !== "AUTONOMOUS") {
    return { valid: true };
  }

  const ceilingPermission = grant.permissions.find((permission) => AUTONOMY_CEILING_PERMISSIONS.has(permission));
  if (ceilingPermission) {
    return {
      valid: false,
      reason:
        `Grant requests permission "${ceilingPermission}" with autonomyState "AUTONOMOUS": ` +
        "SPEND/TRADE/PUBLISH/DELETE require ALWAYS_APPROVE or CONDITIONAL (Phase 9.4 structural ceiling).",
    };
  }

  return { valid: true };
}

/** Sentinel riskTier returned when no risk computation was performed (DENY paths below). */
const NO_RISK_COMPUTED: RiskTier = "low";

/**
 * Reads `proposedActionSnapshot.amountOrScope`, distinguishing "field
 * absent" (fine — defaults to `null`, matching `computeRiskTier`'s own
 * `number | null` parameter type) from "field present but the wrong type"
 * (fails closed — throws — rather than silently under-reading a malformed
 * value as "no amount", which would be the least-cautious, wrong-direction
 * default for a risk computation). An explicit `null` is a legitimate,
 * intentional "no amount" value and is accepted, matching the target type.
 * A `number` that is NaN/Infinity/-Infinity is rejected too: it would
 * otherwise silently fail every `amountOrScope > threshold` comparison in
 * `computeRiskTier`, which is exactly the "malformed data reads as
 * low-risk" failure mode this fix targets.
 */
function readAmountOrScope(snapshot: Record<string, unknown>): number | null {
  const value = snapshot.amountOrScope;
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `evaluatePolicy: proposedActionSnapshot.amountOrScope is present but not a finite number ` +
        `(received ${JSON.stringify(value)}). Refusing to silently default to "no amount".`
    );
  }
  return value;
}

/**
 * Reads `proposedActionSnapshot.isNovelAction`, with the same absent-vs-
 * wrong-type distinction as `readAmountOrScope`. `computeRiskTier`'s
 * `isNovelAction` parameter type is plain `boolean` (no `null` variant), so
 * — unlike `amountOrScope` — only `true`/`false` are accepted when the field
 * is present; any other value (including `null`) fails closed via throw
 * rather than silently reading as "not novel".
 */
function readIsNovelAction(snapshot: Record<string, unknown>): boolean {
  const value = snapshot.isNovelAction;
  if (value === undefined) {
    return false;
  }
  if (typeof value !== "boolean") {
    throw new Error(
      `evaluatePolicy: proposedActionSnapshot.isNovelAction is present but not a boolean ` +
        `(received ${JSON.stringify(value)}). Refusing to silently default to "not novel".`
    );
  }
  return value;
}

/**
 * Inputs deliberately exclude budget state. Reads autonomyState generically:
 * ALWAYS_APPROVE -> REQUIRE_APPROVAL; CONDITIONAL -> REQUIRE_APPROVAL for V1
 * (performance-driven relaxation deferred, Phase 18.1); AUTONOMOUS -> ALLOW.
 */
export async function evaluatePolicy(
  tx: DrizzleTransaction,
  input: {
    grant: CapabilityGrant | null; // null if no Grant exists for this Agent/Capability pair
    permission: CapabilityPermission;
    proposedActionSnapshot: Record<string, unknown>;
    trustLevel: "first_party" | "verified_third_party" | "unverified_third_party";
  }
): Promise<{ decision: PolicyDecision; riskTier: RiskTier }> {
  const { grant, permission, proposedActionSnapshot, trustLevel } = input;

  if (grant === null) {
    return { decision: "DENY", riskTier: NO_RISK_COMPUTED };
  }

  if (!grant.permissions.includes(permission)) {
    return { decision: "DENY", riskTier: NO_RISK_COMPUTED };
  }

  // Validate the snapshot's risk-relevant fields before touching the DB, so
  // a malformed snapshot fails closed regardless of what else is true.
  const amountOrScope = readAmountOrScope(proposedActionSnapshot);
  const isNovelAction = readIsNovelAction(proposedActionSnapshot);

  const capability = await tx.query.capabilities.findFirst({ where: eq(capabilities.id, grant.capabilityId) });
  if (!capability) {
    throw new Error(`evaluatePolicy: no capability found for id "${grant.capabilityId}" referenced by the Grant`);
  }

  const riskTier = computeRiskTier({
    staticRiskTag: capability.staticRiskTag as RiskTier,
    amountOrScope,
    isNovelAction,
    trustLevel,
  });

  const decision: PolicyDecision = grant.autonomyState === "AUTONOMOUS" ? "ALLOW" : "REQUIRE_APPROVAL";

  return { decision, riskTier };
}
