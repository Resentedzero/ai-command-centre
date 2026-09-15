/**
 * Agents (spec 15.1 screen 2): roster from the Registry joined with active runs,
 * the agent's read model with lineage, read-only keys, per-unit usage, context,
 * outputs, actions and measured performance, and its one control, the stop.
 */
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AgentDetail, RegistryData } from "../lib/api";

const api = vi.hoisted(() => ({
  getAgentDetail: vi.fn(),
  engageAgentStop: vi.fn(),
  liftAgentStop: vi.fn(),
  getRegistry: vi.fn(),
  listActiveAgents: vi.fn(),
  listActiveStops: vi.fn(),
}));

vi.mock("../lib/api", () => api);

import AgentDetailPage from "../app/agents/[id]/page";
import AgentsPage from "../app/agents/page";

const registry: RegistryData = {
  agentDefinitions: [
    { id: "agent-1", name: "Publisher", version: 2, role: "Publishing Reviewer", objective: "Publish reports.", instructions: "", createdAt: "t" },
    { id: "agent-9", name: "Researcher", version: 1, role: "Research", objective: "Research.", instructions: "", createdAt: "t" },
  ],
  capabilities: [],
  capabilityGrants: [],
  taskDefinitions: [{ id: "td-1", name: "Review-and-Publish", kind: "publish", version: 1, planRegistered: true }],
  workflowDefinitions: [],
};

const base: AgentDetail = {
  agent: { id: "agent-1", name: "Publisher", version: 2, role: "Publishing Reviewer", objective: "Publish reports." },
  activeStop: null,
  grants: [
    { id: "grant-1", capabilityId: "cap-1", capabilityName: "publish.report", permissions: ["PUBLISH"], autonomyState: "ALWAYS_APPROVE", maxTrustLevelRequired: 1, revoked: false },
  ],
  runs: [
    {
      runId: "run-1",
      status: "awaiting_approval",
      startedAt: "t",
      completedAt: null,
      outcomeReason: null,
      taskInstance: { id: "ti-1", status: "awaiting_approval" },
      taskDefinitionName: "Review-and-Publish",
      workflowRunId: "wr-1",
      goal: { id: "g-1", title: "Compare EV batteries" },
      latestInvocation: { seqNo: 1, kind: "tool", status: "awaiting_approval" },
    },
  ],
  budgetTotals: [
    { resourceUnit: "subscription_tokens", consumed: "1050", reserved: "0" },
    { resourceUnit: "usd", consumed: "0.05", reserved: "0.05" },
  ],
  recentEvents: [{ eventId: "e-1", eventType: "approval_required", occurredAt: "t", runId: "run-1", invocationId: "i-1", eventCursor: 9 }],
  outputs: [{ id: "art-1", type: "report", size: 42, createdAt: "t", invocationId: "i-0", runId: "run-0" }],
  contextLineage: {
    invocationId: "i-2",
    occurredAt: "t",
    intent: "synthesize",
    estimatedInputTokens: 180,
    maxInputTokens: 1000,
    included: [{ id: "ti-0", tier: 1 }],
    excluded: [{ id: "art-9", reason: "stale" }],
  },
  performance: [
    {
      taskDefinitionId: "td-1",
      modelTier: "none",
      sampleCount: 3,
      successRate: "1",
      avgRetries: "0",
      avgCost: { usd: "0.01" },
      updatedAt: "t",
      eligible: false,
      eligibilityReason: "insufficient_samples",
      minSamples: 10,
    },
  ],
};

async function renderPage(id = "agent-1") {
  await act(async () => {
    render(
      <Suspense fallback={<p>suspended</p>}>
        <AgentDetailPage params={Promise.resolve({ id })} />
      </Suspense>
    );
  });
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getRegistry.mockResolvedValue(registry);
  api.listActiveAgents.mockResolvedValue([
    { agentDefinitionId: "agent-1", agentName: "Publisher", runId: "run-1", taskInstanceId: "ti-1", taskStatus: "awaiting_approval", taskDefinitionName: null, goalTitle: null, latestActivitySummary: null },
  ]);
  api.listActiveStops.mockResolvedValue([]);
});

describe("Agent Detail", () => {
  it("renders the roster, lineage, read-only keys, per-unit usage, context, outputs, actions and performance", async () => {
    api.getAgentDetail.mockResolvedValue(base);
    await renderPage();

    expect(await screen.findByRole("heading", { name: "Publisher v2" })).toBeInTheDocument();
    expect(api.getAgentDetail).toHaveBeenCalledWith("agent-1");

    const roster = screen.getByRole("navigation", { name: "Agent roster" });
    expect(within(roster).getByRole("link", { name: /Publisher v2/ })).toHaveAttribute("aria-current", "page");
    expect(within(roster).getByRole("link", { name: /Publisher v2/ })).toHaveTextContent("awaiting approval");
    expect(within(roster).getByRole("link", { name: /Researcher v1/ })).toHaveTextContent("no active run");

    expect(screen.getByRole("link", { name: "Compare EV batteries" })).toHaveAttribute("href", "/workflows/wr-1");
    expect(screen.getByTestId("agent-run")).toHaveTextContent("latest #1 tool · awaiting approval");

    const grants = screen.getByTestId("agent-grants");
    expect(grants).toHaveTextContent("Key 1 · publish.report");
    expect(grants).toHaveTextContent("PUBLISH · ALWAYS_APPROVE · trust ≥ 1");
    // V1.1: a key can be revoked (a confirmed Registry act); keys are never granted from this board.
    expect(within(grants).getByRole("button", { name: "Revoke" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /grant/i })).not.toBeInTheDocument();

    const usage = screen.getByTestId("agent-usage");
    expect(usage).toHaveTextContent("subscription_tokens1050 consumed · 0 reserved");
    expect(usage).toHaveTextContent("usd0.05 consumed · 0.05 reserved");

    expect(screen.getByTestId("agent-context")).toHaveTextContent("~180 of 1000 input tokens");
    expect(screen.queryByTestId("agent-context-budget")).not.toBeInTheDocument();
    expect(screen.getByTestId("agent-context")).toHaveTextContent("excluded art-9: stale");
    expect(screen.getByRole("link", { name: /report · 42 bytes/ })).toHaveAttribute("href", "/artifacts/art-1");
    expect(screen.getByTestId("agent-events")).toHaveTextContent("approval required");
    // Time, type and cursor are separate cells on the shared track, so only the time can ellipsize (#37).
    expect(screen.getByTestId("agent-events").querySelector("li")?.children).toHaveLength(3);

    const performance = screen.getByTestId("agent-performance");
    expect(performance).toHaveTextContent("Review-and-Publish v1");
    expect(performance).toHaveTextContent("0.01 usd");
    // Eligibility is the API's; the copy never claims performance cannot influence routing.
    expect(performance).toHaveTextContent("not enough samples · 3 of 10");
    expect(screen.getByText(/can steer the Model Router's tier choice/)).toBeInTheDocument();
    expect(screen.queryByText(/ranks and recommends nothing/)).not.toBeInTheDocument();
  });

  it("names a Context Budget the Budget Governor tightened, with the Task's own ceiling, and nothing otherwise", async () => {
    api.getAgentDetail.mockResolvedValue({
      ...base,
      contextLineage: { ...base.contextLineage!, maxInputTokens: 900, effectiveMaxInputTokens: 750, budgetOutcome: "downgraded", taskMaxInputTokens: 1000 },
    });
    await renderPage();
    expect(await screen.findByTestId("agent-context-budget")).toHaveTextContent("budget downgraded · task ceiling 1000 input tokens");
    expect(screen.getByTestId("agent-context")).toHaveTextContent("~180 of 750 input tokens");
  });

  it("never claims no model calls: a missing context is said to be missing (#50)", async () => {
    api.getAgentDetail.mockResolvedValue({ ...base, contextLineage: null });
    await renderPage();
    expect(await screen.findByText("No compiled context recorded.")).toBeInTheDocument();
    expect(screen.queryByText(/No model calls/)).not.toBeInTheDocument();
  });

  it("says a model call's context wasn't recorded when a run's latest invocation is an llm call (#50)", async () => {
    const run = { ...base.runs[0]!, status: "failed", latestInvocation: { seqNo: 2, kind: "llm", status: "failed" } };
    api.getAgentDetail.mockResolvedValue({ ...base, runs: [run], contextLineage: null });
    await renderPage();
    expect(await screen.findByText("No context was recorded for its model calls.")).toBeInTheDocument();
  });

  it("says so when no performance has been measured", async () => {
    api.getAgentDetail.mockResolvedValue({ ...base, performance: [] });
    await renderPage();
    expect(await screen.findByText("No performance measured for this version yet.")).toBeInTheDocument();
  });

  it("Stop asks once, engages the agent-scope stop with the reason, then shows it as stopped", async () => {
    api.getAgentDetail
      .mockResolvedValueOnce(base)
      .mockResolvedValue({ ...base, activeStop: { id: "s-1", scope: "agent_definition", scopeRefId: "agent-1", reason: "maintenance", engagedAt: "t" } });
    api.engageAgentStop.mockResolvedValueOnce(undefined);
    await renderPage();
    await screen.findByRole("heading", { name: "Publisher v2" });

    fireEvent.click(screen.getByRole("button", { name: /Stop agent/ }));
    fireEvent.change(screen.getByLabelText("Reason (optional)"), { target: { value: " maintenance " } });
    fireEvent.click(screen.getByRole("button", { name: /Confirm stop/ }));

    await waitFor(() => expect(api.engageAgentStop).toHaveBeenCalledWith("agent-1", "maintenance"));
    expect(await screen.findByText(/Reason: maintenance/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lift stop" })).toBeInTheDocument();
  });

  it("Lift stop lifts the stop that was shown; a refused action is shown, not swallowed", async () => {
    const stopped = { ...base, activeStop: { id: "s-1", scope: "agent_definition", scopeRefId: "agent-1", reason: null, engagedAt: "t" } };
    api.getAgentDetail.mockResolvedValue(stopped);
    api.liftAgentStop.mockRejectedValueOnce(new Error("API request failed: POST /execution-stops/lift -> 404 Not Found"));
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Lift stop" }));
    await waitFor(() => expect(api.liftAgentStop).toHaveBeenCalledWith("agent-1", "s-1"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/404/);
  });

  it("says an unknown agent was not found, with Retry", async () => {
    api.getAgentDetail.mockRejectedValue(new Error('API request failed: GET /agents/x -> 404 Not Found: No agent definition found for id "x"'));
    await renderPage("x");
    expect(await screen.findByText("This agent wasn't found.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

describe("Agents roster page", () => {
  it("lists every Agent Definition and opens the one needing attention", async () => {
    api.getAgentDetail.mockResolvedValue(base);
    render(<AgentsPage />);
    expect(await screen.findByRole("link", { name: /Researcher v1/ })).toHaveAttribute("href", "/agents/agent-9");
    expect(await screen.findByRole("heading", { name: "Publisher v2" })).toBeInTheDocument();
    expect(api.getAgentDetail).toHaveBeenCalledWith("agent-1");
  });

  it("says a global stop refuses the agent, without offering a lift it cannot perform", async () => {
    api.listActiveStops.mockResolvedValue([{ id: "gs-1", scope: "global", scopeRefId: null, reason: "freeze" }]);
    api.getAgentDetail.mockResolvedValue(base);
    await act(async () => {
      render(
        <Suspense fallback={<p>suspended</p>}>
          <AgentDetailPage params={Promise.resolve({ id: "agent-1" })} />
        </Suspense>
      );
    });
    expect(await screen.findByText(/A global stop refuses every agent/)).toBeInTheDocument();
    expect(screen.getByTestId("stop-state")).toHaveTextContent("Reason: freeze");
    expect(screen.queryByRole("button", { name: /Lift stop|Stop agent/ })).not.toBeInTheDocument();
  });

  it("shows a roster load failure with Retry", async () => {
    api.getRegistry.mockRejectedValue(new Error("API request failed: GET /registry -> 500 Internal Server Error"));
    render(<AgentsPage />);
    expect(await screen.findByText("Couldn't load the roster.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    // Unloaded means unlit, not absent (#35): the workshop stays, with no stops warning under a missing roster (#41).
    expect(screen.getByRole("img", { name: "Workshop, state unknown" })).toBeInTheDocument();
  });
});
