/**
 * `research.search` as an autonomous loop action: discover material in one named public
 * index. The agent picks the index by name, so nothing in the decision names a provider's
 * implementation — and an index that is added or replaced changes no Grant.
 */
import type { LoopAction } from "../shared/loopActions.js";
import { RESEARCH_SEARCH_CAPABILITY } from "./capability.js";
import { RESEARCH_PROVIDERS } from "./providers.js";

export const researchSearchLoopAction: LoopAction = {
  capabilityName: RESEARCH_SEARCH_CAPABILITY.id,
  permission: "READ",
  describe: `search a public encyclopedic or scholarly source (${RESEARCH_PROVIDERS.join(", ")}) — real external sources, but not the live web`,
  inputFields: {
    query: { maxLength: 300, description: "what to search for" },
    source: { maxLength: 20, description: `which source: ${RESEARCH_PROVIDERS.join(", ")}` },
  },
  toSnapshot: (input) => ({ query: input.query, source: input.source }),
};
