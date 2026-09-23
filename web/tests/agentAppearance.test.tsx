/**
 * R2 visual identity in the UI: a recruit saves its Definition and then its look (two writes,
 * the look keyed on the name); a new version shows the agent's look read-only and saves none;
 * Change appearance saves only the look; sprites draw the chosen kit, or the default character.
 */
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { RegistryData } from "../lib/api";

const api = vi.hoisted(() => ({
  getRegistry: vi.fn(),
  createAgentDefinition: vi.fn(),
  setAgentAppearance: vi.fn(),
}));
vi.mock("../lib/api", () => api);

import NewAgentPage from "../app/agents/new/page";
import AgentAppearancePage from "../app/agents/[id]/appearance/page";
import { AgentSprite } from "../components/world/World";

const SCHOLAR = { skin: "deep", hair: "bun", hairColor: "grey", top: "robe", topColor: "violet", bottom: "skirt", bottomColor: "umber", accessory: "glasses", mark: "book" };
const part = (d: string, options: string[]) => ({ label: d, default: options[0]!, options });

const registry: RegistryData = {
  agentDefinitions: [
    { id: "s1", name: "Scholar", version: 1, role: "r", objective: "o", instructions: "i", createdAt: "t", executionProfile: {}, appearance: SCHOLAR },
    { id: "s2", name: "Scholar", version: 2, role: "r", objective: "o", instructions: "i", createdAt: "t", executionProfile: {}, appearance: SCHOLAR },
    { id: "p1", name: "Publisher", version: 1, role: "r", objective: "o", instructions: "i", createdAt: "t", executionProfile: {}, appearance: null },
  ],
  capabilities: [],
  capabilityGrants: [],
  taskDefinitions: [],
  workflowDefinitions: [],
  builder: {
    permissions: ["READ"],
    autonomyStates: ["ALWAYS_APPROVE"],
    tiers: ["MID"],
    providers: [],
    autonomyLimits: { maxIterations: 12, maxActiveSeconds: 900, minActiveSeconds: 60, taskInstanceBudgetCeilings: {} },
    appearance: {
      version: 1,
      poses: ["idle", "run"],
      frameSize: 68,
      frames: { idle: 4, run: 6 },
      parts: {
        skin: part("Skin", ["tan", "fair", "deep"]),
        hair: part("Hair", ["short", "none", "bun"]),
        hairColor: part("Hair colour", ["brown", "grey"]),
        top: part("Top", ["tunic", "robe"]),
        topColor: part("Top colour", ["indigo", "violet"]),
        bottom: part("Bottom", ["trousers", "skirt"]),
        bottomColor: part("Bottom colour", ["slate", "umber"]),
        accessory: part("Accessory", ["none", "glasses"]),
        mark: part("Role mark", ["none", "book"]),
      },
    },
  },
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getRegistry.mockResolvedValue(registry);
});

async function renderPage(node: React.ReactNode) {
  await act(async () => {
    render(<Suspense fallback={<p>suspended</p>}>{node}</Suspense>);
  });
}

describe("Character station in the Agent Builder", () => {
  it("recruits the agent, then saves the chosen look keyed on its name", async () => {
    api.createAgentDefinition.mockResolvedValue({ id: "n1", name: "Archivist", version: 1 });
    api.setAgentAppearance.mockResolvedValue({ name: "Archivist", appearance: {} });
    await renderPage(<NewAgentPage searchParams={Promise.resolve({})} />);

    const form = await screen.findByRole("form", { name: "Agent Builder" });
    for (const [label, value] of [["Name", "Archivist"], ["Role", "r"], ["Objective", "o"], ["Instructions", "i"]] as const) {
      fireEvent.change(within(form).getByLabelText(label), { target: { value } });
    }
    const station = within(form).getByRole("group", { name: "Character" });
    fireEvent.change(within(station).getByLabelText("Hair"), { target: { value: "bun" } });
    fireEvent.change(within(station).getByLabelText("Role mark"), { target: { value: "book" } });
    expect(within(station).getByText("preview · not a run")).toBeTruthy();

    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "Recruit agent" }));
    });

    // The Definition payload carries no appearance: the look is a separate, presentation-only write.
    expect(Object.keys(api.createAgentDefinition.mock.calls[0]![0])).not.toContain("appearance");
    expect(api.setAgentAppearance).toHaveBeenCalledWith("Archivist", {
      skin: "tan", hair: "bun", hairColor: "brown", top: "tunic", topColor: "indigo", bottom: "trousers", bottomColor: "slate", accessory: "none", mark: "book",
    });
    expect(await screen.findByText(/Archivist v1 recruited/)).toBeTruthy();
  });

  it("reports a refused look beside a recorded recruit, never as a failed recruit", async () => {
    api.createAgentDefinition.mockResolvedValue({ id: "n1", name: "Archivist", version: 1 });
    api.setAgentAppearance.mockRejectedValue(new Error("400 unknown appearance part"));
    await renderPage(<NewAgentPage searchParams={Promise.resolve({})} />);
    const form = await screen.findByRole("form", { name: "Agent Builder" });
    for (const [label, value] of [["Name", "Archivist"], ["Role", "r"], ["Objective", "o"], ["Instructions", "i"]] as const) {
      fireEvent.change(within(form).getByLabelText(label), { target: { value } });
    }
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "Recruit agent" }));
    });
    expect(await screen.findByText(/Archivist v1 recruited/)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/character wasn.t saved/);
  });

  it("a new version shows the agent's look read-only and saves no appearance", async () => {
    api.createAgentDefinition.mockResolvedValue({ id: "s3", name: "Scholar", version: 3 });
    await renderPage(<NewAgentPage searchParams={Promise.resolve({ from: "s2" })} />);
    const form = await screen.findByRole("form", { name: "Agent Builder" });
    const station = within(form).getByRole("group", { name: "Character" });
    expect((within(station).getByLabelText("Hair") as HTMLSelectElement).disabled).toBe(true);
    expect((within(station).getByLabelText("Hair") as HTMLSelectElement).value).toBe("bun");
    expect(within(station).getByRole("link", { name: "Change appearance" }).getAttribute("href")).toBe("/agents/s2/appearance");

    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "Save Scholar v3" }));
    });
    expect(api.createAgentDefinition).toHaveBeenCalledOnce();
    expect(api.setAgentAppearance).not.toHaveBeenCalled();
  });
});

describe("Change appearance", () => {
  it("saves only the look, for the agent's name, and creates no version", async () => {
    api.setAgentAppearance.mockResolvedValue({ name: "Scholar", appearance: {} });
    await renderPage(<AgentAppearancePage params={Promise.resolve({ id: "s1" })} />);
    const form = await screen.findByRole("form", { name: "Change appearance" });
    expect((within(form).getByLabelText("Top") as HTMLSelectElement).value).toBe("robe");
    fireEvent.change(within(form).getByLabelText("Top"), { target: { value: "tunic" } });
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "Save appearance" }));
    });
    expect(api.setAgentAppearance).toHaveBeenCalledWith("Scholar", { ...SCHOLAR, top: "tunic" });
    expect(api.createAgentDefinition).not.toHaveBeenCalled();
    expect(await screen.findByText("Saved. No version was created.")).toBeTruthy();
  });

  it("starts an agent with no look from the catalogue defaults and says it has the default character", async () => {
    await renderPage(<AgentAppearancePage params={Promise.resolve({ id: "p1" })} />);
    const form = await screen.findByRole("form", { name: "Change appearance" });
    expect(within(form).getByText(/default character until you save one/)).toBeTruthy();
    expect((within(form).getByLabelText("Skin") as HTMLSelectElement).value).toBe("tan");
  });

  it("says an unknown agent is unknown", async () => {
    await renderPage(<AgentAppearancePage params={Promise.resolve({ id: "nope" })} />);
    expect(await screen.findByText("That agent isn't in the Registry.")).toBeTruthy();
  });
});

describe("AgentSprite", () => {
  it("draws a chosen look as stacked kit layers, top layer first, and the default character otherwise", () => {
    const { container } = render(
      <>
        <AgentSprite look={{ character: "wizard", appearance: SCHOLAR }} pose="run" footX={0} footY={0} />
        <AgentSprite look={{ character: "wizard", appearance: null }} pose="run" footX={0} footY={0} />
      </>
    );
    const [kit, legacy] = [...container.querySelectorAll<HTMLElement>("[data-look]")];
    expect(kit!.dataset.look).toBe("kit");
    const layers = kit!.style.backgroundImage.match(/\/world\/agents\/[^")]+/g);
    expect(layers![0]).toBe("/world/agents/work-down-mark-book.png");
    expect(layers!.at(-1)).toBe("/world/agents/work-down-body-deep.png");
    expect(layers).toHaveLength(6);
    expect(legacy!.dataset.look).toBe("wizard");
  });

  it("holds a failed kit character on its idle frame (the kit has no death strip)", () => {
    const { container } = render(<AgentSprite look={{ character: "knight", appearance: SCHOLAR }} pose="death" footX={0} footY={0} />);
    const el = container.querySelector<HTMLElement>("[data-look]")!;
    expect(el.style.backgroundImage).toContain("idle-down-body-deep.png");
    expect(el.className).toMatch(/frozen/);
  });
});

describe("AgentSprite facing", () => {
  it("walks in the direction it faces: side strips for left and right, left mirrored", () => {
    const { container } = render(
      <>
        <AgentSprite look={{ character: "knight", appearance: SCHOLAR }} pose="idle" kitPose="walk" facing="left" footX={0} footY={0} />
        <AgentSprite look={{ character: "knight", appearance: SCHOLAR }} pose="idle" kitPose="walk" facing="up" footX={0} footY={0} scale={2} />
      </>
    );
    const [left, up] = [...container.querySelectorAll<HTMLElement>("[data-look]")];
    expect(left!.style.backgroundImage).toContain("walk-side-body-deep.png");
    expect(left!.style.transform).toBe("scaleX(-1)");
    expect(up!.style.backgroundImage).toContain("walk-up-body-deep.png");
    expect(up!.style.transform).toBe("scale(2)");
  });
});
