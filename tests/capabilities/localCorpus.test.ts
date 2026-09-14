/**
 * `searchLocalCorpus` (`src/capabilities/researchRetrieve/localCorpus.ts`): plain,
 * bounded, deterministic term matching over a local corpus, contained to its root.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { queryTerms, searchLocalCorpus, SNIPPET_CHARS } from "../../src/capabilities/researchRetrieve/localCorpus.js";

let root: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "corpus-"));
  writeFileSync(path.join(root, "battery.md"), "# Battery chemistries\n\nLithium iron phosphate batteries last longer. Lithium is common.");
  mkdirSync(path.join(root, "notes"));
  writeFileSync(path.join(root, "notes", "sodium.txt"), "Sodium-ion batteries avoid lithium entirely.");
  writeFileSync(path.join(root, "notes", "ignored.json"), '{"lithium": "lithium lithium lithium"}');
  writeFileSync(path.join(root, "unrelated.md"), "Nothing relevant here.");
  writeFileSync(path.join(root, "long.txt"), "x".repeat(5_000) + " lithium " + "y".repeat(5_000));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("searchLocalCorpus", () => {
  it("ranks .md/.txt files by term occurrences, with relative POSIX paths, titles and bounded snippets", async () => {
    vi.stubEnv("RESEARCH_CORPUS_ROOT", root);
    const { results } = await searchLocalCorpus("Lithium batteries");

    expect(results.map((r) => r.sourcePath)).toEqual(["battery.md", "notes/sodium.txt", "long.txt"]);
    // "lithium" twice + "batteries" once ("Battery" in the title is a different word).
    expect(results[0]).toMatchObject({ title: "Battery chemistries", score: 3 });
    expect(results[1]).toMatchObject({ title: "sodium.txt", score: 2 });
    for (const r of results) {
      expect(r.snippet.length).toBeLessThanOrEqual(SNIPPET_CHARS);
      expect(r.snippet.toLowerCase()).toMatch(/lithium|batteries/);
      expect(path.isAbsolute(r.sourcePath)).toBe(false);
      expect(r.sourcePath).not.toContain(root);
    }
  });

  it("is deterministic and honours the result limit", async () => {
    vi.stubEnv("RESEARCH_CORPUS_ROOT", root);
    const first = await searchLocalCorpus("lithium", 2);
    expect(first.results).toHaveLength(2);
    expect(await searchLocalCorpus("lithium", 2)).toEqual(first);
  });

  it("returns nothing for a query with no usable terms or no matches", async () => {
    vi.stubEnv("RESEARCH_CORPUS_ROOT", root);
    expect(await searchLocalCorpus("a ? !")).toEqual({ results: [] });
    expect(await searchLocalCorpus("zeppelin")).toEqual({ results: [] });
  });

  it("refuses without consuming anything when the root is unset or not a directory", async () => {
    vi.stubEnv("RESEARCH_CORPUS_ROOT", "");
    await expect(searchLocalCorpus("lithium")).rejects.toMatchObject({ consumption: "none" });
    vi.stubEnv("RESEARCH_CORPUS_ROOT", path.join(root, "battery.md"));
    await expect(searchLocalCorpus("lithium")).rejects.toMatchObject({ consumption: "none" });
  });

  it("queryTerms lower-cases, splits on non-word characters, drops one-letter terms and de-duplicates", () => {
    expect(queryTerms("Lithium-ion, LITHIUM & a sodium")).toEqual(["lithium", "ion", "sodium"]);
  });
});
