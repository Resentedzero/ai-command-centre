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
 * contains no branch naming any of those four permissions: ALWAYS_APPROVE ->
 * REQUIRE_APPROVAL, AUTONOMOUS -> ALLOW, and CONDITIONAL -> the Conditional
 * Autonomy rule (`CONDITIONAL_AUTONOMY_RULE`, decided 2026-09-15), whose one
 * permission reference is an allowlist (`READ`): the only actions performance may
 * automatically allow. The ceiling is a property of what Grants are allowed to
 * exist, not runtime policy logic. Each decision also returns a `basis` naming the
 * path taken; it explains the decision and never feeds it.
 *
 * Performance reaches Policy only as `conditionalEvidence`, resolved by the caller
 * through the minimum sample criterion's gate (`./performanceEligibility.ts`); this
 * module never queries the projection. The evidence can only narrow what a
 * CONDITIONAL Grant does: it never promotes an autonomy state, never touches an
 * ALWAYS_APPROVE or AUTONOMOUS Grant, and never allows a gated action.
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

/**
 * Why `evaluatePolicy` decided as it did: exactly one value per return path, recorded
 * with every evaluation (`policy_evaluated`) so a decision is explainable without
 * re-deriving it. Evaluations recorded before 2026-09-15's Conditional Autonomy rule
 * carry `autonomy_conditional_rule_undecided`, which Policy no longer returns.
 */
export type PolicyBasis =
  | "no_grant"
  | "permission_not_granted"
  | "binding_below_grant_trust_bar"
  | "autonomy_always_approve"
  | "autonomy_autonomous"
  | "autonomy_state_unrecognized"
  | "unverified_binding_requires_approval"
  | "conditional_human_gated_action"
  | "conditional_insufficient_evidence"
  | "conditional_performance_meets_allow_threshold"
  | "conditional_performance_below_allow_threshold"
  | "conditional_performance_below_deny_threshold";

/** The three DENY paths that return before any risk tier is computed: configuration facts. */
const CONFIGURATION_DENY_BASES: ReadonlySet<PolicyBasis> = new Set(["no_grant", "permission_not_granted", "binding_below_grant_trust_bar"]);

/** Whether Policy computed a risk tier for this decision (a performance DENY computes one; a configuration DENY does not). */
export function riskTierComputed(basis: PolicyBasis): boolean {
  return !CONFIGURATION_DENY_BASES.has(basis);
}

/**
 * The Conditional Autonomy rule (spec §9.4), values decided by the operator 2026-09-15.
 * For a CONDITIONAL Grant only, and only for an action that may be automatically allowed
 * at all — a READ whose computed risk tier is `low` — the performance of the Run's own
 * Agent Definition version and Task Definition at the tier the Model Router selected in
 * this Run decides: success rate >= 0.80 ALLOW, >= 0.60 REQUIRE_APPROVAL, below DENY.
 * Evidence below the minimum sample criterion, or none, requires approval. Every other
 * CONDITIONAL action (spending, publishing, deleting, writing, sending, executing, any
 * risk above `low`) requires approval whatever the performance. `id` is recorded with
 * every CONDITIONAL evaluation so a decision names the rule it applied.
 */
export const CONDITIONAL_AUTONOMY_RULE = {
  id: "conditional_autonomy_v1",
  allowAtOrAboveSuccessRate: 0.8,
  requireApprovalAtOrAboveSuccessRate: 0.6,
  autoAllowPermissions: ["READ"] as readonly CapabilityPermission[],
  autoAllowRiskTiers: ["low"] as readonly RiskTier[],
} as const;

/**
 * The performance a CONDITIONAL evaluation consulted, as resolved by
 * `performanceEligibility.ts#readConditionalEvidence` (the sample criterion's gate). Policy
 * reads only these fields; it never queries the projection itself.
 * - `effectiveTier`: the resulting tier of the Model Router's latest route in this Run;
 *   null when the Run has routed no model call yet.
 * - `sampleCount`/`successRate`: that row's values; null when no row applies.
 * - `eligible`: the gate's decision; `eligibilityReason` says why not.
 */
export type ConditionalPerformanceEvidence = {
  agentDefinitionId: string | null;
  agentDefinitionVersion: number | null;
  taskDefinitionId: string | null;
  effectiveTier: string | null;
  sampleCount: number | null;
  successRate: string | null;
  minSamples: number | null;
  eligible: boolean;
  eligibilityReason: "no_criterion" | "unbound_run" | "no_routed_tier" | "no_performance_row" | "insufficient_samples" | null;
};

export type CapabilityPermission = "READ" | "WRITE" | "CREATE" | "PUBLISH" | "SPEND" | "TRADE" | "DELETE" | "EXECUTE" | "SEND";

export type CapabilityGrant = {
  /**
   * `capability_grants.id` — surfaced so a `capability_grant`-scoped emergency
   * stop (Phase 9.7) can match the exact Grant being exercised. Always set by
   * `resolveCapabilityGrant`; optional only so hand-built Grant values in
   * Policy's own unit tests stay valid. Policy itself never reads it.
   */
  id?: string;
  agentDefinitionId: string;
  agentDefinitionVersion: number;
  capabilityId: string;
  permissions: CapabilityPermission[];
  /**
   * Phase 9.2's `max_trust_level_required` (`capability_grants`): the Grant's
   * declared MINIMUM `tool_bindings.trust_level` — the trust bar a binding
   * must clear for this Grant to authorize it at all. Same integer space as
   * `tool_bindings.trust_level`; higher is more trusted (see
   * `../execution/invocationLifecycle.ts`'s `mapTrustLevel`). Required, not
   * optional: the column is NOT NULL, so every Grant value carries a bar, and
   * making it required means every construction site is a compile error until
   * it supplies one — no Grant can silently reach Policy with "no bar".
   */
  maxTrustLevelRequired: number;
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
export function readAmountOrScope(snapshot: Record<string, unknown>): number | null {
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
export function readIsNovelAction(snapshot: Record<string, unknown>): boolean {
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
 * Does the binding clear the Grant's declared trust bar (Phase 6 / 9.2)?
 *
 * Both values are raw integers straight off their respective rows
 * (`tool_bindings.trust_level`, `capability_grants.max_trust_level_required`),
 * so this comparison needs no knowledge of the integer -> category mapping and
 * cannot drift from it. Fails closed on anything non-finite — an unreadable
 * trust level is never read as "trusted enough", matching this module's
 * existing `readAmountOrScope`/`readIsNovelAction` convention of refusing to
 * silently default toward less governance.
 */
function meetsGrantTrustBar(bindingTrustLevel: number, maxTrustLevelRequired: number): boolean {
  if (!Number.isFinite(bindingTrustLevel) || !Number.isFinite(maxTrustLevelRequired)) {
    return false;
  }
  return bindingTrustLevel >= maxTrustLevelRequired;
}

/**
 * Inputs deliberately exclude budget state. Reads autonomyState:
 * ALWAYS_APPROVE -> REQUIRE_APPROVAL; CONDITIONAL -> `conditionalDecision`
 * (ALLOW, REQUIRE_APPROVAL or DENY from the recorded evidence); AUTONOMOUS -> ALLOW.
 *
 * Final-review Finding 2 — trust level is now an ACTED-ON input, not just a
 * risk-computation factor. Two rules, both funnelled through this function's
 * existing `ALLOW | DENY | REQUIRE_APPROVAL` contract (never a side-channel
 * gate that runs before or after Policy; Phase 9.3's "never a substitute for
 * Policy/Approval gating" applied to trust exactly as it is to risk):
 *
 *   1. Binding below the Grant's `maxTrustLevelRequired` -> DENY. Phase 9.3
 *      defines DENY as "the Grant doesn't cover the action at all (a
 *      configuration fact, not a judgment call)" — a Grant that declares a bar
 *      the binding does not clear does not cover that binding, and the two
 *      stored integers make it a fact rather than a judgment. Placed with the
 *      other DENY paths, above the snapshot reads and the capability lookup,
 *      so it keeps their structural property: it never touches `tx` and never
 *      reaches risk computation.
 *
 *   2. An `unverified_third_party` binding is never ALLOW -> escalate to
 *      REQUIRE_APPROVAL. Phase 6: "REQUIRE_APPROVAL on first use per
 *      capability; never eligible for autonomous EXECUTE-class permissions
 *      until explicitly upgraded". Deliberately stricter than the letter of
 *      that sentence in two directions, both fail-closed: it applies on EVERY
 *      use, not just the first (a strict superset of the requirement that
 *      needs no first-use state, and therefore no new query, inside Policy),
 *      and to every permission type generically rather than via an
 *      EXECUTE-specific branch (this module's standing rule: `evaluatePolicy`
 *      reads `autonomyState` generically and carries no permission-type
 *      branch). The escalation is one-directional — it can only turn ALLOW
 *      into REQUIRE_APPROVAL, never relax a REQUIRE_APPROVAL into ALLOW.
 *
 * Trust only ever narrows what a Grant authorizes. There is no path by which a
 * higher trust level adds a permission, promotes an autonomyState, or relaxes
 * Phase 9.4's structural ceiling — those remain `validateCapabilityGrant`'s
 * and the `permissions[]` check's business, enforced independently.
 *
 * `bindingTrustLevel` (raw integer) and `trustLevel` (the three-category
 * classification) are two projections of ONE source of truth — the
 * `tool_bindings` row — and callers derive both from a single read of that row
 * (`resolveToolBindingTrustLevel`), which is what keeps them consistent by
 * construction. Neither is derivable from, or influenceable by, anything a
 * model produced: `proposedActionSnapshot` is the only model-reachable input
 * here, and nothing in this function reads a trust value out of it.
 */
export async function evaluatePolicy(
  tx: DrizzleTransaction,
  input: {
    grant: CapabilityGrant | null; // null if no Grant exists for this Agent/Capability pair
    permission: CapabilityPermission;
    proposedActionSnapshot: Record<string, unknown>;
    trustLevel: "first_party" | "verified_third_party" | "unverified_third_party";
    /**
     * The resolved Tool Binding's raw `tool_bindings.trust_level`, read
     * server-side from the binding row — the same row `trustLevel` above is
     * classified from. Compared against the Grant's own
     * `maxTrustLevelRequired`.
     */
    bindingTrustLevel: number;
    /**
     * The performance a CONDITIONAL Grant's rule consults (`CONDITIONAL_AUTONOMY_RULE`),
     * resolved by the caller through the sample criterion's gate. Ignored for any other
     * autonomy state; absent on a CONDITIONAL Grant, it is insufficient evidence.
     */
    conditionalEvidence?: ConditionalPerformanceEvidence | null;
  }
): Promise<PolicyResult> {
  const { grant, permission, proposedActionSnapshot, trustLevel, bindingTrustLevel } = input;

  if (grant === null) {
    return { decision: "DENY", riskTier: NO_RISK_COMPUTED, basis: "no_grant", performanceEvidence: null };
  }

  if (!grant.permissions.includes(permission)) {
    return { decision: "DENY", riskTier: NO_RISK_COMPUTED, basis: "permission_not_granted", performanceEvidence: null };
  }

  // Rule 1 (see header): the Grant declares a trust bar this binding does not
  // clear, so the Grant does not cover this action — a configuration fact.
  if (!meetsGrantTrustBar(bindingTrustLevel, grant.maxTrustLevelRequired)) {
    return { decision: "DENY", riskTier: NO_RISK_COMPUTED, basis: "binding_below_grant_trust_bar", performanceEvidence: null };
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

  // An autonomy state outside the three (the column is text) requires approval and says so,
  // rather than being recorded as ALWAYS_APPROVE.
  const autonomy =
    grant.autonomyState === "AUTONOMOUS"
      ? { decision: "ALLOW" as PolicyDecision, basis: "autonomy_autonomous" as PolicyBasis, performanceEvidence: null }
      : grant.autonomyState === "CONDITIONAL"
        ? conditionalDecision(permission, riskTier, input.conditionalEvidence ?? null)
        : {
            decision: "REQUIRE_APPROVAL" as PolicyDecision,
            basis: (grant.autonomyState === "ALWAYS_APPROVE" ? "autonomy_always_approve" : "autonomy_state_unrecognized") as PolicyBasis,
            performanceEvidence: null,
          };

  // Rule 2 (see header): an unverified binding is never autonomously ALLOWed.
  // One-directional — the only transition this can make is ALLOW ->
  // REQUIRE_APPROVAL.
  if (autonomy.decision === "ALLOW" && trustLevel === "unverified_third_party") {
    return { decision: "REQUIRE_APPROVAL", riskTier, basis: "unverified_binding_requires_approval", performanceEvidence: autonomy.performanceEvidence };
  }

  return { ...autonomy, riskTier };
}

export type PolicyResult = {
  decision: PolicyDecision;
  riskTier: RiskTier;
  basis: PolicyBasis;
  /** The evidence a CONDITIONAL rule consulted; null when no performance was consulted. */
  performanceEvidence: ConditionalPerformanceEvidence | null;
};

/**
 * `CONDITIONAL_AUTONOMY_RULE` applied. Gating comes first, so performance never reaches a
 * decision about an action that must stay human-approved; then evidence below the
 * sample criterion requires approval; only then does the success rate decide. A
 * success rate that is not a finite number in [0, 1] is insufficient evidence.
 */
function conditionalDecision(
  permission: CapabilityPermission,
  riskTier: RiskTier,
  evidence: ConditionalPerformanceEvidence | null
): { decision: PolicyDecision; basis: PolicyBasis; performanceEvidence: ConditionalPerformanceEvidence | null } {
  const rule = CONDITIONAL_AUTONOMY_RULE;
  if (!rule.autoAllowPermissions.includes(permission) || !rule.autoAllowRiskTiers.includes(riskTier)) {
    return { decision: "REQUIRE_APPROVAL", basis: "conditional_human_gated_action", performanceEvidence: null };
  }
  const rate = evidence?.successRate === null || evidence?.successRate === undefined ? NaN : Number(evidence.successRate);
  if (!evidence || !evidence.eligible || !Number.isFinite(rate) || rate < 0 || rate > 1) {
    return { decision: "REQUIRE_APPROVAL", basis: "conditional_insufficient_evidence", performanceEvidence: evidence };
  }
  if (rate >= rule.allowAtOrAboveSuccessRate) {
    return { decision: "ALLOW", basis: "conditional_performance_meets_allow_threshold", performanceEvidence: evidence };
  }
  if (rate >= rule.requireApprovalAtOrAboveSuccessRate) {
    return { decision: "REQUIRE_APPROVAL", basis: "conditional_performance_below_allow_threshold", performanceEvidence: evidence };
  }
  return { decision: "DENY", basis: "conditional_performance_below_deny_threshold", performanceEvidence: evidence };
}
