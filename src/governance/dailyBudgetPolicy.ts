/**
 * Aggregate DAY budget ceilings — governance configuration (Phase 8).
 *
 * WHY A DAY SCOPE
 * ---------------
 * Run ceilings (`./runBudgetPolicy.ts`) bound one Run. They do not bound how
 * MANY Runs there are: N Runs can spend N × the run ceiling. The day scope is
 * additive containment above that — one counter per resource unit per calendar
 * day, reserved alongside the run counter in the same transaction, so a burst of
 * autonomous Runs cannot exceed the daily allowance however many are created.
 * It never replaces or weakens the per-run ceiling; both must have room.
 *
 * SHIPPED INERT — NO LIMIT IS INVENTED
 * ------------------------------------
 * `DAILY_BUDGET_CEILINGS` is EMPTY. With no ceiling configured for a unit, no
 * day counter is created and no day reservation is attempted, so runtime
 * behaviour is exactly what it was before this module existed. Activating the
 * day scope is a deliberate operator decision: choosing a number per unit. No
 * number here is derived from Claude Max entitlement, quota utilization, or USD
 * pricing, because none of those is a sound basis for one.
 *
 * DECISIONS REQUIRED BEFORE ACTIVATION
 * ------------------------------------
 *   1. A daily ceiling per resource unit (`usd`, `subscription_tokens`).
 *   2. The day boundary. Days are keyed as the UTC calendar date. That is a
 *      mechanical default so the mechanism is well-defined and testable; it has
 *      no effect while no ceiling is configured, and should be confirmed (or
 *      changed to a local timezone) when ceilings are set.
 *   3. (RESOLVED by Phase 9.) A day counter is ONE ROW SHARED BY EVERY RUN,
 *      and reservation holds `SELECT … FOR UPDATE` on it until the reserving
 *      transaction commits. Before Phase 9 that transaction spanned
 *      multi-minute provider calls, so a configured ceiling would have
 *      serialized all execution in its unit behind one call. Provider calls now
 *      happen between transactions (docs/architecture/DURABLE_EXECUTION.md), so
 *      the day row — like the shared `subscription_quota_state` row — is held
 *      only for the short reserve and reconcile transactions. Tool Invocations
 *      still reserve, execute and reconcile in one transaction, which is short
 *      while every tool is local.
 *
 * The ceilings object is frozen: it cannot be raised at runtime, and no
 * capability or caller can pass a different limit.
 */
import type { ResourceUnit } from "./resourceUnit.js";

/**
 * Per-day ceilings, one per resource unit. Units are separate counters and are
 * never summed or converted. EMPTY = the day scope is inactive for every unit.
 */
export const DAILY_BUDGET_CEILINGS: Readonly<Partial<Record<ResourceUnit, string>>> = Object.freeze({});

/** `scope_ref_id` for a day counter: the UTC calendar date, `YYYY-MM-DD`. */
export function dayScopeRef(now: Date): string {
  return now.toISOString().slice(0, 10);
}
