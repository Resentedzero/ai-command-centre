/**
 * `RESEARCH_WEB_CAPABILITY` — the provider-agnostic contract for `research.web`: finding
 * current information on the live web.
 *
 * Fulfilled by the runtime's own model provider rather than by a Tool Binding, because the
 * search happens inside the model call (see `../shared/loopActions.ts`, `providerTools`).
 * The Capability layer neither knows nor names which provider that is: the Router excludes
 * candidates that cannot search, so a different provider would serve the same Grant.
 *
 * SEPARATE FROM `research.search` ON PURPOSE. Searching the live web costs real
 * entitlement — measured at roughly 54,000 subscription tokens for one question, more than
 * a whole autonomous Run's ceiling — while the scholarly indexes cost an HTTP request. Two
 * Capabilities means an operator grants the expensive one deliberately, and an agent that
 * holds only the cheap one cannot reach for it.
 */
export const RESEARCH_WEB_CAPABILITY = {
  id: "research.web",
  description: "Search the live web for current information, through the runtime's own model provider",
  staticRiskTag: "low" as const,
  // Its cost is the model call it happens inside, accounted by the Router in that call's
  // own resource unit — never a second, invented charge.
  costProfile: { costClass: "llm" as const },
};
