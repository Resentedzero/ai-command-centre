/**
 * `searchLocalCorpus` resilience and containment edges: one unreadable file is
 * skipped rather than failing the search, and containment holds for a filesystem
 * root. File reads are wrapped so a single read can be made to fail.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

import { readFile } from "node:fs/promises";
import { isInside, searchLocalCorpus } from "../../src/capabilities/researchRetrieve/localCorpus.js";

let root: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "corpus-resilience-"));
  writeFileSync(path.join(root, "a.md"), "lithium one");
  writeFileSync(path.join(root, "b.md"), "lithium two");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("searchLocalCorpus resilience", () => {
  it("skips a file that cannot be read instead of failing the whole search", async () => {
    vi.stubEnv("RESEARCH_CORPUS_ROOT", root);
    const actualReadFile = vi.mocked(readFile).getMockImplementation()!;
    vi.mocked(readFile).mockImplementation(async (file, options) => {
      if (String(file).endsWith("a.md")) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return actualReadFile(file, options);
    });
    try {
      const { results } = await searchLocalCorpus("lithium");
      expect(results.map((r) => r.sourcePath)).toEqual(["b.md"]);
    } finally {
      vi.mocked(readFile).mockImplementation(actualReadFile);
    }
  });

  it("containment is correct for a filesystem root and for sibling directories sharing a prefix", () => {
    // This platform's filesystem root (`C:\` on Windows, `/` elsewhere) already ends in a separator.
    const fsRoot = path.parse(process.cwd()).root;
    expect(isInside(fsRoot, path.join(fsRoot, "notes", "a.md"))).toBe(true);
    expect(isInside(fsRoot, fsRoot)).toBe(true);
    expect(isInside(path.join(path.sep, "corpus"), path.join(path.sep, "corpus-evil", "a.md"))).toBe(false);
    expect(isInside(path.join(path.sep, "corpus"), path.join(path.sep, "corpus", "a.md"))).toBe(true);
  });
});
