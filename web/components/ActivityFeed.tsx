"use client";

import { useEffect, useState } from "react";
import { subscribeToActivity, type EventDisplayItem } from "../lib/api";

/**
 * Subscribes to `subscribeToActivity` on mount (always starting from
 * `null` — a fresh page load has no prior sequence number to resume from)
 * and renders events oldest-to-newest, in the exact order they arrive.
 *
 * No client-side re-ordering / business logic of any kind: events are
 * appended to the end of the list as `onEvent` fires, nothing else. This is
 * correct because the server's replay-then-live design
 * (`src/api/routes/events.ts`) delivers the replay in ascending `eventCursor`
 * order — re-sorting here would be redundant at best and would risk silently
 * masking a real ordering bug at worst.
 *
 * The one thing done client-side is de-duplication by `eventId`: after a
 * reconnect the server's per-connection de-dup set starts empty, so an event
 * can be delivered twice (and would otherwise render twice, with a duplicate
 * React key). The number shown is the global `eventCursor`; the per-run
 * `sequenceNo` repeats across Runs.
 *
 * Reconnect across a dropped connection is handled entirely inside
 * `subscribeToActivity` itself (Ruling 5, `web/lib/api.ts`'s header) — this
 * component calls it exactly once and never needs to know a reconnect ever
 * happened.
 */
export function ActivityFeed() {
  const [events, setEvents] = useState<EventDisplayItem[]>([]);

  useEffect(() => {
    const unsubscribe = subscribeToActivity(null, (event) => {
      setEvents((previous) => (previous.some((e) => e.eventId === event.eventId) ? previous : [...previous, event]));
    });
    return unsubscribe;
  }, []);

  return (
    <div data-testid="activity-feed">
      <h2>Activity Feed</h2>
      {events.length === 0 ? (
        <p>No activity yet.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {events.map((event) => (
            <li key={event.eventId} data-testid="activity-item" style={{ borderBottom: "1px solid #eee", padding: "4px 0" }}>
              <span style={{ color: "#666" }}>[{event.eventCursor}]</span> {event.summary}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
