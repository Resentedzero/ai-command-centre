/**
 * Goals & Projects (spec 15.1 screen 5): goals grouped by project with links to
 * their workflow runs, and start-a-goal — a plain API call whose failure is
 * shown with the non-idempotency hint rather than swallowed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ProjectGoals } from "../lib/api";

const api = vi.hoisted(() => ({ listGoals: vi.fn(), createGoal: vi.fn() }));
vi.mock("../lib/api", () => api);

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
  api.listGoals.mockReset();
  api.createGoal.mockReset();
});

describe("Goals page", () => {
  it("groups goals under their project, links each workflow run, and omits empty projects", async () => {
    api.listGoals.mockResolvedValue(projects);
    render(<GoalsPage />);

    const project = await screen.findByTestId("project");
    expect(project).toHaveTextContent("Research Lab");
    const goal = screen.getByTestId("goal");
    expect(goal).toHaveTextContent("Compare EV batteries");
    expect(goal).toHaveTextContent("for a buyer's guide");
    expect(within(goal).getByRole("link", { name: /Workflow run/ })).toHaveAttribute("href", "/workflows/wr-1");
    expect(within(goal).getByRole("link", { name: /Workflow run/ })).toHaveTextContent("in progress");
    expect(screen.queryByText("Empty Project")).not.toBeInTheDocument();
    expect(screen.getByText("1 goal in 1 project")).toBeInTheDocument();
  });

  it("says so when there are no goals", async () => {
    api.listGoals.mockResolvedValue([{ id: "p-2", name: "Empty Project", description: null, goals: [] }]);
    render(<GoalsPage />);
    expect(await screen.findByText("No goals yet. Start one with the form.")).toBeInTheDocument();
  });

  it("shows a load failure with Retry", async () => {
    api.listGoals.mockRejectedValueOnce(new Error("API request failed: GET /goals -> 500 Internal Server Error")).mockResolvedValue(projects);
    render(<GoalsPage />);
    expect(await screen.findByText("Couldn't load the goals.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("project")).toBeInTheDocument();
  });

  it("starts a goal with the trimmed title, links the new workflow run, and refetches", async () => {
    api.listGoals.mockResolvedValue(projects);
    api.createGoal.mockResolvedValueOnce({ goalId: "g-2", workflowRunId: "wr-2", status: "in_progress" });
    render(<GoalsPage />);
    await screen.findByTestId("project");

    const button = screen.getByRole("button", { name: "Start goal" });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Goal title"), { target: { value: "  New goal  " } });
    expect(button).not.toBeDisabled();
    fireEvent.click(button);

    await waitFor(() => expect(api.createGoal).toHaveBeenCalledWith("New goal", undefined));
    expect(await screen.findByRole("link", { name: "View the workflow run" })).toHaveAttribute("href", "/workflows/wr-2");
    await waitFor(() => expect(api.listGoals).toHaveBeenCalledTimes(2));
  });

  it("on a failed request, says the goal may still exist and offers a refresh before any retry", async () => {
    api.listGoals.mockResolvedValue(projects);
    api.createGoal.mockRejectedValueOnce(new Error("API request failed: POST /goals -> 500 Internal Server Error"));
    render(<GoalsPage />);
    await screen.findByTestId("project");
    fireEvent.change(screen.getByLabelText("Goal title"), { target: { value: "Doomed goal" } });
    fireEvent.click(screen.getByRole("button", { name: "Start goal" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/500/);
    expect(alert).toHaveTextContent(/may still have been created/);
    expect(alert).not.toHaveTextContent(/could not start/i);
    fireEvent.click(within(alert).getByRole("button", { name: "Refresh goals" }));
    await waitFor(() => expect(api.listGoals).toHaveBeenCalledTimes(3));
  });
});
