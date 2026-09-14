/**
 * Workflow/Task view (spec 15.1 screen 3): the list links to each run, and the
 * detail renders exactly what the API returns — steps in order, each Run's
 * Invocations with failure reasons, and budget counters per unit.
 */
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { WorkflowRunDetail } from "../lib/api";

const { listWorkflowRuns, getWorkflowRun } = vi.hoisted(() => ({
  listWorkflowRuns: vi.fn(),
  getWorkflowRun: vi.fn(),
}));

vi.mock("../lib/api", () => ({ listWorkflowRuns, getWorkflowRun }));

import WorkflowsPage from "../app/workflows/page";
import WorkflowRunPage, { WORKFLOW_REFRESH_MS } from "../app/workflows/[id]/page";

beforeEach(() => {
  listWorkflowRuns.mockReset();
  getWorkflowRun.mockReset();
});

describe("Workflows list", () => {
  it("renders each run with a link to its detail view", async () => {
    listWorkflowRuns.mockResolvedValueOnce([
      {
        id: "wr-1",
        status: "in_progress",
        createdAt: "2026-09-14T10:00:00.000Z",
        completedAt: null,
        goal: { id: "g-1", title: "Compare EV batteries" },
        workflowDefinition: { name: "Research-and-Publish", version: 1 },
      },
    ]);

    render(<WorkflowsPage />);

    const link = await screen.findByRole("link", { name: "Compare EV batteries" });
    expect(link).toHaveAttribute("href", "/workflows/wr-1");
    expect(screen.getByTestId("workflow-run-row")).toHaveTextContent("in_progress");
    expect(screen.getByTestId("workflow-run-row")).toHaveTextContent("Research-and-Publish v1");
  });

  it("says so when there are no runs", async () => {
    listWorkflowRuns.mockResolvedValueOnce([]);
    render(<WorkflowsPage />);
    expect(await screen.findByText("No workflow runs yet.")).toBeInTheDocument();
  });
});

describe("Workflow run detail", () => {
  const detail: WorkflowRunDetail = {
    workflowRun: { id: "wr-1", status: "failed", createdAt: "t", completedAt: "t" },
    goal: { id: "g-1", title: "Compare EV batteries", description: null },
    workflowDefinition: { id: "wd-1", name: "Research-and-Publish", version: 1 },
    steps: [
      {
        index: 0,
        taskDefinition: { id: "td-1", name: "Research-Report", version: 1 },
        taskInstance: { id: "ti-1", status: "failed" },
        run: {
          id: "run-1",
          status: "failed",
          outcomeReason: "invocation_interrupted",
          startedAt: "t",
          completedAt: "t",
          agent: { name: "Researcher", version: 1 },
          invocations: [
            { id: "i-1", seqNo: 1, kind: "tool", status: "completed", startedAt: "t", completedAt: "t", failureReason: null, errorCode: null, artifactIds: [] },
            {
              id: "i-2",
              seqNo: 2,
              kind: "llm",
              status: "failed",
              startedAt: "t",
              completedAt: "t",
              failureReason: "interrupted_outcome_unknown",
              errorCode: "timeout",
              artifactIds: [],
            },
          ],
          budget: [
            { resourceUnit: "subscription_tokens", limitAmount: "200000", reservedAmount: "0", consumedAmount: "1050" },
            { resourceUnit: "usd", limitAmount: "1.00", reservedAmount: "0", consumedAmount: "0.01" },
          ],
        },
      },
      { index: 1, taskDefinition: { id: "td-2", name: "Review-and-Publish", version: 1 }, taskInstance: null, run: null },
    ],
    stepsUnavailableReason: null,
  };

  it("renders steps in order with each Run's invocations, failure reasons and per-unit budget", async () => {
    getWorkflowRun.mockResolvedValueOnce(detail);

    // The page reads `params` with React's `use`, which suspends: the render must
    // happen inside an AWAITED act so the suspension can settle.
    await act(async () => {
      render(
        <Suspense fallback={<p>suspended</p>}>
          <WorkflowRunPage params={Promise.resolve({ id: "wr-1" })} />
        </Suspense>
      );
    });

    expect(await screen.findByRole("heading", { name: "Compare EV batteries" })).toBeInTheDocument();
    expect(getWorkflowRun).toHaveBeenCalledWith("wr-1");
    // A finished run is read exactly once: no polling, and no extra read when it is found to be finished.
    expect(getWorkflowRun).toHaveBeenCalledTimes(1);

    const steps = screen.getAllByTestId("workflow-step");
    expect(steps).toHaveLength(2);
    expect(steps[0]).toHaveTextContent("Research-Report — failed");
    expect(steps[0]).toHaveTextContent("Researcher v1");
    expect(steps[0]).toHaveTextContent("invocation_interrupted");
    expect(steps[1]).toHaveTextContent("Review-and-Publish — not started");

    const rows = screen.getAllByTestId("invocation-row");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveTextContent("interrupted_outcome_unknown (timeout)");

    // Separate counters per unit, never summed.
    const budget = screen.getByTestId("run-budget");
    expect(budget).toHaveTextContent("subscription_tokens: 1050 consumed of 200000");
    expect(budget).toHaveTextContent("usd: 0.01 consumed of 1.00");
  });

  it("re-reads an unfinished run periodically, and stops once it has finished", async () => {
    vi.useFakeTimers();
    try {
      const running = { ...detail, workflowRun: { ...detail.workflowRun, status: "in_progress" } };
      getWorkflowRun.mockResolvedValueOnce(running).mockResolvedValueOnce(running).mockResolvedValue(detail);

      await act(async () => {
        render(
          <Suspense fallback={<p>suspended</p>}>
            <WorkflowRunPage params={Promise.resolve({ id: "wr-1" })} />
          </Suspense>
        );
      });
      expect(getWorkflowRun).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORKFLOW_REFRESH_MS);
      });
      expect(getWorkflowRun).toHaveBeenCalledTimes(2);

      // The third read reports it finished; polling then stops.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORKFLOW_REFRESH_MS);
      });
      const callsWhenFinished = getWorkflowRun.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORKFLOW_REFRESH_MS * 3);
      });
      // Finishing stops the timer without any further read.
      expect(callsWhenFinished).toBe(3);
      expect(getWorkflowRun.mock.calls.length).toBe(callsWhenFinished);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says why steps cannot be shown instead of rendering an empty run", async () => {
    getWorkflowRun.mockResolvedValueOnce({
      ...detail,
      steps: [],
      stepsUnavailableReason: "the workflow definition's graph is not a valid linear graph",
    });

    await act(async () => {
      render(
        <Suspense fallback={<p>suspended</p>}>
          <WorkflowRunPage params={Promise.resolve({ id: "wr-1" })} />
        </Suspense>
      );
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(/Steps cannot be shown: .*not a valid linear graph/);
  });

  it("shows the error when the run cannot be loaded", async () => {
    getWorkflowRun.mockRejectedValueOnce(new Error("API request failed: GET /workflow-runs/x -> 404 Not Found"));

    await act(async () => {
      render(
        <Suspense fallback={<p>suspended</p>}>
          <WorkflowRunPage params={Promise.resolve({ id: "x" })} />
        </Suspense>
      );
    });

    expect(await screen.findByText(/Failed to load workflow run: .*404/)).toBeInTheDocument();
  });
});
