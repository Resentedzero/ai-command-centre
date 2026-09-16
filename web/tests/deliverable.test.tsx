/**
 * Deliverables: a document-like Artifact opens as a readable document (Document
 * view), with Evidence (provenance, integrity, sources) and Raw (stored bytes) as
 * secondary views of the same immutable Artifact. Model output never renders as HTML.
 */
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AgentDetail, ArtifactDetail, RegistryData } from "../lib/api";
import { basisLine, parseDeliverable } from "../lib/deliverable";

const api = vi.hoisted(() => ({
  getRegistry: vi.fn(),
  listActiveAgents: vi.fn(),
  listActiveStops: vi.fn(),
  getAgentDetail: vi.fn(),
  getArtifact: vi.fn(),
}));
vi.mock("../lib/api", () => api);

import ArtifactPage from "../app/artifacts/[id]/page";

const registry: RegistryData = { agentDefinitions: [], capabilities: [], capabilityGrants: [], taskDefinitions: [], workflowDefinitions: [] };
const agent = {
  agent: { id: "agent-1", name: "Idea Architect", version: 2, role: "r", objective: "o" },
  activeStop: null,
  grants: [],
  runs: [],
  budgetTotals: [],
  recentEvents: [],
  outputs: [],
  contextLineage: null,
  performance: [],
} satisfies AgentDetail;

const deliverableContent = JSON.stringify({
  format: "deliverable/v1",
  title: "AI automation opportunities",
  summary: "Three **strong** candidates.",
  body: "## Market\n\nSmall firms lose hours.\n\n| Idea | Score |\n| --- | --- |\n| Invoicing | 8 |\n\n1. first\n2. second\n\n<script>alert(1)</script><b>raw</b>\n\n[bad](javascript:alert(1)) and `code`",
  findings: ["Admin work dominates"],
  recommendations: ["Start with invoicing"],
  sources: [{ label: "Fixture result 1", ref: "internal.local/1", origin: "fixture" }],
  completion: { status: "complete", reason: "agent_finished" },
  basis: { externalResearch: false, evidence: [{ capability: "research.retrieve", evidenceClass: "fixture", calls: 2 }], note: null },
});

function detail(content: string | null, type = "deliverable", matches: boolean | null = true): ArtifactDetail {
  return {
    artifact: {
      id: "art-9",
      type,
      version: 1,
      size: 900,
      hash: "e".repeat(64),
      summary: null,
      createdAt: "2026-09-15T10:00:00Z",
      storedInline: true,
      preview: content === null ? null : content.slice(0, 50),
      truncated: content !== null && content.length > 50,
      content,
      contentHashMatches: matches,
    },
    producedBy: {
      invocation: { id: "inv-1", kind: "deterministic", seqNo: 38 },
      runId: "run-7",
      agent: { id: "agent-1", name: "Idea Architect", version: 2 },
      taskInstanceId: "ti-1",
      taskDefinition: { id: "td-1", name: "Autonomous Objective", version: 1 },
      workflowRunId: "wr-1",
      goal: { id: "g-1", title: "Find AI automation opportunities" },
    },
    referencedBy: [],
    referencedByTruncated: false,
  };
}

async function open(id = "art-9") {
  await act(async () => {
    render(
      <Suspense fallback={<p>suspended</p>}>
        <ArtifactPage params={Promise.resolve({ id })} searchParams={Promise.resolve({})} />
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

describe("parseDeliverable", () => {
  it("reads deliverable/v1, the V1 report shape, and refuses anything else", () => {
    const d = parseDeliverable("deliverable", deliverableContent)!;
    expect(d.title).toBe("AI automation opportunities");
    expect(d.findings).toEqual(["Admin work dominates"]);
    expect(d.sources[0]).toEqual({ label: "Fixture result 1", ref: "internal.local/1", artifactId: null, origin: "fixture" });
    expect(parseDeliverable("report", JSON.stringify({ report: "# Hi" }))!.body).toBe("# Hi");
    expect(parseDeliverable("invocation_result", deliverableContent)).toBeNull();
    expect(parseDeliverable("deliverable", "{not json")).toBeNull();
    expect(parseDeliverable("deliverable", JSON.stringify({ format: "other", body: "x" }))).toBeNull();
    expect(parseDeliverable("report", JSON.stringify({ report: 3 }))).toBeNull();
  });

  it("says plainly when no external research was performed", () => {
    expect(basisLine({ externalResearch: false, evidence: [], note: null })).toBe("No external research was performed. Evidence: the model's own knowledge only.");
    expect(basisLine({ externalResearch: false, evidence: [{ capability: "research.retrieve", evidenceClass: "fixture", calls: 1 }], note: null })).toMatch(/fixture \(test\) data, not real research/);
  });
});

describe("Deliverable views", () => {
  it("opens a deliverable as a document by default: headings, tables, lists, emphasis; no raw HTML or unsafe links", async () => {
    api.getArtifact.mockResolvedValue(detail(deliverableContent));
    await open();

    const doc = await screen.findByTestId("deliverable-document");
    expect(api.getArtifact).toHaveBeenCalledWith("art-9", true);
    expect(within(doc).getByRole("heading", { name: "AI automation opportunities" })).toBeInTheDocument();
    expect(within(doc).getByRole("heading", { name: "Market" })).toBeInTheDocument();
    expect(within(doc).getByRole("table")).toHaveTextContent("Invoicing");
    expect(doc.querySelector("ol li")).toHaveTextContent("first");
    expect(doc.querySelector("strong")).toHaveTextContent("strong");
    expect(doc.querySelector("code")).toHaveTextContent("code");
    expect(doc.querySelector("script")).toBeNull();
    expect(doc.querySelector("b")).toBeNull();
    expect(doc.innerHTML).not.toContain("javascript:");
    expect(within(doc).getByRole("heading", { name: "Recommendations" })).toBeInTheDocument();
    expect(screen.getByTestId("evidence-basis")).toHaveTextContent("No external research was performed.");
    expect(screen.getByRole("tab", { name: "Document" })).toHaveAttribute("aria-selected", "true");
    expect(doc).toHaveTextContent("complete · agent_finished");
  });

  it("renders a long document whole: fenced code, a wide table and nested lists, none of it truncated", async () => {
    const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}. ${"Small firms lose hours to manual admin work. ".repeat(4)}`).join("\n\n");
    const columns = Array.from({ length: 9 }, (_, i) => `Col ${i + 1}`);
    const table = [`| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`, `| ${columns.map((_, i) => `v${i + 1}`).join(" | ")} |`].join("\n");
    const body = [
      "## Long body",
      paragraphs,
      "```ts\nconst governed = await policy.evaluate(action);\n```",
      table,
      "- outer\n  - inner one\n  - inner two",
      "The last line survives.",
    ].join("\n\n");
    expect(body.length).toBeGreaterThan(2000); // past the API's preview cap: the view must read full content
    api.getArtifact.mockResolvedValue(detail(JSON.stringify({ format: "deliverable/v1", title: "Long deliverable", summary: "s", body, findings: [], recommendations: [], sources: [] })));
    await open();

    const doc = await screen.findByTestId("deliverable-document");
    expect(doc.querySelector("pre code")).toHaveTextContent("policy.evaluate(action)");
    expect(within(doc).getAllByRole("columnheader")).toHaveLength(9);
    expect(doc.querySelector("ul ul li")).toHaveTextContent("inner one");
    expect(doc).toHaveTextContent("Paragraph 40.");
    expect(doc).toHaveTextContent("The last line survives.");
  });

  it("renders a V1 report's markdown instead of escaped JSON", async () => {
    api.getArtifact.mockResolvedValue(detail(JSON.stringify({ report: "### Executive Summary\n\n- one\n- two" }), "report"));
    await open();
    const doc = await screen.findByTestId("deliverable-document");
    expect(within(doc).getByRole("heading", { name: "Executive Summary" })).toBeInTheDocument();
    expect(within(doc).getByRole("heading", { name: "Find AI automation opportunities" })).toBeInTheDocument();
    expect(doc).not.toHaveTextContent("\\n");
  });

  it("shows provenance, sources and integrity in Evidence, and re-verifies the hash on request", async () => {
    api.getArtifact.mockResolvedValue(detail(deliverableContent));
    await open();
    await screen.findByTestId("deliverable-document");

    fireEvent.click(screen.getByRole("tab", { name: "Evidence" }));
    const integrity = screen.getByTestId("integrity");
    expect(integrity).toHaveTextContent("e".repeat(64));
    expect(screen.getByTestId("produced-by")).toHaveTextContent("run-7");
    expect(screen.getByTestId("produced-by")).toHaveTextContent("deterministic #38");
    expect(screen.getByTestId("sources")).toHaveTextContent("research.retrieve");
    expect(screen.getByTestId("sources")).toHaveTextContent("fixture · 2 calls");

    const calls = api.getArtifact.mock.calls.length;
    fireEvent.click(within(integrity).getByRole("button", { name: "Verify integrity" }));
    await waitFor(() => expect(api.getArtifact.mock.calls.length).toBe(calls + 1));
    expect(await screen.findByTestId("verified")).toHaveTextContent("the stored bytes match the hash");
  });

  it("shows the stored JSON in Raw", async () => {
    api.getArtifact.mockResolvedValue(detail(deliverableContent));
    await open();
    await screen.findByTestId("deliverable-document");
    fireEvent.click(screen.getByRole("tab", { name: "Raw" }));
    expect(screen.getByTestId("artifact-content")).toHaveTextContent('"format": "deliverable/v1"');
    expect(screen.queryByTestId("deliverable-document")).toBeNull();
  });

  it("marks a document whose bytes no longer match their hash as untrusted", async () => {
    api.getArtifact.mockResolvedValue(detail(deliverableContent, "deliverable", false));
    await open();
    await screen.findByTestId("deliverable-document");
    expect(screen.getAllByText(/Untrusted: this content does not match its stored hash/).length).toBeGreaterThan(0);
  });

  it("says when a document type's content isn't a readable document", async () => {
    api.getArtifact.mockResolvedValue(detail(JSON.stringify({ nope: true })));
    await open();
    expect(await screen.findByText("This content isn't a readable document.")).toBeInTheDocument();
  });
});
