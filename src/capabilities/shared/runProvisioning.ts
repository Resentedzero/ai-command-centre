/**
 * `bindRunAgent` / `ensureRunBudgetCounter` — small, shared provisioning
 * helpers both of Unit 9's `InvocationSpecBuilder` implementations need
 * (`../researchRetrieve/buildInvocationSpecs.ts` and
 * `../publishReport/buildInvocationSpecs.ts`), factored out to avoid
 * duplicating the same handful of lines twice rather than because either
 * builder needed anything genuinely capability-specific here.
 *
 * This is Ruling 3's disclosed constraint made concrete: Unit 7's
 * `advanceWorkflowRun` creates each step's `runs` row with NO agent binding
 * and NO `budget_counters` row (see `src/workflow/interpreter.ts`'s module
 * header, "The `runs` row created for a workflow step..."), and the ONLY
 * hook available before `executeRun` authorizes/budgets an invocation is the
 * `buildInvocationSpecs` closure itself, via whatever `tx` it closes over.
 *
 * Both helpers are idempotent BY DESIGN, not by accident: Ruling 3 requires
 * `buildInvocationSpecs` to be safe to call again on every resume of an
 * `awaiting_approval` step (Unit 9's `publish.report` step reaches exactly
 * that state under its `ALWAYS_APPROVE` Grant). `bindRunAgent` is a bare
 * `UPDATE ... SET` (naturally idempotent — setting the same values twice
 * changes nothing). `ensureRunBudgetCounter` uses `onConflictDoNothing`
 * against `budget_counters`' own `(scope, scope_ref_id)` unique index
 * (`src/db/schema.ts`) rather than a check-then-insert, so a second call for
 * the same run never throws a unique-violation and never resets an
 * already-in-flight counter's `reserved_amount`/`consumed_amount` back to
 * zero.
 */
import { and, eq } from "drizzle-orm";
import { budgetCounters, runs } from "../../db/schema.js";
import type { DrizzleTransaction } from "../../events/emit.js";

export async function bindRunAgent(
  tx: DrizzleTransaction,
  runId: string,
  agentDefinitionId: string,
  agentDefinitionVersion: number
): Promise<void> {
  await tx.update(runs).set({ agentDefinitionId, agentDefinitionVersion }).where(eq(runs.id, runId));
}

export async function ensureRunBudgetCounter(tx: DrizzleTransaction, runId: string, limitAmount: string): Promise<void> {
  const existing = await tx.query.budgetCounters.findFirst({
    where: and(eq(budgetCounters.scope, "run"), eq(budgetCounters.scopeRefId, runId)),
  });
  if (existing) return;

  await tx
    .insert(budgetCounters)
    .values({ scope: "run", scopeRefId: runId, limitAmount, reservedAmount: "0", consumedAmount: "0" })
    .onConflictDoNothing({ target: [budgetCounters.scope, budgetCounters.scopeRefId] });
}

/** Looks up the `runs` row for a just-created (or resumed) Task Instance — see this module's header. */
export async function findRunByTaskInstanceId(tx: DrizzleTransaction, taskInstanceId: string) {
  const row = await tx.query.runs.findFirst({ where: eq(runs.taskInstanceId, taskInstanceId) });
  if (!row) {
    throw new Error(`findRunByTaskInstanceId: no runs row found for task_instance_id "${taskInstanceId}"`);
  }
  return row;
}
