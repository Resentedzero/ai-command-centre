/**
 * The living world on screen (`components/world/LivingAgents.tsx`): the Keeper's real Think run
 * (a mocked `/agents/active` row) walks it to a thinking workstation, keeps it there labelled with
 * the real activity while the run is active, and walks it back when the row is gone; idle agents are
 * labelled as ambient; a stop freezes an agent. The component reads only its props and calls nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { AgentCardData } from "../lib/api";
import { LivingAgents, type LivingAgent } from "../components/world/LivingAgents";
import type { LivingWorld } from "../lib/living";

const area = (id: string, purpose: string, x: number, y: number, w: number, h: number) => ({ id, name: id, purpose, x, y, w, h, active: true });
const world: LivingWorld = {
  areas: [area("study", "work", 0, 0, 200, 150), area("hall", "corridor", 0, 146, 400, 60), area("plaza", "common", 200, 202, 200, 150), area("council", "waiting", 200, 0, 200, 150)],
  workstations: [{ id: "console", areaId: "study", name: "Console", activity: "think", x: 100, y: 100, active: true }],
};
const look = { character: "knight" as const, appearance: null };
const thinkRow: AgentCardData = {
  agentDefinitionId: "k1",
  agentName: "Keeper",
  runId: "run-k",
  taskInstanceId: "t",
  taskStatus: "active",
  taskDefinitionName: "Keeper Answer",
  goalTitle: "Why is Field Researcher level 4?",
  latestActivitySummary: null,
  activity: { invocationKind: "llm", invocationStatus: "executing", capability: null, intent: "decide" },
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
});
afterEach(() => {
  vi.useRealTimers();
});

function ui(keeperRows: AgentCardData[], stops: { id: string; scope: string; scopeRefId: string | null; reason: string | null }[] = []) {
  const agents: LivingAgent[] = [
    { name: "Keeper", definitionIds: ["k1"], look, rows: keeperRows },
    { name: "Scholar", definitionIds: ["s1"], look, rows: [] },
  ];
  return <LivingAgents world={world} agents={agents} stops={stops} selected={null} onSelect={() => undefined} />;
}

const keeper = () => screen.getByRole("button", { name: /^Keeper:/ });
const advance = async (ms: number) => {
  for (let t = 0; t < ms; t += 250) {
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
  }
};

describe("the Keeper's real Think in the world", () => {
  it("walks to a think workstation, works there while the run is active, and walks back when it ends", async () => {
    const { rerender } = render(ui([]));
    await advance(500);
    expect(keeper().getAttribute("aria-label")).toMatch(/\(ambient, no work\)$/);
    expect(screen.getByRole("button", { name: /^Scholar:/ }).getAttribute("aria-label")).toMatch(/ambient, no work/);

    rerender(ui([thinkRow]));
    await advance(250);
    expect(keeper().dataset.presence).toBe("walking");
    expect(keeper().getAttribute("aria-label")).toBe("Keeper: on the way to work: thinking");
    await advance(20_000);
    expect(keeper().dataset.presence).toBe("working");
    expect(keeper().style.left).toBe("100px");
    expect(keeper().style.top).toBe("100px");
    expect(keeper()).toHaveTextContent("Keeper · working: thinking");
    await advance(10_000);
    expect(keeper().dataset.presence).toBe("working");

    rerender(ui([]));
    await advance(250);
    expect(keeper().dataset.presence).toBe("walking");
    expect(keeper().getAttribute("aria-label")).toMatch(/ambient, no work/);
    await advance(20_000);
    expect(keeper().dataset.presence).not.toBe("working");
    expect(keeper().textContent).not.toMatch(/working/);
  });

  it("waits in the council hall while awaiting approval, and freezes behind a barrier when stopped", async () => {
    const { rerender } = render(ui([{ ...thinkRow, taskStatus: "awaiting_approval" }]));
    await advance(20_000);
    expect(keeper().dataset.presence).toBe("waiting");
    expect(keeper()).toHaveTextContent("waiting for approval");
    rerender(ui([thinkRow], [{ id: "stop", scope: "agent_definition", scopeRefId: "k1", reason: null }]));
    await advance(500);
    expect(keeper().dataset.presence).toBe("stopped");
    const left = keeper().style.left;
    await advance(5_000);
    expect(keeper().style.left).toBe(left);
  });

  it("is presentation only: the component imports no API call and writes nothing", () => {
    const source = readFileSync(path.resolve("components/world/LivingAgents.tsx"), "utf8");
    expect(source).not.toMatch(/\bfetch\(|apiFetch|localStorage|sessionStorage/);
    expect([...source.matchAll(/^import\s+(type\s+)?\{[^}]*\}\s+from\s+"\.\.\/\.\.\/lib\/api";/gm)].every((m) => m[1] === "type ")).toBe(true);
  });
});

describe("Settings → General in the world", () => {
  const idleWorld = (props: { ambient?: boolean; nameTags?: "real" | "all" | "none" }) => (
    <LivingAgents
      world={world}
      agents={[
        { name: "Keeper", definitionIds: ["k1"], look, rows: [] },
        { name: "Scholar", definitionIds: ["s1"], look, rows: [] },
      ]}
      stops={[]}
      selected={null}
      onSelect={() => undefined}
      {...props}
    />
  );

  it("with ambient life off, idle agents stay where they are", async () => {
    render(idleWorld({ ambient: false }));
    await advance(250);
    const start = keeper().style.cssText;
    let walked = false;
    for (let t = 0; t < 60_000; t += 1_000) {
      await advance(1_000);
      if (screen.getAllByRole("button").some((b) => b.dataset.presence === "walking")) walked = true;
    }
    expect(walked).toBe(false);
    expect(keeper().style.cssText).toBe(start);
  });

  it("with ambient life on, idle agents do walk", async () => {
    render(idleWorld({}));
    let walked = false;
    for (let t = 0; t < 60_000 && !walked; t += 1_000) {
      await advance(1_000);
      walked = screen.getAllByRole("button").some((b) => b.dataset.presence === "walking");
    }
    expect(walked).toBe(true);
  });

  it("name tags: none for idle agents by default, every agent with 'all'", async () => {
    const { rerender, container } = render(idleWorld({}));
    await advance(250);
    expect(container.querySelectorAll("[data-real]")).toHaveLength(0);
    rerender(idleWorld({ nameTags: "all" }));
    await advance(250);
    expect(container.querySelectorAll('[data-real="false"]')).toHaveLength(2);
  });
});
