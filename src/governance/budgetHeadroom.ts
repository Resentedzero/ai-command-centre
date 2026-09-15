/**
 * Budget headroom (V1.1), read-only: how much of a resource unit is still available to
 * a Run before any of the counters that govern it (Run, Task Instance, day) would refuse
 * a reservation. A counter not yet created is at its governance ceiling.
 *
 * It authorizes nothing and changes nothing: the Budget Governor (`./budget.ts`) still
 * reserves and refuses every call. An autonomous loop uses it only to stop cleanly and
 * write its deliverable before the Governor would have to refuse.
 */
import { and, eq } from "drizzle-orm";
import { budgetCounters } from "../db/schema.js";
import type { DrizzleTransaction } from "../events/emit.js";
import { DAILY_BUDGET_CEILINGS, dayScopeRef } from "./dailyBudgetPolicy.js";
import type { ResourceUnit } from "./resourceUnit.js";
import { RUN_BUDGET_CEILINGS, TASK_INSTANCE_BUDGET_CEILINGS } from "./runBudgetPolicy.js";

export async function budgetHeadroom(
  tx: DrizzleTransaction,
  input: { runId: string; taskInstanceId: string; resourceUnit: ResourceUnit; now: Date }
): Promise<number> {
  const keys = [
    { scope: "run" as const, ref: input.runId, ceiling: RUN_BUDGET_CEILINGS[input.resourceUnit] },
    { scope: "task_instance" as const, ref: input.taskInstanceId, ceiling: TASK_INSTANCE_BUDGET_CEILINGS[input.resourceUnit] },
    { scope: "day" as const, ref: dayScopeRef(input.now), ceiling: DAILY_BUDGET_CEILINGS[input.resourceUnit] },
  ];
  let headroom = Number.POSITIVE_INFINITY;
  for (const key of keys) {
    const row = await tx.query.budgetCounters.findFirst({
      where: and(eq(budgetCounters.scope, key.scope), eq(budgetCounters.scopeRefId, key.ref), eq(budgetCounters.resourceUnit, input.resourceUnit)),
    });
    const remaining = row
      ? Number(row.limitAmount) - Number(row.reservedAmount) - Number(row.consumedAmount)
      : key.ceiling !== undefined
        ? Number(key.ceiling)
        : Number.POSITIVE_INFINITY;
    headroom = Math.min(headroom, remaining);
  }
  return headroom;
}
