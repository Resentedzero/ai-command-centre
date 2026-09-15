"use client";

import Link from "next/link";
import { formatTime, stateWord } from "../../lib/keep";
import { isStale, useLive } from "../live";
import { PixelButton, Skeleton } from "./Pixel";
import s from "./strip.module.css";

/** Events worth pinning; the full recent list lives on the Overview board and the Events screen. */
const NOTABLE = /approval_required|_failed|execution_stop_engaged|run_halted|artifact_created/;

/** The global notice strip: the live feed's state, or the latest notable events as pinned notes. */
export function NoticeStrip() {
  const { status, events, reconnect } = useLive();
  const notable = events.filter((e) => NOTABLE.test(e.eventType));

  return (
    <footer className={s.strip} aria-label="Notices">
      {isStale(status) ? (
        <>
          <span className={s.text} role="status">
            {status === "offline"
              ? "The live feed is offline. What you see may be out of date."
              : "Reconnecting to the live feed. Missed events replay when it returns."}
          </span>
          <PixelButton onClick={reconnect}>Reconnect</PixelButton>
        </>
      ) : status === "connecting" ? (
        <span className={s.text} role="status">
          Connecting to the live feed <Skeleton />
        </span>
      ) : notable.length === 0 ? (
        <span className={s.text}>{events.length === 0 ? "Live feed connected. No events received yet." : "Live feed connected. Notable events are pinned here."}</span>
      ) : (
        notable
          .slice(-6)
          .reverse()
          .map((e) => (
            <Link key={e.eventId} href="/events" className={s.note}>
              {stateWord(e.eventType)} <span className={s.time}>{formatTime(e.occurredAt)}</span>
            </Link>
          ))
      )}
    </footer>
  );
}
