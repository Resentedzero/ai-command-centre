/** Presentation mappings in lib/keep: character identity (#54) and amount display (#45). */
import { describe, expect, it } from "vitest";
import { budgetFallbackTitle, characterFor, kitLayers, lookFor, formatAmount, formatTime, hashOf, policyEvidenceTitle, policyToken, policyTone, routeTitle, routeToken } from "../lib/keep";

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
    // Refused before pricing: never called a denial by the Governor.
    expect(
      budgetFallbackTitle({ fromTier: "MID", attemptedTier: "CHEAP", authorized: false, refusal: "resource_mismatch", contextBudgetFactor: 0.75, maxInputTokens: 750 })
    ).toBe("denied at MID · not tried at CHEAP: resource mismatch · context ×0.75 · input 750");
    expect(
      budgetFallbackTitle({ fromTier: "MID", attemptedTier: "CHEAP", authorized: false, refusal: "insufficient_budget", contextBudgetFactor: 0.75, maxInputTokens: 750 })
    ).toBe("denied at MID · tried CHEAP · context ×0.75 · input 750 · denied");
  });

  it("titles a route with its model (qualified when never called) and the performance it consulted", () => {
    const performance = { consulted: true, reason: null, rows: [{ tier: "MID", sampleCount: 12, successRate: "0.9", eligible: true }] };
    expect(routeTitle({ resultingTier: "MID", modelId: "claude-sonnet-5", performance })).toBe("claude-sonnet-5 · MID 12 samples success 0.9 eligible");
    expect(routeTitle({ resultingTier: null, modelId: "claude-sonnet-5", performance: { consulted: false, reason: "unbound_run", rows: [] } })).toBe(
      "claude-sonnet-5 (priced, not called) · performance not consulted: unbound run"
    );
    expect(routeTitle({ resultingTier: "MID", modelId: null })).toBeUndefined();
    // A row recorded without eligibility is not called ineligible.
    expect(routeTitle({ resultingTier: "MID", modelId: "m", performance: { consulted: true, reason: null, rows: [{ tier: "MID", sampleCount: 2, successRate: "1", eligible: null }] } })).toBe(
      "m · MID 2 samples success 1 eligibility not recorded"
    );
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

describe("characterFor and lookFor", () => {
  const scholar = { skin: "deep", hair: "bun", hairColor: "grey", top: "robe", topColor: "violet", bottom: "skirt", bottomColor: "umber", accessory: "glasses", mark: "book" };
  const definitions = [
    { id: "id-strategist-v2", name: "Strategist", appearance: null },
    { id: "id-researcher-v1", name: "Researcher", appearance: null },
    { id: "id-strategist-v1", name: "Strategist", appearance: null },
    { id: "id-scholar-v1", name: "Scholar", appearance: scholar },
  ];

  it("gives the Registry's agents distinct default characters in sorted name order, whatever order the Registry lists them", () => {
    expect(characterFor("Researcher", ["Strategist", "Researcher"])).toBe("knight");
    expect(characterFor("Strategist", ["Researcher", "Strategist", "Strategist"])).toBe("wizard");
    expect(characterFor("c", ["a", "b", "c"])).toBe("knight"); // cycles
  });

  it("falls back to the name hash without the Registry, or for a name it doesn't list", () => {
    const byHash = hashOf("Publisher") % 2 === 0 ? "knight" : "wizard";
    expect(characterFor("Publisher")).toBe(byHash);
    expect(characterFor("Publisher", null)).toBe(byHash);
    expect(characterFor("Publisher", ["other"])).toBe(byHash);
  });

  it("draws every version of an agent the same, keyed on its name, not its version id", () => {
    expect(lookFor("id-strategist-v1", definitions)).toEqual(lookFor("id-strategist-v2", definitions));
    expect(lookFor("id-strategist-v1", definitions).name).toBe("Strategist");
  });

  it("uses a chosen appearance when the name carries one, and the default character otherwise", () => {
    expect(lookFor("id-scholar-v1", definitions).appearance).toEqual(scholar);
    expect(lookFor("id-researcher-v1", definitions).appearance).toBeNull();
    // An agent with no chosen appearance is drawn with the look the API derived from its name.
    expect(lookFor("x", [{ id: "x", name: "Derived", appearance: null, look: scholar }]).appearance).toEqual(scholar);
    expect(lookFor("unknown-id", definitions, "Researcher")).toEqual(lookFor("id-researcher-v1", definitions));
  });

  it("stacks an appearance's layer strips bottom first and draws nothing for a 'none' part", () => {
    expect(kitLayers(scholar, "walk", "up")).toEqual([
      "/world/agents/walk-up-body-deep.png",
      "/world/agents/walk-up-bottom-skirt-umber.png",
      "/world/agents/walk-up-top-robe-violet.png",
      "/world/agents/walk-up-hair-bun-grey.png",
      "/world/agents/walk-up-accessory-glasses.png",
      "/world/agents/walk-up-mark-book.png",
    ]);
    expect(kitLayers({ ...scholar, hair: "none", accessory: "none", mark: "none" }, "idle")).toHaveLength(3);
    // Left and right share the side strips (left is mirrored by the sprite); down is the default.
    expect(kitLayers(scholar, "work", "left")).toEqual(kitLayers(scholar, "work", "right"));
    expect(kitLayers(scholar, "idle")[0]).toBe("/world/agents/idle-down-body-deep.png");
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
