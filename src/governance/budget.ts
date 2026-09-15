/**
 * Budget Governor — the reserve/reconcile budget primitive (Phase 4
 * cost-class governance, Phase 12 `budget_counters`, Phase 10.7's two-pass
 * reservation). This module has zero knowledge of Policy (Unit 3): it makes
 * no risk/approval decisions, it only tracks numeric budget consumption
 * against `budget_counters` rows.
 *
 * `reserveBudget` does NOT create RUN counter rows. A run scope key with no row
 * behaves exactly like a zero-limit budget: every non-deterministic reservation
 * against it is rejected as `insufficient_budget`. Run rows are provisioned by
 * governance (`./runBudgetPolicy.ts`), never by the code being governed.
 *
 * The exceptions are the DAY counter (Phase 8, `./dailyBudgetPolicy.ts`; values
 * D3) and the TASK_INSTANCE counter (`./runBudgetPolicy.ts`; values D20), which
 * this module creates on demand: nothing else runs at midnight to open the next
 * day's row, and a retry Run must find its Task Instance's counter already
 * holding the earlier attempts. Each is created only when a ceiling is
 * configured for the unit, only at that governance-configured limit, and never
 * at a limit a caller supplies. A run-scope reservation holds its Run counter
 * plus, when configured for the unit, the local day's counter and the Run's
 * Task Instance counter; all must have room.
 *
 * Reservation ID encoding
 * ------------------------
 * There is no separate reservations ledger table in the MVP schema (Phase 12
 * lists none) — only the aggregate `reserved_amount` / `consumed_amount`
 * columns on `budget_counters`. So `reconcileBudget` and `releaseReservation`
 * cannot look anything up by a bare opaque UUID; they need every counter the
 * reservation holds, plus the ORIGINAL `estimatedAmount`, so they decrement
 * `reserved_amount` by exactly that amount rather than a re-derived guess.
 *
 * The reservationId therefore *is* that data: a `res_` prefix followed by the
 * base64url encoding of a JSON payload. Two shapes exist:
 *
 *   - SINGLE-COUNTER (when neither a daily nor a Task Instance ceiling applies,
 *     and byte-for-byte what this module produced before Phase 8):
 *     `{ scope, scopeRefId, resourceUnit, estimatedAmount, nonce }`
 *   - MULTI-COUNTER (a run hold plus a day hold, a task_instance hold, or both,
 *     so two or three holds):
 *     `{ holds: [{ scope, scopeRefId }, ...], resourceUnit, estimatedAmount, nonce }`
 *
 * Every hold in one reservation shares ONE resource unit and ONE estimated
 * amount. A reservation can never span units: the unit is a single field, so
 * mixing is unrepresentable in the id itself.
 *
 * `estimatedAmount` is carried as the exact string handed to Postgres (via
 * `String(estimatedAmount)`) rather than re-parsed as a float, so the eventual
 * `reserved_amount - estimatedAmount` arithmetic is exact. `nonce` is a random
 * UUID purely so two reservations of the same amount against the same counters
 * produce different reservationIds.
 *
 * LOCK ORDER. Every operation that touches more than one counter locks them in
 * one fixed order — day, then run, then task_instance — in reserve, reconcile
 * AND release alike. Two transactions can therefore never hold one counter each
 * while waiting on the other's: no deadlock cycle is possible.
 *
 * Tradeoffs of this approach (accepted for MVP, flagged for the record):
 *  - Self-contained and process-restart-safe: reconcile/release work even if
 *    the process reserving and the process reconciling are different.
 *  - NOT idempotent: there is no ledger row marking "this reservation has
 *    already been reconciled/released", so calling `reconcileBudget` or
 *    `releaseReservation` twice with the same reservationId double-decrements
 *    `reserved_amount`. Callers must call each exactly once per reservation.
 *  - The reservationId is caller-forgeable (unsigned base64url JSON).
 *    Acceptable for an MVP with no external/untrusted callers of this module.
 *
 * `costClass: "deterministic"` short-circuits before any of this: it returns
 * the fixed sentinel `"res_noop"` and never touches `budget_counters`.
 * `reconcileBudget` and `releaseReservation` both reject `"res_noop"` (and
 * anything else that doesn't decode) rather than silently no-op.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { budgetCounters, events, runs } from "../db/schema.js";
import type { DrizzleTransaction } from "../events/emit.js";
import { correlationForRun, emitLifecycleEvent, NO_CORRELATION } from "../events/lifecycle.js";
import type { CostClass } from "./costClass.js";
import { DAILY_BUDGET_CEILINGS, dayScopeRef } from "./dailyBudgetPolicy.js";
import { isResourceUnit, type ResourceUnit } from "./resourceUnit.js";
import { TASK_INSTANCE_BUDGET_CEILINGS } from "./runBudgetPolicy.js";

// Production reserves only at `run` scope; a Run's day and Task Instance holds (D3, D20)
// are added here, never requested by a caller. agent_definition/goal rollups deferred (Phase 18.1).
export type BudgetScope = "run" | "task_instance";

/** Every scope a reservation may hold a counter at. `day` is never requested by a caller directly. */
type CounterScope = BudgetScope | "day";

export type ReservationResult =
  | { authorized: true; reservationId: string }
  | { authorized: false; reason: "insufficient_budget" };

/** Optional reservation inputs. Production callers pass none; tests inject both. */
export type ReserveBudgetOptions = {
  /** Daily ceilings to apply. Defaults to the governance configuration. */
  dailyCeilings?: Readonly<Partial<Record<ResourceUnit, string>>>;
  /** Task Instance ceilings to apply. Defaults to the governance configuration. */
  taskInstanceCeilings?: Readonly<Partial<Record<ResourceUnit, string>>>;
  /** The clock used to pick the day counter. Defaults to now. */
  now?: Date;
};

/** Sentinel reservationId returned for the deterministic cost-class short-circuit. */
export const NOOP_RESERVATION_ID = "res_noop";

const RESERVATION_ID_PREFIX = "res_";

/** Fixed lock order — see this module's header. */
const LOCK_ORDER: Record<CounterScope, number> = { day: 0, run: 1, task_instance: 2 };

type Hold = { scope: CounterScope; scopeRefId: string };

interface DecodedReservation {
  holds: Hold[];
  /** Which counters this reservation belongs to. Rejected — never defaulted — when absent. */
  resourceUnit: ResourceUnit;
  estimatedAmount: string;
  /** Unique per reservation; keys its `budget_consumed` event, so one reservation is recorded as consumed at most once. */
  nonce: string;
}

function sortHolds(holds: Hold[]): Hold[] {
  return [...holds].sort(
    (a, b) => LOCK_ORDER[a.scope] - LOCK_ORDER[b.scope] || a.scopeRefId.localeCompare(b.scopeRefId)
  );
}

function encodeReservationId(payload: Record<string, unknown>): string {
  return RESERVATION_ID_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeReservationId(reservationId: string): DecodedReservation {
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

  const p = parsed as Record<string, unknown> | null;
  const malformed = () => new Error(`Invalid reservationId "${reservationId}": decoded payload is malformed.`);
  if (typeof p !== "object" || p === null) throw malformed();
  if (typeof p.estimatedAmount !== "string" || typeof p.nonce !== "string") throw malformed();

  let holds: Hold[];
  if (Array.isArray(p.holds)) {
    // Multi-counter shape: every hold must name a known scope and a target,
    // and no counter may be held twice.
    if (p.holds.length === 0) throw malformed();
    holds = p.holds.map((h) => {
      const hold = h as Record<string, unknown> | null;
      if (
        typeof hold !== "object" ||
        hold === null ||
        typeof hold.scope !== "string" ||
        !(hold.scope in LOCK_ORDER) ||
        typeof hold.scopeRefId !== "string"
      ) {
        throw malformed();
      }
      return { scope: hold.scope as CounterScope, scopeRefId: hold.scopeRefId };
    });
    if (new Set(holds.map((h) => `${h.scope}:${h.scopeRefId}`)).size !== holds.length) throw malformed();
  } else {
    // Single-counter shape — unchanged from before Phase 8.
    if (typeof p.scope !== "string" || typeof p.scopeRefId !== "string") throw malformed();
    holds = [{ scope: p.scope as CounterScope, scopeRefId: p.scopeRefId }];
  }

  // A missing/unrecognized unit is REJECTED, never defaulted to "usd"
  // (amended Phase 12). Defaulting would silently reconcile a subscription
  // reservation against a monetary counter — mixing incommensurable units,
  // which is the exact failure this dimension exists to make impossible.
  if (!isResourceUnit(p.resourceUnit)) {
    throw new Error(
      `Invalid reservationId "${reservationId}": decoded payload carries no recognized resourceUnit` +
        " (it must name one explicitly — a missing unit is never assumed to be \"usd\")."
    );
  }

  return { holds: sortHolds(holds), resourceUnit: p.resourceUnit, estimatedAmount: p.estimatedAmount, nonce: p.nonce };
}

/**
 * Rejects a structurally invalid `estimatedAmount` (negative, NaN, or
 * +/-Infinity) synchronously, before any DB operation is attempted. A caller
 * passing one of these is a programming error, not a legitimate "not enough
 * budget" business outcome — so this throws rather than returning
 * `{ authorized: false, reason: "insufficient_budget" }`.
 */
function validateEstimatedAmount(estimatedAmount: number): void {
  if (!Number.isFinite(estimatedAmount) || estimatedAmount < 0) {
    throw new Error(
      `reserveBudget: estimatedAmount must be a finite, non-negative number; received ${estimatedAmount}.`
    );
  }
}

/**
 * Locks and returns the single budget_counters row for
 * (scope, scopeRefId, resourceUnit), or undefined if none exists.
 *
 * The three-column key means two units under the same scope are DIFFERENT
 * rows, so a `usd` reservation and a `subscription_tokens` reservation for the
 * same run never contend on the same lock.
 */
async function lockCounterRow(
  tx: DrizzleTransaction,
  scope: CounterScope,
  scopeRefId: string,
  resourceUnit: ResourceUnit
) {
  const rows = await tx
    .select()
    .from(budgetCounters)
    .where(
      and(
        eq(budgetCounters.scope, scope),
        eq(budgetCounters.scopeRefId, scopeRefId),
        eq(budgetCounters.resourceUnit, resourceUnit)
      )
    )
    .for("update");
  return rows[0];
}

/**
 * Creates a day or Task Instance counter for a unit if it does not exist, at the
 * governance-configured ceiling (`DAILY_BUDGET_CEILINGS`, `TASK_INSTANCE_BUDGET_CEILINGS`;
 * never a caller's value). Race-safe: `onConflictDoNothing` against the full
 * three-column unique key, so concurrent first reservations converge on one row.
 * Never raises an existing row's limit.
 */
async function ensureGovernedCounter(
  tx: DrizzleTransaction,
  scope: "day" | "task_instance",
  scopeRefId: string,
  resourceUnit: ResourceUnit,
  limitAmount: string
): Promise<void> {
  await tx
    .insert(budgetCounters)
    .values({ scope, scopeRefId, resourceUnit, limitAmount, reservedAmount: "0", consumedAmount: "0" })
    .onConflictDoNothing({
      target: [budgetCounters.scope, budgetCounters.scopeRefId, budgetCounters.resourceUnit],
    });
}

type DenialRequest = {
  scope: BudgetScope;
  scopeRefId: string;
  costClass: CostClass;
  resourceUnit: ResourceUnit;
  requestedAmount: string;
};

/**
 * Records a refusal as `budget_denied` (spec §8.2) and returns it. Emitted here
 * because only this function knows which counter refused and what it held. Same
 * transaction as the refusal; every caller commits it (the Invocation's failure
 * follows). Lock order is the one `budget_consumed` already uses: counter rows,
 * then the Run's event lock. Amounts are the exact stored strings; a missing
 * counter (a zero-limit budget, see `reserveBudget`) is named as missing. One
 * event per refusal, so its key is unique rather than derived.
 */
async function deny(
  tx: DrizzleTransaction,
  request: DenialRequest,
  refused: { scope: CounterScope; scopeRefId: string; row: typeof budgetCounters.$inferSelect | undefined }
): Promise<ReservationResult> {
  await emitLifecycleEvent(tx, {
    eventType: "budget_denied",
    subjectId: randomUUID(),
    // Every production caller reserves at run scope, so this takes only that Run's
    // event lock. A non-run scope would take the shared no-run event lock while
    // holding counter rows (possibly the day row, shared by every Run) — a lock
    // order DURABLE_EXECUTION §6 does not allow; revisit before adding such a caller.
    correlation: request.scope === "run" ? await correlationForRun(tx, request.scopeRefId) : NO_CORRELATION,
    producer: "budget-governor",
    payload: {
      requestedScope: request.scope,
      requestedScopeRefId: request.scopeRefId,
      resourceUnit: request.resourceUnit,
      costClass: request.costClass,
      requestedAmount: request.requestedAmount,
      deniedCounter: {
        scope: refused.scope,
        scopeRefId: refused.scopeRefId,
        missing: refused.row === undefined,
        limitAmount: refused.row?.limitAmount ?? null,
        reservedAmount: refused.row?.reservedAmount ?? null,
        consumedAmount: refused.row?.consumedAmount ?? null,
      },
    },
  });
  return { authorized: false, reason: "insufficient_budget" };
}

/**
 * Reserves `estimatedAmount` against the budget_counters row for
 * (scope, scopeRefId, resourceUnit), inside the caller's transaction. A `run`
 * reservation also holds, in the same unit, the DAY counter when a daily
 * ceiling is configured for that unit, and the Run's TASK_INSTANCE counter when
 * a Task Instance ceiling is: up to three counters.
 *
 * Atomicity: takes `SELECT ... FOR UPDATE` row locks (in the fixed lock order)
 * before checking availability, so concurrent reservations against the same
 * counter are serialized by Postgres — the second blocks until the first
 * commits or rolls back, then re-reads the row's up-to-date values (READ
 * COMMITTED's EvalPlanQual re-evaluation) before deciding.
 *
 * All-or-nothing: EVERY held counter must have room. If any one is short,
 * nothing is written to any of them and the result is `insufficient_budget`.
 *
 * Does NOT create a run row when none exists: that case is treated exactly like
 * a zero-limit budget.
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
  resourceUnit: ResourceUnit,
  estimatedAmount: number,
  options: ReserveBudgetOptions = {}
): Promise<ReservationResult> {
  validateEstimatedAmount(estimatedAmount);

  if (costClass === "deterministic") {
    return { authorized: true, reservationId: NOOP_RESERVATION_ID };
  }

  const estimatedAmountStr = String(estimatedAmount);
  const request: DenialRequest = { scope, scopeRefId, costClass, resourceUnit, requestedAmount: estimatedAmountStr };
  const dailyLimit =
    scope === "run" ? (options.dailyCeilings ?? DAILY_BUDGET_CEILINGS)[resourceUnit] : undefined;
  const taskInstanceLimit =
    scope === "run" ? (options.taskInstanceCeilings ?? TASK_INSTANCE_BUDGET_CEILINGS)[resourceUnit] : undefined;

  // ---- Single counter: no day or Task Instance ceiling for this unit. Unchanged pre-Phase-8 path.
  if (dailyLimit === undefined && taskInstanceLimit === undefined) {
    // No row for THIS unit behaves exactly like a zero-limit budget for this
    // unit, independently of any other unit's counter on the same scope.
    const row = await lockCounterRow(tx, scope, scopeRefId, resourceUnit);
    if (!row) {
      return deny(tx, request, { scope, scopeRefId, row: undefined });
    }

    const available = Number(row.limitAmount) - Number(row.reservedAmount) - Number(row.consumedAmount);
    if (estimatedAmount > available) {
      return deny(tx, request, { scope, scopeRefId, row });
    }

    await tx
      .update(budgetCounters)
      .set({
        reservedAmount: sql`${budgetCounters.reservedAmount} + ${estimatedAmountStr}::numeric`,
        updatedAt: new Date(),
      })
      .where(eq(budgetCounters.id, row.id));

    return {
      authorized: true,
      reservationId: encodeReservationId({
        scope,
        scopeRefId,
        resourceUnit,
        estimatedAmount: estimatedAmountStr,
        nonce: randomUUID(),
      }),
    };
  }

  // ---- Run + day and/or Task Instance: additive containment (Phase 8 day; D20 Task Instance).
  // Every Run of a Task Instance, retries included, holds the same counter. A Run
  // with no row has no Task Instance to charge: refused, never skipped, and before
  // any counter row is created, so a refusal leaves no side effect.
  const taskInstanceId =
    taskInstanceLimit === undefined ? undefined : (await tx.query.runs.findFirst({ where: eq(runs.id, scopeRefId) }))?.taskInstanceId;
  if (taskInstanceLimit !== undefined && taskInstanceId === undefined) {
    return deny(tx, request, { scope: "task_instance", scopeRefId: `unresolved (no run ${scopeRefId})`, row: undefined });
  }

  // Missing day / Task Instance rows are inserted (ON CONFLICT DO NOTHING) before any
  // row lock is taken; DURABLE_EXECUTION §6 records that this precedes the lock order.
  const unsorted: Hold[] = [{ scope, scopeRefId }];
  if (dailyLimit !== undefined) {
    const dayRef = dayScopeRef(options.now ?? new Date());
    await ensureGovernedCounter(tx, "day", dayRef, resourceUnit, dailyLimit);
    unsorted.push({ scope: "day", scopeRefId: dayRef });
  }
  if (taskInstanceLimit !== undefined && taskInstanceId !== undefined) {
    await ensureGovernedCounter(tx, "task_instance", taskInstanceId, resourceUnit, taskInstanceLimit);
    unsorted.push({ scope: "task_instance", scopeRefId: taskInstanceId });
  }
  const holds = sortHolds(unsorted);

  const rows = [];
  for (const hold of holds) {
    const row = await lockCounterRow(tx, hold.scope, hold.scopeRefId, resourceUnit);
    if (!row) {
      return deny(tx, request, { scope: hold.scope, scopeRefId: hold.scopeRefId, row: undefined });
    }
    rows.push(row);
  }

  // Check EVERY counter before writing ANY — so a refusal leaves all of them untouched.
  for (const row of rows) {
    const available = Number(row.limitAmount) - Number(row.reservedAmount) - Number(row.consumedAmount);
    if (estimatedAmount > available) {
      return deny(tx, request, { scope: row.scope as CounterScope, scopeRefId: row.scopeRefId, row });
    }
  }

  for (const row of rows) {
    await tx
      .update(budgetCounters)
      .set({
        reservedAmount: sql`${budgetCounters.reservedAmount} + ${estimatedAmountStr}::numeric`,
        updatedAt: new Date(),
      })
      .where(eq(budgetCounters.id, row.id));
  }

  return {
    authorized: true,
    reservationId: encodeReservationId({
      holds,
      resourceUnit,
      estimatedAmount: estimatedAmountStr,
      nonce: randomUUID(),
    }),
  };
}

/**
 * Locks every counter a reservation holds, in the fixed lock order, throwing —
 * before ANY write — if one has disappeared since it was reserved against.
 */
async function lockHeldCounters(tx: DrizzleTransaction, operation: string, reservation: DecodedReservation) {
  const rows = [];
  for (const hold of reservation.holds) {
    const row = await lockCounterRow(tx, hold.scope, hold.scopeRefId, reservation.resourceUnit);
    if (!row) {
      throw new Error(
        `${operation}: no budget_counters row found for scope="${hold.scope}" scopeRefId="${hold.scopeRefId}"` +
          ` resourceUnit="${reservation.resourceUnit}" (it existed when the reservation was made, but has since been removed).`
      );
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Reconciles a reservation: releases the original `estimatedAmount` from
 * `reserved_amount` and adds `actualAmount` to `consumed_amount` on EVERY
 * counter the reservation holds, each in one update (so no row is ever observed
 * with the reservation released but consumption not yet recorded).
 */
export async function reconcileBudget(
  tx: DrizzleTransaction,
  reservationId: string,
  actualAmount: number,
  /**
   * `reported`: an amount something measured (a provider's usage report).
   * `estimate`: the caller's own estimate standing in for a measurement it
   * cannot make (e.g. a tool whose `execute()` reports no cost). Recorded on
   * the `budget_consumed` event so measured and estimated spend stay separable.
   */
  basis: "reported" | "estimate" = "reported"
): Promise<void> {
  const reservation = decodeReservationId(reservationId);
  await reconcileDecoded(tx, "reconcileBudget", reservation, String(actualAmount), basis);
}

/**
 * Reconciles a reservation as though the work consumed EXACTLY its reserved
 * estimate — for work whose actual consumption can never be known (Phase 9:
 * an Invocation interrupted while `executing`).
 *
 * Why charge rather than release: the provider may well have consumed the
 * entitlement (a `claude -p` child that was killed mid-call, or whose result
 * was lost with the process). Releasing would hand that capacity back and let
 * later work spend it a second time — widening effective authorization on the
 * strength of an unknown. Charging the pessimistic estimate over-counts at
 * worst, and only against a Run that has already failed. The estimate is the
 * exact string recorded at reservation time, so no rounding is introduced.
 */
export async function chargeReservationAtEstimate(
  tx: DrizzleTransaction,
  reservationId: string
): Promise<{ chargedAmount: string; resourceUnit: ResourceUnit }> {
  const reservation = decodeReservationId(reservationId);
  await reconcileDecoded(tx, "chargeReservationAtEstimate", reservation, reservation.estimatedAmount, "estimate");
  // Returned so the caller can record the charge as an immutable fact: no usage
  // event exists for it, so without this the counter could not be explained
  // from the event log.
  return { chargedAmount: reservation.estimatedAmount, resourceUnit: reservation.resourceUnit };
}

async function reconcileDecoded(
  tx: DrizzleTransaction,
  operation: string,
  reservation: DecodedReservation,
  actualAmount: string,
  basis: "reported" | "estimate"
): Promise<void> {
  // A reservation is consumed at most once. The counter update below is not
  // idempotent but the event is (keyed by the reservation's nonce), so a second
  // reconcile would move the counters again while the log still showed one
  // consumption — silently breaking "consumed = sum of budget_consumed". No
  // current path can reconcile twice (every settle is gated on Invocation
  // status under row locks); this makes a future mistake loud instead of silent.
  const alreadyConsumed = await tx.query.events.findFirst({
    where: eq(events.idempotencyKey, `budget_consumed:${reservation.nonce}`),
  });
  if (alreadyConsumed) {
    throw new Error(
      `${operation}: this reservation was already consumed (budget_consumed event "${alreadyConsumed.id}"); ` +
        "refusing to move the counters a second time."
    );
  }

  const rows = await lockHeldCounters(tx, operation, reservation);

  for (const row of rows) {
    await tx
      .update(budgetCounters)
      .set({
        reservedAmount: sql`${budgetCounters.reservedAmount} - ${reservation.estimatedAmount}::numeric`,
        consumedAmount: sql`${budgetCounters.consumedAmount} + ${actualAmount}::numeric`,
        updatedAt: new Date(),
      })
      .where(eq(budgetCounters.id, row.id));
  }

  // Spec §8.5 `budget_consumed`, in the same transaction as the counter
  // update, so every counter's `consumed_amount` is the sum of these events'
  // amounts for its (scope, scopeRefId, resourceUnit) — reconstructible from
  // the log alone. One event per reservation, naming every counter it moved.
  // `basis` separates a provider- or caller-reported amount from a charge at
  // the reservation's estimate (consumption unknown — see
  // `chargeReservationAtEstimate`). Carries no `usage`: that envelope field is
  // a model-usage observation, and this is the counter fact.
  const runHold = reservation.holds.find((h) => h.scope === "run");
  await emitLifecycleEvent(tx, {
    eventType: "budget_consumed",
    subjectId: reservation.nonce,
    correlation: runHold ? await correlationForRun(tx, runHold.scopeRefId) : NO_CORRELATION,
    producer: "budget-governor",
    payload: {
      resourceUnit: reservation.resourceUnit,
      amount: actualAmount,
      estimatedAmount: reservation.estimatedAmount,
      basis,
      holds: reservation.holds,
    },
  });
}

/**
 * Releases a reservation without recording any consumption (e.g. the reserved
 * work failed before execution): decrements `reserved_amount` by the original
 * `estimatedAmount` on every counter the reservation holds.
 */
export async function releaseReservation(tx: DrizzleTransaction, reservationId: string): Promise<void> {
  const reservation = decodeReservationId(reservationId);
  const rows = await lockHeldCounters(tx, "releaseReservation", reservation);

  for (const row of rows) {
    await tx
      .update(budgetCounters)
      .set({
        reservedAmount: sql`${budgetCounters.reservedAmount} - ${reservation.estimatedAmount}::numeric`,
        updatedAt: new Date(),
      })
      .where(eq(budgetCounters.id, row.id));
  }
}
