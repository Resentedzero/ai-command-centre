/**
 * `research.retrieve` as an autonomous loop action: retrieve what we already hold
 * for a query. Which data answers (fixture or local documents) is the binding's
 * business, recorded as evidence on the deliverable; it is never external research.
 */
import type { LoopAction } from "../shared/loopActions.js";
import { RESEARCH_RETRIEVE_CAPABILITY } from "./capability.js";

export const researchRetrieveLoopAction: LoopAction = {
  capabilityName: RESEARCH_RETRIEVE_CAPABILITY.id,
  permission: "READ",
  describe: "retrieve information we already hold for a query (not a web search)",
  inputFields: { query: { maxLength: 300, description: "what to retrieve" } },
  toSnapshot: (input) => ({ query: input.query }),
};
