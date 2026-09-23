/**
 * Role icons in the web: `[icon] Name` wherever an agent is named. The icon is identity — its colour is a
 * role colour, never a runtime status colour, and it is decorative, so the name stays the accessible label.
 * An agent the catalogue does not cover, or an unreadable catalogue, shows the name alone.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";

const api = vi.hoisted(() => ({ getRoleIcons: vi.fn(), subscribeToActivity: vi.fn() }));
vi.mock("../lib/api", () => api);

import { AgentLabel, AgentLabels, RoleIcon, RoleIconsProvider } from "../components/agents/RoleIcon";
import catalogueJson from "../../src/definitions/roleIconCatalogue.json";

const catalogue = { version: catalogueJson.version, size: catalogueJson.size, icons: catalogueJson.icons };
const agents = [
  { name: "Manager", iconId: "command", chosen: false },
  { name: "Researcher", iconId: "research", chosen: false },
  { name: "Publisher", iconId: "publishing", chosen: true },
];

async function renderWith(node: React.ReactNode) {
  await act(async () => {
    render(<RoleIconsProvider>{node}</RoleIconsProvider>);
  });
  await act(async () => {});
}

beforeEach(() => {
  api.getRoleIcons.mockReset();
  api.getRoleIcons.mockResolvedValue({ catalogue, agents });
});

describe("the catalogue", () => {
  it("gives every role its own symbol and its own identity colour, and never a state colour", () => {
    const stateHues = ["--state-active", "--state-done", "--state-wait", "--state-fail", "--state-idle"];
    expect(new Set(catalogue.icons.map((i) => i.colorToken)).size).toBe(catalogue.icons.length);
    expect(new Set(catalogue.icons.map((i) => i.pixels.join("|"))).size).toBe(catalogue.icons.length);
    for (const i of catalogue.icons) expect(stateHues).not.toContain(i.colorToken);
  });
});

describe("[icon] Name", () => {
  it("draws the agent's icon beside its name, in its role colour, without changing the name", async () => {
    await renderWith(
      <a href="/agents/x">
        <AgentLabel name="Researcher" suffix={<span>v1</span>} />
      </a>
    );
    // The icon is decorative, so the link still reads as the agent's name and version.
    const link = screen.getByRole("link", { name: "Researcher v1" });
    const svg = link.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("style")).toContain("var(--role-research)");
    expect(within(link).getByText("Researcher")).toBeTruthy();
    // A symbol, drawn as pixels — not an image request.
    expect(svg.querySelectorAll("rect").length).toBeGreaterThan(8);
    expect(svg.querySelector("title")!.textContent).toContain("Research");
  });

  it("gives different roles different symbols and colours", async () => {
    await renderWith(<AgentLabels names={["Manager", "Researcher", "Publisher"]} />);
    const svgs = [...document.querySelectorAll("svg")];
    expect(svgs).toHaveLength(3);
    expect(new Set(svgs.map((s) => s.getAttribute("style"))).size).toBe(3);
    expect(new Set(svgs.map((s) => s.innerHTML)).size).toBe(3);
    expect([...document.querySelectorAll("[data-agent-label]")].map((e) => e.getAttribute("data-agent-label"))).toEqual(["Manager", "Researcher", "Publisher"]);
  });

  it("an agent the catalogue does not cover, and an unreadable catalogue, show the name alone", async () => {
    await renderWith(<AgentLabel name="Nobody" />);
    expect(document.querySelector("svg")).toBeNull();
    expect(screen.getByText("Nobody")).toBeTruthy();

    api.getRoleIcons.mockRejectedValue(new Error("offline"));
    await renderWith(
      <span data-testid="offline">
        <RoleIcon agentName="Manager" />
        Manager
      </span>
    );
    expect(within(screen.getByTestId("offline")).queryByRole("img")).toBeNull();
    expect(screen.getByTestId("offline").querySelector("svg")).toBeNull();
  });

  it("an icon is presentation: nothing about it says what an agent may do", () => {
    const text = JSON.stringify(catalogue);
    for (const word of ["grant", "capability:", "permission", "policy", "budget"]) expect(text.toLowerCase()).not.toContain(`"${word}"`);
    expect(catalogue.icons.every((i) => Object.keys(i).sort().join(",") === "colorToken,description,id,name,pixels")).toBe(true);
  });
});
