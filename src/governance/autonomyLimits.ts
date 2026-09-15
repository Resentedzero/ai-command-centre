/**
 * Autonomy ceilings for the `agent_objective` loop (V1.1). Governance values set
 * by the operator on 2026-09-15 (V1.1 brief §4), frozen here like the budget
 * ceilings (`runBudgetPolicy.ts`, `dailyBudgetPolicy.ts`):
 *
 * - at most 12 iterations per Run, fixed when the plan is built (R1);
 * - at most 15 minutes of ACTIVE execution per Run: time the Run spends waiting on
 *   a human Approval does not count;
 * - the Task Instance's `subscription_tokens` ceiling stays the existing 50,000
 *   (`TASK_INSTANCE_BUDGET_CEILINGS`), with no override.
 *
 * An Agent's execution profile or a workflow step may ask for LESS, never more;
 * nothing a model outputs can change these. Autonomous Runs are not retried
 * automatically (`retryPolicy.ts`).
 */
export const MAX_LOOP_ITERATIONS = 12;
export const MAX_ACTIVE_SECONDS = 15 * 60;
