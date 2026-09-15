/** Events: a dense log of events the live feed delivered, newest first, filterable by type client-side, with honest feed states. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { EventDisplayItem, StreamStatus } from "../lib/api";

const api = vi.hoisted(() => ({ subscribeToActivity: vi.fn() }));
vi.mock("../lib/api", () => api);

import EventsPage from "../app/events/page";
import { LiveProvider } from "../components/live";

let onEvent: ((e: EventDisplayItem) => void) | undefined;
let onStatus: ((s: StreamStatus) => void) | undefined;

function event(cursor: number, eventType: string): EventDisplayItem {
  return { eventId: `e-${cursor}`, eventType, occurredAt: "t", sequenceNo: 1, eventCursor: cursor, summary: `${eventType} (kind=tool)` };
}

beforeEach(() => {
  api.subscribeToActivity.mockReset();
  api.subscribeToActivity.mockImplementation((_s: number | null, e: typeof onEvent, st: typeof onStatus) => {
    onEvent = e;
    onStatus = st;
    return () => {};
  });
});

async function renderPage() {
  render(
    <LiveProvider>
      <EventsPage />
    </LiveProvider>
  );
  await waitFor(() => expect(onEvent).toBeDefined());
}

describe("Events page", () => {
  it("shows connecting, then no events, as honest states", async () => {
    await renderPage();
    expect(screen.getByText(/Connecting to the live feed/)).toBeInTheDocument();
    act(() => onStatus!("live"));
    expect(screen.getByText("No events received yet.")).toBeInTheDocument();
  });

  it("lists received events newest first with type, summary and cursor, and filters by type", async () => {
    await renderPage();
    act(() => {
      onStatus!("live");
      onEvent!(event(3, "run_started"));
      onEvent!(event(4, "invocation_failed"));
      onEvent!(event(5, "run_started"));
    });

    const rows = screen.getAllByTestId("event-row");
    expect(rows.map((r) => r.textContent)).toEqual([
      // The summary drops the type the type column already shows (#36); the full summary stays in the title.
      expect.stringMatching(/run started\(kind=tool\)5$/),
      expect.stringMatching(/invocation failed\(kind=tool\)4$/),
      expect.stringMatching(/run started.*3$/),
    ]);
    expect(within(rows[1]!).getByTitle("invocation_failed (kind=tool)")).toHaveTextContent(/^\(kind=tool\)$/);
    expect(screen.getByText("3 received")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "invocation failed" }));
    expect(screen.getAllByTestId("event-row")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "all types" }));
    expect(screen.getAllByTestId("event-row")).toHaveLength(3);
  });

  it("says the feed is reconnecting and offers Reconnect", async () => {
    await renderPage();
    act(() => onStatus!("reconnecting"));
    expect(screen.getByRole("status")).toHaveTextContent(/Reconnecting to the live feed\. Missed events will be filled in when it's back\./);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(api.subscribeToActivity).toHaveBeenCalledTimes(2));
  });
});
