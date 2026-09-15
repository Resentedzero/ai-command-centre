/**
 * `bindRunAgent` / `findRunByTaskInstanceId` — small, shared provisioning
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
 * `bindRunAgent` is idempotent BY DESIGN: Ruling 3 requires
 * `buildInvocationSpecs` to be safe to call again on every resume of an
 * `awaiting_approval` step, and a bare `UPDATE ... SET` of the same values
 * changes nothing.
 *
 * BUDGET PROVISIONING NO LONGER LIVES HERE (Phase 8). It moved to
 * `../../governance/runBudgetPolicy.ts`, because a helper in `capabilities/`
 * that accepted an arbitrary limit let the governed code choose the ceiling
 * that governed it. Builders now call `provisionRunBudgets(tx, runId)`, which
 * takes no limit at all.
 */
import { and, eq, notInArray } from "drizzle-orm";
import { runs } from "../../db/schema.js";
import type { DrizzleTransaction } from "../../events/emit.js";

export async function bindRunAgent(
  tx: DrizzleTransaction,
  runId: string,
  agentDefinitionId: string,
  agentDefinitionVersion: number
): Promise<void> {
  await tx.update(runs).set({ agentDefinitionId, agentDefinitionVersion }).where(eq(runs.id, runId));
}

/**
 * The Task Instance's current Run: its one unfinished `runs` row. A retried Task
 * Instance also has earlier, finished Runs (spec §3d), so "the first row" would be an
 * arbitrary pick; anything but exactly one unfinished Run fails closed.
 */
export async function findRunByTaskInstanceId(tx: DrizzleTransaction, taskInstanceId: string) {
  const rows = await tx.query.runs.findMany({
    where: and(eq(runs.taskInstanceId, taskInstanceId), notInArray(runs.status, ["completed", "failed"])),
  });
  if (rows.length !== 1) {
    throw new Error(
      `findRunByTaskInstanceId: expected exactly one unfinished runs row for task_instance_id "${taskInstanceId}", found ${rows.length} (fail closed).`
    );
  }
  return rows[0]!;
}
