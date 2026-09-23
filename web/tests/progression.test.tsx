/**
 * R2 progression in the UI: the Progress card says level, XP, measured work, specialisation,
 * achievements and reputation in plain words from the API, with honest empty states and an
 * auditable ledger; the quality verdict control records the operator's judgement, never an approval.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { AgentProgression } from "../lib/api";

const api = vi.hoisted(() => ({
  getAgentProgression: vi.fn(),
  getQualityVerdicts: vi.fn(),
  recordQualityVerdict: vi.fn(),
}));
vi.mock("../lib/api", () => api);

import { Progression } from "../components/agents/Progression";
import { QualityVerdictControl } from "../components/QualityVerdict";

const agent = { id: "a1", name: "Field Researcher", version: 2, role: "r", objective: "o" };

const progression: AgentProgression = {
  name: "Field Researcher",
  level: 3,
  xp: 1450,
  levelStartXp: 1250,
  nextLevelXp: 2250,
  awards: [
    { rule: "validated_artifact", xp: 150, awardKey: "artifact:d1", runId: "r1", workflowRunId: null, goalId: null, artifactId: "d1", evidence: {}, earnedAt: "2026-09-16T10:00:00Z" },
    { rule: "capability", xp: 50, awardKey: "capability:r1:research.search", runId: "r1", workflowRunId: "wr1", goalId: "g1", artifactId: null, evidence: { capability: "research.search" }, earnedAt: "2026-09-16T10:00:00Z" },
  ],
  achievements: [
    { achievement: "verified_research", label: "First verified research result", domain: null, earnedAt: "2026-09-16T10:00:00Z", evidence: {} },
    { achievement: "seasoned:research", label: "Seasoned in a domain", domain: "research", earnedAt: "2026-09-16T11:00:00Z", evidence: {} },
  ],
  specialisation: { domain: "research", runs: 3 },
  domains: { research: 3 },
  specialisationMinRuns: 3,
  reputation: { verdicts: { POOR: 0, ACCEPTABLE: 0, GOOD: 1, EXCELLENT: 1 }, verdictCount: 2, enoughVerdicts: false, minVerdicts: 3, independentEndorsers: ["Evidence Analyst"], mutualEndorsements: 0, unverifiedEndorsements: 0 },
  endorsementsGiven: 0,
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
});

async function renderNode(node: React.ReactNode) {
  await act(async () => {
    render(node);
  });
}

describe("Progress card", () => {
  it("reads the persistent agent's progression by name and says it in plain words", async () => {
    api.getAgentProgression.mockResolvedValue(progression);
    await renderNode(<Progression agent={agent} performance={{ samples: 4, successes: 3, versions: 2 }} />);
    expect(api.getAgentProgression).toHaveBeenCalledWith("Field Researcher");
    const card = await screen.findByTestId("agent-progress");
    expect(within(card).getByLabelText("Level 3")).toBeTruthy();
    expect(card.textContent).toContain("1,450 XP · 800 to level 4");
    expect(within(card).getByRole("img", { name: "200 of 1000 XP toward level 4" })).toBeTruthy();
    expect(within(card).getByTestId("progress-performance").textContent).toBe("3 of 4 measured runs succeeded (all versions counted)");
    expect(within(card).getByTestId("progress-specialisation").textContent).toBe("research (3 successful runs)");
    expect(within(card).getByTestId("progress-reputation").textContent).toBe("operator verdicts: 1 good, 1 excellent (a reputation needs 3) · endorsed by Evidence Analyst");
    expect(within(card).getByRole("list", { name: "Achievements" }).textContent).toContain("Seasoned in a domain: research");
    const ledger = within(card).getByTestId("progress-awards");
    expect(ledger.textContent).toContain("+150Deliverable backed by verified evidence");
    expect(within(ledger).getByRole("link", { name: "deliverable" }).getAttribute("href")).toBe("/artifacts/d1");
    expect(card.textContent).toContain("grant no keys");
  });

  it("shows honest empty states, never invented progress", async () => {
    api.getAgentProgression.mockResolvedValue({
      ...progression,
      level: 1,
      xp: 0,
      levelStartXp: 0,
      nextLevelXp: 500,
      awards: [],
      achievements: [],
      specialisation: null,
      domains: {},
      reputation: { ...progression.reputation, verdicts: { POOR: 0, ACCEPTABLE: 0, GOOD: 0, EXCELLENT: 0 }, verdictCount: 0, independentEndorsers: [] },
    });
    await renderNode(<Progression agent={agent} performance={{ samples: 0, successes: 0, versions: 0 }} />);
    const card = await screen.findByTestId("agent-progress");
    expect(within(card).getByTestId("progress-performance").textContent).toBe("no measured runs yet");
    expect(within(card).getByTestId("progress-specialisation").textContent).toMatch(/^none yet/);
    expect(within(card).getByTestId("progress-reputation").textContent).toMatch(/^not enough evidence yet/);
    expect(card.textContent).toContain("No achievements yet.");
    expect(within(card).getByRole("img", { name: "0 of 500 XP toward level 2" })).toBeTruthy();
  });

  it("says when progress can't be read, with a retry", async () => {
    api.getAgentProgression.mockRejectedValue(new Error("API 500"));
    await renderNode(<Progression agent={agent} performance={undefined} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't load this agent's progress.");
  });
});

describe("Quality verdict", () => {
  it("records the operator's chosen verdict with a reason and shows the result", async () => {
    api.getQualityVerdicts.mockResolvedValueOnce({ verdicts: [] }).mockResolvedValue({
      verdicts: [{ eventId: "e1", actor: "human:operator", occurredAt: "2026-09-16T12:00:00Z", verdict: "GOOD", rationale: "well cited", agentName: "Field Researcher", previousVerdict: null }],
    });
    api.recordQualityVerdict.mockResolvedValue({ verdict: "GOOD", agentName: "Field Researcher", xp: 150, note: null });
    await renderNode(<QualityVerdictControl artifactId="d1" />);
    const box = await screen.findByTestId("quality-verdict");
    expect(box.textContent).toContain("Not judged yet.");
    expect(box.textContent).toContain("not an approval");
    fireEvent.click(within(box).getByRole("button", { name: "good" }));
    fireEvent.change(within(box).getByPlaceholderText("why (optional)"), { target: { value: "well cited" } });
    await act(async () => {
      fireEvent.click(within(box).getByRole("button", { name: "Record good" }));
    });
    expect(api.recordQualityVerdict).toHaveBeenCalledWith({ artifactId: "d1", verdict: "GOOD", rationale: "well cited" });
    expect((await within(box).findByRole("status")).textContent).toContain("Field Researcher earns 150 XP");
    expect(box.textContent).toContain("Current: good");
  });
});
