/**
 * `GET /events/stream?sinceSequenceNo=N` — Server-Sent Events, correctly
 * combining Postgres replay (authoritative) with in-process live delivery.
 * Implements the brief's frozen 4-step sequence EXACTLY in order (see
 * task-10-brief.md's interface comment for `routes/events.ts`) — do not
 * reorder into query-then-subscribe:
 *   1. Subscribe to the live EventEmitter FIRST, buffering.
 *   2. Query Postgres for `sequenceNo > N`, stream as read (authoritative).
 *   3. Flush the buffered live events, de-duplicated against step 2.
 *   4. Continue streaming subsequent live events directly.
 *
 * ---------------------------------------------------------------------------
 * Scope of `sinceSequenceNo` / the replay query (documented MVP limitation)
 * ---------------------------------------------------------------------------
 * `sequenceNo` (`../../events/types.ts`) is monotonic ONLY per `runId`,
 * never globally — two different Runs' events can legitimately share the
 * same `sequenceNo`. This route nonetheless queries `events` GLOBALLY
 * (`sequenceNo > N`, ordered ascending, with `runId` as a documented
 * TIEBREAK ONLY — it carries no ordering meaning across runs) rather than
 * scoped to one run, per the brief's own explicit MVP-scope guidance
 * (task-10-brief.md's pre-dispatch note: the required test "seeds events
 * 1-10 without specifying a run, so a global/all-events query ordered by
 * sequenceNo ascending is the right MVP scope"). This is correct for the
 * common MVP case (at most one Workflow Run meaningfully in flight at a
 * time) but is NOT a sound general multi-run replay cursor — a real one
 * would need a genuinely global monotonic column, which does not exist in
 * this schema (Unit 1, frozen) and is out of this unit's scope to add.
 * Standalone (non-workflow) Task Instances' events fall inside this query's
 * scope like any other event (nothing here excludes them by `runId`), even
 * though none of this unit's own mutating routes ever produce one.
 *
 * ---------------------------------------------------------------------------
 * De-duplication is by `eventId`, NOT by `sequenceNo`
 * ---------------------------------------------------------------------------
 * The brief's step 3 reads "skip any buffered event whose sequenceNo was
 * already sent" as if `sequenceNo` were globally unique — it is not (see
 * above). De-duplicating on it would silently DROP a real, never-before-seen
 * event from a different run that happens to share a `sequenceNo` with
 * something already replayed. `eventId` (the envelope's UUID primary key) is
 * genuinely globally unique, so that is what this route de-duplicates on.
 *
 * `sinceSequenceNo` is applied ONLY to the Postgres replay query (step 2) —
 * NEVER to buffered/live events (steps 1/3/4). A live event from a brand-new
 * Run legitimately starts back at `sequenceNo: 1`, which can be <= N despite
 * the client never having seen it — filtering live events by `N` would drop
 * it permanently. Live events are forward-in-time by construction (they are
 * only ever published, via `../liveEventRelay.ts`, for a transaction that
 * commits during or after this connection's lifetime); the `eventId`
 * de-dup set is the only filter they need.
 */
import type { FastifyInstance } from "fastify";
import { asc, gt } from "drizzle-orm";
import { events } from "../../db/schema.js";
import type { ApiDeps } from "../server.js";
import { subscribeToLiveEvents } from "../eventBus.js";
import { rowToEventEnvelope } from "../eventEnvelopeRow.js";
import type { EventEnvelope } from "../../events/types.js";

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
  app.get<{ Querystring: { sinceSequenceNo?: string } }>("/events/stream", async (request, reply) => {
    const sinceSequenceNo = Number(request.query.sinceSequenceNo ?? 0);

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
    // connection with sinceSequenceNo ahead of everything, or an empty
    // events table) never even sees a response until SOMETHING is written,
    // which may be arbitrarily far in the future. Found via fix round 2's
    // new "real relay path" test (Important #2) — the two pre-existing SSE
    // tests both always had seed rows ready to replay immediately, so they
    // masked this: their very first replayed row's `write()` flushed the
    // headers as a side effect, well before either test asserted anything.
    reply.raw.flushHeaders();

    const sentEventIds = new Set<string>();
    let buffering = true;
    const buffer: EventEnvelope[] = [];
    let closed = false;

    function writeEvent(e: EventEnvelope): void {
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
      // Step 2: authoritative Postgres replay, streamed as read. `runId` is
      // a documented tiebreak only (see module header) — it does not imply
      // cross-run ordering meaning.
      const rows = await deps.db.query.events.findMany({
        where: gt(events.sequenceNo, sinceSequenceNo),
        orderBy: [asc(events.sequenceNo), asc(events.runId)],
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
