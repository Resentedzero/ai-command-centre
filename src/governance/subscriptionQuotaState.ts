/**
 * Provider quota state — the observation Event and its current-state
 * projection (Phase 7A; design Parts 3, 4 and 10).
 *
 * The architecture this module exists to enforce:
 *
 *     provider observation  ->  immutable Event  ->  current-state projection
 *
 * `recordQuotaObservation` is the ONLY way to write `subscription_quota_state`.
 * There is deliberately no "just update the state" entry point: a projection
 * written without an event behind it would be a second source of truth, which
 * Phase 8 of the spec forbids ("all projections over one event model — none is
 * a separate source of truth").
 *
 * What this module is NOT
 * -----------------------
 * Quota utilization is a provider-reported GAUGE. It was measured oscillating
 * 0.47 -> 0.48 -> 0.47 inside a single second, and identical bursts moved it by
 * different amounts. So this module never:
 *
 *   - converts utilization into tokens, dollars, or any other resource unit;
 *   - accumulates, maxes, averages, or differences utilization;
 *   - infers window capacity, tokens remaining, or consumption;
 *   - touches `budget_counters` or `subscription_tokens` accounting.
 *
 * Usage accounting (`subscription_tokens`, via the Budget Governor) and quota
 * state (this module) are independent by construction. Nothing here imports
 * `./budget.js`, and nothing here reads or writes a counter.
 *
 * It also makes no ALLOW/REFUSE decision and applies no staleness threshold.
 * `observedAt` is recorded so a future policy CAN judge freshness; choosing the
 * threshold, and deciding what a stale reading means, is Phase 7C's job.
 */
import { eq, sql } from "drizzle-orm";
import { subscriptionQuotaState } from "../db/schema.js";
import { emitEvent, type DrizzleTransaction, type EmitEventInput } from "../events/emit.js";
import type {
  EventEnvelope,
  ProviderQuotaObservedPayload,
  QuotaWindowObservation,
} from "../events/types.js";

export const PROVIDER_QUOTA_OBSERVED = "provider_quota_observed";
export const PROVIDER_QUOTA_OBSERVED_VERSION = 1;

/** One quota window as reported; either member may be absent (never invented). */
export type QuotaWindow = QuotaWindowObservation;

/**
 * A single provider quota reading, in the shape a provider adapter produces it.
 * Every field mirrors something the provider actually said — nothing here is
 * derived.
 */
export type QuotaObservation = {
  provider: string;
  /**
   * LOCAL RECEIPT time — when this runtime saw the reading, not when the
   * provider measured it. The provider supplies no timestamp, so none can be
   * recorded; consumers must never present this as a provider-side time.
   */
  observedAt: Date;
  status: string;
  overageStatus: string | null;
  source: string;
  fiveHour: QuotaWindow | null;
  sevenDay: QuotaWindow | null;
  /** Raw readings summarized by this observation; defaults to 1. */
  observationCount?: number;
};

/**
 * Envelope fields the caller owns. `idempotencyKey` is caller-supplied, exactly
 * as `emitEvent` requires of every other event in the system; the design's
 * recommended format is
 * `provider_quota_observed:<invocationId>:<observationIndex>`.
 */
export type QuotaObservationContext = Pick<
  EmitEventInput,
  "idempotencyKey" | "causationId" | "correlation" | "producer"
>;

/**
 * Validates one window BEFORE the event is written.
 *
 * This has to happen here, not only in the projection: the payload is stored as
 * jsonb, and `JSON.stringify(NaN)` is `null` — so a NaN utilization would round
 * -trip into a legitimate-looking "the provider omitted this field" and be
 * recorded as an immutable fact. Rejecting at the boundary keeps a malformed
 * reading out of the event log entirely.
 */
function validateWindow(window: QuotaWindow | null, label: string): void {
  if (!window) return;
  if (
    window.utilization !== null &&
    window.utilization !== undefined &&
    !Number.isFinite(window.utilization)
  ) {
    throw new Error(
      `subscription quota observation: ${label} utilization must be a finite number;` +
        ` received ${window.utilization}.`
    );
  }
  if (window.resetsAt && Number.isNaN(new Date(window.resetsAt).getTime())) {
    throw new Error(
      `subscription quota observation: ${label} resetsAt "${window.resetsAt}" is not a valid ISO-8601 instant.`
    );
  }
}

function toPayload(observation: QuotaObservation): ProviderQuotaObservedPayload {
  validateWindow(observation.fiveHour, "five_hour");
  validateWindow(observation.sevenDay, "seven_day");
  if (Number.isNaN(observation.observedAt.getTime())) {
    throw new Error("subscription quota observation: observedAt is not a valid Date.");
  }

  return {
    provider: observation.provider,
    observedAt: observation.observedAt.toISOString(),
    status: observation.status,
    overageStatus: observation.overageStatus,
    source: observation.source,
    fiveHour: observation.fiveHour,
    sevenDay: observation.sevenDay,
    observationCount: observation.observationCount ?? 1,
  };
}

/**
 * `numeric` columns are written as strings so the value Postgres stores is the
 * one the provider reported, digit for digit. `null` stays `null` — an absent
 * utilization is absent, not zero.
 */
function utilizationColumn(window: QuotaWindow | null): string | null {
  if (!window || window.utilization === null || window.utilization === undefined) return null;
  if (!Number.isFinite(window.utilization)) {
    throw new Error(
      `subscription quota observation: utilization must be a finite number; received ${window.utilization}.`
    );
  }
  return String(window.utilization);
}

function resetColumn(window: QuotaWindow | null): Date | null {
  if (!window || !window.resetsAt) return null;
  const parsed = new Date(window.resetsAt);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `subscription quota observation: resetsAt "${window.resetsAt}" is not a valid ISO-8601 instant.`
    );
  }
  return parsed;
}

/**
 * Projects one `provider_quota_observed` event onto `subscription_quota_state`.
 *
 * Exported so the projection can be rebuilt from the event log alone, which is
 * what makes the event — not this row — authoritative.
 *
 * Semantics, in one statement:
 *  - no row for this provider yet   -> insert it;
 *  - stored observation is OLDER    -> replace it wholesale;
 *  - stored observation is NEWER or the SAME instant -> leave it untouched.
 *
 * The last clause is what makes this both order-independent and idempotent:
 * replaying the same event, or applying events out of order, converges on the
 * latest observation either way. It is a straight replacement, never a merge —
 * the row always reflects exactly one provider reading, never a blend of
 * several.
 */
export async function applyQuotaObservation(
  tx: DrizzleTransaction,
  event: EventEnvelope
): Promise<void> {
  if (event.eventType !== PROVIDER_QUOTA_OBSERVED) {
    throw new Error(
      `applyQuotaObservation: refusing to project event of type "${event.eventType}";` +
        ` only "${PROVIDER_QUOTA_OBSERVED}" describes a provider quota observation.`
    );
  }

  const payload = event.payload as unknown as ProviderQuotaObservedPayload;
  const observedAt = new Date(payload.observedAt);
  if (Number.isNaN(observedAt.getTime())) {
    throw new Error(
      `applyQuotaObservation: event "${event.eventId}" carries observedAt "${payload.observedAt}",` +
        " which is not a valid ISO-8601 instant."
    );
  }

  const row = {
    provider: payload.provider,
    fiveHourUtilization: utilizationColumn(payload.fiveHour),
    fiveHourResetAt: resetColumn(payload.fiveHour),
    sevenDayUtilization: utilizationColumn(payload.sevenDay),
    sevenDayResetAt: resetColumn(payload.sevenDay),
    observedAt,
    status: payload.status,
    overageStatus: payload.overageStatus,
    source: payload.source,
    observationEventId: event.eventId,
  };

  await tx
    .insert(subscriptionQuotaState)
    .values(row)
    .onConflictDoUpdate({
      target: subscriptionQuotaState.provider,
      set: {
        fiveHourUtilization: row.fiveHourUtilization,
        fiveHourResetAt: row.fiveHourResetAt,
        sevenDayUtilization: row.sevenDayUtilization,
        sevenDayResetAt: row.sevenDayResetAt,
        observedAt: row.observedAt,
        status: row.status,
        overageStatus: row.overageStatus,
        source: row.source,
        observationEventId: row.observationEventId,
      },
      // The guard that makes "older never overwrites newer" a property of the
      // single UPDATE statement rather than of a read-then-write the caller
      // could race. Strict `<` also makes re-applying the identical event a
      // no-op, so replay is idempotent.
      //
      // Consequence of the strictness, accepted deliberately: two DISTINCT
      // readings bearing the same `observedAt` collapse to whichever applied
      // first — the second is dropped. The provider timestamps at
      // sub-second resolution and four readings inside one second were observed
      // to differ, so this is reachable in principle. It is the safe direction
      // to err: both readings are already in the event log, and quota state is
      // advisory, so losing one same-instant gauge reading changes no decision
      // that the other would not have produced.
      setWhere: sql`${subscriptionQuotaState.observedAt} < ${observedAt}`,
    });
}

/**
 * Records a provider quota reading: emits the immutable `provider_quota_observed`
 * Event and projects it, in the caller's single transaction — so the fact and
 * the derived state can never diverge.
 *
 * Idempotent end to end: `emitEvent` returns the existing row for a repeated
 * `idempotencyKey` without inserting, and re-projecting that event changes
 * nothing.
 */
export async function recordQuotaObservation(
  tx: DrizzleTransaction,
  observation: QuotaObservation,
  context: QuotaObservationContext
): Promise<EventEnvelope> {
  const event = await emitEvent(tx, {
    idempotencyKey: context.idempotencyKey,
    eventType: PROVIDER_QUOTA_OBSERVED,
    eventVersion: PROVIDER_QUOTA_OBSERVED_VERSION,
    causationId: context.causationId,
    correlation: context.correlation,
    actor: "system",
    producer: context.producer,
    payload: toPayload(observation) as unknown as Record<string, unknown>,
    // A quota reading records no consumption. See ProviderQuotaObservedPayload.
    usage: null,
  });

  await applyQuotaObservation(tx, event);
  return event;
}

/** Reads the current projected quota state for a provider, if any exists yet. */
export async function getQuotaState(tx: DrizzleTransaction, provider: string) {
  return tx.query.subscriptionQuotaState.findFirst({
    where: eq(subscriptionQuotaState.provider, provider),
  });
}
