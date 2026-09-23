/**
 * History / Archive and Settings → World screens: history lists goals with their recorded
 * lifecycle, filters by what the API supports, and archives only finished goals (nothing deleted);
 * Settings shows the world, creates it from the current keep when none is saved, and edits and
 * deactivates items through the API, showing the API's refusals.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { HistoryData, WorldData } from "../lib/api";

const api = vi.hoisted(() => ({
  getHistory: vi.fn(),
  getHistoryWorkflowRuns: vi.fn(),
  archiveFinished: vi.fn(),
  applyWorldTemplate: vi.fn(),
  getRegistry: vi.fn(),
  setGoalArchived: vi.fn(),
  getWorld: vi.fn(),
  createWorld: vi.fn(),
  saveWorldItem: vi.fn(),
  renameWorkspace: vi.fn(),
  subscribeToActivity: vi.fn(),
}));
vi.mock("../lib/api", () => api);

import HistoryPage from "../app/history/page";
import SettingsPage from "../app/settings/page";
import { PreferencesProvider } from "../components/preferences";
import { DEFAULT_PREFERENCES, parsePreferences } from "../lib/preferences";

const history: HistoryData = {
  goals: [
    { id: "g1", title: "Research RAG", project: "Missions", status: "completed", lifecycle: "completed", createdAt: "2026-09-16T10:00:00Z", archivedAt: null, archivedBy: null, agents: ["Field Researcher"], workflowRuns: [{ id: "wr1", status: "completed", createdAt: "2026-09-16T10:00:00Z", completedAt: "2026-09-16T10:05:00Z", workflow: "Mission v1" }] },
    { id: "g2", title: "Stopped job", project: "P", status: "failed", lifecycle: "stopped", createdAt: "2026-09-15T10:00:00Z", archivedAt: "2026-09-16T11:00:00Z", archivedBy: "human:operator", agents: [], workflowRuns: [] },
    { id: "g3", title: "Running now", project: "P", status: "active", lifecycle: "awaiting_approval", createdAt: "2026-09-16T12:00:00Z", archivedAt: null, archivedBy: null, agents: ["Publisher"], workflowRuns: [] },
  ],
  capped: false,
  limit: 200,
  filters: { lifecycles: ["active", "awaiting_approval", "paused", "completed", "failed", "stopped"], agents: ["Field Researcher", "Publisher"], workflows: ["Mission"] },
};

const area = (id: string, buildingId: string, name: string, purpose: string) => ({ id, buildingId, name, purpose, x: 480, y: 832, w: 480, h: 160, active: true });
const world: WorldData = {
  workspace: { id: "ws", name: "The Keep", width: 1440, height: 1024 },
  buildings: [{ id: "b1", name: "The Keep", x: 64, y: 24, w: 1312, h: 976, active: true }],
  areas: [area("a1", "b1", "Entrance plaza", "common"), { ...area("a2", "b1", "Runtime room", "work"), x: 480, y: 432, w: 480, h: 256 }],
  workstations: [{ id: "s1", areaId: "a2", name: "Console (west)", activity: "think", x: 545, y: 580, active: true }],
  purposes: ["work", "common", "rest", "social", "waiting", "corridor", "other"],
  activities: ["think", "research", "analysis", "writing", "publishing", "generic"],
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
});

async function renderPage(node: React.ReactNode) {
  await act(async () => {
    render(node);
  });
}

describe("History", () => {
  it("opens a mission's goal in Command, and leaves an ordinary goal unlinked", async () => {
    api.getHistory.mockResolvedValue(history);
    await renderPage(<HistoryPage />);
    const rows = await screen.findAllByTestId("history-goal");
    // A mission goal links to where its plan, blockers, recovery and timeline are.
    expect(within(rows[0]!).getByRole("link", { name: "Research RAG" })).toHaveAttribute("href", "/command?goal=g1");
    // An ordinary goal has no Command link: Command would refuse it.
    expect(within(rows[1]!).queryByRole("link", { name: "Stopped job" })).toBeNull();
  });

  it("reads the search term Command linked with, so the link lands on the goal it named", async () => {
    window.history.replaceState(null, "", "/history?q=Research%20RAG");
    api.getHistory.mockResolvedValue(history);
    await renderPage(<HistoryPage />);
    // The filter the page actually asked the API for is the proof the link was honoured.
    await screen.findAllByTestId("history-goal");
    expect(api.getHistory).toHaveBeenCalledWith(expect.objectContaining({ q: "Research RAG" }));
    window.history.replaceState(null, "", "/history");
  });

  it("lists goals with their recorded lifecycle and archive state, and filters through the API", async () => {
    api.getHistory.mockResolvedValue(history);
    await renderPage(<HistoryPage />);
    const rows = await screen.findAllByTestId("history-goal");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Research RAG");
    expect(rows[0]).toHaveTextContent("completed");
    expect(within(rows[0]!).getByRole("link", { name: /Mission v1/ }).getAttribute("href")).toBe("/workflows/wr1");
    expect(rows[1]).toHaveTextContent("stopped (emergency stop)");
    expect(rows[1]).toHaveTextContent("archived");
    // Work in progress has no archive control.
    expect(within(rows[2]!).queryByRole("button", { name: /Archive/ })).toBeNull();
    expect(screen.queryByText(/draft|cancel/i)).toBeNull();

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "Publisher" } });
    });
    expect(api.getHistory).toHaveBeenLastCalledWith(expect.objectContaining({ agent: "Publisher", archived: "include" }));
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Archive"), { target: { value: "only" } });
      fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-09-16" } });
    });
    expect(api.getHistory).toHaveBeenLastCalledWith(expect.objectContaining({ archived: "only", to: new Date("2026-09-16T23:59:59.999").toISOString() }));
  });

  it("archives and unarchives finished goals through the API, and shows a refusal", async () => {
    api.getHistory.mockResolvedValue(history);
    api.setGoalArchived.mockResolvedValue({ id: "g1", archivedAt: "now" });
    await renderPage(<HistoryPage />);
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Archive Research RAG" }));
    });
    expect(api.setGoalArchived).toHaveBeenCalledWith("g1", true);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Unarchive Stopped job" }));
    });
    expect(api.setGoalArchived).toHaveBeenCalledWith("g2", false);
    api.setGoalArchived.mockRejectedValue(new Error("API 409: This goal is already archived."));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Archive Research RAG" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("already archived");
  });

  it("archives a backlog in one action, only after counting it, and archives exactly that count", async () => {
    api.getHistory.mockResolvedValue(history);
    api.archiveFinished.mockResolvedValueOnce({ dryRun: true, count: 212 }).mockResolvedValueOnce({ dryRun: false, count: 212 });
    await renderPage(<HistoryPage />);
    const bulk = await screen.findByRole("group", { name: "Archive finished work" });
    await act(async () => {
      fireEvent.click(within(bulk).getByRole("button", { name: "Count" }));
    });
    expect(api.archiveFinished).toHaveBeenLastCalledWith(168, undefined);
    await act(async () => {
      fireEvent.click(within(bulk).getByRole("button", { name: "Archive 212 goals" }));
    });
    expect(api.archiveFinished).toHaveBeenLastCalledWith(168, 212);
    expect(within(bulk).getByRole("status")).toHaveTextContent("Archived 212 goals. Nothing was deleted.");
  });

  it("lists workflow runs on their own tab, each linking to its full record, filtered through the API", async () => {
    api.getHistory.mockResolvedValue(history);
    api.getHistoryWorkflowRuns.mockResolvedValue({
      workflowRuns: [{ id: "wr9", status: "failed", createdAt: "2026-09-10T10:00:00Z", completedAt: "2026-09-10T10:02:00Z", goal: { id: "g9", title: "Old attempt", archivedAt: null }, workflow: "Mission v1" }],
      capped: false,
      limit: 200,
    });
    await renderPage(<HistoryPage />);
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Workflow runs" }));
    });
    const rows = await screen.findAllByTestId("history-run");
    expect(within(rows[0]!).getByRole("link", { name: /Old attempt/ }).getAttribute("href")).toBe("/workflows/wr9");
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Run status"), { target: { value: "failed" } });
    });
    expect(api.getHistoryWorkflowRuns).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", archived: "include" }));
  });
});

describe("Settings → General, Agents, System", () => {
  beforeEach(() => window.localStorage.clear());

  it("stores this browser's preferences, applies motion to the page, and never calls the API to do it", async () => {
    await renderPage(
      <PreferencesProvider>
        <SettingsPage />
      </PreferencesProvider>
    );
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Motion"), { target: { value: "reduced" } });
      fireEvent.change(screen.getByLabelText("Ambient life"), { target: { value: "false" } });
      fireEvent.change(screen.getByLabelText("Name tags in the world"), { target: { value: "all" } });
    });
    expect(document.documentElement.dataset.motion).toBe("reduced");
    expect(JSON.parse(window.localStorage.getItem("command-centre.preferences.v1")!)).toMatchObject({ motion: "reduced", ambient: false, nameTags: "all" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "System" }));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Current work"), { target: { value: "72" } });
    });
    expect(JSON.parse(window.localStorage.getItem("command-centre.preferences.v1")!).currentWindowHours).toBe(72);
    expect(api.getWorld).not.toHaveBeenCalled();
    expect(api.saveWorldItem).not.toHaveBeenCalled();
  });

  it("falls back to the defaults for anything stored that is unknown or malformed", () => {
    expect(parsePreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences({ motion: "wild", ambient: "yes", nameTags: 3, currentWindowHours: 5, recruitPreset: "x".repeat(99) })).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences({ motion: "full", currentWindowHours: 0, recruitPreset: "scribe" })).toMatchObject({ motion: "full", currentWindowHours: 0, recruitPreset: "scribe" });
  });
});

describe("Settings → World", () => {
  it("offers to create the world from the current keep when none is saved, and edits nothing until then", async () => {
    api.getWorld.mockResolvedValue({ ...world, workspace: null, buildings: [], areas: [], workstations: [], preview: { buildings: world.buildings, areas: world.areas, workstations: world.workstations } });
    api.createWorld.mockResolvedValue({ world });
    await renderPage(<SettingsPage />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "World" }));
    });
    expect(await screen.findByText("No world is saved yet. The map shows the current keep as a preview.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add building" })).toBeNull();
    expect(screen.getByText("Runtime room")).toBeTruthy();
    api.getWorld.mockResolvedValue(world);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create the world from the current keep" }));
    });
    expect(api.createWorld).toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Add building" })).toBeTruthy();
  });

  it("edits, adds and deactivates items through the API, says it grants nothing, and shows refusals", async () => {
    api.getWorld.mockResolvedValue(world);
    api.saveWorldItem.mockResolvedValue({ saved: { id: "s1" } });
    await renderPage(<SettingsPage />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "World" }));
    });
    expect(await screen.findByText(/changes no agent's keys, budgets, approvals or progression/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Console \(west\)/ }));
    const editor = screen.getByRole("form", { name: "Edit world item" });
    fireEvent.change(within(editor).getByLabelText("Name"), { target: { value: "Console (north)" } });
    fireEvent.change(within(editor).getByLabelText("Activity it hosts"), { target: { value: "research" } });
    fireEvent.change(within(editor).getByLabelText("x"), { target: { value: "600" } });
    await act(async () => {
      fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
    });
    expect(api.saveWorldItem).toHaveBeenCalledWith("workstations", "s1", { name: "Console (north)", activity: "research", x: 600, y: 580 });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Deactivate" }));
    });
    expect(api.saveWorldItem).toHaveBeenLastCalledWith("workstations", "s1", { active: false });

    fireEvent.click(screen.getAllByRole("button", { name: "Add workstation" })[0]!);
    const adding = screen.getByRole("form", { name: "Edit world item" });
    fireEvent.change(within(adding).getByLabelText("Name"), { target: { value: "Spare desk" } });
    await act(async () => {
      fireEvent.click(within(adding).getByRole("button", { name: "Add" }));
    });
    expect(api.saveWorldItem).toHaveBeenLastCalledWith("workstations", null, { name: "Spare desk", activity: "generic", x: 720, y: 560, areaId: "a2" });

    api.saveWorldItem.mockRejectedValue(new Error("API 409: The world needs at least one active common area for idle agents to live in."));
    fireEvent.click(screen.getByRole("button", { name: "Area Entrance plaza" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Deactivate" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("at least one active common area");
  });
});
