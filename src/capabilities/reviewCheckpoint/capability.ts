/**
 * `review.checkpoint` (V1.1): the contract behind a workflow's explicit approval gate.
 * Continuing past the gate is an action on the exact outputs shown, so it is a Tool
 * Invocation like any other: Grant, Policy, an Approval pinned to those outputs'
 * hashes (spec §9.5), stops and events. No second approval system exists.
 *
 * A gate that could run without asking would not be a gate, so the step validator
 * and the plan both require the step's Agent to hold this capability at
 * `ALWAYS_APPROVE` (`./buildInvocationSpecs.ts`); anything else fails closed.
 */
export const REVIEW_CHECKPOINT_CAPABILITY = {
  id: "review.checkpoint",
  description: "Pause a workflow until the operator approves continuing with the exact outputs shown",
  staticRiskTag: "medium" as const,
  costProfile: { costClass: "local_retrieval" as const },
};

/** The permission a gate acts under. */
export const REVIEW_CHECKPOINT_PERMISSION = "EXECUTE" as const;
