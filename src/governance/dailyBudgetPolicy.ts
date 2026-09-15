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
 * ACTIVE SINCE 2026-09-15 — THE OPERATOR'S VALUES (DECISION D3)
 * -------------------------------------------------------------
 * `usd` 5.00 and `subscription_tokens` 200,000 per local calendar day. These
 * were chosen by the operator, not derived here. The 200,000 figure is an
 * application governance ceiling; it is not a claim about Claude Max entitlement
 * or any provider's quota. A unit absent from the object has no day scope (no
 * day counter is created and no day reservation is attempted for it).
 *
 * DECISIONS AND HOW THEY WERE SETTLED
 * -----------------------------------
 *   1. A daily ceiling per resource unit: D3, above. Units stay separate.
 *   2. The day boundary: the local calendar day (D3), see `dayScopeRef`.
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
export const DAILY_BUDGET_CEILINGS: Readonly<Partial<Record<ResourceUnit, string>>> = Object.freeze({
  usd: "5.00",
  subscription_tokens: "200000",
});

/**
 * `scope_ref_id` for a day counter: the LOCAL calendar date, `YYYY-MM-DD`
 * (operator decision D3). "Local" is the API process's time zone — the `TZ`
 * environment variable when set, otherwise the operating system's zone — so a
 * day runs from local midnight to local midnight, daylight-saving days included.
 */
export function dayScopeRef(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
