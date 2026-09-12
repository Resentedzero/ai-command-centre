import { describe, it, expect } from "vitest";
import { mapTrustLevel } from "../../src/execution/invocationLifecycle.js";

// Fix-round-1 (Important #4): mapTrustLevel had zero direct tests — only the
// `>= 2` (first_party) branch was ever exercised indirectly, via fixtures
// that happened to default trustLevel to 2. The fail-closed branch, which is
// the entire point of the design decision documented in
// invocationLifecycle.ts's module header, was completely unexercised.
describe("mapTrustLevel", () => {
  it("maps trustLevel >= 2 to first_party", () => {
    expect(mapTrustLevel(2)).toBe("first_party");
    expect(mapTrustLevel(3)).toBe("first_party");
    expect(mapTrustLevel(1000)).toBe("first_party");
  });

  it("maps trustLevel === 1 to verified_third_party", () => {
    expect(mapTrustLevel(1)).toBe("verified_third_party");
  });

  it("fails closed to unverified_third_party for trustLevel 0", () => {
    expect(mapTrustLevel(0)).toBe("unverified_third_party");
  });

  it("fails closed to unverified_third_party for negative trustLevel", () => {
    expect(mapTrustLevel(-1)).toBe("unverified_third_party");
    expect(mapTrustLevel(-1000)).toBe("unverified_third_party");
  });

  it("fails closed to unverified_third_party for non-finite input (NaN, Infinity, -Infinity)", () => {
    expect(mapTrustLevel(NaN)).toBe("unverified_third_party");
    // Infinity satisfies the ">= 2" comparison mathematically, but the
    // non-finite guard runs FIRST specifically so a malformed/unbounded value
    // never reads as the LEAST cautious category ("first_party") — proving
    // the fail-closed guard genuinely overrides what the numeric comparison
    // would otherwise produce, not just a case the comparison never reaches.
    expect(mapTrustLevel(Infinity)).toBe("unverified_third_party");
    expect(mapTrustLevel(-Infinity)).toBe("unverified_third_party");
  });
});
