/**
 * The internal Tool Adapter function behind `research.search`: one named public index,
 * searched for one query. Which indexes exist is this file's business, never the
 * Capability's (`./capability.ts`) and never an agent's.
 */
import type { InternalToolFunction } from "../toolAdapters.js";
import { RESEARCH_SEARCH_CAPABILITY } from "./capability.js";
import { RESEARCH_PROVIDERS, ResearchUnavailableError, searchProvider, type ResearchProvider } from "./providers.js";

/** The `config.function` a binding names to be fulfilled by this adapter. */
export const RESEARCH_SEARCH_PUBLIC_INDEXES = "research.search.public_indexes";

export const researchSearchPublicIndexes: InternalToolFunction = {
  capabilityName: RESEARCH_SEARCH_CAPABILITY.id,
  // Newly discovered material from outside this machine — the one evidence class that lets
  // a deliverable say external sources were consulted.
  evidenceClass: "external",

  async prepare(_tx, { proposedActionSnapshot }) {
    const query = proposedActionSnapshot.query;
    if (typeof query !== "string" || query.trim() === "") {
      throw new Error(`${RESEARCH_SEARCH_PUBLIC_INDEXES}: the proposed action carries no query.`);
    }
    const source = proposedActionSnapshot.source;
    if (typeof source !== "string" || !RESEARCH_PROVIDERS.includes(source as ResearchProvider)) {
      throw new Error(`${RESEARCH_SEARCH_PUBLIC_INDEXES}: "${String(source)}" is not a source; choose one of ${RESEARCH_PROVIDERS.join(", ")}.`);
    }
    // Free to call, but rate-limited and dependent on a third party staying up (D7).
    return { inputs: { query: query.trim(), source }, costClass: "free_external", estimatedCost: 0 };
  },

  async execute({ inputs }) {
    const provider = inputs.source as ResearchProvider;
    try {
      const results = await searchProvider(provider, inputs.query as string);
      // An empty result set is an answer, not a failure: the agent may look elsewhere.
      return { source: provider, query: inputs.query, resultCount: results.length, results };
    } catch (error) {
      if (error instanceof ResearchUnavailableError) {
        // The source failed, so nothing was retrieved and nothing was consumed. Fail
        // explicitly — never return an empty result set, which would read as "nothing
        // exists on this topic" and could end up stated as such in a deliverable.
        throw Object.assign(new Error(`capability_unavailable: ${error.message}`), { consumption: "none" as const });
      }
      throw error;
    }
  },
};
