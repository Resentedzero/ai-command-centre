/**
 * Artifacts (spec 15.1 screen 8): per-agent browsing through AgentDetail
 * outputs (no list route), and GET /artifacts/:id with provenance, the hash
 * check, the preview as text, the full content on request, and references.
 */
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AgentDetail, ArtifactDetail, RegistryData } from "../lib/api";

const api = vi.hoisted(() => ({
  getRegistry: vi.fn(),
  listActiveAgents: vi.fn(),
  listActiveStops: vi.fn(),
  getAgentDetail: vi.fn(),
  getArtifact: vi.fn(),
}));
vi.mock("../lib/api", () => api);

import ArtifactsPage from "../app/artifacts/page";
import ArtifactPage from "../app/artifacts/[id]/page";
import { readable } from "../app/artifacts/ArtifactsScreen";

const registry: RegistryData = {
  agentDefinitions: [{ id: "agent-1", name: "Researcher", version: 1, role: "r", objective: "o", instructions: "", createdAt: "t" }],
  capabilities: [],
  capabilityGrants: [],
  taskDefinitions: [],
  workflowDefinitions: [],
};

const agent = {
  agent: { id: "agent-1", name: "Researcher", version: 1, role: "r", objective: "o" },
  activeStop: null,
  grants: [],
  runs: [],
  budgetTotals: [],
  recentEvents: [],
  outputs: [
    { id: "art-1", type: "report", size: 42, createdAt: "t", invocationId: "i-1", runId: "run-1" },
    { id: "art-2", type: "notes", size: 7, createdAt: "t", invocationId: "i-2", runId: "run-1" },
  ],
  contextLineage: null,
  performance: [],
} satisfies AgentDetail;

const artifact: ArtifactDetail = {
  artifact: {
    id: "art-1",
    type: "invocation_result",
    version: 1,
    size: 42,
    hash: "c".repeat(64),
    summary: null,
    createdAt: "t",
    storedInline: true,
    preview: "<i>draft</i> start",
    truncated: true,
    contentHashMatches: true,
  },
  producedBy: {
    invocation: { id: "i-1", kind: "llm", seqNo: 2 },
    runId: "run-1",
    agent: { id: "agent-1", name: "Researcher", version: 1 },
    taskInstanceId: "ti-1",
    taskDefinition: { id: "td-1", name: "Research-Report", version: 1 },
    workflowRunId: "wr-1",
    goal: { id: "g-1", title: "Compare EV batteries" },
  },
  referencedBy: [{ invocationId: "i-9", runId: "run-2", occurredAt: "t", kind: "artifact", tier: 2, version: 1, hash: "d".repeat(64) }],
  referencedByTruncated: false,
};

async function renderArtifact(id: string, search: { agent?: string; full?: string } = {}) {
  await act(async () => {
    render(
      <Suspense fallback={<p>suspended</p>}>
        <ArtifactPage params={Promise.resolve({ id })} searchParams={Promise.resolve(search)} />
      </Suspense>
    );
  });
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getRegistry.mockResolvedValue(registry);
  api.listActiveAgents.mockResolvedValue([]);
  api.listActiveStops.mockResolvedValue([]);
  api.getAgentDetail.mockResolvedValue(agent);
});

describe("Artifact detail", () => {
  it("renders metadata, the hash check, provenance, the preview as text, references, and the producing agent's vault", async () => {
    api.getArtifact.mockResolvedValue(artifact);
    await renderArtifact("art-1");

    expect(await screen.findByRole("heading", { name: "invocation_result v1" })).toBeInTheDocument();
    expect(api.getArtifact).toHaveBeenCalledWith("art-1", false);
    expect(screen.getByText("the content matches its hash")).toBeInTheDocument();

    // A non-document Artifact opens on Raw; provenance is the Evidence view.
    const preview = screen.getByTestId("artifact-preview");
    expect(preview).toHaveTextContent("<i>draft</i> start");
    expect(preview.querySelector("i")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Evidence" }));
    const produced = screen.getByTestId("produced-by");
    expect(within(produced).getByRole("link", { name: "Compare EV batteries" })).toHaveAttribute("href", "/workflows/wr-1");
    expect(within(produced).getByRole("link", { name: "Researcher v1" })).toHaveAttribute("href", "/agents/agent-1");
    expect(produced).toHaveTextContent("Research-Report v1");
    expect(produced).toHaveTextContent("llm #2");

    expect(screen.getByTestId("referenced-by")).toHaveTextContent("artifact · tier 2 · version 1");

    // The vault comes from the producing agent's outputs: one entry per output, the open one selected.
    await waitFor(() => expect(api.getAgentDetail).toHaveBeenCalledWith("agent-1"));
    const outputs = await screen.findAllByTestId("output");
    expect(outputs).toHaveLength(2);
    expect(outputs[0]).toHaveAttribute("aria-current", "page");
    expect(outputs[1]).toHaveAttribute("href", "/artifacts/art-2?agent=agent-1");
  });

  it("loads the whole content on request", async () => {
    api.getArtifact.mockResolvedValueOnce(artifact).mockResolvedValueOnce({ ...artifact, artifact: { ...artifact.artifact, content: "<i>draft</i> start and the rest" } });
    await renderArtifact("art-1");
    fireEvent.click(await screen.findByRole("button", { name: "Show the full content" }));
    await waitFor(() => expect(api.getArtifact).toHaveBeenLastCalledWith("art-1", true));
    expect(await screen.findByTestId("artifact-content")).toHaveTextContent("and the rest");
  });

  it("opens the full content directly with ?full=1", async () => {
    api.getArtifact.mockResolvedValue({ ...artifact, artifact: { ...artifact.artifact, content: "everything" } });
    await renderArtifact("art-1", { full: "1" });
    expect(await screen.findByTestId("artifact-content")).toHaveTextContent("everything");
    expect(api.getArtifact).toHaveBeenCalledWith("art-1", true);
  });

  it("flags a content hash mismatch and marks the content untrusted", async () => {
    api.getArtifact.mockResolvedValue({ ...artifact, artifact: { ...artifact.artifact, contentHashMatches: false } });
    await renderArtifact("art-1");
    expect(await screen.findByRole("alert")).toHaveTextContent("the content no longer matches its hash");
    expect(screen.getByText(/Untrusted/)).toBeInTheDocument();
  });

  it("says an artifact was not found, with Retry", async () => {
    api.getArtifact.mockRejectedValue(new Error('API request failed: GET /artifacts/x -> 404 Not Found: No artifact found for id "x"'));
    await renderArtifact("x", { agent: "agent-1" });
    expect(await screen.findByText("This output's artifact wasn't found.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

describe("Artifacts vault index", () => {
  it("browses the first agent's outputs and says when its vault is empty", async () => {
    api.getAgentDetail.mockResolvedValue({ ...agent, outputs: [] });
    await act(async () => {
      render(
        <Suspense fallback={<p>suspended</p>}>
          <ArtifactsPage searchParams={Promise.resolve({})} />
        </Suspense>
      );
    });
    expect(await screen.findByText("Researcher v1's vault is empty.")).toBeInTheDocument();
    // Nothing to choose is never offered as a choice (#32).
    expect(screen.getByRole("heading", { name: "Empty vault" })).toBeInTheDocument();
    expect(screen.queryByText(/Choose an output/)).not.toBeInTheDocument();
  });

  it("with no agent in the URL, opens the agent with the most recent output (#48)", async () => {
    api.getRegistry.mockResolvedValue({
      ...registry,
      agentDefinitions: [
        { id: "agent-0", name: "Publisher", version: 1, role: "p", objective: "o", instructions: "", createdAt: "t" },
        ...registry.agentDefinitions,
      ],
    });
    api.getAgentDetail.mockImplementation(async (id: string) =>
      id === "agent-1" ? agent : { ...agent, agent: { ...agent.agent, id, name: "Publisher" }, outputs: [] }
    );
    await act(async () => {
      render(
        <Suspense fallback={<p>suspended</p>}>
          <ArtifactsPage searchParams={Promise.resolve({})} />
        </Suspense>
      );
    });
    expect(await screen.findAllByTestId("output")).toHaveLength(2);
    expect(screen.getByText("Choose an output to read it and see where it came from.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Researcher v1/ })).toHaveAttribute("aria-current", "page");
  });

  it("with the roster unreadable, says so instead of asking for choices (#38)", async () => {
    api.getRegistry.mockRejectedValue(new Error("API request failed: GET /registry -> 500 Internal Server Error"));
    await act(async () => {
      render(
        <Suspense fallback={<p>suspended</p>}>
          <ArtifactsPage searchParams={Promise.resolve({})} />
        </Suspense>
      );
    });
    expect(await screen.findByText("Couldn't load the roster.")).toBeInTheDocument();
    expect(screen.getAllByText("The roster couldn't be read.")).toHaveLength(2);
    expect(screen.queryByText(/Choose an/)).not.toBeInTheDocument();
  });
});

describe("readable preview (#51)", () => {
  it("indents JSON as text and leaves everything else as stored", () => {
    expect(readable('{"a":[1,"<b>"]}')).toBe('{\n  "a": [\n    1,\n    "<b>"\n  ]\n}');
    expect(readable('{"a":1', true)).toBe('{"a":1');
    expect(readable('{"a":1}', true)).toBe('{"a":1}');
    expect(readable("plain words")).toBe("plain words");
    expect(readable("42")).toBe("42");
  });
});
