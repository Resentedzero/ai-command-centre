/**
 * Budget Governor — the reserve/reconcile budget primitive (Phase 4
 * cost-class governance, Phase 12 `budget_counters`, Phase 10.7's two-pass
 * reservation). This module has zero knowledge of Policy (Unit 3): it makes
 * no risk/approval decisions, it only tracks numeric budget consumption
 * against a pre-existing `budget_counters` row.
 *
 * `reserveBudget` deliberately does NOT create `budget_counters` rows. A
 * scope key with no row behaves exactly like a zero-limit budget: every
 * non-deterministic reservation against it is rejected as
 * `insufficient_budget`. Rows are provisioned by whatever process owns budget
 * setup (out of scope for this unit) — auto-creating one here with some
 * default limit would be an unspecified design decision this module has no
 * business making.
 *
 * Reservation ID encoding
 * ------------------------
 * There is no separate reservations ledger table in the MVP schema (Phase 12
 * lists none, and one is out of scope for this unit) — only the aggregate
 * `reserved_amount` / `consumed_amount` columns on `budget_counters`. So
 * `reconcileBudget` and `releaseReservation` cannot look anything up by a
 * bare opaque UUID; they need the reservation's `scope`, `scopeRefId`, and
 * (crucially) the ORIGINAL `estimatedAmount` that was reserved, so they can
 * decrement `reserved_amount` by exactly that amount rather than a
 * re-derived guess.
 *
 * The reservationId therefore *is* that data: a `res_` prefix followed by
 * the base64url encoding of `{ scope, scopeRefId, estimatedAmount, nonce }`
 * as JSON. `estimatedAmount` is carried as the exact string handed to
 * Postgres (via `String(estimatedAmount)`) rather than re-parsed as a float,
 * so the eventual `reserved_amount - estimatedAmount` arithmetic is exact.
 * `nonce` is a random UUID purely to make two reservations of the same
 * amount against the same scope key produce different reservationIds (no
 * functional use otherwise).
 *
 * Tradeoffs of this approach (accepted for MVP, flagged for the record):
 *  - Self-contained and process-restart-safe: reconcile/release work even if
 *    the process reserving and the process reconciling are different, or the
 *    original process crashed and restarted — a purely in-memory lookup
 *    table would not survive that.
 *  - NOT idempotent: because there is no ledger row marking "this
 *    reservation has already been reconciled/released", calling
 *    `reconcileBudget` or `releaseReservation` twice with the same
 *    reservationId double-decrements `reserved_amount` with nothing to
 *    detect it. Callers must call each exactly once per reservation.
 *  - The reservationId is caller-forgeable (it's just base64url JSON, not
 *    signed) — anyone holding a valid-looking string can construct one that
 *    decrements an arbitrary scope key's `reserved_amount`. Acceptable for
 *    an MVP with no external/untrusted callers of this module; would need a
 *    signature or a real ledger table before this module is exposed beyond
 *    trusted in-process callers.
 *
 * `costClass: "deterministic"` short-circuits before any of this: it returns
 * the fixed sentinel `"res_noop"` (never a `res_`-prefixed base64url
 * payload) and never touches `budget_counters`. `reconcileBudget` and
 * `releaseReservation` both reject `"res_noop"` (and anything else that
 * doesn't decode) rather than silently no-op, since a caller invoking them
 * on a no-op reservation indicates a bug in the caller.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { budgetCounters } from "../db/schema.js";
import type { DrizzleTransaction } from "../events/emit.js";
import type { CostClass } from "./costClass.js";

export type BudgetScope = "run" | "task_instance"; // agent_definition/goal/day rollups deferred (Phase 18.1)

export type ReservationResult =
  | { authorized: true; reservationId: string }
  | { authorized: false; reason: "insufficient_budget" };

/** Sentinel reservationId returned for the deterministic cost-class short-circuit. */
export const NOOP_RESERVATION_ID = "res_noop";

const RESERVATION_ID_PREFIX = "res_";

interface ReservationPayload {
  scope: BudgetScope;
  scopeRefId: string;
  estimatedAmount: string;
  nonce: string;
}

function encodeReservationId(payload: ReservationPayload): string {
  const json = JSON.stringify(payload);
  return RESERVATION_ID_PREFIX + Buffer.from(json, "utf8").toString("base64url");
}

function decodeReservationId(reservationId: string): ReservationPayload {
  if (reservationId === NOOP_RESERVATION_ID || !reservationId.startsWith(RESERVATION_ID_PREFIX)) {
    throw new Error(
      `Invalid reservationId "${reservationId}": the deterministic no-op reservation (and any` +
        ` non-"${RESERVATION_ID_PREFIX}"-prefixed value) never corresponds to a budget_counters` +
        " reservation and must never be passed to reconcileBudget/releaseReservation."
    );
  }

  let parsed: unknown;
  try {
    const json = Buffer.from(reservationId.slice(RESERVATION_ID_PREFIX.length), "base64url").toString("utf8");
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `Invalid reservationId "${reservationId}": could not be decoded (${(error as Error).message}).`
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as ReservationPayload).scope !== "string" ||
    typeof (parsed as ReservationPayload).scopeRefId !== "string" ||
    typeof (parsed as ReservationPayload).estimatedAmount !== "string" ||
    typeof (parsed as ReservationPayload).nonce !== "string"
  ) {
    throw new Error(`Invalid reservationId "${reservationId}": decoded payload is malformed.`);
  }

  return parsed as ReservationPayload;
}

/**
 * Rejects a structurally invalid `estimatedAmount` (negative, NaN, or
 * +/-Infinity) synchronously, before any DB operation is attempted. A caller
 * passing one of these is a programming error, not a legitimate "not enough
 * budget" business outcome — so this throws rather than returning
 * `{ authorized: false, reason: "insufficient_budget" }`, which is reserved
 * for structurally valid amounts that simply exceed what's available.
 * `Number.isFinite` rejects NaN and both Infinities in one check; the
 * separate `< 0` check rejects negative amounts (including `-0`'s valid,
 * since `-0 < 0` is false and `-0` behaves as `0` for this arithmetic).
 */
function validateEstimatedAmount(estimatedAmount: number): void {
  if (!Number.isFinite(estimatedAmount) || estimatedAmount < 0) {
    throw new Error(
      `reserveBudget: estimatedAmount must be a finite, non-negative number; received ${estimatedAmount}.`
    );
  }
}

/** Locks and returns the single budget_counters row for (scope, scopeRefId), or undefined if none exists. */
async function lockCounterRow(tx: DrizzleTransaction, scope: BudgetScope, scopeRefId: string) {
  const rows = await tx
    .select()
    .from(budgetCounters)
    .where(and(eq(budgetCounters.scope, scope), eq(budgetCounters.scopeRefId, scopeRefId)))
    .for("update");
  return rows[0];
}

/**
 * Reserves `estimatedAmount` against the budget_counters row for
 * (scope, scopeRefId), inside the caller's transaction.
 *
 * Atomicity: takes a `SELECT ... FOR UPDATE` row lock on that specific row
 * before checking `limit_amount - reserved_amount - consumed_amount`, so two
 * concurrent reserveBudget calls against the same scope key are serialized
 * by Postgres — the second blocks on the lock until the first commits (or
 * rolls back), then re-reads the row's up-to-date values (Postgres
 * READ COMMITTED's EvalPlanQual re-evaluation) before making its own
 * decision. This depends on there being exactly one row per (scope,
 * scopeRefId) — enforced by the `budget_counters_scope_scope_ref_id_idx`
 * unique index — since a second row for the same key would not be covered
 * by this lock.
 *
 * Does NOT create a row when none exists: that case is treated exactly like
 * a zero-limit budget, i.e. `{ authorized: false, reason: "insufficient_budget" }`.
 *
 * Throws synchronously (before any DB operation, including for the
 * `"deterministic"` short-circuit) if `estimatedAmount` is negative, NaN, or
 * +/-Infinity — see `validateEstimatedAmount`.
 */
export async function reserveBudget(
  tx: DrizzleTransaction,
  scope: BudgetScope,
  scopeRefId: string,
  costClass: CostClass,
  estimatedAmount: number
): Promise<ReservationResult> {
  validateEstimatedAmount(estimatedAmount);

  if (costClass === "deterministic") {
    return { authorized: true, reservationId: NOOP_RESERVATION_ID };
  }

  const row = await lockCounterRow(tx, scope, scopeRefId);
  if (!row) {
    return { authorized: false, reason: "insufficient_budget" };
  }

  const available = Number(row.limitAmount) - Number(row.reservedAmount) - Number(row.consumedAmount);
  if (estimatedAmount > available) {
    return { authorized: false, reason: "insufficient_budget" };
  }

  const estimatedAmountStr = String(estimatedAmount);

  await tx
    .update(budgetCounters)
    .set({
      reservedAmount: sql`${budgetCounters.reservedAmount} + ${estimatedAmountStr}::numeric`,
      updatedAt: new Date(),
    })
    .where(eq(budgetCounters.id, row.id));

  const reservationId = encodeReservationId({
    scope,
    scopeRefId,
    estimatedAmount: estimatedAmountStr,
    nonce: randomUUID(),
  });

  return { authorized: true, reservationId };
}

/**
 * Reconciles a reservation: releases the original `estimatedAmount` from
 * `reserved_amount` and adds `actualAmount` to `consumed_amount`, in one
 * update (so the row is never observed with the reservation released but
 * consumption not yet recorded, or vice versa).
 */
export async function reconcileBudget(
  tx: DrizzleTransaction,
  reservationId: string,
  actualAmount: number
): Promise<void> {
  const { scope, scopeRefId, estimatedAmount } = decodeReservationId(reservationId);

  const row = await lockCounterRow(tx, scope, scopeRefId);
  if (!row) {
    throw new Error(
      `reconcileBudget: no budget_counters row found for scope="${scope}" scopeRefId="${scopeRefId}"` +
        " (it existed when the reservation was made, but has since been removed)."
    );
  }

  await tx
    .update(budgetCounters)
    .set({
      reservedAmount: sql`${budgetCounters.reservedAmount} - ${estimatedAmount}::numeric`,
      consumedAmount: sql`${budgetCounters.consumedAmount} + ${String(actualAmount)}::numeric`,
      updatedAt: new Date(),
    })
    .where(eq(budgetCounters.id, row.id));
}

/**
 * Releases a reservation without recording any consumption (e.g. the
 * reserved work failed before execution): decrements `reserved_amount` by
 * the original `estimatedAmount` only.
 */
export async function releaseReservation(tx: DrizzleTransaction, reservationId: string): Promise<void> {
  const { scope, scopeRefId, estimatedAmount } = decodeReservationId(reservationId);

  const row = await lockCounterRow(tx, scope, scopeRefId);
  if (!row) {
    throw new Error(
      `releaseReservation: no budget_counters row found for scope="${scope}" scopeRefId="${scopeRefId}"` +
        " (it existed when the reservation was made, but has since been removed)."
    );
  }

  await tx
    .update(budgetCounters)
    .set({
      reservedAmount: sql`${budgetCounters.reservedAmount} - ${estimatedAmount}::numeric`,
      updatedAt: new Date(),
    })
    .where(eq(budgetCounters.id, row.id));
}
