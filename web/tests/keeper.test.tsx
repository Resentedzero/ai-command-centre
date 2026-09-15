/**
 * The Keeper in the UI (V1.1): explain and look-ups call the deterministic API only;
 * Think is an explicit press that starts a governed goal and shows the answer document;
 * a proposal only becomes a pre-filled builder link (nothing is written from here).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ArtifactDetail, WorkflowRunDetail } from "../lib/api";

const api = vi.hoisted(() => ({
  keeperExplain: vi.fn(),
  keeperGuide: vi.fn(),
  askKeeper: vi.fn(),
  getWorkflowRun: vi.fn(),
  getArtifact: vi.fn(),
  createAgentDefinition: vi.fn(),
}));
vi.mock("../lib/api", () => api);
const nav = vi.hoisted(() => ({ path: "/workflows/11111111-1111-4111-8111-111111111111" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.path }));

import { KeeperDock, KeeperPanel, KeeperProvider, subjectForPath } from "../components/keeper/Keeper";

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  sessionStorage.clear();
  api.keeperExplain.mockResolvedValue({
    subject: { type: "workflow_run", id: "11111111-1111-4111-8111-111111111111" },
    headline: "This workflow run is waiting for your approval.",
    status: "in_progress",
    facts: [{ label: "agent", value: "Publisher v1" }],
    reasons: ["Why: the agent's Grant for this capability is set to ask you first (ALWAYS_APPROVE)."],
    next: [{ label: "Review approvals", href: "/approvals" }],
  });
});

async function openKeeper() {
  await act(async () => {
    render(
      <KeeperProvider>
        <KeeperDock />
        <KeeperPanel />
      </KeeperProvider>
    );
  });
  fireEvent.click(screen.getByRole("button", { name: "Ask the Keeper" }));
  return screen.findByRole("complementary", { name: "The Keeper" });
}

describe("Keeper", () => {
  it("asks about what is on screen", () => {
    expect(subjectForPath("/workflows/11111111-1111-4111-8111-111111111111")).toBe("workflow_run:11111111-1111-4111-8111-111111111111");
    expect(subjectForPath("/agents/22222222-2222-4222-8222-222222222222")).toBe("agent:22222222-2222-4222-8222-222222222222");
    expect(subjectForPath("/agents/new")).toBe("system");
    expect(subjectForPath("/")).toBe("system");
  });

  it("explains this page and looks things up without any model call", async () => {
    api.keeperGuide.mockResolvedValue([{ slug: "create-an-agent", title: "Create an agent", body: "1. Open **Agents**." }]);
    const panel = await openKeeper();
    const explanation = await within(panel).findByTestId("keeper-explanation");
    expect(api.keeperExplain).toHaveBeenCalledWith("workflow_run:11111111-1111-4111-8111-111111111111");
    expect(explanation).toHaveTextContent("This workflow run is waiting for your approval.");
    expect(explanation).toHaveTextContent("ALWAYS_APPROVE");

    fireEvent.change(within(panel).getByLabelText("Question for the Keeper"), { target: { value: "How do I create an agent?" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Look it up" }));
    const card = await within(panel).findByTestId("keeper-card");
    expect(card).toHaveTextContent("Create an agent");
    expect(card.querySelector("strong")).toHaveTextContent("Agents");
    expect(api.askKeeper).not.toHaveBeenCalled();
  });

  it("thinks only when asked, shows the answer document, and turns a proposal into a pre-filled builder link", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const content = JSON.stringify({
      format: "deliverable/v1",
      title: "Why is Publisher waiting?",
      body: "It needs **your** approval.",
      findings: ["Publisher asks first"],
      recommendations: [],
      sources: [],
      basis: { externalResearch: false, evidence: [{ capability: "system.inspect", evidenceClass: "system_state", calls: 1 }], note: null },
      proposal: { kind: "agent", name: "Analyst", role: "Analyst", objective: "Analyse", instructions: "Be precise.", capabilities: ["research.retrieve"] },
    });
    api.askKeeper.mockResolvedValue({ goalId: "g", workflowRunId: "wr-k", status: "in_progress" });
    api.getWorkflowRun.mockResolvedValue({
      workflowRun: { id: "wr-k", status: "completed" },
      steps: [{ run: { invocations: [{ artifactIds: ["a-result"] }, { artifactIds: ["a-answer"] }] } }],
    } as unknown as WorkflowRunDetail);
    api.getArtifact.mockImplementation(async (id: string) => ({ artifact: { id, type: id === "a-answer" ? "keeper_answer" : "invocation_result", content } }) as unknown as ArtifactDetail);

    const panel = await openKeeper();
    fireEvent.change(within(panel).getByLabelText("Question for the Keeper"), { target: { value: "Why is Publisher waiting?" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Think" }));
    await waitFor(() => expect(api.askKeeper).toHaveBeenCalledWith("Why is Publisher waiting?", "workflow_run:11111111-1111-4111-8111-111111111111"));
    await act(async () => {
      vi.advanceTimersByTime(2_100);
    });
    vi.useRealTimers();

    const answer = await within(panel).findByTestId("keeper-answer");
    expect(answer).toHaveTextContent("It needs your approval.");
    expect(answer).toHaveTextContent("the Command Keep's own records");
    const proposal = within(answer).getByRole("link", { name: 'Review the proposed agent "Analyst"' });
    expect(proposal.getAttribute("href")).toMatch(/^\/agents\/new\?proposal=agent-/);
    const key = proposal.getAttribute("href")!.split("proposal=")[1]!;
    expect(JSON.parse(sessionStorage.getItem(`keeper-proposal:${key}`)!)).toMatchObject({
      kind: "agent",
      value: { name: "Analyst", grants: [{ capabilityName: "research.retrieve", permissions: ["READ"], autonomyState: "ALWAYS_APPROVE" }] },
    });
    expect(api.createAgentDefinition).not.toHaveBeenCalled();
  });
});
