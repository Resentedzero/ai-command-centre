import { describe, it, expect } from "vitest";
import { computeRiskTier } from "../../src/governance/risk.js";

// Pure function — no DB, no beforeAll/resetTestSchema needed.

describe("computeRiskTier", () => {
  it("is a pure function: the same input always produces the same tier", () => {
    const input = {
      staticRiskTag: "low" as const,
      amountOrScope: 5,
      isNovelAction: false,
      trustLevel: "first_party" as const,
    };
    const results = new Set(Array.from({ length: 5 }, () => computeRiskTier(input)));
    expect(results.size).toBe(1);
    expect(computeRiskTier(input)).toBe("low");
  });

  it("never de-escalates below staticRiskTag when no escalation factors apply", () => {
    expect(
      computeRiskTier({
        staticRiskTag: "medium",
        amountOrScope: 0,
        isNovelAction: false,
        trustLevel: "first_party",
      })
    ).toBe("medium");
  });

  it("escalates one tier for a large amountOrScope", () => {
    expect(
      computeRiskTier({
        staticRiskTag: "low",
        amountOrScope: 1_000_000,
        isNovelAction: false,
        trustLevel: "first_party",
      })
    ).toBe("medium");
  });

  it("escalates one tier for a novel action", () => {
    expect(
      computeRiskTier({
        staticRiskTag: "low",
        amountOrScope: null,
        isNovelAction: true,
        trustLevel: "first_party",
      })
    ).toBe("medium");
  });

  it("escalates one tier for unverified_third_party trust", () => {
    expect(
      computeRiskTier({
        staticRiskTag: "low",
        amountOrScope: null,
        isNovelAction: false,
        trustLevel: "unverified_third_party",
      })
    ).toBe("medium");
  });

  it("stacks multiple escalation factors", () => {
    expect(
      computeRiskTier({
        staticRiskTag: "low",
        amountOrScope: 1_000_000,
        isNovelAction: true,
        trustLevel: "unverified_third_party",
      })
    ).toBe("highest");
  });

  it("clamps at highest rather than overflowing", () => {
    expect(
      computeRiskTier({
        staticRiskTag: "highest",
        amountOrScope: 1_000_000,
        isNovelAction: true,
        trustLevel: "unverified_third_party",
      })
    ).toBe("highest");
  });

  it("throws for an unrecognized staticRiskTag", () => {
    expect(() =>
      computeRiskTier({
        // @ts-expect-error deliberately invalid at the type level too
        staticRiskTag: "not-a-tier",
        amountOrScope: null,
        isNovelAction: false,
        trustLevel: "first_party",
      })
    ).toThrow(/staticRiskTag/);
  });
});
