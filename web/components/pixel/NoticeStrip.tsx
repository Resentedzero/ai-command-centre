"use client";

import Link from "next/link";
import { formatTime, stateWord } from "../../lib/keep";
import { isStale, useLive } from "../live";
import { PixelButton, Skeleton } from "./Pixel";
import s from "./strip.module.css";

/** The global notice strip: the live feed's state, or the latest events as pinned notes. */
export function NoticeStrip() {
  const { status, events, reconnect } = useLive();

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
      ) : events.length === 0 ? (
        <span className={s.text}>No events received yet.</span>
      ) : (
        events
          .slice(-4)
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
