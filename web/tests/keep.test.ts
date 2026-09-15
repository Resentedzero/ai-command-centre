/** Presentation mappings in lib/keep: character identity (#54) and amount display (#45). */
import { describe, expect, it } from "vitest";
import { characterFor, formatAmount, formatTime, hashOf } from "../lib/keep";

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
