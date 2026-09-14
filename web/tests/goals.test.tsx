/**
 * Goals & Projects (spec 15.1 screen 5): Goals grouped by Project with links to
 * their Workflow Runs, and the start-a-Goal command — a plain API call with no
 * client-side policy logic, whose failure is shown rather than swallowed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ProjectGoals } from "../lib/api";

const { listGoals, createGoal } = vi.hoisted(() => ({
  listGoals: vi.fn(),
  createGoal: vi.fn(),
}));

vi.mock("../lib/api", () => ({ listGoals, createGoal }));

import GoalsPage from "../app/goals/page";

const projects: ProjectGoals[] = [
  {
    id: "p-1",
    name: "Research Lab",
    description: null,
    goals: [
      {
        id: "g-1",
        title: "Compare EV batteries",
        description: "for a buyer's guide",
        status: "active",
        createdAt: "2026-09-14T10:00:00.000Z",
        workflowRuns: [{ id: "wr-1", status: "in_progress", createdAt: "2026-09-14T10:00:00.000Z", completedAt: null }],
      },
    ],
  },
  { id: "p-2", name: "Empty Project", description: null, goals: [] },
];

beforeEach(() => {
  listGoals.mockReset();
  createGoal.mockReset();
});

describe("Goals page", () => {
  it("groups goals under their project and links each workflow run; empty projects are omitted", async () => {
    listGoals.mockResolvedValueOnce(projects);

    render(<GoalsPage />);

    const project = await screen.findByTestId("project");
    expect(project).toHaveTextContent("Research Lab");
    const goal = screen.getByTestId("goal");
    expect(goal).toHaveTextContent("Compare EV batteries");
    expect(goal).toHaveTextContent("for a buyer's guide");
    expect(screen.getByRole("link", { name: "Workflow run" })).toHaveAttribute("href", "/workflows/wr-1");
    expect(screen.queryByText("Empty Project")).not.toBeInTheDocument();
  });

  it("says so when there are no goals", async () => {
    listGoals.mockResolvedValueOnce([{ id: "p-2", name: "Empty Project", description: null, goals: [] }]);
    render(<GoalsPage />);
    expect(await screen.findByText("No goals yet.")).toBeInTheDocument();
  });

  it("starts a goal with the trimmed title, links the new workflow run, and refetches", async () => {
    listGoals.mockResolvedValue(projects);
    createGoal.mockResolvedValueOnce({ goalId: "g-2", workflowRunId: "wr-2", status: "in_progress" });

    render(<GoalsPage />);
    await screen.findByTestId("project");

    const button = screen.getByRole("button", { name: "Start goal" });
    expect(button).toBeDisabled(); // a title is required
    fireEvent.change(screen.getByLabelText("Goal title"), { target: { value: "  New goal  " } });
    expect(button).not.toBeDisabled();
    fireEvent.click(button);

    await waitFor(() => expect(createGoal).toHaveBeenCalledWith("New goal", undefined));
    expect(await screen.findByRole("link", { name: "view workflow run" })).toHaveAttribute("href", "/workflows/wr-2");
    await waitFor(() => expect(listGoals).toHaveBeenCalledTimes(2));
  });

  it("on a failed request, says the goal may still exist rather than claiming it was not started", async () => {
    listGoals.mockResolvedValue(projects);
    createGoal.mockRejectedValueOnce(new Error("API request failed: POST /goals -> 500 Internal Server Error"));

    render(<GoalsPage />);
    await screen.findByTestId("project");
    fireEvent.change(screen.getByLabelText("Goal title"), { target: { value: "Doomed goal" } });
    fireEvent.click(screen.getByRole("button", { name: "Start goal" }));

    // The API commits the Goal before driving it, so a failure may come after it started.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/The request failed: .*500/);
    expect(alert).toHaveTextContent(/may still have been created/);
    expect(alert).not.toHaveTextContent(/could not start/i);
  });
});
