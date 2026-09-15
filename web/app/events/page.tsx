"use client";

import { useMemo, useState } from "react";
import { MAX_EVENTS, isStale, useLive } from "../../components/live";
import { PixelButton, Skeleton, StateNotice, StatusMark, cx, px } from "../../components/pixel/Pixel";
import { world } from "../../components/world/World";
import { formatTime, stateWord, type Tone } from "../../lib/keep";
import s from "./events.module.css";

/** Outcome markers per event name (presentation only). A past event claims no current state, so started and waiting rows stay neutral. */
const TYPE_TONES: [RegExp, Tone][] = [
  [/failed|halted|denied|rejected|expired|revoked|stop_engaged/, "fail"],
    [/completed|approved/, "done"],
];

function toneOfEvent(eventType: string): Tone {
  return TYPE_TONES.find(([re]) => re.test(eventType))?.[1] ?? "neutral";
}

/** The summary without the event type the type column already shows; the full summary stays in `title`. */
function shownSummary(e: { eventType: string; summary: string }): string {
  if (e.summary === e.eventType) return "";
  return e.summary.startsWith(`${e.eventType} `) ? e.summary.slice(e.eventType.length + 1) : e.summary;
}

/**
 * Events (Figma "Events — pixel (dense log)"): what happened, and in what
 * order? Almost no world (a library strip), then a dense mono log of every
 * event the live feed has delivered this session, newest first, with the
 * global cursor as the order. The feed replays from the start on load, and a
 * reconnect replays what was missed from the highest cursor seen. Filtering by
 * type is client-side over received events: there is no event list route.
 */
export default function EventsPage() {
  const { status, events, reconnect } = useLive();
  const [filter, setFilter] = useState<string | null>(null);
  const types = useMemo(() => [...new Set(events.map((e) => e.eventType))].sort(), [events]);
  const active = filter !== null && types.includes(filter) ? filter : null;
  const rows = useMemo(() => events.filter((e) => active === null || e.eventType === active).reverse(), [events, active]);

  return (
    <main className={s.screen}>
      <header className={s.head}>
        <div className={cx(s.strip, isStale(status) && world.stale)} aria-hidden>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/world/room-v5-library-2x.png" width={352} height={256} alt="" className={world.base} style={{ top: -72 }} draggable={false} />
          <div className={world.night} />
        </div>
        <div className={cx(px.parchment, s.card)}>
          <div className={s.row}>
            <h1 className={px.heading}>Events</h1>
            {status === "live" ? (
              <StatusMark state="live" tone="done" surface="parchment" />
            ) : (
              <StatusMark state={status} tone="neutral" surface="parchment" />
            )}
            <span>
              {events.length} received{events.length >= MAX_EVENTS ? ` · only the latest ${MAX_EVENTS} are kept` : ""}
            </span>
          </div>
          {isStale(status) && (
            <div className={s.row} role="status">
              <span>
                {status === "offline" ? "The live feed is offline." : "Reconnecting to the live feed."} Missed events will be filled in when it&apos;s back.
              </span>
              <PixelButton onClick={reconnect}>Reconnect</PixelButton>
            </div>
          )}
          {types.length > 0 && (
            <div role="group" aria-label="Filter by type" className={s.chips}>
              <button type="button" className={cx(px.plaque, s.chip, active === null && px.selected)} aria-pressed={active === null} onClick={() => setFilter(null)}>
                all types
              </button>
              {types.map((t) => (
                <button key={t} type="button" className={cx(px.plaque, s.chip, active === t && px.selected)} aria-pressed={active === t} onClick={() => setFilter(t)}>
                  {stateWord(t)}
                </button>
              ))}
            </div>
          )}
        </div>
      </header>

      <section className={cx(px.board, s.log)} aria-label="Event log">
        {events.length === 0 ? (
          status === "connecting" ? (
            <StateNotice role="status" message={<>Connecting to the live feed <Skeleton /></>} />
          ) : (
            <StateNotice message="No events received yet." detail={isStale(status) ? "The feed is not connected." : "Events appear here as the runtime records them."} />
          )
        ) : (
          <table className={s.table}>
            <thead>
              <tr>
                <th scope="col">time</th>
                <th scope="col">type</th>
                <th scope="col">summary</th>
                <th scope="col">cursor</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.eventId} data-testid="event-row">
                  <td>{formatTime(e.occurredAt)}</td>
                  <td>
                    <StatusMark state={e.eventType} tone={toneOfEvent(e.eventType)}>
                      {stateWord(e.eventType)}
                    </StatusMark>
                  </td>
                  {/* A failure's reason is the row's most important fact: it wraps instead of being cut. */}
                  <td title={e.summary} className={toneOfEvent(e.eventType) === "fail" ? s.wrap : undefined}>
                    {shownSummary(e)}
                  </td>
                  <td>{e.eventCursor === undefined ? "" : e.eventCursor}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
