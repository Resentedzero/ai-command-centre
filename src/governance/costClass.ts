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
  | "metered_api"
  | "llm"
  | "external_side_effect";
