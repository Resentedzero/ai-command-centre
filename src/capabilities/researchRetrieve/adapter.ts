/**
 * The internal Tool Adapter functions for `research.retrieve`'s bindings
 * (`../toolAdapters.ts`): the synthetic stub (`./toolBinding.ts`) and the local
 * corpus search (`./localCorpus.ts`). Which one runs is decided by the
 * Capability's Tool Binding row, never here.
 */
import type { InternalToolFunction } from "../toolAdapters.js";
import { RESEARCH_RETRIEVE_CAPABILITY } from "./capability.js";
import { DEFAULT_MAX_RESULTS, MAX_RESULTS_LIMIT, searchLocalCorpus } from "./localCorpus.js";
import { retrieveResearch } from "./toolBinding.js";

function requireQuery(name: string, snapshot: Record<string, unknown>): string {
  const query = snapshot.query;
  if (typeof query !== "string" || query.trim() === "") {
    throw new Error(`${name}: the proposed action carries no query.`);
  }
  return query;
}

/** The `config.function` a binding names to be fulfilled by this adapter. */
export const RESEARCH_RETRIEVE_SYNTHETIC = "research.retrieve.synthetic";

export const researchRetrieveSynthetic: InternalToolFunction = {
  capabilityName: RESEARCH_RETRIEVE_CAPABILITY.id,
  async prepare(_tx, { proposedActionSnapshot }) {
    const query = requireQuery(RESEARCH_RETRIEVE_SYNTHETIC, proposedActionSnapshot);
    // The cost declaration this binding carried before the adapter registry,
    // kept unchanged. It reserves a small USD amount although nothing is metered.
    return { inputs: { query }, costClass: "metered_api", estimatedCost: 0.01 };
  },
  execute: async ({ inputs }) => await retrieveResearch(inputs.query as string),
};

/** The `config.function` for the local corpus search. Optional `config.maxResults` (1–20, default 5). */
export const RESEARCH_RETRIEVE_LOCAL_CORPUS = "research.retrieve.local_corpus";

export const researchRetrieveLocalCorpus: InternalToolFunction = {
  capabilityName: RESEARCH_RETRIEVE_CAPABILITY.id,
  async prepare(_tx, { config, proposedActionSnapshot }) {
    const query = requireQuery(RESEARCH_RETRIEVE_LOCAL_CORPUS, proposedActionSnapshot);
    const maxResults = config.maxResults ?? DEFAULT_MAX_RESULTS;
    if (typeof maxResults !== "number" || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS_LIMIT) {
      throw new Error(`${RESEARCH_RETRIEVE_LOCAL_CORPUS}: config.maxResults must be an integer from 1 to ${MAX_RESULTS_LIMIT}.`);
    }
    // A local read: nothing is metered, so it reserves nothing and is not
    // mislabelled as a metered API call.
    return { inputs: { query, maxResults }, costClass: "local_retrieval", estimatedCost: 0 };
  },
  execute: async ({ inputs }) => await searchLocalCorpus(inputs.query as string, inputs.maxResults as number),
};
