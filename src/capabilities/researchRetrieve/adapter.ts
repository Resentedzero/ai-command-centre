/**
 * The internal Tool Adapter function for `research.retrieve`'s synthetic stub
 * binding (`../toolAdapters.ts`), fulfilled by `./toolBinding.ts`.
 */
import type { InternalToolFunction } from "../toolAdapters.js";
import { retrieveResearch } from "./toolBinding.js";

/** The `config.function` a binding names to be fulfilled by this adapter. */
export const RESEARCH_RETRIEVE_SYNTHETIC = "research.retrieve.synthetic";

export const researchRetrieveSynthetic: InternalToolFunction = {
  async prepare(_tx, { proposedActionSnapshot }) {
    const query = proposedActionSnapshot.query;
    if (typeof query !== "string" || query.trim() === "") {
      throw new Error(`${RESEARCH_RETRIEVE_SYNTHETIC}: the proposed action carries no query.`);
    }
    // The cost declaration this binding carried before the adapter registry,
    // kept unchanged. It reserves a small USD amount although nothing is metered.
    return { inputs: { query }, costClass: "metered_api", estimatedCost: 0.01 };
  },
  execute: async ({ inputs }) => await retrieveResearch(inputs.query as string),
};
