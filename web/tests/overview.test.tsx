/**
 * Unit 11 (task-11-brief.md) "Tests required" bullets 1-3, covered here
 * because the Overview page (`web/app/page.tsx`) is what actually renders
 * both `AgentCard`s and the `ActivityFeed`:
 *   1. Overview renders Active Agents from `listActiveAgents()`; no revenue
 *      stat when no revenue projection exists.
 *   2. Activity Feed renders events from `subscribeToActivity(null, ...)` on
 *      initial mount, oldest-to-newest, no client-side re-ordering logic.
 *   3. Reconnect test: after receiving events up through sequence 7 and a
 *      simulated dropped connection, the NEXT `EventSource` opened uses
 *      `sinceSequenceNo=7` -- not `null`/0, not some other value.
 *
 * Bullet 3's exact wording in the brief ("assert the component calls
 * subscribeToActivity(7, ...)") does not fit this codebase's actual,
 * intentional design: the `subscribeToActivity` interface is
 * `(sinceSequenceNo, onEvent) => unsubscribe` with NO "connection dropped"
 * callback exposed to the caller, and Ruling 5 explicitly assigns
 * reconnect-on-error to `subscribeToActivity`'s OWN implementation (a raw
 * `EventSource` swap internally) -- so the calling component (`ActivityFeed`)
 * has no signal to react to and, correctly, never calls `subscribeToActivity`
 * a second time itself. The substantive property the brief's
 * Codex-reviewability note actually cares about -- "the last-seen sequence
 * is actually tracked and threaded through, not merely accepted as a
 * parameter nobody calls correctly" -- is what the third test below proves,
 * at the layer where that logic really lives: it exercises the REAL
 * `subscribeToActivity` (via `vi.importActual`, bypassing this file's
 * top-level `vi.mock` of `../lib/api` for that one test) against a fake
 * global `EventSource`, and asserts the second `EventSource` instance is
 * constructed with `sinceSequenceNo=7`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import OverviewPage from "../app/page";
import type { EventDisplayItem } from "../lib/api";

const { listActiveAgents, subscribeToActivity } = vi.hoisted(() => ({
  listActiveAgents: vi.fn(),
  subscribeToActivity: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  listActiveAgents,
  subscribeToActivity,
}));

describe("Overview page", () => {
  beforeEach(() => {
    listActiveAgents.mockReset();
    subscribeToActivity.mockReset();
    subscribeToActivity.mockImplementation(() => () => {});
  });

  it("renders Active Agents from listActiveAgents(), with no revenue stat", async () => {
    listActiveAgents.mockResolvedValue([
      {
        agentDefinitionId: "agent-1",
        agentName: "Researcher",
        runId: "run-1",
        taskInstanceId: "task-1",
        taskStatus: "awaiting_approval",
        latestActivitySummary: "invocation.completed",
      },
      {
        agentDefinitionId: "agent-2",
        agentName: "Publisher",
        runId: "run-2",
        taskInstanceId: "task-2",
        taskStatus: "active",
        latestActivitySummary: null,
      },
    ]);

    render(<OverviewPage />);

    expect(await screen.findByText("Researcher")).toBeInTheDocument();
    expect(screen.getByText("Publisher")).toBeInTheDocument();
    expect(screen.getByText(/awaiting_approval/)).toBeInTheDocument();
    // No revenue stat anywhere on the page (AgentCardData has no such field
    // and AgentCard never renders one -- asserted here as a guard against
    // regression, not because there was ever a live risk of one appearing).
    expect(screen.queryByText(/revenue/i)).not.toBeInTheDocument();
  });

  it("shows a message instead of a card when no agents are active", async () => {
    listActiveAgents.mockResolvedValue([]);
    render(<OverviewPage />);
    expect(await screen.findByText("No agents are currently active.")).toBeInTheDocument();
  });

  it("Activity Feed subscribes via subscribeToActivity(null, ...) on mount and renders events oldest-to-newest with no client-side re-ordering", async () => {
    listActiveAgents.mockResolvedValue([]);
    let capturedOnEvent: ((e: EventDisplayItem) => void) | undefined;
    subscribeToActivity.mockImplementation((since: number | null, onEvent: (e: EventDisplayItem) => void) => {
      expect(since).toBeNull();
      capturedOnEvent = onEvent;
      return () => {};
    });

    render(<OverviewPage />);

    await waitFor(() => expect(capturedOnEvent).toBeDefined());

    // Deliberately delivered out of numeric sequence order (5, 3, 9) --
    // proves the feed appends in RECEIPT order only. If the component
    // re-sorted by sequenceNo, the rendered order would be 3, 5, 9 instead.
    capturedOnEvent!({ eventId: "e-5", eventType: "run.started", occurredAt: "t", sequenceNo: 5, summary: "run.started" });
    capturedOnEvent!({ eventId: "e-3", eventType: "invocation.proposed", occurredAt: "t", sequenceNo: 3, summary: "invocation.proposed" });
    capturedOnEvent!({ eventId: "e-9", eventType: "invocation.completed", occurredAt: "t", sequenceNo: 9, summary: "invocation.completed" });

    const items = await screen.findAllByTestId("activity-item");
    expect(items.map((el) => el.textContent)).toEqual([
      expect.stringContaining("run.started"),
      expect.stringContaining("invocation.proposed"),
      expect.stringContaining("invocation.completed"),
    ]);
  });
});

describe("subscribeToActivity reconnect (Ruling 5) -- real implementation, mocked EventSource", () => {
  type FakeEventSourceInstance = {
    url: string;
    closed: boolean;
    onmessage: ((e: MessageEvent) => void) | null;
    onerror: (() => void) | null;
  };

  let instances: FakeEventSourceInstance[];
  let originalEventSource: typeof EventSource | undefined;

  beforeEach(() => {
    instances = [];
    originalEventSource = (globalThis as { EventSource?: typeof EventSource }).EventSource;

    class FakeEventSource implements FakeEventSourceInstance {
      url: string;
      closed = false;
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(url: string) {
        this.url = url;
        instances.push(this);
      }
      close(): void {
        this.closed = true;
      }
    }

    (globalThis as { EventSource: unknown }).EventSource = FakeEventSource;
  });

  afterEach(() => {
    (globalThis as { EventSource: unknown }).EventSource = originalEventSource;
  });

  function emit(instance: FakeEventSourceInstance, sequenceNo: number): void {
    instance.onmessage?.({
      data: JSON.stringify({ eventId: `e-${sequenceNo}`, eventType: "test.event", occurredAt: "t", sequenceNo, payload: {} }),
    } as MessageEvent);
  }

  it("opens a NEW EventSource with sinceSequenceNo=7 (the last sequence actually seen), not null/0 and not some other value, after the connection drops", async () => {
    const real = await vi.importActual<typeof import("../lib/api")>("../lib/api");

    const received: EventDisplayItem[] = [];
    const unsubscribe = real.subscribeToActivity(null, (e) => received.push(e));

    expect(instances).toHaveLength(1);
    expect(instances[0]!.url).toContain("sinceSequenceNo=0");

    for (let seq = 1; seq <= 7; seq++) {
      emit(instances[0]!, seq);
    }
    expect(received).toHaveLength(7);
    expect(received[received.length - 1]!.sequenceNo).toBe(7);

    // Simulate a dropped connection.
    instances[0]!.onerror?.();

    expect(instances[0]!.closed).toBe(true);
    expect(instances).toHaveLength(2);
    expect(instances[1]!.url).toContain("sinceSequenceNo=7");
    expect(instances[1]!.url).not.toContain("sinceSequenceNo=0");
    expect(instances[1]!.url).not.toContain("sinceSequenceNo=null");

    unsubscribe();
    expect(instances[1]!.closed).toBe(true);
  });
});
