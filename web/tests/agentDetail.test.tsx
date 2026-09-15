/**
 * Agent Detail (spec 15.1 screen 2): renders the API's read model — work with
 * lineage, read-only permissions, per-unit usage, context lineage, outputs,
 * recent actions — and its one control, the agent-scope emergency stop.
 */
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentDetail } from "../lib/api";

const { getAgentDetail, engageAgentStop, liftAgentStop } = vi.hoisted(() => ({
  getAgentDetail: vi.fn(),
  engageAgentStop: vi.fn(),
  liftAgentStop: vi.fn(),
}));

vi.mock("../lib/api", () => ({ getAgentDetail, engageAgentStop, liftAgentStop }));

import AgentDetailPage from "../app/agents/[id]/page";

const base: AgentDetail = {
  agent: { id: "agent-1", name: "Publisher", version: 2, role: "Publishing Reviewer", objective: "Publish reports." },
  activeStop: null,
  grants: [
    {
      id: "grant-1",
      capabilityId: "cap-1",
      capabilityName: "publish.report",
      permissions: ["PUBLISH"],
      autonomyState: "ALWAYS_APPROVE",
      maxTrustLevelRequired: 1,
      revoked: false,
    },
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
  performance: [],
};

async function renderPage() {
  await act(async () => {
    render(
      <Suspense fallback={<p>suspended</p>}>
        <AgentDetailPage params={Promise.resolve({ id: "agent-1" })} />
      </Suspense>
    );
  });
}

beforeEach(() => {
  getAgentDetail.mockReset();
  engageAgentStop.mockReset();
  liftAgentStop.mockReset();
});

describe("Agent Detail page", () => {
  it("renders work with lineage, read-only permissions, per-unit usage, context, outputs and actions", async () => {
    getAgentDetail.mockResolvedValue(base);
    await renderPage();

    expect(await screen.findByRole("heading", { name: "Publisher v2" })).toBeInTheDocument();
    expect(getAgentDetail).toHaveBeenCalledWith("agent-1");

    const run = screen.getByTestId("agent-run");
    expect(screen.getByRole("link", { name: "Compare EV batteries" })).toHaveAttribute("href", "/workflows/wr-1");
    expect(run).toHaveTextContent("latest #1 tool awaiting_approval");

    expect(screen.getByTestId("agent-grants")).toHaveTextContent("publish.report: PUBLISH · ALWAYS_APPROVE");
    // Read-only: no control acts on grants.
    expect(screen.queryByRole("button", { name: /grant|revoke/i })).not.toBeInTheDocument();

    const usage = screen.getByTestId("agent-usage");
    expect(usage).toHaveTextContent("subscription_tokens: 1050 consumed");
    expect(usage).toHaveTextContent("usd: 0.05 consumed (0.05 reserved)");

    expect(screen.getByTestId("agent-context")).toHaveTextContent("~180 of 1000 input tokens");
    expect(screen.getByTestId("agent-context")).toHaveTextContent("art-9: stale");
    expect(screen.getByTestId("agent-outputs")).toHaveTextContent("report · 42 bytes");
    expect(screen.getByTestId("agent-events")).toHaveTextContent("approval_required");
    expect(screen.getByText(/performance projection has not been built/)).toBeInTheDocument();
  });

  it("Stop agent engages the agent-scope stop with the reason, then shows it as stopped", async () => {
    getAgentDetail
      .mockResolvedValueOnce(base)
      .mockResolvedValue({ ...base, activeStop: { id: "s-1", scope: "agent_definition", scopeRefId: "agent-1", reason: "maintenance", engagedAt: "t" } });
    engageAgentStop.mockResolvedValueOnce(undefined);
    await renderPage();
    await screen.findByRole("heading", { name: "Publisher v2" });

    fireEvent.change(screen.getByLabelText("Reason (optional)"), { target: { value: " maintenance " } });
    fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));

    await waitFor(() => expect(engageAgentStop).toHaveBeenCalledWith("agent-1", "maintenance"));
    expect(await screen.findByText("Stopped: maintenance")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lift stop" })).toBeInTheDocument();
  });

  it("Lift stop lifts it; a refused control action is shown, not swallowed", async () => {
    const stopped = { ...base, activeStop: { id: "s-1", scope: "agent_definition", scopeRefId: "agent-1", reason: null, engagedAt: "t" } };
    getAgentDetail.mockResolvedValue(stopped);
    liftAgentStop.mockRejectedValueOnce(new Error("API request failed: POST /execution-stops/lift -> 404 Not Found"));
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Lift stop" }));

    // Lifts the stop that was SHOWN, by id — never "whatever is active now".
    await waitFor(() => expect(liftAgentStop).toHaveBeenCalledWith("agent-1", "s-1"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/404/);
  });
});
