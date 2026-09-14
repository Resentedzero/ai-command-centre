/**
 * In-process live-event fan-out for SSE subscribers (Unit 10,
 * task-10-brief.md). This module is LIVE DELIVERY ONLY — it is never a
 * source of truth for events; that is Postgres, via `../events/emit.ts`'s
 * `events` table (frozen, Unit 1). If this process restarts, every live
 * subscriber and anything buffered in `routes/events.ts` is gone; a
 * reconnecting SSE client simply replays from Postgres via
 * `?sinceEventCursor=N` (`routes/events.ts`) and resumes live delivery from
 * here — nothing is permanently lost because nothing here is ever the only
 * copy of an event.
 *
 * WHO CALLS `publishLiveEvent`, AND WHY (the design question the brief poses
 * explicitly — task-10-brief.md's "SSE replay-then-live implementation"
 * section): `../liveEventRelay.ts` (`createWorkflowRelay`, which relays after
 * every committed transaction of a workflow request, and `relayCommittedEvent`
 * for control-plane events such as emergency stops), and ONLY that module.
 * The history below describes the original per-request design; the
 * mechanism — observe committed rows, never publish from inside a
 * transaction — is unchanged.
 *
 * The problem: `emitEvent` (`../events/emit.ts`) is frozen/unmodifiable
 * (Unit 1), and it is called from deep inside Units 2-9 — e.g.
 * `src/router/modelRouter.ts`'s `authorizeRoute`/`callModel`, several layers
 * below any route handler — so neither "modify emitEvent to also call
 * publishLiveEvent" nor "make every emitEvent call site also call
 * publishLiveEvent" is available without touching frozen Unit 1-9 files.
 *
 * The resolution: Ruling 3 (task-10-brief.md) already makes this unit's own
 * route handlers (`POST /goals`, `POST /approvals/:id/approve|reject`,
 * `POST /workflow-runs/:id/resume`) the ONLY place any mutation happens in
 * this single-process, no-poller MVP — every Event that will ever exist got
 * created synchronously inside one of those four routes' own database
 * transaction. So THIS layer (new, unfrozen, Unit 10 code) is a legitimate
 * place to observe "which Event rows did that transaction just create" —
 * `../liveEventRelay.ts` does this via a before/after per-`runId` sequenceNo
 * watermark diff around each mutating route's transaction (see that
 * module's header for the exact mechanism and why it is correct even though
 * `sequenceNo` is only monotonic per-run, never globally).
 *
 * Why NOT Postgres LISTEN/NOTIFY: the frozen spec (Phase 4) offered it as an
 * option, but every prior unit in this project has consistently chosen an
 * in-process mechanism over a deployment/database trick when the process
 * topology allows it (e.g. Unit 6's `runs.budget_envelope` in-process
 * bookkeeping instead of a separate reservations table/service). This is a
 * single-process app — the API server is the only process that ever writes
 * an Event — so a LISTEN/NOTIFY round-trip through Postgres would be strictly
 * more moving parts (a second PG connection held open, NOTIFY payload size
 * limits, no back-pressure) for zero benefit over an in-process EventEmitter
 * the writer and the reader already share. Why NOT a polling loop: the
 * before/after diff triggers exactly once per mutating request, event-driven
 * by that request's own completion — there is no interval timer anywhere in
 * this design, and so no added latency or steady-state DB load between
 * requests.
 */
import { EventEmitter } from "node:events";
import type { WireEventEnvelope } from "./eventEnvelopeRow.js";

const emitter = new EventEmitter();
// An unbounded number of concurrent SSE connections is expected (each one
// calls subscribeToLiveEvents once) — this is not a leak, it is the
// intended fan-out shape.
emitter.setMaxListeners(0);

const LIVE_EVENT = "live-event";

/**
 * Takes a `WireEventEnvelope`, NOT the domain `EventEnvelope` — i.e. a row
 * already mapped through `./eventEnvelopeRow.js` (Finding 3). A live event
 * and a replayed event must be indistinguishable on the wire, and only that
 * mapper attaches the `eventCursor` a reconnecting client resumes from;
 * publishing `emitEvent`'s own return value here would put a cursor-less
 * envelope on the bus and silently break reconnects for exactly the events
 * delivered live. The type makes that mistake a compile error.
 */
export function publishLiveEvent(event: WireEventEnvelope): void {
  emitter.emit(LIVE_EVENT, event);
}

export function subscribeToLiveEvents(handler: (e: WireEventEnvelope) => void): () => void {
  emitter.on(LIVE_EVENT, handler);
  return () => emitter.off(LIVE_EVENT, handler);
}
