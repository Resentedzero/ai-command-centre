/**
 * R2 Stage 6 Keeper UI: Explain offers only the intents the Keeper supports for this page's subject,
 * renders an answer as Recorded / Calculated / Not known with its sources and record links, lists
 * what it can explain when a question is unsupported, accepts a question handed over by another
 * screen, draws the Keeper through the appearance system (Rogue by default), and flags a Think
 * answer that used numbers its records did not contain. No model call is made to explain.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { KeeperAnswer } from "../lib/api";

const api = vi.hoisted(() => ({
  keeperExplain: vi.fn(),
  keeperExplanation: vi.fn(),
  keeperIdentity: vi.fn(),
  keeperGuide: vi.fn(),
  askKeeper: vi.fn(),
  getWorkflowRun: vi.fn(),
  getArtifact: vi.fn(),
}));
vi.mock("../lib/api", () => api);
const nav = vi.hoisted(() => ({ path: "/agents/22222222-2222-4222-8222-222222222222" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.path }));

import { KeeperDock, KeeperPanel, KeeperProvider, useKeeper } from "../components/keeper/Keeper";

const AGENT = "agent:22222222-2222-4222-8222-222222222222";
const identity = {
  agentDefinitionId: "k1",
  name: "Keeper",
  version: 1,
  appearance: null,
  intents: [
    { id: "level", label: "Why is it this level?", subjects: ["agent"] },
    { id: "xp_ledger", label: "How did it earn its XP?", subjects: ["agent"] },
    { id: "stop_reason", label: "Why did it stop?", subjects: ["run", "workflow_run", "goal"] },
  ],
};

const levelAnswer: KeeperAnswer = {
  intent: "level",
  intentLabel: "Why is it this level?",
  subject: { type: "agent", id: "22222222-2222-4222-8222-222222222222", name: "Field Researcher" },
  question: null,
  headline: "Field Researcher is level 4.",
  facts: [{ text: "Field Researcher has 3,450 XP from 18 recorded award(s).", source: "agent_xp_awards", links: [{ label: "Field Researcher", href: "/agents/22222222-2222-4222-8222-222222222222" }] }],
  derived: [{ text: "Level 4 starts at 2,250 XP and level 5 at 3,500 XP, so Field Researcher is level 4, 50 XP short of level 5.", source: "progression rules", links: [] }],
  unknown: [],
  sources: ["agent_xp_awards", "progression rules"],
  canExplain: [],
  size: { characters: 1550, estimatedTokens: 388 },
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  nav.path = "/agents/22222222-2222-4222-8222-222222222222";
  api.keeperIdentity.mockResolvedValue(identity);
  api.keeperExplain.mockResolvedValue({ subject: { type: "agent", id: "x" }, headline: "Field Researcher v2.", status: "idle", facts: [], reasons: [], next: [] });
});

function Asker() {
  const keeper = useKeeper();
  return (
    <button type="button" onClick={() => keeper.askAbout("xp_ledger", AGENT)}>
      Why this XP?
    </button>
  );
}

async function renderKeeper(extra?: React.ReactNode) {
  await act(async () => {
    render(
      <KeeperProvider>
        {extra}
        <KeeperDock />
        <KeeperPanel />
      </KeeperProvider>
    );
  });
}

async function openPanel() {
  await renderKeeper();
  fireEvent.click(screen.getByRole("button", { name: "Ask the Keeper" }));
  return screen.findByRole("complementary", { name: "The Keeper" });
}

describe("Keeper Explain", () => {
  it("offers only this subject's intents, and explains one as recorded, calculated and unknown with sources and links", async () => {
    api.keeperExplanation.mockResolvedValue(levelAnswer);
    const panel = await openPanel();
    const choices = within(panel).getByRole("group", { name: "Questions the Keeper can answer here" });
    expect(within(choices).getAllByRole("button").map((b) => b.textContent)).toEqual(["Why is it this level?", "How did it earn its XP?"]);

    await act(async () => {
      fireEvent.click(within(choices).getByRole("button", { name: "Why is it this level?" }));
    });
    expect(api.keeperExplanation).toHaveBeenCalledWith(AGENT, { intent: "level" });
    const answer = await within(panel).findByTestId("keeper-intent-answer");
    expect(answer).toHaveTextContent("Field Researcher is level 4.");
    expect(within(answer).getByTestId("keeper-facts")).toHaveTextContent("Field Researcher has 3,450 XP from 18 recorded award(s).agent_xp_awards");
    expect(within(answer).getByTestId("keeper-derived")).toHaveTextContent("50 XP short of level 5.");
    expect(within(answer).getByRole("link", { name: "Field Researcher" }).getAttribute("href")).toBe("/agents/22222222-2222-4222-8222-222222222222");
    expect(answer).toHaveTextContent("Read from the records without a model · about 388 tokens of context");
    expect(api.askKeeper).not.toHaveBeenCalled();
  });

  it("asks a typed question, and an unsupported one says what it can explain instead of guessing", async () => {
    api.keeperExplanation.mockResolvedValue({
      ...levelAnswer,
      intent: null,
      intentLabel: null,
      headline: "I can't answer that from the records yet.",
      facts: [],
      derived: [],
      unknown: ["That question is not one the Keeper can answer from the records yet."],
      canExplain: [{ intent: "level", label: "Why is it this level?" }],
    });
    const panel = await openPanel();
    fireEvent.change(within(panel).getByLabelText("Question for the Keeper"), { target: { value: "What will the weather be?" } });
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "Explain" }));
    });
    expect(api.keeperExplanation).toHaveBeenCalledWith(AGENT, { question: "What will the weather be?" });
    const answer = await within(panel).findByTestId("keeper-intent-answer");
    expect(within(answer).queryByTestId("keeper-facts")).toBeNull();
    expect(within(answer).getByTestId("keeper-unknown")).toHaveTextContent("not one the Keeper can answer");
    api.keeperExplanation.mockResolvedValue(levelAnswer);
    await act(async () => {
      fireEvent.click(within(within(answer).getByRole("group", { name: "What the Keeper can explain here" })).getByRole("button", { name: "Why is it this level?" }));
    });
    expect(api.keeperExplanation).toHaveBeenLastCalledWith(AGENT, { intent: "level" });
  });

  it("answers a question another screen hands over, about that screen's subject", async () => {
    nav.path = "/";
    api.keeperExplanation.mockResolvedValue(levelAnswer);
    await renderKeeper(<Asker />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Why this XP?" }));
    });
    expect(api.keeperExplanation).toHaveBeenCalledWith(AGENT, { intent: "xp_ledger" });
    expect(await screen.findByTestId("keeper-intent-answer")).toHaveTextContent("Field Researcher is level 4.");
  });

  it("says when the records can't be read", async () => {
    api.keeperExplanation.mockRejectedValue(new Error("API 500"));
    const panel = await openPanel();
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "Why is it this level?" }));
    });
    expect(await within(panel).findByText("The Keeper couldn't read the records.")).toBeTruthy();
  });
});

describe("the Keeper as a character", () => {
  it("is the Rogue by default and its own appearance when one is set, standing still", async () => {
    await renderKeeper();
    expect(screen.getByRole("button", { name: "Ask the Keeper" }).querySelector("img")!.getAttribute("src")).toBe("/world/strips/rogue-idle-2x-outlined.png");
  });

  it("uses the ordinary appearance system when the Keeper has a look", async () => {
    api.keeperIdentity.mockResolvedValue({ ...identity, appearance: { skin: "fair", hair: "hood", hairColor: "black", top: "robe", topColor: "slate", bottom: "trousers", bottomColor: "umber", accessory: "none", mark: "scroll" } });
    await renderKeeper();
    const dock = screen.getByRole("button", { name: "Ask the Keeper" });
    const sprite = dock.querySelector<HTMLElement>("[data-look]")!;
    expect(sprite.dataset.look).toBe("kit");
    expect(sprite.dataset.pose).toBe("frozen");
    expect(dock.querySelector("img")).toBeNull();
  });
});

describe("Think answers", () => {
  it("warn when the answer used numbers its records did not contain", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const content = JSON.stringify({ format: "deliverable/v1", title: "q", body: "It has 48213 XP.", findings: [], recommendations: [], sources: [], basis: { externalResearch: false, evidence: [], note: null }, checks: { unsupportedNumbers: ["48213"] } });
    api.askKeeper.mockResolvedValue({ goalId: "g", workflowRunId: "wr-k", status: "in_progress" });
    api.getWorkflowRun.mockResolvedValue({ workflowRun: { id: "wr-k", status: "completed" }, steps: [{ run: { invocations: [{ artifactIds: ["a-answer"] }] } }] });
    api.getArtifact.mockResolvedValue({ artifact: { id: "a-answer", type: "keeper_answer", content } });
    const panel = await openPanel();
    fireEvent.change(within(panel).getByLabelText("Question for the Keeper"), { target: { value: "Why is it level 12?" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Think" }));
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(2_100);
    });
    vi.useRealTimers();
    const answer = await within(panel).findByTestId("keeper-answer");
    expect(within(answer).getByRole("alert")).toHaveTextContent("it mentions 48213, which the records it was given do not contain");
  });
});
