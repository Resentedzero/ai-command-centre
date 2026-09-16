/**
 * `CostClass` — Phase 4's cost-class taxonomy. Governs whether an invocation
 * needs budget governance at all: `"deterministic"` operations are free and
 * bypass `budget_counters` entirely (see `reserveBudget` in `./budget.ts`).
 *
 * This module has no knowledge of Policy (Unit 3) — it is a pure vocabulary
 * type, nothing else.
 */
export type CostClass =
  | "deterministic"
  | "local_retrieval"
  /**
   * R2 (D7): a call to a third party that charges nothing but is still not free to make —
   * it has rate limits, availability and terms of use. Distinct from `local_retrieval`
   * (which leaves the machine not at all) and from `metered_api` (which costs money), so
   * neither a budget nor a deliverable's evidence basis can mistake one for the other.
   */
  | "free_external"
  | "metered_api"
  | "llm"
  | "external_side_effect";
