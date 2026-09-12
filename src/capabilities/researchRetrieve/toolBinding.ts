/**
 * `retrieveResearch` — the concrete implementation backing the
 * `research.retrieve` Capability's `tool_bindings` row (Unit 8).
 *
 * MVP DECISION (documented per the brief's Phase 6 decision framework and
 * Reconciliation point 3 of the frozen spec): this is a DETERMINISTIC, LOCAL
 * implementation — a small synthesized/fixed result set derived from the
 * query string — NOT a call to any real external search provider. No
 * external search API key infrastructure exists anywhere in this codebase
 * (`.env` carries no such key, and no provider wrapper for one exists
 * alongside `src/router/providers/anthropic.ts`/`openai.ts`), so standing
 * one up for a single MVP capability would be pure speculative scope. The
 * `tool_bindings` row seeded for this capability
 * (`src/definitions/seed.ts`) accordingly uses `kind: "internal"` — an
 * in-process implementation, not `"direct_api"`.
 *
 * This module is intentionally invisible to `./capability.ts` — the
 * Capability's contract (id/description/risk/cost) says nothing about how
 * it's fulfilled. Swapping this function's body for a real search API later
 * (or for a test fixture, per the brief's "Codex reviewability" note) is a
 * change confined entirely to this file.
 */
export type ResearchResult = { title: string; snippet: string; sourceUrl: string };

/**
 * Synthesizes a small, fixed-shape set of results for `query`. Genuinely
 * deterministic (same query -> same output) and asynchronous only for
 * interface-compatibility with a future real implementation — no I/O of any
 * kind happens here.
 */
export async function retrieveResearch(query: string): Promise<{ results: ResearchResult[] }> {
  const trimmedQuery = query.trim();
  const encodedQuery = encodeURIComponent(trimmedQuery);

  const results: ResearchResult[] = [
    {
      title: `Overview: ${trimmedQuery}`,
      snippet:
        `A synthesized summary of information relevant to "${trimmedQuery}". ` +
        "This MVP retrieval is a local, deterministic stub — no external search API is called.",
      sourceUrl: `https://internal.local/research?q=${encodedQuery}&section=overview`,
    },
    {
      title: `Key considerations: ${trimmedQuery}`,
      snippet: `Synthesized considerations and open questions related to "${trimmedQuery}".`,
      sourceUrl: `https://internal.local/research?q=${encodedQuery}&section=considerations`,
    },
  ];

  return { results };
}
