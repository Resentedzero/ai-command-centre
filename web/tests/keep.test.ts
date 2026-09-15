/** Presentation mappings in lib/keep: character identity (#54) and amount display (#45). */
import { describe, expect, it } from "vitest";
import { budgetFallbackTitle, characterFor, formatAmount, formatTime, hashOf, policyEvidenceTitle, policyToken, policyTone, routeToken } from "../lib/keep";

describe("route and budget fallback presentation", () => {
  it("names a budget downgrade as the tier's source, and never drops a source it does not know", () => {
    expect(routeToken({ resultingTier: "CHEAP", attemptedTier: null, tierSource: "budget_downgrade" })).toBe("CHEAP · budget downgrade");
    expect(routeToken({ resultingTier: "MID", attemptedTier: null, tierSource: "default" })).toBe("MID");
    expect(routeToken({ resultingTier: "MID", attemptedTier: null, tierSource: "something_new" })).toBe("MID · something new");
  });

  it("lists the recorded fallback as given", () => {
    expect(budgetFallbackTitle({ fromTier: "MID", attemptedTier: "CHEAP", authorized: true, contextBudgetFactor: 0.75, maxInputTokens: 75000 })).toBe(
      "denied at MID · tried CHEAP · context ×0.75 · input 75000 · authorized"
    );
    expect(budgetFallbackTitle(null)).toBeUndefined();
  });
});

describe("policy decision presentation (the API's record, never recomputed)", () => {
  it("reads an allowed CONDITIONAL decision as neutral words", () => {
    const record = { decision: "ALLOW", basis: "conditional_performance_meets_allow_threshold" };
    expect(policyToken(record)).toBe("allowed · conditional");
    expect(policyTone(record, false)).toBe("neutral");
  });

  it("is red for any denial, amber for an approval requirement only while a human is being asked", () => {
    expect(policyTone({ decision: "DENY" }, false)).toBe("fail");
    expect(policyTone({ decision: "REQUIRE_APPROVAL" }, true)).toBe("wait");
    expect(policyTone({ decision: "REQUIRE_APPROVAL" }, false)).toBe("neutral");
    expect(policyTone(null, true)).toBe("neutral");
  });

  it("lists the recorded rule and evidence as given, and nothing for a non-CONDITIONAL record", () => {
    const rule = { id: "conditional_autonomy_v1", allowAtOrAboveSuccessRate: 0.8, requireApprovalAtOrAboveSuccessRate: 0.6 };
    expect(
      policyEvidenceTitle({ conditionalRule: rule, performanceEvidence: { effectiveTier: "MID", sampleCount: 12, successRate: "0.9", eligibilityReason: null } })
    ).toBe("conditional_autonomy_v1 · MID · 12 samples · success 0.9 · allow ≥ 0.8 · approval ≥ 0.6");
    expect(
      policyEvidenceTitle({ conditionalRule: rule, performanceEvidence: { effectiveTier: null, sampleCount: null, successRate: null, eligibilityReason: "no_routed_tier" } })
    ).toBe("conditional_autonomy_v1 · no routed tier · allow ≥ 0.8 · approval ≥ 0.6");
    expect(policyEvidenceTitle({ conditionalRule: rule, performanceEvidence: null })).toBe(
      "conditional_autonomy_v1 · performance not consulted · allow ≥ 0.8 · approval ≥ 0.6"
    );
    expect(policyEvidenceTitle({ conditionalRule: null, performanceEvidence: null })).toBeUndefined();
  });
});

describe("formatTime", () => {
  it("drops the year in compact form for a past day, and shows only the time today (#57)", () => {
    const past = new Date(2026, 8, 12, 22, 20, 14).toISOString();
    expect(formatTime(past)).toBe("2026-09-12 22:20:14");
    expect(formatTime(past, true)).toBe("09-12 22:20:14");
    expect(formatTime(new Date().toISOString(), true)).toMatch(/^\d\d:\d\d:\d\d$/);
  });
});

describe("characterFor", () => {
  // The live Publisher and Researcher ids, which the id hash maps to the same knight.
  const publisher = "e74dc82f-da5d-4485-81be-c5ea2a8ff771";
  const researcher = "b7913c4d-4743-429e-92d1-c8d84f9625df";

  it("gives the Registry's definitions distinct characters in sorted id order, whatever order the Registry lists them", () => {
    expect(characterFor(researcher, [publisher, researcher])).toBe("knight");
    expect(characterFor(publisher, [publisher, researcher])).toBe("wizard");
    expect(characterFor(publisher, [researcher, publisher])).toBe("wizard");
    expect(characterFor("c", ["a", "b", "c"])).toBe("knight"); // cycles
  });

  it("falls back to the id hash without the Registry, or for an id it doesn't list", () => {
    const byHash = hashOf(publisher) % 2 === 0 ? "knight" : "wizard";
    expect(characterFor(publisher)).toBe(byHash);
    expect(characterFor(publisher, null)).toBe(byHash);
    expect(characterFor(publisher, ["other"])).toBe(byHash);
  });
});

describe("formatAmount", () => {
  it("trims trailing zeros from exact decimals and leaves everything else as is", () => {
    expect(formatAmount("0.000000000000000000")).toBe("0");
    expect(formatAmount("1.00")).toBe("1");
    expect(formatAmount("0.0100")).toBe("0.01");
    expect(formatAmount("120.50")).toBe("120.5");
    expect(formatAmount("200000")).toBe("200000");
    expect(formatAmount("n/a")).toBe("n/a");
  });
});
