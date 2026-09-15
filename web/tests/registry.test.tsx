/** Registry (spec 15.1 screen 6): every Definition from GET /registry, read-only, one key per grant. */
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { RegistryData } from "../lib/api";

const api = vi.hoisted(() => ({ getRegistry: vi.fn(), listActiveAgents: vi.fn(), listActiveStops: vi.fn() }));
vi.mock("../lib/api", () => api);

import RegistryPage from "../app/registry/page";

const registry: RegistryData = {
  agentDefinitions: [
    { id: "a-1", name: "Researcher", version: 1, role: "Research", objective: "o", instructions: "", createdAt: "t" },
    { id: "a-2", name: "Publisher", version: 1, role: "Publish", objective: "o", instructions: "", createdAt: "t" },
  ],
  capabilities: [
    {
      id: "c-1",
      name: "research.retrieve",
      description: "Retrieve sources",
      staticRiskTag: "low",
      costProfile: null,
      toolBindings: [{ id: "b-1", kind: "internal", version: 1, trustLevel: 1, internalFunction: "retrieveSources" }],
    },
  ],
  capabilityGrants: [
    { id: "g-1", agentDefinitionId: "a-1", agentDefinitionVersion: 1, capabilityId: "c-1", permissions: ["READ"], autonomyState: "AUTONOMOUS", maxTrustLevelRequired: 1, scope: null, createdAt: "t", revokedAt: null },
    { id: "g-2", agentDefinitionId: "a-1", agentDefinitionVersion: 1, capabilityId: "c-1", permissions: ["READ"], autonomyState: "ALWAYS_APPROVE", maxTrustLevelRequired: 2, scope: null, createdAt: "t", revokedAt: "t2" },
    { id: "g-3", agentDefinitionId: "a-2", agentDefinitionVersion: 1, capabilityId: "c-1", permissions: ["PUBLISH"], autonomyState: "ALWAYS_APPROVE", maxTrustLevelRequired: 1, scope: null, createdAt: "t", revokedAt: null },
  ],
  taskDefinitions: [{ id: "t-1", name: "Research-Report", kind: "research", version: 1, planRegistered: false }],
  workflowDefinitions: [{ id: "w-1", name: "Research-and-Publish", version: 1, createdAt: "t" }],
};

async function renderPage(agent?: string) {
  await act(async () => {
    render(
      <Suspense fallback={<p>suspended</p>}>
        <RegistryPage searchParams={Promise.resolve(agent ? { agent } : {})} />
      </Suspense>
    );
  });
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getRegistry.mockResolvedValue(registry);
  api.listActiveAgents.mockResolvedValue([]);
  api.listActiveStops.mockResolvedValue([]);
});

describe("Registry page", () => {
  it("shows the selected agent's grants as numbered keys, every definition, and no controls", async () => {
    await renderPage();

    expect(await screen.findByRole("heading", { name: "Registry · Researcher v1" })).toBeInTheDocument();
    const grants = screen.getAllByTestId("grant");
    expect(grants).toHaveLength(2);
    expect(grants[0]).toHaveTextContent("Key 1 · research.retrieve");
    expect(grants[0]).toHaveTextContent("READ · AUTONOMOUS · trust ≥ 1");
    expect(grants[1]).toHaveTextContent("revoked");
    expect(screen.getByTestId("read-only")).toHaveTextContent("Read-only");
    expect(screen.getByTestId("capability")).toHaveTextContent("internal v1 · trust 1 · retrieveSources");
    expect(screen.getByText(/no plan registered/)).toBeInTheDocument();
    expect(screen.getByText("Research-and-Publish v1")).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("selects the agent named in the query", async () => {
    await renderPage("a-2");
    expect(await screen.findByRole("heading", { name: "Registry · Publisher v1" })).toBeInTheDocument();
    expect(screen.getAllByTestId("grant")).toHaveLength(1);
  });

  it("says an unknown agent id is unknown instead of showing another agent's keys", async () => {
    await renderPage("no-such-agent");
    expect(await screen.findByText("That agent isn't in the Registry.")).toBeInTheDocument();
    expect(screen.queryByTestId("grant")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Registry" })).toBeInTheDocument();
  });

  it("shows a load failure with Retry", async () => {
    api.getRegistry.mockRejectedValue(new Error("API request failed: GET /registry -> 503 Service Unavailable"));
    await renderPage();
    expect(await screen.findByText("Couldn't load the Registry.")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Retry" }).length).toBeGreaterThan(0);
  });
});
