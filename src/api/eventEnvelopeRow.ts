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
 */
import type { events } from "../db/schema.js";
import type { EventEnvelope } from "../events/types.js";

export function rowToEventEnvelope(row: typeof events.$inferSelect): EventEnvelope {
  const hasUsage =
    row.tokensIn !== null || row.tokensOut !== null || row.cacheHit !== null || row.costAmount !== null || row.modelId !== null;

  return {
    eventId: row.id,
    idempotencyKey: row.idempotencyKey,
    eventType: row.eventType,
    eventVersion: row.eventVersion,
    occurredAt: row.occurredAt,
    sequenceNo: row.sequenceNo,
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
          modelId: row.modelId ?? "",
        }
      : null,
  };
}
