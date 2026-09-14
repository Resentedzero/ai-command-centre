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
 *
 * Events are written by `emitEvent` deep inside the Executor, Router and
 * governance modules, so publishing is not done at the write. Instead every
 * writer runs its transactions through a relaying runner, which, AFTER each
 * commit, reads the Event rows that transaction created (a per-`runId`
 * sequence watermark diff — see `../liveEventRelay.ts`) and publishes them.
 * Nothing is ever published from inside a transaction, so a subscriber never
 * sees an event Postgres does not durably have.
 *
 * The writers that relay (each commit separately — Phase 9 short
 * transactions): the mutating routes (`POST /goals`, approve/reject,
 * `POST /workflow-runs/:id/resume|advance`, `/execution-stops`), and, in
 * `../api/start.ts`, the startup re-drive and the periodic Approval TTL sweep.
 *
 * Why not Postgres LISTEN/NOTIFY: this is one process (startup enforces it —
 * `../execution/executorInstanceLock.ts`), so every Event writer and every
 * subscriber share it. A NOTIFY round-trip would add a held connection and
 * payload limits for no benefit over an in-process EventEmitter.
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

const LIVE_GAP = "live-gap";

/**
 * Says committed events may not have been published (a relay failed after its
 * commit). Open streams then end, so each client reconnects and replays from
 * Postgres by the highest cursor it received, rather than never seeing them.
 */
export function signalLiveDeliveryGap(): void {
  emitter.emit(LIVE_GAP);
}

export function onLiveDeliveryGap(handler: () => void): () => void {
  emitter.on(LIVE_GAP, handler);
  return () => emitter.off(LIVE_GAP, handler);
}
