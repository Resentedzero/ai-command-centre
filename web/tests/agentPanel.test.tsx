/**
 * R2 character interaction on screen: clicking a character opens a small panel beside it with its
 * real level, XP, speciality, runtime status and location; Talk sends only a message, then follows the
 * run's own records to the reply, a recorded failure or a refusal. Ambient life is never worded as work.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import type { AgentCardData } from "../lib/api";
import type { Desire, LivingWorld } from "../lib/living";

const api = vi.hoisted(() => ({
  getAgentSchedule: vi.fn(),
  getMeetingPresence: vi.fn(),
  getAgentProgression: vi.fn(),
  talkToAgent: vi.fn(),
  getWorkflowRun: vi.fn(),
  getArtifact: vi.fn(),
}));
vi.mock("../lib/api", () => api);

import { LivingAgents, PANEL_BELOW_Y, type LivingAgent } from "../components/world/LivingAgents";
import { AgentPanel, TALK_POLL_MS, statusLine } from "../components/world/AgentPanel";
import { desireFor } from "../lib/activity";

const area = (id: string, name: string, purpose: string, x: number, y: number, w: number, h: number) => ({ id, name, purpose, x, y, w, h, active: true });
const world: LivingWorld = {
  areas: [area("plaza", "Entrance plaza", "common", 200, 400, 400, 200), area("study", "Map room", "work", 0, 0, 200, 150), area("hall", "North hall", "corridor", 0, 146, 800, 260)],
  workstations: [{ id: "desk", areaId: "study", name: "Desk", activity: "think", x: 100, y: 100, active: true }],
};
const look = { character: "knight" as const, appearance: null };
const PROGRESS = {
  name: "Scholar",
  level: 4,
  xp: 3450,
  levelStartXp: 3000,
  nextLevelXp: 4000,
  awards: [],
  achievements: [],
  specialisation: { domain: "research", runs: 12 },
  domains: {},
  specialisationMinRuns: 10,
  reputation: {},
  endorsementsGiven: 0,
};
const idle: Desire = { kind: "idle" };

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  // Workplace: no meetings unless a test says so.
  api.getAgentSchedule.mockResolvedValue({ now: "2026-09-17T09:00:00Z", timezone: "Europe/London", current: null, meetings: [], entries: [], next: null });
  api.getMeetingPresence.mockResolvedValue({ now: "2026-09-17T09:00:00Z", presence: [] });
  api.getAgentProgression.mockResolvedValue(PROGRESS);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
});
afterEach(() => vi.useRealTimers());

const advance = async (ms: number) => {
  for (let t = 0; t < ms; t += 250) {
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
  }
};

function World({ rows = [] }: { rows?: AgentCardData[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const agents: LivingAgent[] = [
    { name: "Scholar", definitionIds: ["s-v1", "s-v2"], look, rows },
    { name: "Scribe", definitionIds: ["w-v1"], look, rows: [] },
  ];
  return (
    <LivingAgents
      world={world}
      agents={agents}
      stops={[]}
      selected={null}
      selectable={new Set()}
      onSelect={(name) => setOpen((o) => (o === name ? null : name))}
      panelFor={open}
      renderPanel={({ agent, desire, activityLabel, areaName }) => (
        <AgentPanel name={agent.name} agentDefinitionId={agent.definitionIds.at(-1)!} desire={desire} activityLabel={activityLabel} areaName={areaName} onClose={() => setOpen(null)} />
      )}
    />
  );
}

describe("clicking a character in the world", () => {
  it("opens a compact panel beside it with real level, XP, speciality, status and profile link, and closes it", async () => {
    render(<World />);
    await advance(250);
    // Idle agents are pressable too once the world offers panels.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Scholar:/ }));
    });
    const panel = await screen.findByTestId("agent-panel");
    expect(api.getAgentProgression).toHaveBeenCalledWith("Scholar");
    expect(within(panel).getByLabelText("Level 4")).toHaveTextContent("Lv 4");
    expect(panel).toHaveTextContent("3,450 XP");
    expect(panel).toHaveTextContent("research specialist");
    expect(within(panel).getByTestId("agent-status").textContent).toMatch(/^Idle( · (Entrance plaza|North hall))?$/);
    expect(within(panel).getByRole("link", { name: "View profile" }).getAttribute("href")).toBe("/agents/s-v2");
    expect(screen.getAllByTestId("agent-panel")).toHaveLength(1);

    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "Close Scholar" }));
    });
    expect(screen.queryByTestId("agent-panel")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Scribe:/ }));
    });
    expect(await screen.findByTestId("agent-panel")).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(screen.queryByTestId("agent-panel")).toBeNull();
  });

  it("keeps the panel inside the map near its edges and opens it below a character near the top", async () => {
    render(<World />);
    await advance(250);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Scholar:/ }));
    });
    const anchor = (await screen.findByTestId("agent-panel")).parentElement!;
    const left = parseFloat(anchor.style.left);
    expect(left).toBeGreaterThanOrEqual(170);
    expect(left).toBeLessThanOrEqual(1440 - 170);
    expect(anchor.dataset.below).toBe(String(parseFloat(anchor.style.top) < PANEL_BELOW_Y));
  });
});

describe("status is the runtime's, never the ambient simulation's", () => {
  it("words each real state and calls every ambient state idle", () => {
    expect(statusLine(idle, null, "Benches").text).toBe("Idle · Benches");
    expect(statusLine({ kind: "work", activity: "research", runIds: ["r"] }, "research", "North hall").text).toBe("Working · Research");
    expect(statusLine({ kind: "wait", runIds: ["r"] }, null, null).text).toBe("Awaiting approval");
    expect(statusLine({ kind: "paused", runIds: ["r"] }, null, null).text).toBe("Paused");
    expect(statusLine({ kind: "stopped", runIds: [] }, null, null).text).toBe("Stopped");
  });

  it("a paused workflow run is paused, not working; a talk is thinking", () => {
    const row = (over: Partial<AgentCardData>): AgentCardData => ({ agentDefinitionId: "d", agentName: "Scholar", runId: "r", taskInstanceId: "t", taskStatus: "active", taskDefinitionName: null, goalTitle: null, latestActivitySummary: null, ...over });
    expect(desireFor([row({ workflowRunStatus: "paused" })], [], ["d"]).kind).toBe("paused");
    expect(desireFor([row({ activity: { invocationKind: "llm", invocationStatus: "executing", capability: null, intent: "write", taskKind: "agent_talk" } })], [], ["d"])).toEqual({ kind: "work", activity: "think", runIds: ["r"] });
  });

  it("a real talk run shows the agent working · thinking in its panel", async () => {
    const talkRow: AgentCardData = { agentDefinitionId: "s-v2", agentName: "Scholar", runId: "r1", taskInstanceId: "t", taskStatus: "active", taskDefinitionName: "Agent Talk", goalTitle: "Scholar: hi", latestActivitySummary: null, activity: { invocationKind: "llm", invocationStatus: "executing", capability: null, intent: "write", taskKind: "agent_talk" } };
    render(<World rows={[talkRow]} />);
    await advance(250);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Scholar:/ }));
    });
    const panel = await screen.findByTestId("agent-panel");
    expect(within(panel).getByTestId("agent-status")).toHaveTextContent("Working · Thinking");
    expect(within(panel).getByRole("button", { name: "Talk to Scholar" })).toBeDisabled();
    expect(panel).toHaveTextContent("Scholar is working. Talk when it is free.");
  });
});

function Panel({ desire = idle }: { desire?: Desire }) {
  return <AgentPanel name="Scholar" agentDefinitionId="s-v2" desire={desire} activityLabel={null} areaName="Benches" onClose={() => undefined} />;
}

async function sendTalk(text: string) {
  await act(async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Talk to Scholar" }));
  });
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: text } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
  });
}

const runDetail = (status: string, extra: Record<string, unknown> = {}) => ({
  workflowRun: { id: "wr1", status, createdAt: "t", completedAt: null },
  goal: null,
  workflowDefinition: null,
  stepsUnavailableReason: null,
  steps: [{ taskDefinition: null, taskInstance: null, run: { invocations: [{ artifactIds: ["a1"] }] }, ...extra }],
});

describe("talking to an agent", () => {
  it("sends only the message, shows the real run working, then the reply with links to the full work", async () => {
    api.talkToAgent.mockResolvedValue({ goalId: "g1", workflowRunId: "wr1", agent: { id: "s-v2", name: "Scholar", version: 2 } });
    api.getWorkflowRun.mockResolvedValueOnce(runDetail("in_progress")).mockResolvedValue(runDetail("completed"));
    api.getArtifact.mockResolvedValue({ artifact: { type: "deliverable", content: JSON.stringify({ format: "deliverable/v1", title: "Scholar: ideas", summary: "", body: "Here are three ideas.", findings: [], recommendations: [], sources: [] }) } });
    render(<Panel />);
    await sendTalk("Give me three ideas");
    expect(api.talkToAgent).toHaveBeenCalledWith("s-v2", "Give me three ideas");
    expect(screen.getByRole("status")).toHaveTextContent("Scholar is working on it");
    expect(screen.getByRole("link", { name: "Watch the run" }).getAttribute("href")).toBe("/workflows/wr1");

    await advance(TALK_POLL_MS);
    expect(screen.getByRole("status")).toHaveTextContent("working on it");
    await advance(TALK_POLL_MS);
    const reply = await screen.findByTestId("agent-reply");
    expect(reply).toHaveTextContent("Here are three ideas.");
    expect(within(reply).getByRole("link", { name: "View full work" }).getAttribute("href")).toBe("/workflows/wr1");
    expect(within(reply).getByRole("link", { name: "Reply artifact" }).getAttribute("href")).toBe("/artifacts/a1");
  });

  it("says a talk failed, with the runtime's recorded reason", async () => {
    api.talkToAgent.mockResolvedValue({ goalId: "g1", workflowRunId: "wr1", agent: { id: "s-v2", name: "Scholar", version: 2 } });
    api.getWorkflowRun.mockResolvedValue(runDetail("failed", { attempts: [{ id: "r", attempt: 1, status: "failed", outcomeReason: "budget_denied", failureReason: null, errorCode: null, startedAt: "t", completedAt: "t" }] }));
    render(<Panel />);
    await sendTalk("Anything");
    await advance(TALK_POLL_MS);
    expect(await screen.findByRole("alert")).toHaveTextContent("The talk failed: budget denied.");
    expect(screen.getByRole("link", { name: "Open the run" }).getAttribute("href")).toBe("/workflows/wr1");
  });

  it("shows the API's refusal plainly when nothing was started", async () => {
    api.talkToAgent.mockRejectedValue(new Error("API request failed: POST /agents/s-v2/talk -> 409 Conflict: Scholar is waiting for an approval on \"Publish\". A talk never interrupts or runs beside it."));
    render(<Panel />);
    await sendTalk("Why are you waiting?");
    expect(screen.getByRole("alert")).toHaveTextContent('Not started: Scholar is waiting for an approval on "Publish".');
    expect(api.getWorkflowRun).not.toHaveBeenCalled();
  });

  it("offers no talk to a stopped, waiting or paused agent, and says why", () => {
    const { rerender } = render(<Panel desire={{ kind: "stopped", runIds: [] }} />);
    expect(screen.getByRole("button", { name: "Talk to Scholar" })).toBeDisabled();
    expect(screen.getByText("Scholar is stopped.")).toBeTruthy();
    rerender(<Panel desire={{ kind: "wait", runIds: ["r"] }} />);
    expect(screen.getByText("Scholar is waiting for an approval.")).toBeTruthy();
    rerender(<Panel desire={{ kind: "paused", runIds: ["r"] }} />);
    expect(screen.getByText("Scholar has paused work.")).toBeTruthy();
  });
});

describe("talking to the Manager", () => {
  it("starts a mission rather than waiting for a chat reply, and links to Command", async () => {
    api.talkToAgent.mockResolvedValue({ goalId: "g9", workflowRunId: "wr9", agent: { id: "m", name: "Manager", version: 1 }, mission: true });
    render(<AgentPanel name="Manager" agentDefinitionId="m" desire={{ kind: "idle" }} activityLabel={null} areaName="Benches" onClose={() => undefined} />);
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Talk to Manager" }));
    });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Research X and produce a report." } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    const started = screen.getByTestId("agent-mission");
    expect(started).toHaveTextContent("Mission started: Manager is planning the work");
    expect(within(started).getByRole("link", { name: "Follow it in Command" }).getAttribute("href")).toBe("/command?goal=g9");
    await advance(TALK_POLL_MS * 2);
    expect(api.getWorkflowRun).not.toHaveBeenCalled();
  });
});
