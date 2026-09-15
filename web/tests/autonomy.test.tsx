/**
 * V1.1 autonomous work in the UI: the Loop panel renders only the Run's recorded
 * `agent_loop_iteration_recorded` events (what the agent decided, what happened, why it
 * stopped), and "Give an objective" creates or reuses the agent's objective workflow
 * through the Registry and starts it asynchronously.
 */
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AgentDetail, RegistryData, RunTrace } from "../lib/api";

const api = vi.hoisted(() => ({
  getRunTrace: vi.fn(),
  getRegistry: vi.fn(),
  createWorkflowDefinition: vi.fn(),
  createGoal: vi.fn(),
}));
vi.mock("../lib/api", () => api);

import { LoopPanel, loopProgress, stopReasonWords } from "../components/workflows/LoopPanel";
import { DelegateObjective, objectiveWorkflowName } from "../components/agents/DelegateObjective";

const event = (sequenceNo: number, payload: Record<string, unknown>, eventType = "agent_loop_iteration_recorded") => ({
  eventId: `e${sequenceNo}`,
  eventType,
  occurredAt: "2026-09-15T10:00:00Z",
  sequenceNo,
  actor: "system",
  payload,
});

const trace: RunTrace = {
  run: { id: "run-1", status: "completed", startedAt: "t", completedAt: "t" },
  invocations: [],
  events: [
    event(1, {}, "run_started"),
    event(5, { iteration: 1, maxIterations: 12, action: { type: "think", intent: "brainstorm" }, outcome: { status: "completed" }, note: "list pain points", decisionArtifactId: "d1", resultArtifactId: "r1" }),
    event(9, { iteration: 2, maxIterations: 12, action: { type: "tool", capability: "research.retrieve" }, outcome: { status: "refused", reason: "the agent holds no Grant" }, decisionArtifactId: "d2", resultArtifactId: null }),
    event(12, { iteration: 3, maxIterations: 12, action: { type: "finish" }, outcome: { status: "finished" }, decisionArtifactId: "d3", resultArtifactId: null }),
    event(14, { iteration: null, maxIterations: 12, iterations: 3, terminal: { status: "complete", reason: "agent_finished" }, activeSeconds: 240 }),
  ],
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
});

describe("Loop panel", () => {
  it("reads progress only from loop events, in iteration order", () => {
    const p = loopProgress(trace.events)!;
    expect(p.iterations.map((i) => [i.iteration, i.action.type, i.outcome.status])).toEqual([
      [1, "think", "completed"],
      [2, "tool", "refused"],
      [3, "finish", "finished"],
    ]);
    expect(p.terminal).toMatchObject({ status: "complete", reason: "agent_finished", iterations: 3 });
    expect(loopProgress([event(1, {}, "run_started")])).toBeNull();
    expect(stopReasonWords("budget_headroom")).toMatch(/budget/);
  });

  it("shows each decision and outcome with links, and why the agent stopped", async () => {
    api.getRunTrace.mockResolvedValue(trace);
    await act(async () => {
      render(<LoopPanel runId="run-1" runStatus="completed" invocationCount={12} />);
    });
    const panel = await screen.findByTestId("loop-panel");
    expect(within(panel).getByTestId("loop-status")).toHaveTextContent("Finished");
    expect(within(panel).getByTestId("loop-status")).toHaveTextContent("after 3 of 12 iterations: the agent judged the objective met");
    const rows = within(panel).getByTestId("loop-iterations").querySelectorAll("li");
    expect(rows[0]).toHaveTextContent("thought: brainstorm");
    expect(rows[0]).toHaveTextContent("list pain points");
    expect(within(rows[0] as HTMLElement).getByRole("link", { name: "result" })).toHaveAttribute("href", "/artifacts/r1");
    expect(rows[1]).toHaveTextContent("used research.retrieve");
    expect(rows[1]).toHaveTextContent("the agent holds no Grant");
    expect(rows[2]).toHaveTextContent("decided it was finished");
  });

  it("renders nothing for a step that is not an autonomous loop", async () => {
    api.getRunTrace.mockResolvedValue({ ...trace, events: [event(1, {}, "run_started")] });
    const { container } = render(<LoopPanel runId="run-2" runStatus="completed" invocationCount={3} />);
    await waitFor(() => expect(api.getRunTrace).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("while working, says so without inventing progress", async () => {
    api.getRunTrace.mockResolvedValue({ ...trace, events: trace.events.slice(0, 2) });
    await act(async () => {
      render(<LoopPanel runId="run-1" runStatus="awaiting_approval" invocationCount={4} />);
    });
    expect(await screen.findByTestId("loop-status")).toHaveTextContent("Waiting for your approval before iteration 2 of 12 continues");
  });
});

describe("Give an objective", () => {
  const agent: AgentDetail["agent"] = { id: "arch", name: "Idea Architect", version: 2, role: "r", objective: "o" };
  const grants: AgentDetail["grants"] = [
    { id: "g1", capabilityId: "c1", capabilityName: "research.retrieve", permissions: ["READ"], autonomyState: "AUTONOMOUS", maxTrustLevelRequired: 1, revoked: false },
  ];
  const registry: RegistryData = {
    agentDefinitions: [],
    capabilities: [],
    capabilityGrants: [],
    taskDefinitions: [{ id: "t-obj", name: "Autonomous Objective", kind: "agent_objective", version: 1, planRegistered: true }],
    workflowDefinitions: [],
    builder: {
      permissions: [],
      autonomyStates: [],
      tiers: [],
      providers: [],
      thinkingIntents: ["plan", "brainstorm"],
      loopActions: [
        { capability: "research.retrieve", permission: "READ", describe: "retrieve" },
        { capability: "research.search", permission: "READ", describe: "search" },
      ],
      autonomyLimits: { maxIterations: 12, maxActiveSeconds: 900, minActiveSeconds: 60, taskInstanceBudgetCeilings: {} },
    },
  };

  it("creates the agent's objective workflow once, from its keys only, and starts the goal asynchronously", async () => {
    api.getRegistry.mockResolvedValue(registry);
    api.createWorkflowDefinition.mockResolvedValue({ id: "wf-obj", name: objectiveWorkflowName(agent), version: 1 });
    api.createGoal.mockResolvedValue({ goalId: "g", workflowRunId: "wr-5", status: "in_progress" });
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <DelegateObjective agent={agent} grants={grants} />
        </Suspense>
      );
    });
    const form = await screen.findByRole("form", { name: "Give an objective" });
    // research.search is a loop action but not one of this agent's keys, so it is not offered.
    expect(within(form).queryByText("research.search")).toBeNull();
    fireEvent.change(within(form).getByLabelText("Objective"), { target: { value: "Find AI automation opportunities for small businesses" } });
    fireEvent.change(within(form).getByLabelText("research.retrieve max calls"), { target: { value: "5" } });
    fireEvent.click(within(form).getByRole("button", { name: "Start working" }));

    await waitFor(() => expect(api.createGoal).toHaveBeenCalled());
    expect(api.createWorkflowDefinition).toHaveBeenCalledWith({
      name: "Idea Architect v2 · objective",
      graphDefinition: {
        kind: "linear",
        description: "Objectives delegated to Idea Architect v2.",
        steps: [
          {
            stepId: "objective",
            label: "Work on the objective",
            taskDefinitionId: "t-obj",
            taskDefinitionVersion: 1,
            agentDefinitionId: "arch",
            agentDefinitionVersion: 2,
            parameters: { intents: ["plan", "brainstorm"], tools: [{ capability: "research.retrieve", maxCalls: 5 }] },
          },
        ],
      },
    });
    expect(api.createGoal).toHaveBeenCalledWith("Find AI automation opportunities for small businesses", undefined, { workflowDefinitionId: "wf-obj", async: true });
    expect(await screen.findByRole("link", { name: "Watch the work" })).toHaveAttribute("href", "/workflows/wr-5");
  });

  it("reuses an unchanged objective workflow instead of creating another version", async () => {
    const graph = {
      kind: "linear" as const,
      description: "Objectives delegated to Idea Architect v2.",
      steps: [
        {
          stepId: "objective",
          label: "Work on the objective",
          taskDefinitionId: "t-obj",
          taskDefinitionVersion: 1,
          agentDefinitionId: "arch",
          agentDefinitionVersion: 2,
          parameters: { intents: ["plan", "brainstorm"], tools: [{ capability: "research.retrieve", maxCalls: 12 }] },
        },
      ],
    };
    api.getRegistry.mockResolvedValue({ ...registry, workflowDefinitions: [{ id: "wf-old", name: "Idea Architect v2 · objective", version: 1, createdAt: "t", graphDefinition: graph }] });
    api.createGoal.mockResolvedValue({ goalId: "g", workflowRunId: "wr-6", status: "in_progress" });
    await act(async () => {
      render(<DelegateObjective agent={agent} grants={grants} />);
    });
    const form = await screen.findByRole("form", { name: "Give an objective" });
    fireEvent.change(within(form).getByLabelText("Objective"), { target: { value: "Again" } });
    fireEvent.click(within(form).getByRole("button", { name: "Start working" }));
    await waitFor(() => expect(api.createGoal).toHaveBeenCalledWith("Again", undefined, { workflowDefinitionId: "wf-old", async: true }));
    expect(api.createWorkflowDefinition).not.toHaveBeenCalled();
  });
});
