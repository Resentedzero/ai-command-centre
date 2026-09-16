/**
 * `RESEARCH_SEARCH_CAPABILITY` — the provider-agnostic contract for `research.search`:
 * discovering material in public encyclopedic and scholarly indexes.
 *
 * Distinct from `research.retrieve`, which reads what we already hold. This one leaves the
 * machine, so its results are external evidence and a deliverable built on them may say so.
 *
 * It is NOT general web search: nothing behind it crawls the open web. That is
 * `research.web`, a separate Capability with a separate Grant, so an operator can authorize
 * scholarly discovery without authorizing the live web — and so the cost difference between
 * them stays visible.
 *
 * As with every Capability, nothing here says how it is fulfilled: which indexes back it is
 * the Tool Binding's business, and swapping them changes no Grant.
 */
export const RESEARCH_SEARCH_CAPABILITY = {
  id: "research.search",
  description: "Search public encyclopedic and scholarly sources for material on a topic",
  staticRiskTag: "low" as const,
  // Free to call, but not free of consequence: rate limits, availability and the third
  // party's terms all still apply (D7).
  costProfile: { costClass: "free_external" as const },
};
