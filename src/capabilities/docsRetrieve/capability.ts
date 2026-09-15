/**
 * `docs.retrieve` (V1.1): retrieve the Command Keep's own guide cards (`docs/keeper`)
 * relevant to a question. Documents already held: retrieval, not research.
 */
export const DOCS_RETRIEVE_CAPABILITY = {
  id: "docs.retrieve",
  description: "Retrieve the Command Keep's own guide cards relevant to a question",
  staticRiskTag: "low" as const,
  costProfile: { costClass: "local_retrieval" as const },
};
