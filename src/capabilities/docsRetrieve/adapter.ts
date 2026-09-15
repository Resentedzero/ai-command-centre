/** The internal function behind `docs.retrieve`: deterministic term matching over the guide cards. */
import type { InternalToolFunction } from "../toolAdapters.js";
import { searchGuide } from "../../keeper/guide.js";
import { DOCS_RETRIEVE_CAPABILITY } from "./capability.js";

export const DOCS_RETRIEVE_GUIDE = "docs.retrieve.guide";
const MAX_QUERY = 300;
const MAX_EXCERPT = 1_500;

export const docsRetrieveGuide: InternalToolFunction = {
  capabilityName: DOCS_RETRIEVE_CAPABILITY.id,
  evidenceClass: "local_corpus",
  async prepare(_tx, { proposedActionSnapshot }) {
    const query = proposedActionSnapshot.query;
    if (typeof query !== "string" || query.trim() === "" || query.length > MAX_QUERY) {
      throw new Error(`${DOCS_RETRIEVE_GUIDE}: the proposed action needs a query of 1 to ${MAX_QUERY} characters.`);
    }
    return { inputs: { query }, costClass: "local_retrieval", estimatedCost: 0 };
  },
  execute: async ({ inputs }) => ({
    results: (await searchGuide(inputs.query as string, 4)).map((h) => ({ title: h.title, slug: h.slug, excerpt: h.body.slice(0, MAX_EXCERPT) })),
  }),
};
