/**
 * `GET /events/stream?sinceEventCursor=N` — Server-Sent Events, correctly
 * combining Postgres replay (authoritative) with in-process live delivery.
 * Implements the brief's frozen 4-step sequence EXACTLY in order (see
 * task-10-brief.md's interface comment for `routes/events.ts`) — do not
 * reorder into query-then-subscribe:
 *   1. Subscribe to the live EventEmitter FIRST, buffering.
 *   2. Query Postgres for `globalSeq > N`, stream as read (authoritative).
 *   3. Flush the buffered live events, de-duplicated against step 2.
 *   4. Continue streaming subsequent live events directly.
 *
 * ---------------------------------------------------------------------------
 * The replay cursor is `globalSeq`, NEVER `sequenceNo` (final-review Finding 3)
 * ---------------------------------------------------------------------------
 * `sequenceNo` (`../../events/types.ts`) is monotonic ONLY per `runId`, never
 * globally — two different Runs' events legitimately share the same
 * `sequenceNo`, both starting back at 1. This route previously compared a
 * SINGLE GLOBAL watermark against that per-run counter (`sequenceNo > N`,
 * tiebroken by `runId`), which is unsound in both directions and was a real,
 * reproduced bug, not a hypothetical:
 *   - SKIPPED events: a single `POST /goals` drives
 *     `advanceWorkflowRunUntilBlocked`, which creates TWO Runs in one
 *     request. A client holding N = 3 after run A would never receive run
 *     B's events 1, 2, 3 at all — they are permanently invisible to every
 *     future replay, since their `sequenceNo`s stay <= N forever.
 *   - DUPLICATED events: ordering by `sequenceNo` interleaves the two runs,
 *     so resuming from any mid-stream position hands back events from the
 *     other run that were already rendered.
 * `../liveEventRelay.ts`'s header had already reasoned this out for the LIVE
 * path ("a single global watermark ... would silently miss an entire new
 * Run's events"); this replay path simply had not followed it.
 *
 * The fix is `events.global_seq` (`../../db/schema.ts`): a `bigserial`, so
 * genuinely monotonic across ALL runs, independent of `sequence_no`, which is
 * untouched and remains the authoritative causal-ordering field within one
 * run (Phase 8.1) for anything that needs that — e.g. a future Agent Detail
 * trace view. The client-facing name of the cursor was renamed from
 * `sinceSequenceNo` to `sinceEventCursor` deliberately: the wire envelope
 * carries BOTH `sequenceNo` and `eventCursor`, and leaving the parameter
 * named after the wrong one is precisely how these two got wired together in
 * the first place.
 *
 * Standalone (non-workflow) Task Instances' events fall inside this query's
 * scope like any other event (nothing here excludes them by `runId`), even
 * though none of this unit's own mutating routes ever produce one.
 *
 * Accepted residual (documented, not fixed here): a sequence guarantees
 * monotonic ASSIGNMENT, not monotonic COMMIT visibility — two concurrent
 * transactions can commit out of cursor order, so a reconnect could in
 * principle step over an event whose cursor was assigned earlier but
 * committed later. This is out of scope for this fix (it needs a
 * commit-ordered cursor) and is the identical property the pre-existing
 * per-run `sequenceNo` already has.
 *
 * Be precise about what does and does not bound that residual
 * (independent-review Minor 1 — an earlier version of this paragraph claimed
 * "mutations are serialized per request", which is false and, worse, read as
 * if requests were serialized with respect to EACH OTHER). What IS
 * guaranteed: each mutating request does its own writes inside ONE atomic
 * transaction, and `../liveEventRelay.ts` publishes only after that
 * transaction has committed, so a subscriber never sees an event Postgres
 * does not durably have. What is NOT guaranteed: any serialization BETWEEN
 * requests. Fastify serves requests concurrently, each on its own pooled
 * connection, so two mutating transactions can genuinely overlap and commit
 * out of `global_seq` order — which is precisely the residual above, and it
 * is reachable rather than merely theoretical. Nothing elsewhere closes it in
 * general either: the `approvals` row lock added for independent-review
 * Important 1 serializes concurrent resolutions of THE SAME Approval and says
 * nothing about any other pair of requests. What bounds this in practice is
 * operational, not structural — a single-operator local MVP rarely has two
 * mutating requests in flight at once.
 *
 * ---------------------------------------------------------------------------
 * De-duplication is by `eventId`, NOT by any sequence/cursor value
 * ---------------------------------------------------------------------------
 * The brief's step 3 reads "skip any buffered event whose sequenceNo was
 * already sent" as if `sequenceNo` were globally unique — it is not (see
 * above). De-duplicating on it would silently DROP a real, never-before-seen
 * event from a different run that happens to share a `sequenceNo` with
 * something already replayed. `eventId` (the envelope's UUID primary key) is
 * genuinely globally unique, so that is what this route de-duplicates on.
 *
 * `sinceEventCursor` is applied ONLY to the Postgres replay query (step 2) —
 * NEVER to buffered/live events (steps 1/3/4). Live events are
 * forward-in-time by construction (they are only ever published, via
 * `../liveEventRelay.ts`, for a transaction that commits during or after this
 * connection's lifetime); the `eventId` de-dup set is the only filter they
 * need.
 */
import type { FastifyInstance } from "fastify";
import { asc, gt } from "drizzle-orm";
import { events } from "../../db/schema.js";
import type { ApiDeps } from "../server.js";
import { subscribeToLiveEvents } from "../eventBus.js";
import { rowToEventEnvelope } from "../eventEnvelopeRow.js";
import type { WireEventEnvelope } from "../eventEnvelopeRow.js";

/**
 * Test-only synchronization seam (documented, not hidden). A real client
 * never sets this — it defaults to a no-op. Lets
 * `tests/api/sseReplay.test.ts` deterministically run code (emitting a live
 * event via `emitEvent` + `publishLiveEvent`) AFTER a specific replayed row
 * has been written to the client but BEFORE step 2's loop finishes — the
 * exact "mid-replay" race the brief's Codex-reviewability note asks to prove
 * closed. Deliberately NOT a `setTimeout`/sleep-based race: this makes the
 * interleaving point exact and reproducible instead of timing-dependent.
 */
export const sseTestHooks = {
  afterReplayRow: null as ((rowIndex: number, totalRows: number) => void | Promise<void>) | null,
};

export function registerEventsRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get<{ Querystring: { sinceEventCursor?: string } }>("/events/stream", async (request, reply) => {
    const sinceEventCursor = Number(request.query.sinceEventCursor ?? 0);
    // Validated before the stream opens: a non-integer cursor would otherwise
    // reach the replay query as NaN and silently end the stream.
    if (!Number.isSafeInteger(sinceEventCursor) || sinceEventCursor < 0) {
      return reply.status(400).send({ error: "sinceEventCursor must be a non-negative integer" });
    }

    // Fastify won't try to manage/send a response after this — we own
    // `reply.raw` for the rest of the connection's lifetime.
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    // Node buffers headers until the first body write/flush by default —
    // without this, a client connecting when there is nothing to replay
    // and no live event has arrived yet (the common case: a fresh
    // connection with sinceEventCursor ahead of everything, or an empty
    // events table) never even sees a response until SOMETHING is written,
    // which may be arbitrarily far in the future. Found via fix round 2's
    // new "real relay path" test (Important #2) — the two pre-existing SSE
    // tests both always had seed rows ready to replay immediately, so they
    // masked this: their very first replayed row's `write()` flushed the
    // headers as a side effect, well before either test asserted anything.
    reply.raw.flushHeaders();

    const sentEventIds = new Set<string>();
    let buffering = true;
    const buffer: WireEventEnvelope[] = [];
    let closed = false;

    function writeEvent(e: WireEventEnvelope): void {
      if (closed || sentEventIds.has(e.eventId)) return;
      sentEventIds.add(e.eventId);
      reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    }

    // Step 1: subscribe to live events FIRST, buffering — before any
    // Postgres read, so nothing emitted from here on can be missed.
    const unsubscribe = subscribeToLiveEvents((e) => {
      if (buffering) {
        buffer.push(e);
      } else {
        // Step 4: already caught up — write directly.
        writeEvent(e);
      }
    });

    const cleanup = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
    };
    request.raw.on("close", cleanup);
    reply.raw.on("close", cleanup);

    try {
      // Step 2: authoritative Postgres replay, streamed as read. Filtered
      // AND ordered by the globally-monotonic cursor only (see module
      // header) — `globalSeq` is unique by construction, so no tiebreak
      // column is needed and none is used: the order is total, and it is
      // the same order the client will resume from.
      const rows = await deps.db.query.events.findMany({
        where: gt(events.globalSeq, sinceEventCursor),
        orderBy: [asc(events.globalSeq)],
      });

      for (let i = 0; i < rows.length; i++) {
        if (closed) break;
        writeEvent(rowToEventEnvelope(rows[i]!));
        await sseTestHooks.afterReplayRow?.(i, rows.length);
      }

      // Step 3: flush buffered live events, de-duplicated by eventId.
      buffering = false;
      const toFlush = buffer.splice(0);
      for (const e of toFlush) {
        writeEvent(e);
      }
      // Step 4 (continued): `buffering` is now false — the subscription
      // callback above writes any further live event directly, with no
      // further buffering needed.
    } catch (err) {
      request.log.error(err);
      cleanup();
      try {
        reply.raw.end();
      } catch {
        // best-effort only — the connection may already be gone
      }
    }
  });
}
