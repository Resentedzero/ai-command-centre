/**
 * Overview (spec 15.1 screen 1, Figma "Overview A5"): every value comes from a
 * mocked `lib/api` read; states are honest (loading, empty, load failed, stop).
 * The real `subscribeToActivity` reconnect contract is exercised at the bottom
 * against a fake EventSource.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import OverviewPage from "../app/page";
import { LiveProvider } from "../components/live";
import { NoticeStrip } from "../components/pixel/NoticeStrip";
import type { AgentCardData, EventDisplayItem, StreamStatus } from "../lib/api";

const api = vi.hoisted(() => ({
  listActiveAgents: vi.fn(),
  listPendingApprovals: vi.fn(),
  listActiveStops: vi.fn(),
  listGoals: vi.fn(),
  listWorkflowRuns: vi.fn(),
  getRegistry: vi.fn(),
  engageAgentStop: vi.fn(),
  liftAgentStop: vi.fn(),
  subscribeToActivity: vi.fn(),
}));

vi.mock("../lib/api", () => api);

const researcherActive: AgentCardData = {
  agentDefinitionId: "agent-1",
  agentName: "Researcher",
  runId: "run-1",
  taskInstanceId: "task-1",
  taskStatus: "active",
  taskDefinitionName: "Research-Report",
  goalTitle: "Compare EV batteries",
  latestActivitySummary: "invocation_started",
};
const publisherWaiting: AgentCardData = {
  agentDefinitionId: "agent-2",
  agentName: "Publisher",
  runId: "run-2",
  taskInstanceId: "task-2",
  taskStatus: "awaiting_approval",
  taskDefinitionName: "Review-and-Publish",
  goalTitle: null,
  latestActivitySummary: null,
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.listPendingApprovals.mockResolvedValue([]);
  api.listActiveStops.mockResolvedValue([]);
  api.listGoals.mockResolvedValue([]);
  api.listWorkflowRuns.mockResolvedValue([]);
  api.getRegistry.mockResolvedValue({ agentDefinitions: [], capabilities: [], capabilityGrants: [], taskDefinitions: [], workflowDefinitions: [] });
  api.subscribeToActivity.mockImplementation(() => () => {});
});

describe("Overview page", () => {
  it("renders one entry per active Agent Definition with its mission, selecting the one that needs attention", async () => {
    api.listActiveAgents.mockResolvedValue([researcherActive, { ...researcherActive, runId: "run-3", taskStatus: "pending" }, publisherWaiting]);
    api.listPendingApprovals.mockResolvedValue([{ id: "a-1" }]);

    render(<OverviewPage />);

    // The waiting agent is selected first; Stop sits directly under its name.
    expect(await screen.findByRole("heading", { name: "Publisher" })).toBeInTheDocument();
    const roster = screen.getByRole("group", { name: "Active agents" });
    expect(within(roster).getAllByRole("button")).toHaveLength(2);
    const run = screen.getByTestId("agent-run");
    expect(run).toHaveTextContent("Review-and-Publish");
    expect(run).toHaveTextContent("no goal");
    expect(run).toHaveTextContent("awaiting approval");
    expect(screen.getByRole("button", { name: /Stop agent/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Approvals.*1 pending/ })).toHaveAttribute("href", "/approvals");

    fireEvent.click(within(roster).getByRole("button", { name: /Researcher/ }));
    expect(screen.getByRole("heading", { name: "Researcher" })).toBeInTheDocument();
    expect(screen.getAllByTestId("agent-run")).toHaveLength(2);
    expect(screen.getAllByTestId("agent-run")[0]).toHaveTextContent("Compare EV batteries");
    expect(screen.getAllByTestId("agent-run")[0]).toHaveTextContent("latest: invocation started");
    expect(screen.getByRole("link", { name: "Open agent" })).toHaveAttribute("href", "/agents/agent-1");
    expect(screen.queryByText(/revenue/i)).not.toBeInTheDocument();
  });

  it("shows loading as dots, never sample data", () => {
    api.listActiveAgents.mockReturnValue(new Promise(() => {}));
    render(<OverviewPage />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading the keep");
    expect(screen.queryByTestId("agent-run")).not.toBeInTheDocument();
  });

  it("says nothing is running, with a way to start a goal, when no agents are active", async () => {
    api.listActiveAgents.mockResolvedValue([]);
    api.getRegistry.mockResolvedValue({
      agentDefinitions: [{ id: "a-1", name: "Researcher", version: 1, role: "r", objective: "o", instructions: "", createdAt: "t" }],
      capabilities: [],
      capabilityGrants: [],
      taskDefinitions: [],
      workflowDefinitions: [],
    });
    render(<OverviewPage />);
    expect(await screen.findByText("Nothing is running. Start a goal to run a workflow.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start a goal" })).toHaveAttribute("href", "/goals");
    // The empty board still leads into the world: every Agent Definition, with no active run.
    expect(await screen.findByRole("link", { name: /Researcher v1.*no active run/ })).toHaveAttribute("href", "/agents/a-1");
  });

  it("shows a load failure with the detail and a Retry that reads again", async () => {
    api.listActiveAgents.mockRejectedValueOnce(new Error("API request failed: GET /agents/active -> 500 Internal Server Error")).mockResolvedValue([]);
    render(<OverviewPage />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load the keep.");
    expect(alert).toHaveTextContent("500");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Nothing is running. Start a goal to run a workflow.")).toBeInTheDocument();
    expect(api.listActiveAgents).toHaveBeenCalledTimes(2);
  });

  it("shows an engaged stop as stopped and lifts the stop it showed", async () => {
    api.listActiveAgents.mockResolvedValue([researcherActive]);
    api.listActiveStops.mockResolvedValue([{ id: "s-1", scope: "agent_definition", scopeRefId: "agent-1", reason: "maintenance" }]);
    api.liftAgentStop.mockResolvedValue(undefined);
    render(<OverviewPage />);

    expect(await screen.findByText("Reason: maintenance")).toBeInTheDocument();
    expect(screen.getAllByText("stopped").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Lift stop" }));
    await waitFor(() => expect(api.liftAgentStop).toHaveBeenCalledWith("agent-1", "s-1"));
  });

  it("Stop asks for confirmation, then engages the agent-scope stop", async () => {
    api.listActiveAgents.mockResolvedValue([researcherActive]);
    api.engageAgentStop.mockRejectedValueOnce(new Error("API request failed: POST /execution-stops -> 400 Bad Request"));
    render(<OverviewPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Stop agent/ }));
    expect(api.engageAgentStop).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Confirm stop/ }));
    await waitFor(() => expect(api.engageAgentStop).toHaveBeenCalledWith("agent-1", undefined));
    expect(await screen.findByText(/400 Bad Request/)).toBeInTheDocument();
  });

  it("lists recent live events newest first, once each", async () => {
    api.listActiveAgents.mockResolvedValue([]);
    let onEvent: ((e: EventDisplayItem) => void) | undefined;
    api.subscribeToActivity.mockImplementation((since: number | null, cb: (e: EventDisplayItem) => void) => {
      expect(since).toBeNull();
      onEvent = cb;
      return () => {};
    });

    render(
      <LiveProvider>
        <OverviewPage />
      </LiveProvider>
    );
    await waitFor(() => expect(onEvent).toBeDefined());

    act(() => {
      onEvent!({ eventId: "e-5", eventType: "run_started", occurredAt: "t", sequenceNo: 5, eventCursor: 5, summary: "" });
      onEvent!({ eventId: "e-3", eventType: "invocation_proposed", occurredAt: "t", sequenceNo: 3, eventCursor: 3, summary: "" });
      onEvent!({ eventId: "e-3", eventType: "invocation_proposed", occurredAt: "t", sequenceNo: 3, eventCursor: 3, summary: "" });
    });

    const items = await screen.findAllByTestId("activity-item");
    expect(items.map((el) => el.textContent)).toEqual([expect.stringMatching(/invocation proposed\s*#3/), expect.stringMatching(/run started\s*#5/)]);
  });
});

describe("Notice strip", () => {
  it("shows a dropped feed as reconnecting and Reconnect resumes from the highest cursor seen", async () => {
    let onEvent: ((e: EventDisplayItem) => void) | undefined;
    let onStatus: ((s: StreamStatus) => void) | undefined;
    api.subscribeToActivity.mockImplementation((_since: number | null, e: typeof onEvent, s: typeof onStatus) => {
      onEvent = e;
      onStatus = s;
      return () => {};
    });

    render(
      <LiveProvider>
        <NoticeStrip />
      </LiveProvider>
    );
    await waitFor(() => expect(onStatus).toBeDefined());
    expect(screen.getByRole("status")).toHaveTextContent("Connecting to the live feed");

    act(() => {
      onStatus!("live");
      onEvent!({ eventId: "e-9", eventType: "invocation_failed", occurredAt: "t", sequenceNo: 1, eventCursor: 9, summary: "" });
      onEvent!({ eventId: "e-4", eventType: "run_started", occurredAt: "t", sequenceNo: 1, eventCursor: 4, summary: "" });
    });
    // Only notable events are pinned.
    expect(screen.getByRole("link", { name: /invocation failed/ })).toHaveAttribute("href", "/events");
    expect(screen.queryByRole("link", { name: /run started/ })).not.toBeInTheDocument();

    act(() => onStatus!("reconnecting"));
    expect(screen.getByRole("status")).toHaveTextContent("Reconnecting to the live feed");
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(api.subscribeToActivity).toHaveBeenCalledTimes(2));
    expect(api.subscribeToActivity.mock.calls[1]![0]).toBe(9);
  });
});

describe("subscribeToActivity reconnect (Ruling 5) -- real implementation, mocked EventSource", () => {
  type FakeEventSourceInstance = {
    url: string;
    closed: boolean;
    onopen: (() => void) | null;
    onmessage: ((e: MessageEvent) => void) | null;
    onerror: (() => void) | null;
  };

  let instances: FakeEventSourceInstance[];
  let originalEventSource: typeof EventSource | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    instances = [];
    originalEventSource = (globalThis as { EventSource?: typeof EventSource }).EventSource;

    class FakeEventSource implements FakeEventSourceInstance {
      url: string;
      closed = false;
      onopen: (() => void) | null = null;
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
    vi.useRealTimers();
  });

  /** `eventCursor` defaults to `sequenceNo` (a single run, where the two coincide). */
  function emit(instance: FakeEventSourceInstance, sequenceNo: number, eventCursor: number = sequenceNo): void {
    instance.onmessage?.({
      data: JSON.stringify({ eventId: `e-${eventCursor}`, eventType: "test.event", occurredAt: "t", sequenceNo, eventCursor, payload: {} }),
    } as MessageEvent);
  }

  it("opens a NEW EventSource with sinceEventCursor=7 (the last cursor actually seen) after the connection drops", async () => {
    const real = await vi.importActual<typeof import("../lib/api")>("../lib/api");

    const received: EventDisplayItem[] = [];
    const unsubscribe = real.subscribeToActivity(null, (e) => received.push(e));

    expect(instances).toHaveLength(1);
    expect(instances[0]!.url).toContain("sinceEventCursor=0");
    for (let seq = 1; seq <= 7; seq++) emit(instances[0]!, seq);
    expect(received).toHaveLength(7);

    instances[0]!.onerror?.();
    expect(instances[0]!.closed).toBe(true);
    expect(instances).toHaveLength(1); // waits out the backoff
    vi.advanceTimersByTime(real.RECONNECT_BASE_MS);
    expect(instances).toHaveLength(2);
    expect(instances[1]!.url).toContain("sinceEventCursor=7");

    unsubscribe();
    expect(instances[1]!.closed).toBe(true);
  });

  it("tracks the MAXIMUM cursor seen, not the last one received, when events arrive out of cursor order", async () => {
    const real = await vi.importActual<typeof import("../lib/api")>("../lib/api");
    const received: EventDisplayItem[] = [];
    const unsubscribe = real.subscribeToActivity(null, (e) => received.push(e));

    emit(instances[0]!, 1, 5);
    emit(instances[0]!, 2, 9);
    emit(instances[0]!, 3, 7);
    expect(received.map((e) => e.eventCursor)).toEqual([5, 9, 7]);

    instances[0]!.onerror?.();
    vi.advanceTimersByTime(real.RECONNECT_BASE_MS);
    expect(instances[1]!.url).toContain("sinceEventCursor=9");
    unsubscribe();
  });

  it("resumes from eventCursor, never from the per-run sequenceNo, when the two diverge", async () => {
    const real = await vi.importActual<typeof import("../lib/api")>("../lib/api");
    const unsubscribe = real.subscribeToActivity(null, () => {});

    emit(instances[0]!, 1, 11);
    emit(instances[0]!, 2, 12);
    emit(instances[0]!, 3, 13);
    instances[0]!.onerror?.();
    vi.advanceTimersByTime(real.RECONNECT_BASE_MS);
    expect(instances[1]!.url).toContain("sinceEventCursor=13");
    unsubscribe();
  });

  it("backs off exponentially on consecutive failures, resets after a healthy message, caps the delay, and never reconnects after unsubscribe", async () => {
    const real = await vi.importActual<typeof import("../lib/api")>("../lib/api");
    const unsubscribe = real.subscribeToActivity(null, () => {});

    let expectedDelay = real.RECONNECT_BASE_MS;
    for (let attempt = 1; attempt <= 3; attempt++) {
      instances[instances.length - 1]!.onerror?.();
      vi.advanceTimersByTime(expectedDelay - 1);
      expect(instances).toHaveLength(attempt);
      vi.advanceTimersByTime(1);
      expect(instances).toHaveLength(attempt + 1);
      expectedDelay *= 2;
    }

    emit(instances[instances.length - 1]!, 1, 1);
    instances[instances.length - 1]!.onerror?.();
    vi.advanceTimersByTime(real.RECONNECT_BASE_MS);
    expect(instances).toHaveLength(5);

    for (let i = 0; i < 10; i++) {
      instances[instances.length - 1]!.onerror?.();
      vi.advanceTimersByTime(real.RECONNECT_MAX_MS);
    }
    expect(instances).toHaveLength(15);

    instances[instances.length - 1]!.onerror?.();
    unsubscribe();
    vi.advanceTimersByTime(real.RECONNECT_MAX_MS * 2);
    expect(instances).toHaveLength(15);
  });

  it("reports connection status: connecting, live on open, reconnecting on a drop, live again on a message", async () => {
    const real = await vi.importActual<typeof import("../lib/api")>("../lib/api");
    const statuses: StreamStatus[] = [];
    const unsubscribe = real.subscribeToActivity(null, () => {}, (s) => statuses.push(s));

    instances[0]!.onopen?.();
    instances[0]!.onerror?.();
    vi.advanceTimersByTime(real.RECONNECT_BASE_MS);
    emit(instances[1]!, 1, 1);
    expect(statuses).toEqual(["connecting", "live", "reconnecting", "connecting", "live"]);
    unsubscribe();
  });
});
