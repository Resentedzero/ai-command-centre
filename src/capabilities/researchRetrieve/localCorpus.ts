/**
 * `searchLocalCorpus` — a real, free, local implementation of `research.retrieve`:
 * plain term matching over `.md` and `.txt` files under `RESEARCH_CORPUS_ROOT`.
 *
 * It exists to fulfil spec §18.2's requirement that "the capability boundary must
 * survive replacing that binding entirely": it replaces the synthetic stub by
 * adding a Tool Binding row, with no change to the Capability or its builder. It
 * is deliberately not a search engine: no index, no stemming, no embeddings
 * (spec Phase 7/19: no vector store until structural retrieval demonstrably
 * fails).
 *
 * Containment: only regular files under the resolved root are read. Symbolic
 * links are not followed, and every path is re-checked to resolve inside the
 * root. Results carry root-relative POSIX paths, never host paths.
 *
 * Bounds: at most `MAX_FILES` files are read, each at most `MAX_FILE_BYTES`;
 * larger files are skipped. Output is at most `maxResults` results with
 * snippets of at most `SNIPPET_CHARS` characters. Ordering is deterministic.
 *
 * What it returns is file content from outside the system, so it is untrusted
 * data: its Artifact has a producing Invocation, and the Context Compiler fences
 * it (spec §5.15).
 */
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const MAX_FILES = 2_000;
export const MAX_FILE_BYTES = 1_000_000;
export const SNIPPET_CHARS = 300;
export const DEFAULT_MAX_RESULTS = 5;
export const MAX_RESULTS_LIMIT = 20;
const MAX_TERMS = 16;
const EXTENSIONS = new Set([".md", ".txt"]);

export type CorpusResult = { title: string; snippet: string; sourcePath: string; score: number };

/** An error proving nothing was read or changed (see `providerConsumptionFrom`). */
function refusal(message: string): Error & { consumption: "none" } {
  return Object.assign(new Error(message), { consumption: "none" as const });
}

/** Lower-cased, de-duplicated word terms of at least two characters, in first-seen order. */
export function queryTerms(query: string): string[] {
  const terms = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2);
  return Array.from(new Set(terms)).slice(0, MAX_TERMS);
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) count++;
  return count;
}

async function listCorpusFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0 && files.length < MAX_FILES) {
    const dir = pending.shift()!;
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(full);
      if (files.length >= MAX_FILES) break;
    }
  }
  return files;
}

function titleOf(content: string, sourcePath: string): string {
  const heading = /^#{1,6}\s+(.+)$/m.exec(content);
  return (heading?.[1] ?? path.posix.basename(sourcePath)).trim().slice(0, 200);
}

function snippetAround(content: string, index: number): string {
  const half = Math.floor(SNIPPET_CHARS / 2);
  const start = Math.max(0, index - half);
  return content.slice(start, start + SNIPPET_CHARS).replace(/\s+/g, " ").trim();
}

export async function searchLocalCorpus(query: string, maxResults: number = DEFAULT_MAX_RESULTS): Promise<{ results: CorpusResult[] }> {
  const configuredRoot = process.env.RESEARCH_CORPUS_ROOT;
  if (!configuredRoot) throw refusal("searchLocalCorpus: RESEARCH_CORPUS_ROOT is not set.");
  const root = path.resolve(configuredRoot);
  const rootStat = await lstat(root).catch(() => null);
  if (!rootStat?.isDirectory()) throw refusal("searchLocalCorpus: RESEARCH_CORPUS_ROOT is not a directory.");

  const terms = queryTerms(query);
  if (terms.length === 0) return { results: [] };
  const limit = Math.min(Math.max(1, Math.floor(maxResults)), MAX_RESULTS_LIMIT);

  const scored: CorpusResult[] = [];
  for (const file of await listCorpusFiles(root)) {
    if (!file.startsWith(root + path.sep)) continue;
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
    const content = await readFile(file, "utf8");
    const lower = content.toLowerCase();
    const score = terms.reduce((sum, term) => sum + countOccurrences(lower, term), 0);
    if (score === 0) continue;
    const firstIndex = Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i !== -1));
    const sourcePath = path.relative(root, file).split(path.sep).join("/");
    scored.push({ title: titleOf(content, sourcePath), snippet: snippetAround(content, firstIndex), sourcePath, score });
  }

  scored.sort((a, b) => b.score - a.score || (a.sourcePath < b.sourcePath ? -1 : a.sourcePath > b.sourcePath ? 1 : 0));
  return { results: scored.slice(0, limit) };
}
