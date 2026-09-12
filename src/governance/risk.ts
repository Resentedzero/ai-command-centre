/**
 * `computeRiskTier` — Phase 9's risk-tier computation. Pure function: no DB,
 * no side effects, same input always produces the same output.
 *
 * The brief (task-3-brief.md) fixes the function's signature and the fact
 * that it must be deterministic, but does not specify the exact escalation
 * rules. This is a documented MVP design decision, not a spec transcription:
 *
 *   - Tiers form a fixed ladder: low < medium < high < highest.
 *   - The result never de-escalates below `staticRiskTag` — that tag is a
 *     floor, not a starting point that can be reasoned away.
 *   - Three independent factors can each escalate the tier by exactly one
 *     step: `amountOrScope` exceeding `AMOUNT_ESCALATION_THRESHOLD`,
 *     `isNovelAction`, and `trustLevel === "unverified_third_party"`.
 *   - Escalations stack (multiple factors can each add a step) and the
 *     result is clamped at "highest" rather than overflowing.
 *
 * `AMOUNT_ESCALATION_THRESHOLD` is an illustrative MVP placeholder — real
 * dollar/scope thresholds are a product decision out of this unit's scope
 * (Phase 9 does not name a concrete number).
 */
export type RiskTier = "low" | "medium" | "high" | "highest";

const TIER_ORDER: readonly RiskTier[] = ["low", "medium", "high", "highest"];

const AMOUNT_ESCALATION_THRESHOLD = 1000;

export function computeRiskTier(input: {
  staticRiskTag: RiskTier;
  amountOrScope: number | null;
  isNovelAction: boolean;
  trustLevel: "first_party" | "verified_third_party" | "unverified_third_party";
}): RiskTier {
  const startIndex = TIER_ORDER.indexOf(input.staticRiskTag);
  if (startIndex === -1) {
    throw new Error(`computeRiskTier: unrecognized staticRiskTag "${input.staticRiskTag}"`);
  }

  let index = startIndex;
  if (input.amountOrScope !== null && input.amountOrScope > AMOUNT_ESCALATION_THRESHOLD) {
    index += 1;
  }
  if (input.isNovelAction) {
    index += 1;
  }
  if (input.trustLevel === "unverified_third_party") {
    index += 1;
  }

  index = Math.min(index, TIER_ORDER.length - 1);
  return TIER_ORDER[index]!;
}
