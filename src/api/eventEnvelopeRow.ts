/**
 * Row -> `EventEnvelope` mapper for the API layer. DUPLICATED deliberately
 * from `../events/emit.ts`'s private (non-exported, frozen Unit 1) internal
 * `rowToEnvelope` function, rather than importing it — that function isn't
 * exported and `emit.ts` must not be modified to export it (Unit 1-9 files
 * are frozen for this unit). Mirrors its `hasUsage` predicate and
 * `Number(row.costAmount)` conversion EXACTLY.
 *
 * This is the ONE mapper the whole API layer uses — both
 * `routes/events.ts`'s Postgres replay query and `liveEventRelay.ts`'s
 * live-event relay call it — so a replayed copy and a live copy of the same
 * underlying row always produce byte-identical envelopes (required for the
 * SSE replay-then-live de-duplication to be meaningful: de-dup compares
 * `eventId`s, but a UI consuming the stream should never observe two
 * differently-shaped payloads for what is otherwise the same event).
 *
 * ---------------------------------------------------------------------------
 * `eventCursor` — why it lives HERE and not on `EventEnvelope` (Finding 3)
 * ---------------------------------------------------------------------------
 * `EventEnvelope` (`../events/types.js`) is the FROZEN Phase 8.1 contract and
 * carries no cursor; its own header forbids adding fields without amending
 * the spec first. Nor should it have one: a resume cursor is a DELIVERY
 * concern, and Phase 15.3 states plainly that the SSE feed is "a delivery
 * mechanism, not a second source of truth". So the cursor is added at the
 * WIRE boundary — this mapper — as `WireEventEnvelope`, and the domain
 * envelope every other module emits and consumes is left untouched.
 *
 * Its value is `events.global_seq`, the globally-monotonic column added for
 * Finding 3. It is deliberately a SEPARATE field from `sequenceNo`, which
 * stays on the wire unchanged and still means exactly what Phase 8.1 says it
 * means (monotonic per `run_id`, authoritative for causal ordering WITHIN one
 * run). Anything resuming a stream must use `eventCursor`; anything ordering
 * one run's trace must use `sequenceNo`. Conflating the two is the bug this
 * field exists to make unrepresentable.
 */
import type { events } from "../db/schema.js";
import { isResourceUnit } from "../governance/resourceUnit.js";
import type { EventEnvelope } from "../events/types.js";

/**
 * The SSE wire shape: the frozen domain envelope plus the transport-only
 * replay/reconnect cursor. `web/lib/api.ts`'s `RawEventEnvelope` mirrors the
 * subset of this that the UI actually reads.
 */
export type WireEventEnvelope = EventEnvelope & {
  /** Globally monotonic across ALL runs — the ONLY sound `?sinceEventCursor=` value. Never per-run; see this module's header. */
  eventCursor: number;
};

export function rowToEventEnvelope(row: typeof events.$inferSelect): WireEventEnvelope {
  const hasUsage =
    row.tokensIn !== null || row.tokensOut !== null || row.cacheHit !== null || row.costAmount !== null || row.modelId !== null;

  return {
    eventId: row.id,
    idempotencyKey: row.idempotencyKey,
    eventType: row.eventType,
    eventVersion: row.eventVersion,
    occurredAt: row.occurredAt,
    sequenceNo: row.sequenceNo,
    eventCursor: row.globalSeq,
    causationId: row.causationId,
    correlation: {
      goalId: row.goalId,
      workflowRunId: row.workflowRunId,
      taskInstanceId: row.taskInstanceId,
      runId: row.runId,
      invocationId: row.invocationId,
    },
    actor: row.actor,
    producer: row.producer,
    payload: row.payload,
    usage: hasUsage
      ? {
          tokensIn: row.tokensIn ?? 0,
          tokensOut: row.tokensOut ?? 0,
          cacheHit: row.cacheHit ?? false,
          costAmount: row.costAmount === null ? 0 : Number(row.costAmount),
          // Mirrors emitEvent's fail-closed read exactly (see this module's
          // header on why the two mappers stay byte-identical): a usage-bearing
          // row with no recognized unit is never silently read as dollars.
          costUnit: assertPersistedResourceUnit(row.costUnit, row.id),
          modelId: row.modelId ?? "",
        }
      : null,
  };
}

function assertPersistedResourceUnit(value: string | null, eventId: string) {
  if (!isResourceUnit(value)) {
    throw new Error(
      `rowToEventEnvelope: event "${eventId}" carries usage but its cost_unit is` +
        ` ${value === null ? "NULL" : `"${value}"`}, which is not a recognized ResourceUnit.`
    );
  }
  return value;
}
