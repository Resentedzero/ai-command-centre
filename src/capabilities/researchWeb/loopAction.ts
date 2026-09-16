/**
 * `research.web` as an autonomous loop action: search the live web for current information.
 *
 * Unlike every other loop action, this one is not carried out by a Tool Invocation: the
 * search happens inside a model call, so the action declares `providerTools` and the loop
 * builds a governed LLM Invocation holding exactly that tool. Grant, Policy, budget, stop
 * and events are the same as any other action — the difference is only where the work runs.
 */
import type { LoopAction } from "../shared/loopActions.js";
import { RESEARCH_WEB_CAPABILITY } from "./capability.js";

/** The provider-side tool this action needs. Named here, authorized by the Grant, never by a prompt. */
export const WEB_SEARCH_TOOL = "WebSearch";

export const researchWebLoopAction: LoopAction = {
  capabilityName: RESEARCH_WEB_CAPABILITY.id,
  permission: "READ",
  describe: "search the live web for current information — expensive, so use it only when the answer must be current or is not in the scholarly sources",
  inputFields: { query: { maxLength: 300, description: "what to find out from the live web" } },
  toSnapshot: (input) => ({ query: input.query }),
  providerTools: [WEB_SEARCH_TOOL],
  get providerToolOutputSchema() {
    return WEB_SEARCH_OUTPUT_SCHEMA as unknown as Record<string, unknown>;
  },
};

/**
 * What a web search must return. Every field is bounded, and `sources` is required with at
 * least one entry: a search that cites nothing is not evidence, and the schema refusing it
 * is cheaper than discovering it in a deliverable.
 */
export const WEB_SEARCH_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string", maxLength: 2_000 },
    asOfDate: { type: "string", maxLength: 40 },
    findings: { type: "array", maxItems: 8, items: { type: "string", maxLength: 400 } },
    sources: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        properties: { url: { type: "string", maxLength: 500 }, title: { type: "string", maxLength: 300 } },
        required: ["url", "title"],
        additionalProperties: false,
      },
    },
  },
  required: ["answer", "asOfDate", "findings", "sources"],
  additionalProperties: false,
} as const satisfies Record<string, unknown>;
