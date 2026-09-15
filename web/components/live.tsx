"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { subscribeToActivity, type EventDisplayItem, type StreamStatus } from "../lib/api";

/**
 * One event-stream subscription for the whole app (the layout persists across
 * client navigation). Everything here is client-only state: the connection
 * status of the stream, the events received this session, and a revision that
 * ticks per event so screens can re-read their REST models. The feed says
 * something changed; the read model says what.
 */
export type ConnectionStatus = StreamStatus | "offline";

/** Events kept in memory for the Events screen and notices. */
export const MAX_EVENTS = 1000;

export type Live = {
  status: ConnectionStatus;
  events: EventDisplayItem[];
  revision: number;
  reconnect: () => void;
};

const LiveContext = createContext<Live>({ status: "connecting", events: [], revision: 0, reconnect: () => {} });

export function LiveProvider({ children }: { children: ReactNode }) {
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("connecting");
  const [online, setOnline] = useState(true);
  const [events, setEvents] = useState<EventDisplayItem[]>([]);
  const [revision, setRevision] = useState(0);
  const [generation, setGeneration] = useState(0);
  const maxCursor = useRef<number | null>(null);

  useEffect(() => {
    return subscribeToActivity(
      maxCursor.current,
      (event) => {
        // An API build without `eventCursor` must not turn the resume position into NaN.
        if (Number.isFinite(event.eventCursor)) maxCursor.current = Math.max(maxCursor.current ?? 0, event.eventCursor);
        // De-duplicated by eventId: a reconnect can re-deliver an event.
        setEvents((prev) => (prev.some((e) => e.eventId === event.eventId) ? prev : [...prev, event].slice(-MAX_EVENTS)));
        setRevision((r) => r + 1);
      },
      setStreamStatus
    );
  }, [generation]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  const reconnect = useCallback(() => setGeneration((g) => g + 1), []);

  return (
    <LiveContext.Provider value={{ status: online ? streamStatus : "offline", events, revision, reconnect }}>
      {children}
    </LiveContext.Provider>
  );
}

export function useLive(): Live {
  return useContext(LiveContext);
}

/** Re-reads a REST model shortly after events arrive (debounced, so a replay burst causes one read). */
export function useRefetchOnEvents(refetch: () => void, delayMs = 600): void {
  const { revision } = useLive();
  const latest = useRef(refetch);
  latest.current = refetch;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const timer = setTimeout(() => latest.current(), delayMs);
    return () => clearTimeout(timer);
  }, [revision, delayMs]);
}

/** Loaded state stale while the feed is down: light dims to 45% (tile-pack.md, SSE offline). */
export function isStale(status: ConnectionStatus): boolean {
  return status === "reconnecting" || status === "offline";
}
