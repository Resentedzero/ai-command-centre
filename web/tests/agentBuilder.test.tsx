/**
 * Agent Builder (V1.1): options come from `GET /registry` `builder`; a submit is one
 * Registry write with the version, its Grants and the execution profile; versioning
 * pre-fills from the chosen version and names the latest; a Keeper-style prefill only
 * fills the form. Agents board: New version, versions, and a confirmed revoke.
 */
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AgentDetail, RegistryData } from "../lib/api";

const api = vi.hoisted(() => ({
  getRegistry: vi.fn(),
  createAgentDefinition: vi.fn(),
  revokeCapabilityGrant: vi.fn(),
  listActiveAgents: vi.fn(),
  listActiveStops: vi.fn(),
  getAgentDetail: vi.fn(),
  engageAgentStop: vi.fn(),
  liftAgentStop: vi.fn(),
}));
vi.mock("../lib/api", () => api);

import NewAgentPage from "../app/agents/new/page";
import { AgentBuilder } from "../components/agents/AgentBuilder";
import { AgentsScreen } from "../app/agents/AgentsScreen";

const registry: RegistryData = {
  agentDefinitions: [
    { id: "a1", name: "Researcher", version: 1, role: "Research Analyst", objective: "Gather evidence", instructions: "Cite.", createdAt: "t", executionProfile: {} },
    { id: "a2", name: "Researcher", version: 2, role: "Research Analyst", objective: "Gather evidence", instructions: "Cite well.", createdAt: "t", executionProfile: { preferredTier: "MID", loop: { maxIterations: 6 } } },
  ],
  capabilities: [
    { id: "cap-r", name: "research.retrieve", description: "Retrieve what we hold", staticRiskTag: "low", costProfile: null, toolBindings: [] },
    { id: "cap-p", name: "publish.report", description: null, staticRiskTag: "highest", costProfile: null, toolBindings: [] },
  ],
  capabilityGrants: [
    { id: "g1", agentDefinitionId: "a1", agentDefinitionVersion: 1, capabilityId: "cap-r", permissions: ["READ"], autonomyState: "AUTONOMOUS", maxTrustLevelRequired: 1, scope: {}, createdAt: "t", revokedAt: null },
  ],
  taskDefinitions: [],
  workflowDefinitions: [],
  builder: {
    permissions: ["READ", "WRITE", "PUBLISH"],
    autonomyStates: ["ALWAYS_APPROVE", "CONDITIONAL", "AUTONOMOUS"],
    tiers: ["CHEAP", "MID", "STRONG"],
    providers: [
      { name: "claude_subscription", enabled: true, tiers: ["CHEAP", "MID", "STRONG"], resourceUnits: ["subscription_tokens"] },
      { name: "openai", enabled: false, tiers: [], resourceUnits: [] },
    ],
    autonomyLimits: { maxIterations: 12, maxActiveSeconds: 900, minActiveSeconds: 60, taskInstanceCeilings: { subscription_tokens: "50000" } },
  },
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getRegistry.mockResolvedValue(registry);
  api.listActiveAgents.mockResolvedValue([]);
  api.listActiveStops.mockResolvedValue([]);
});

async function renderBuilder(node: React.ReactNode) {
  await act(async () => {
    render(<Suspense fallback={<p>suspended</p>}>{node}</Suspense>);
  });
}

describe("Agent Builder", () => {
  it("recruits a new agent with keys and a profile in one Registry write, offering only what the runtime configures", async () => {
    api.createAgentDefinition.mockResolvedValue({ id: "new-1", name: "Idea Architect", version: 1 });
    await renderBuilder(<NewAgentPage searchParams={Promise.resolve({})} />);

    const form = await screen.findByRole("form", { name: "Agent Builder" });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Idea Architect" } });
    fireEvent.change(within(form).getByLabelText("Role"), { target: { value: "Opportunity strategist" } });
    fireEvent.change(within(form).getByLabelText("Objective"), { target: { value: "Develop ideas" } });
    fireEvent.change(within(form).getByLabelText("Instructions"), { target: { value: "Challenge assumptions." } });

    // The disabled provider is not offered.
    const providerSelect = within(form).getByLabelText("Provider");
    expect(within(providerSelect).queryByText(/openai/)).toBeNull();
    fireEvent.change(providerSelect, { target: { value: "claude_subscription" } });
    fireEvent.change(within(form).getByLabelText("Preferred tier"), { target: { value: "STRONG" } });
    fireEvent.change(within(form).getByLabelText(/Max iterations/), { target: { value: "10" } });
    fireEvent.change(within(form).getByLabelText("Max active minutes"), { target: { value: "12" } });

    const researchRow = screen.getAllByTestId("grant-row")[0]!;
    fireEvent.click(within(researchRow).getByRole("checkbox", { name: /research\.retrieve/ }));
    fireEvent.change(within(researchRow).getByLabelText("research.retrieve autonomy"), { target: { value: "AUTONOMOUS" } });

    fireEvent.click(within(form).getByRole("button", { name: "Recruit agent" }));
    await waitFor(() => expect(api.createAgentDefinition).toHaveBeenCalledTimes(1));
    expect(api.createAgentDefinition).toHaveBeenCalledWith({
      name: "Idea Architect",
      role: "Opportunity strategist",
      objective: "Develop ideas",
      instructions: "Challenge assumptions.",
      executionProfile: { preferredTier: "STRONG", provider: "claude_subscription", loop: { maxIterations: 10, maxActiveSeconds: 720 } },
      grants: [{ capabilityId: "cap-r", permissions: ["READ"], autonomyState: "AUTONOMOUS", maxTrustLevelRequired: 1 }],
    });
    expect(await screen.findByRole("link", { name: "Open Idea Architect v1" })).toHaveAttribute("href", "/agents/new-1");
  });

  it("versions an agent from the chosen version, naming the latest as previousVersion and copying its live keys", async () => {
    api.createAgentDefinition.mockResolvedValue({ id: "a3", name: "Researcher", version: 3 });
    await renderBuilder(<NewAgentPage searchParams={Promise.resolve({ from: "a1" })} />);

    expect(await screen.findByRole("heading", { name: "New version of Researcher" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Cite every claim." } });
    fireEvent.click(screen.getByRole("button", { name: "Save Researcher v3" }));

    await waitFor(() => expect(api.createAgentDefinition).toHaveBeenCalled());
    expect(api.createAgentDefinition.mock.calls[0]![0]).toMatchObject({
      name: "Researcher",
      instructions: "Cite every claim.",
      previousVersion: 2,
      grants: [{ capabilityId: "cap-r", permissions: ["READ"], autonomyState: "AUTONOMOUS", maxTrustLevelRequired: 1 }],
      executionProfile: {},
    });
  });

  it("shows the Registry's refusal and writes nothing else", async () => {
    api.createAgentDefinition.mockRejectedValue(new Error("API request failed: POST /agent-definitions -> 400 Bad Request: grants[0]: AUTONOMOUS is not allowed for PUBLISH"));
    await renderBuilder(<AgentBuilder prefill={{ name: "Pub", role: "r", objective: "o", instructions: "i", grants: [{ capabilityName: "publish.report", permissions: ["PUBLISH"], autonomyState: "AUTONOMOUS" }] }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Recruit agent" }));
    expect(await screen.findByText("The Registry refused the agent.")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("AUTONOMOUS is not allowed for PUBLISH");
    expect(api.createAgentDefinition.mock.calls[0]![0].grants).toEqual([
      { capabilityId: "cap-p", permissions: ["PUBLISH"], autonomyState: "AUTONOMOUS", maxTrustLevelRequired: 1 },
    ]);
  });

  it("a prefill only fills the form: nothing is written until the operator submits", async () => {
    await renderBuilder(<AgentBuilder prefill={{ name: "Analyst", role: "Analyst", objective: "Analyse", instructions: "Be clear." }} />);
    expect(await screen.findByLabelText("Name")).toHaveValue("Analyst");
    expect(api.createAgentDefinition).not.toHaveBeenCalled();
  });
});

describe("Agents board: versions and revocation", () => {
  const detail = {
    agent: { id: "a1", name: "Researcher", version: 1, role: "Research Analyst", objective: "Gather evidence", executionProfile: {} },
    activeStop: null,
    grants: [{ id: "g1", capabilityId: "cap-r", capabilityName: "research.retrieve", permissions: ["READ"], autonomyState: "AUTONOMOUS", maxTrustLevelRequired: 1, revoked: false }],
    runs: [],
    budgetTotals: [],
    recentEvents: [],
    outputs: [],
    contextLineage: null,
    performance: [],
  } satisfies AgentDetail;

  it("links a new version, lists versions, and revokes a key only after confirmation", async () => {
    api.getAgentDetail.mockResolvedValue(detail);
    api.revokeCapabilityGrant.mockResolvedValue({ grantId: "g1", revoked: true, cancelledApprovalIds: [] });
    await renderBuilder(<AgentsScreen id="a1" />);

    expect(await screen.findByRole("link", { name: "New version" })).toHaveAttribute("href", "/agents/new?from=a1");
    await waitFor(() => expect(screen.getByTestId("agent-versions")).toHaveTextContent("v1"));
    expect(within(screen.getByTestId("agent-versions")).getByRole("link", { name: "v2" })).toHaveAttribute("href", "/agents/a2");
    expect(screen.getByTestId("agent-profile")).toHaveTextContent("runtime defaults");

    fireEvent.click(within(screen.getByTestId("agent-grants")).getByRole("button", { name: "Revoke" }));
    expect(api.revokeCapabilityGrant).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));
    await waitFor(() => expect(api.revokeCapabilityGrant).toHaveBeenCalledWith("g1"));
  });
});
