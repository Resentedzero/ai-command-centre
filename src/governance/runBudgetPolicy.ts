/**
 * Run budget ceilings — owned by governance, NOT by capability code (Phase 8).
 *
 * THE INTEGRITY PROBLEM THIS CLOSES
 * ---------------------------------
 * Run budget counters used to be created by the capability builders
 * themselves, each passing its own `limitAmount` — and one of them exposed a
 * `runBudgetLimit` config knob with a `?? "1.00"` fallback. The code being
 * governed was choosing the ceiling that governed it. Nothing constrained the
 * value: the insert took any string verbatim.
 *
 * Now the ceilings live here, and the ONLY exported provisioning function,
 * `provisionRunBudgets`, takes no limit argument. A capability builder can
 * trigger provisioning for its Run, but it cannot express a number — there is
 * no parameter to pass one through, and the helper that accepts an arbitrary
 * limit is private to this module. A structural test asserts nothing under
 * `src/capabilities/` writes `budget_counters` directly.
 *
 * The ceilings object is frozen, so it cannot be raised at runtime either:
 * assigning to it throws in strict-mode ES modules rather than silently
 * widening a budget.
 *
 * WHAT DID NOT CHANGE
 * -------------------
 * The values are exactly the ones already in production: $1.00 and 200,000
 * subscription tokens per Run. This moves AUTHORITY over the numbers; it does
 * not change the numbers. Reservation, reconciliation and unit-keyed counters
 * are untouched — this module only creates rows, exactly as the capability
 * helper did.
 *
 * The 200,000 figure is an application-level self-discipline limit. It is not
 * a claim about Claude Max entitlement or any provider's quota capacity.
 */
import { and, eq } from "drizzle-orm";
import { budgetCounters } from "../db/schema.js";
import type { DrizzleTransaction } from "../events/emit.js";
import type { ResourceUnit } from "./resourceUnit.js";

/**
 * Per-Run ceilings, one per resource unit. Units are provisioned as separate,
 * independent counters and are never summed or converted.
 *
 * `local_tokens` is deliberately absent: no local provider exists, and no
 * authoritative ceiling for one has been decided. Adding a unit here is a
 * governance decision, not a capability one.
 *
 * Strings because `budget_counters.limit_amount` is `numeric` — no float ever
 * reaches Postgres.
 */
export const RUN_BUDGET_CEILINGS: Readonly<Partial<Record<ResourceUnit, string>>> = Object.freeze({
  usd: "1.00",
  subscription_tokens: "200000",
});

/**
 * Creates one counter if it does not already exist.
 *
 * PRIVATE on purpose: this is the only code path that accepts an arbitrary
 * limit, and exporting it would reopen exactly the self-authorization hole this
 * module exists to close.
 *
 * Never RAISES an existing counter's limit: an existing row short-circuits, and
 * the insert is `onConflictDoNothing` against the full three-column unique key.
 * So re-provisioning on every resume of an awaiting_approval step can neither
 * reset in-flight `reserved_amount`/`consumed_amount` nor widen the ceiling.
 */
async function ensureRunCounter(
  tx: DrizzleTransaction,
  runId: string,
  resourceUnit: ResourceUnit,
  limitAmount: string
): Promise<void> {
  const existing = await tx.query.budgetCounters.findFirst({
    where: and(
      eq(budgetCounters.scope, "run"),
      eq(budgetCounters.scopeRefId, runId),
      eq(budgetCounters.resourceUnit, resourceUnit)
    ),
  });
  if (existing) return;

  await tx
    .insert(budgetCounters)
    .values({ scope: "run", scopeRefId: runId, resourceUnit, limitAmount, reservedAmount: "0", consumedAmount: "0" })
    // The conflict target must name EVERY column of the unique index, or
    // Postgres cannot infer an arbiter index and raises 42P10.
    .onConflictDoNothing({
      target: [budgetCounters.scope, budgetCounters.scopeRefId, budgetCounters.resourceUnit],
    });
}

/**
 * Provisions every governance-configured Run budget counter for `runId`.
 *
 * Takes NO limit: the ceilings come from `RUN_BUDGET_CEILINGS` alone.
 * Idempotent — safe to call on every builder invocation, including each resume
 * of an awaiting_approval step.
 *
 * Provisioned unconditionally for every unit, independent of which provider a
 * Run will route to: a counter authorizes nothing by itself, and the Router
 * only ever reserves in the unit of the candidate it actually selected.
 */
export async function provisionRunBudgets(tx: DrizzleTransaction, runId: string): Promise<void> {
  for (const [resourceUnit, limitAmount] of Object.entries(RUN_BUDGET_CEILINGS)) {
    await ensureRunCounter(tx, runId, resourceUnit as ResourceUnit, limitAmount!);
  }
}
