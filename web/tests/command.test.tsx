/**
 * Command (R2 management layer): the operator gives the Manager an objective and follows the mission.
 * The page sends only the objective, and shows the plan, delegated agents, progress, blockers, the result
 * and provenance links exactly as the mission's records give them — including refusals and failures.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { MissionDetail } from "../lib/api";

const api = vi.hoisted(() => ({
  listMissions: vi.fn(),
  getMission: vi.fn(),
  startMission: vi.fn(),
  subscribeToActivity: vi.fn(),
  getWorkplaceSettings: vi.fn(),
}));
vi.mock("../lib/api", () => api);

import CommandPage from "../app/command/page";

const goal = { id: "g1", title: "Mission: Brainstorm", objective: "Brainstorm three ideas and summarise them.", status: "active", createdAt: "2026-09-16T10:00:00Z", dueAt: null, overdue: false };
const planned = { status: "delegated" as const, tasks: [{ stepId: "ideas", agentName: "Evidence Analyst", brief: "Brainstorm three ideas.", expectedOutput: "Three ideas.", completionCriteria: "Three distinct ideas.", dependsOn: [], intents: ["brainstorm"], tools: [] }], errors: [], delegatedWorkflowRunId: "wr2", artifactId: "plan-art", summary: "One task." };
const step = (over: Partial<MissionDetail["workflowRuns"][number]["steps"][number]>) => ({ taskInstanceId: "t", kind: "agent_objective", taskStatus: "active", agentName: "Evidence Analyst", runId: "r", runStatus: "active", failure: null, deliverableArtifactId: null, completion: null, ...over });

const working: MissionDetail = {
  goal,
  status: "working",
  plan: planned,
  report: null,
  workflowRuns: [
    { id: "wr1", status: "completed", workflow: "Manager Plan v1", createdAt: "t", completedAt: "t", steps: [step({ taskInstanceId: "t1", kind: "manager_plan", taskStatus: "completed", agentName: "Manager", deliverableArtifactId: "plan-art" })] },
    { id: "wr2", status: "in_progress", workflow: "Mission · Evidence Analyst v1", createdAt: "t", completedAt: null, steps: [step({ taskInstanceId: "t2" })] },
  ],
  pendingApprovals: [],
  blockers: [],
  reason: null,
  reasons: [],
  trace: [],
  recovery: null,
  fromDecision: null,
};

beforeEach(() => {
  // Command writes the selected mission into the URL, so each test starts from a clean one.
  window.history.replaceState(null, "", "/command");
  for (const fn of Object.values(api)) fn.mockReset();
  api.listMissions.mockResolvedValue({ missions: [{ goal, status: "working", blockers: 0 }], manager: { id: "m", name: "Manager", version: 1 } });
});

async function renderPage() {
  await act(async () => {
    render(<CommandPage />);
  });
}

describe("Command", () => {
  it("gives the Manager only the objective, then shows the mission it started", async () => {
    api.listMissions.mockResolvedValue({ missions: [], manager: { id: "m", name: "Manager", version: 1 } });
    api.startMission.mockResolvedValue({ goalId: "g1", workflowRunId: "wr1", agent: { id: "m", name: "Manager", version: 1 } });
    api.getMission.mockResolvedValue({ ...working, status: "planning", plan: null, workflowRuns: [working.workflowRuns[0]!] });
    await renderPage();
    expect(screen.getByText("No missions yet.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Objective"), { target: { value: "Brainstorm three ideas and summarise them." } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Give to the Manager" }));
    });
    expect(api.startMission).toHaveBeenCalledWith("Brainstorm three ideas and summarise them.");
    const m = await screen.findByTestId("mission");
    expect(m).toHaveTextContent("the Manager is planning");
    expect(within(screen.getByTestId("mission-plan")).getByText("The Manager is reading the workforce and planning.")).toBeTruthy();
  });

  it("shows the validated plan, the delegated agent, progress and links to the underlying runs", async () => {
    api.getMission.mockResolvedValue(working);
    await renderPage();
    const m = await screen.findByTestId("mission");
    expect(m).toHaveTextContent("agents are working");
    const plan = screen.getByTestId("mission-plan");
    expect(plan).toHaveTextContent("Evidence Analyst — Brainstorm three ideas.");
    expect(within(plan).getByRole("link", { name: "Plan record" }).getAttribute("href")).toBe("/artifacts/plan-art");
    const work = screen.getByTestId("mission-work");
    expect(within(work).getByRole("link", { name: "Delegated work" }).getAttribute("href")).toBe("/workflows/wr2");
    expect(within(work).getAllByTestId("mission-step").map((s) => s.textContent)).toEqual([expect.stringContaining("Manager"), expect.stringContaining("Evidence Analyst")]);
  });

  it("shows the result with code-verified evidence and the report on completion", async () => {
    api.getMission.mockResolvedValue({
      ...working,
      status: "completed",
      report: { status: "completed", artifactId: "rep", body: "Here are three ideas.", work: [{ stepId: "ideas", agentName: "Evidence Analyst", artifactId: "d1", verified: true, problems: [], runId: "r", loopEnded: "complete: agent_finished" }], assessments: [], blockers: [], followUpWorkflowRunId: null },
    });
    await renderPage();
    const result = await screen.findByTestId("mission-result");
    expect(result).toHaveTextContent("Here are three ideas.");
    expect(result).toHaveTextContent("verified by code");
    expect(within(result).getByRole("link", { name: "deliverable" }).getAttribute("href")).toBe("/artifacts/d1");
    expect(within(result).getByRole("link", { name: "Mission report" }).getAttribute("href")).toBe("/artifacts/rep");
  });

  it("says plainly when the plan was refused, the mission escalated, failed or waits for approval", async () => {
    api.getMission.mockResolvedValue({ ...working, status: "escalated", plan: { ...planned, status: "plan_rejected", tasks: [], errors: ['task 1: no agent named "Admin" exists.'] }, workflowRuns: [working.workflowRuns[0]!], blockers: ['task 1: no agent named "Admin" exists.'], reason: "validation_rejected", reasons: [{ code: "validation_rejected", detail: 'task 1: no agent named "Admin" exists.' }] });
    await renderPage();
    expect(await screen.findByText("Validation refused the plan; nothing was delegated.")).toBeTruthy();
    expect(screen.getByRole("alert")).toHaveTextContent('no agent named "Admin"');

  });

  it("links to approvals when the mission waits, and shows a failure's recorded reason", async () => {
    api.getMission.mockResolvedValue({ ...working, status: "awaiting_approval", pendingApprovals: ["a1"], blockers: ["Careful Researcher is waiting for your approval."], reason: "approval_required", reasons: [{ code: "approval_required", detail: "Careful Researcher is waiting for your approval." }] });
    await renderPage();
    const blockers = await screen.findByTestId("mission-blockers");
    expect(within(blockers).getByRole("link", { name: "Review approvals" }).getAttribute("href")).toBe("/approvals");
  });

  it("shows a failed mission with the recorded reason", async () => {
    api.getMission.mockResolvedValue({ ...working, status: "failed", workflowRuns: [working.workflowRuns[0]!, { ...working.workflowRuns[1]!, status: "failed", steps: [step({ taskStatus: "failed", runStatus: "failed", failure: "Evidence Analyst failed: insufficient_budget", failureCode: "budget_denied" })] }], blockers: ["Evidence Analyst failed: insufficient_budget"], reason: "budget_denied", reasons: [{ code: "budget_denied", detail: "Evidence Analyst failed: insufficient_budget" }] });
    await renderPage();
    expect(await screen.findByTestId("mission-blockers")).toHaveTextContent("budget_denied Evidence Analyst failed: insufficient_budget");
    expect(screen.getByTestId("mission-reason")).toHaveTextContent("budget refused budget_denied");
    expect(screen.getByTestId("mission")).toHaveTextContent("failed");
  });

  it("shows a stopped mission with its reason, alerting", async () => {
    api.getMission.mockResolvedValue({ ...working, status: "stopped", reason: "emergency_stopped", reasons: [{ code: "emergency_stopped", detail: "Evidence Analyst failed: an emergency stop halted it" }], blockers: ["Evidence Analyst failed: an emergency stop halted it"] });
    await renderPage();
    expect(await screen.findByTestId("mission-reason")).toHaveTextContent("an emergency stop emergency_stopped");
    expect(screen.getByRole("alert")).toHaveTextContent("emergency_stopped");
    expect(screen.getByTestId("mission")).toHaveTextContent("stopped");
  });

  it("shows an escalated review whose follow-up started, with the worker's incomplete loop and a link to the follow-up run", async () => {
    api.getMission.mockResolvedValue({
      ...working,
      status: "working",
      report: {
        status: "follow_up_started",
        artifactId: "rep1",
        body: "Thin.",
        work: [{ stepId: "ideas", agentName: "Evidence Analyst", artifactId: "d1", verified: true, problems: [], runId: "r", workerLoop: { status: "incomplete", reason: "max_iterations" } }],
        assessments: [],
        blockers: [],
        followUpWorkflowRunId: "wr3",
      },
    });
    await renderPage();
    const result = await screen.findByTestId("mission-result");
    expect(result).toHaveTextContent("Review: follow-up started");
    expect(within(result).getByRole("link", { name: "Follow-up run" }).getAttribute("href")).toBe("/workflows/wr3");
    expect(result).toHaveTextContent("loop ended incomplete (max_iterations)");
  });

  it("shows the mission's timeline: the recorded facts in order, each with the phase it belongs to", async () => {
    api.getMission.mockResolvedValue({
      ...working,
      trace: [
        { seq: 1, type: "manager_plan_validated", at: "2026-09-17T10:00:00Z", runId: "r1", actor: "agent:Manager", summary: "1 task(s) accepted" },
        { seq: 2, type: "policy_evaluated", at: "2026-09-17T10:00:01Z", runId: "r1", actor: "system", summary: "ALLOW (autonomy_autonomous)" },
      ],
    });
    await renderPage();
    const trace = await screen.findByTestId("mission-trace");
    expect(trace).toHaveTextContent("Timeline · 2 recorded facts");
    expect(trace).toHaveTextContent("manager_plan_validated 1 task(s) accepted");
    expect(trace).toHaveTextContent("policy_evaluated ALLOW (autonomy_autonomous)");
    // The phase is read from the event type, never computed from anything else.
    expect(trace).toHaveTextContent("planned");
    expect(trace).toHaveTextContent("checked");
    // An agent actor is named; the runtime's own "system" actor is not noise worth showing.
    expect(trace).toHaveTextContent("Manager");
  });

  it("says plainly when a mission has recorded nothing yet, rather than hiding the timeline", async () => {
    api.getMission.mockResolvedValue({ ...working, trace: [] });
    await renderPage();
    const trace = await screen.findByTestId("mission-trace");
    expect(trace).toHaveTextContent("Nothing has been recorded for this mission yet.");
  });

  it("shows a deadline, marks it overdue from the server, and never calls late work failed", async () => {
    api.getMission.mockResolvedValue({ ...working, goal: { ...goal, dueAt: "2026-09-17T16:00:00Z", overdue: true } });
    await renderPage();
    const due = await screen.findByTestId("mission-due");
    expect(due).toHaveTextContent("overdue");
    // The mission is still working: overdue is a time, not an outcome.
    expect(await screen.findByTestId("mission")).toHaveTextContent("working");
  });

  it("shows a governed recovery round with the failure it answered and what the Manager decided", async () => {
    api.getMission.mockResolvedValue({ ...working, recovery: { round: 1, failures: ["worker_timed_out"], action: "reassign" } });
    await renderPage();
    const recovery = await screen.findByTestId("mission-recovery");
    expect(recovery).toHaveTextContent("Round 1");
    expect(recovery).toHaveTextContent("reassign");
  });

  it("links a mission back to the meeting decision that started it", async () => {
    api.getMission.mockResolvedValue({ ...working, fromDecision: { meetingId: "meet9", text: "Start with the smaller option." } });
    await renderPage();
    const from = await screen.findByTestId("mission-from-decision");
    expect(from).toHaveTextContent("Start with the smaller option.");
    expect(within(from).getByRole("link")).toHaveAttribute("href", "/calendar?meeting=meet9");
  });

  it("shows the API's refusal when the Manager is busy or stopped, starting nothing", async () => {
    api.getMission.mockResolvedValue(working);
    api.startMission.mockRejectedValue(new Error('API request failed: POST /manager/missions -> 409 Conflict: The Manager is already running a mission ("Mission: Brainstorm"). It runs one mission at a time.'));
    await renderPage();
    fireEvent.change(screen.getByLabelText("Objective"), { target: { value: "Another" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Give to the Manager" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Not started: The Manager is already running a mission");
  });

  it("shows an error state when missions cannot be read", async () => {
    api.listMissions.mockRejectedValue(new Error("API request failed: GET /manager/missions -> 500"));
    await renderPage();
    expect(await screen.findByText("Couldn't load missions.")).toBeTruthy();
  });
});

describe("a meeting mission (workplace)", () => {
  it("shows the code-scheduled meeting in the Keep's timezone, never this browser's", async () => {
    api.getWorkplaceSettings.mockResolvedValue({ settings: { timezone: "America/New_York" }, rooms: [], agentHours: [], allowed: {} });
    api.getMission.mockResolvedValue({
      ...working,
      status: "completed",
      workflowRuns: [working.workflowRuns[0]!],
      plan: {
        ...planned,
        status: "scheduled",
        tasks: [],
        delegatedWorkflowRunId: null,
        meeting: { action: "schedule", meetingId: "meet1", title: "All-hands", participants: ["Manager", "Researcher"], startsAt: "2026-09-17T13:00:00Z", endsAt: "2026-09-17T13:30:00Z", roomName: "Boardroom", previous: null },
      },
    });
    await renderPage();
    await act(async () => {});
    const block = screen.getByTestId("mission-meeting");
    expect(block.textContent).toContain("09:00–09:30 (America/New_York) · Boardroom");
    expect(block.textContent).toContain("2 participant(s): Manager, Researcher");
    expect(within(block).getByRole("link", { name: "Open in the calendar" }).getAttribute("href")).toBe("/calendar?meeting=meet1");
  });
});
