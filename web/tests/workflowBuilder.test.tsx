/**
 * Workflow Builder (V1.1): a linear composer over the Registry. Steps are added,
 * reordered and removed; each kind shows its own parameters; later steps take
 * explicitly selected earlier outputs; Check is a dry run; Save creates a version;
 * a saved workflow starts asynchronously.
 */
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { RegistryData } from "../lib/api";

const api = vi.hoisted(() => ({
  getRegistry: vi.fn(),
  createWorkflowDefinition: vi.fn(),
  validateWorkflowDefinition: vi.fn(),
  createGoal: vi.fn(),
}));
vi.mock("../lib/api", () => api);

import NewWorkflowPage from "../app/workflows/new/page";

const registry: RegistryData = {
  agentDefinitions: [
    { id: "res", name: "Researcher", version: 1, role: "Research Analyst", objective: "o", instructions: "i", createdAt: "t" },
    { id: "ana", name: "Analyst", version: 2, role: "Analyst", objective: "o", instructions: "i", createdAt: "t" },
    { id: "rev", name: "Reviewer", version: 1, role: "Approval gate", objective: "o", instructions: "i", createdAt: "t" },
  ],
  capabilities: [{ id: "cap-chk", name: "review.checkpoint", description: null, staticRiskTag: "medium", costProfile: null, toolBindings: [] }],
  capabilityGrants: [
    { id: "g", agentDefinitionId: "rev", agentDefinitionVersion: 1, capabilityId: "cap-chk", permissions: ["EXECUTE"], autonomyState: "ALWAYS_APPROVE", maxTrustLevelRequired: 1, scope: {}, createdAt: "t", revokedAt: null },
  ],
  taskDefinitions: [
    { id: "t-research", name: "Research-Report", kind: "research_report", version: 1, planRegistered: true },
    { id: "t-agent", name: "Agent Task", kind: "agent_task", version: 1, planRegistered: true },
    { id: "t-gate", name: "Approval Gate", kind: "operator_checkpoint", version: 1, planRegistered: true },
  ],
  workflowDefinitions: [
    {
      id: "wf-1",
      name: "Pipeline",
      version: 3,
      createdAt: "t",
      graphDefinition: {
        kind: "linear",
        description: "An existing pipeline",
        steps: [
          { stepId: "research", label: "Research", taskDefinitionId: "t-research", taskDefinitionVersion: 1, agentDefinitionId: "res", agentDefinitionVersion: 1 },
          { stepId: "analyse", label: "Analyse", taskDefinitionId: "t-agent", taskDefinitionVersion: 1, agentDefinitionId: "ana", agentDefinitionVersion: 2, parameters: { instruction: "Analyse it", inputs: [{ fromStepId: "research", artifactType: "report" }] } },
        ],
      },
    },
  ],
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getRegistry.mockResolvedValue(registry);
});

async function open(search: { from?: string } = {}) {
  await act(async () => {
    render(
      <Suspense fallback={<p>suspended</p>}>
        <NewWorkflowPage searchParams={Promise.resolve(search)} />
      </Suspense>
    );
  });
  return screen.findByRole("form", { name: "Workflow Builder" });
}

describe("Workflow Builder", () => {
  it("composes research → agent task (with an explicit input) → approval gate, checks it, saves it and starts it async", async () => {
    api.validateWorkflowDefinition.mockResolvedValue({ valid: true, name: "Opportunities", version: 1 });
    api.createWorkflowDefinition.mockResolvedValue({ id: "wf-new", name: "Opportunities", version: 1 });
    api.createGoal.mockResolvedValue({ goalId: "g", workflowRunId: "wr-9", status: "in_progress" });
    const form = await open();

    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Opportunities" } });
    fireEvent.change(within(form).getByLabelText("Purpose"), { target: { value: "Find and vet opportunities" } });
    fireEvent.change(screen.getByLabelText("Step 1 label"), { target: { value: "Research" } });
    fireEvent.change(screen.getByLabelText("Step 1 agent"), { target: { value: "res" } });

    fireEvent.click(screen.getByRole("button", { name: "Add step" }));
    fireEvent.change(screen.getByLabelText("Step 2 task"), { target: { value: "t-agent" } });
    fireEvent.change(screen.getByLabelText("Step 2 agent"), { target: { value: "ana" } });
    fireEvent.change(screen.getByLabelText("Step 2 instruction"), { target: { value: "Rank the opportunities" } });
    fireEvent.click(within(screen.getByRole("group", { name: "Step 2 inputs" })).getByRole("checkbox", { name: /Research \(report\)/ }));

    fireEvent.click(screen.getByRole("button", { name: "Add step" }));
    fireEvent.change(screen.getByLabelText("Step 3 task"), { target: { value: "t-gate" } });
    fireEvent.change(screen.getByLabelText("Step 3 agent"), { target: { value: "rev" } });
    fireEvent.change(screen.getByLabelText("Step 3 question"), { target: { value: "Proceed?" } });
    expect(screen.getAllByTestId("workflow-step")[2]).toHaveTextContent("Reviewer v1");
    fireEvent.click(within(screen.getByRole("group", { name: "Step 3 inputs" })).getByRole("checkbox", { name: /Step 2 \(deliverable\)/ }));

    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByTestId("workflow-verdict")).toHaveTextContent("Every step passes");
    const input = api.validateWorkflowDefinition.mock.calls[0]![0];
    const [s1, s2, s3] = input.graphDefinition.steps;
    expect(input).toMatchObject({ name: "Opportunities", graphDefinition: { kind: "linear", description: "Find and vet opportunities" } });
    expect(s1).toMatchObject({ label: "Research", taskDefinitionId: "t-research", agentDefinitionId: "res", agentDefinitionVersion: 1 });
    expect(s1.parameters).toBeUndefined();
    expect(s2).toMatchObject({ taskDefinitionId: "t-agent", agentDefinitionVersion: 2, parameters: { instruction: "Rank the opportunities", inputs: [{ fromStepId: s1.stepId, artifactType: "report" }] } });
    expect(s3).toMatchObject({ taskDefinitionId: "t-gate", parameters: { question: "Proceed?", inputs: [{ fromStepId: s2.stepId, artifactType: "deliverable" }] } });

    fireEvent.click(screen.getByRole("button", { name: "Save workflow" }));
    expect(await screen.findByRole("heading", { name: "Opportunities v1 saved" })).toBeInTheDocument();
    expect(api.createWorkflowDefinition).toHaveBeenCalledWith(input);

    const run = screen.getByRole("form", { name: "Run this workflow" });
    fireEvent.change(within(run).getByLabelText("Goal"), { target: { value: "AI automation for small businesses" } });
    fireEvent.click(within(run).getByRole("button", { name: "Start goal" }));
    await waitFor(() => expect(api.createGoal).toHaveBeenCalledWith("AI automation for small businesses", undefined, { workflowDefinitionId: "wf-new", async: true }));
    expect(await screen.findByRole("link", { name: "Watch the run" })).toHaveAttribute("href", "/workflows/wr-9");
  });

  it("reorders and removes steps", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Step 1 label"), { target: { value: "First" } });
    fireEvent.click(screen.getByRole("button", { name: "Add step" }));
    fireEvent.change(screen.getByLabelText("Step 2 label"), { target: { value: "Second" } });
    fireEvent.click(screen.getByRole("button", { name: "Move step 2 up" }));
    expect(screen.getByLabelText("Step 1 label")).toHaveValue("Second");
    fireEvent.click(screen.getByRole("button", { name: "Remove step 1" }));
    expect(screen.getAllByTestId("workflow-step")).toHaveLength(1);
    expect(screen.getByLabelText("Step 1 label")).toHaveValue("First");
  });

  it("shows the Registry's refusal from Check without saving", async () => {
    api.validateWorkflowDefinition.mockRejectedValue(new Error("API request failed: POST /workflow-definitions?dryRun=1 -> 400 Bad Request: step 1 (agent_task): \"instruction\" must be 1 to 4000 characters."));
    const form = await open();
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Broken" } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText("The Registry refused this workflow.")).toBeInTheDocument();
    expect(screen.getByTestId("workflow-verdict")).toHaveTextContent("instruction");
    expect(api.createWorkflowDefinition).not.toHaveBeenCalled();
  });

  it("versions an existing workflow from its graph, naming the latest version", async () => {
    api.createWorkflowDefinition.mockResolvedValue({ id: "wf-4", name: "Pipeline", version: 4 });
    await open({ from: "wf-1" });
    expect(screen.getByRole("heading", { name: "New version of Pipeline" })).toBeInTheDocument();
    expect(screen.getByLabelText("Step 2 instruction")).toHaveValue("Analyse it");
    fireEvent.click(screen.getByRole("button", { name: "Save Pipeline v4" }));
    await waitFor(() => expect(api.createWorkflowDefinition).toHaveBeenCalled());
    const input = api.createWorkflowDefinition.mock.calls[0]![0];
    expect(input.previousVersion).toBe(3);
    expect(input.graphDefinition.steps.map((s: { stepId: string }) => s.stepId)).toEqual(["research", "analyse"]);
    expect(input.graphDefinition.steps[1].parameters).toEqual({ instruction: "Analyse it", inputs: [{ fromStepId: "research", artifactType: "report" }] });
  });
});
