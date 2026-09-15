/**
 * Workflows (spec 15.1 screen 3): the runs board links each run; the detail
 * renders exactly what the API returns — a corridor of steps in order, the
 * step needing attention selected, its attempts, invocations with failure
 * reasons, per-unit budget counters and, on demand, its trace.
 */
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { WorkflowRunDetail } from "../lib/api";

const api = vi.hoisted(() => ({ listWorkflowRuns: vi.fn(), getWorkflowRun: vi.fn(), getRunTrace: vi.fn() }));
vi.mock("../lib/api", () => api);

import WorkflowsPage from "../app/workflows/page";
import WorkflowRunPage from "../app/workflows/[id]/page";
import { WORKFLOW_REFRESH_MS } from "../app/workflows/WorkflowsScreen";

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.listWorkflowRuns.mockResolvedValue([]);
  api.getWorkflowRun.mockReturnValue(new Promise(() => {}));
});

async function renderRun(id = "wr-1") {
  await act(async () => {
    render(
      <Suspense fallback={<p>suspended</p>}>
        <WorkflowRunPage params={Promise.resolve({ id })} />
      </Suspense>
    );
  });
}

describe("Workflows runs board", () => {
  it("renders each run with its status, definition and a link to its detail view", async () => {
    api.listWorkflowRuns.mockResolvedValueOnce([
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

    const row = await screen.findByTestId("workflow-run-row");
    expect(row).toHaveAttribute("href", "/workflows/wr-1");
    expect(row).toHaveTextContent("Compare EV batteries");
    expect(row).toHaveTextContent("in progress");
    expect(row).toHaveTextContent("Research-and-Publish v1");
    // With no run in the URL, the run needing attention opens.
    await waitFor(() => expect(api.getWorkflowRun).toHaveBeenCalledWith("wr-1"));
    expect(row).toHaveAttribute("aria-current", "page");
  });

  it("says so when there are no runs, with a way to start a goal", async () => {
    render(<WorkflowsPage />);
    expect(await screen.findByText("No workflow runs yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start a goal" })).toHaveAttribute("href", "/goals");
  });

  it("shows a list failure with Retry", async () => {
    api.listWorkflowRuns.mockRejectedValueOnce(new Error("API request failed: GET /workflow-runs -> 500 Internal Server Error"));
    render(<WorkflowsPage />);
    expect(await screen.findByText("Couldn't load workflow runs.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    // Unloaded means unlit, not absent (#35).
    expect(screen.getByRole("region", { name: "Workflow corridor, not loaded" })).toBeInTheDocument();
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
            {
              id: "i-1",
              seqNo: 1,
              kind: "tool",
              status: "completed",
              startedAt: "t",
              completedAt: "t",
              failureReason: null,
              errorCode: null,
              artifactIds: ["art-1"],
              policyDecision: {
                checkpoint: "pre_dispatch",
                decision: "ALLOW",
                basis: "autonomy_autonomous",
                autonomyState: "AUTONOMOUS",
                riskTier: "low",
                grantId: "grant-1",
                capabilityId: "cap-1",
                permission: "READ",
                toolBindingId: "tb-1",
                trustLevel: "first_party",
                maxTrustLevelRequired: 1,
                bindingTrustLevel: 2,
                performanceEvidence: null,
              },
            },
            { id: "i-2", seqNo: 2, kind: "llm", status: "failed", startedAt: "t", completedAt: "t", failureReason: "interrupted_outcome_unknown", errorCode: "timeout", artifactIds: [], policyDecision: null },
          ],
          budget: [
            { resourceUnit: "subscription_tokens", limitAmount: "200000", reservedAmount: "0", consumedAmount: "1050" },
            { resourceUnit: "usd", limitAmount: "1.00", reservedAmount: "0", consumedAmount: "0.01" },
          ],
        },
        attempts: [
          { id: "run-0", attempt: 1, status: "failed", outcomeReason: "provider_failure", failureReason: "timed out", errorCode: "timeout", startedAt: "t", completedAt: "t" },
          { id: "run-1", attempt: 2, status: "failed", outcomeReason: "invocation_interrupted", failureReason: null, errorCode: null, startedAt: "t", completedAt: "t" },
        ],
      },
      { index: 1, taskDefinition: { id: "td-2", name: "Review-and-Publish", version: 1 }, taskInstance: null, run: null },
    ],
    stepsUnavailableReason: null,
  };

  it("renders the corridor in order and the failed step's attempts, invocations, failure reasons and per-unit budget", async () => {
    api.getWorkflowRun.mockResolvedValueOnce(detail);
    await renderRun();

    expect(await screen.findByRole("heading", { name: "Compare EV batteries" })).toBeInTheDocument();
    expect(api.getWorkflowRun).toHaveBeenCalledWith("wr-1");
    // A finished run is read exactly once: no polling.
    expect(api.getWorkflowRun).toHaveBeenCalledTimes(1);

    const steps = screen.getAllByTestId("workflow-step");
    expect(steps).toHaveLength(2);
    expect(steps[0]).toHaveTextContent("Step 1 · Research-Report");
    expect(steps[0]).toHaveTextContent("failed");
    expect(steps[0]).toHaveAttribute("aria-pressed", "true");
    expect(steps[1]).toHaveTextContent("Step 2 · Review-and-Publish");
    expect(steps[1]).toHaveTextContent("not started");

    const step = screen.getByTestId("step-detail");
    expect(step).toHaveTextContent("Researcher v1");
    expect(step).toHaveTextContent("invocation_interrupted");
    expect(within(screen.getByTestId("attempts")).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByTestId("attempts")).toHaveTextContent("timed out (timeout)");

    const rows = screen.getAllByTestId("invocation-row");
    expect(rows).toHaveLength(2);
    // The failure reason is its own full-width line under the failed invocation, never a scrolled-away column (#46).
    const failures = screen.getAllByTestId("invocation-failure");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toHaveTextContent("interrupted_outcome_unknown (timeout)");
    expect(rows[1]!.nextElementSibling).toBe(failures[0]);
    expect(within(rows[0]!).getByRole("link", { name: "output 1" })).toHaveAttribute("href", "/artifacts/art-1");
    // Policy's recorded decision and basis, as words; nothing for a kind Policy does not govern.
    expect(within(rows[0]!).getByTestId("invocation-policy")).toHaveTextContent("allowed · autonomous · at pre dispatch");
    expect(within(rows[1]!).getByTestId("invocation-policy")).toHaveTextContent(/^$/);

    const budget = screen.getByTestId("run-budget");
    expect(budget).toHaveTextContent("1050 consumed of 200000");
    // Trailing zeros trimmed for reading (#45); the exact string stays in the title.
    expect(budget).toHaveTextContent("0.01 consumed of 1 · 0 reserved");
    expect(within(budget).getByTitle("0.01 consumed of 1.00 · 0 reserved")).toBeInTheDocument();

    fireEvent.click(steps[1]!);
    expect(await screen.findByText("No run has started for this step.")).toBeInTheDocument();
  });

  it("loads a Run's trace on demand, in sequence order", async () => {
    api.getWorkflowRun.mockResolvedValueOnce(detail);
    api.getRunTrace.mockResolvedValueOnce({
      run: { id: "run-1", status: "failed", startedAt: "t", completedAt: "t" },
      events: [
        { eventId: "e-1", eventType: "run_started", occurredAt: "t", sequenceNo: 1, actor: "system", payload: {} },
        { eventId: "e-2", eventType: "invocation_failed", occurredAt: "t", sequenceNo: 2, actor: "system", payload: {} },
      ],
      invocations: [],
    });
    await renderRun();

    fireEvent.click(await screen.findByRole("button", { name: "Show the run trace" }));
    await waitFor(() => expect(api.getRunTrace).toHaveBeenCalledWith("run-1"));
    const trace = await screen.findByTestId("run-trace");
    expect(trace).toHaveTextContent(/1 run started.*2 invocation failed/);
  });

  it("keeps the trace on demand: says when it was read, marks it out of date when the run moves, and refreshes only on request", async () => {
    vi.useFakeTimers();
    try {
      const running = { ...detail, workflowRun: { ...detail.workflowRun, status: "in_progress" } };
      const step0 = detail.steps[0]!;
      const run0 = step0.run!;
      const moved = {
        ...running,
        steps: [{ ...step0, run: { ...run0, invocations: [...run0.invocations, { ...run0.invocations[1]!, id: "i-3", seqNo: 3 }] } }, detail.steps[1]!],
      };
      api.getWorkflowRun.mockResolvedValueOnce(running).mockResolvedValue(moved);
      api.getRunTrace.mockResolvedValue({ run: { id: "run-1", status: "failed", startedAt: "t", completedAt: "t" }, events: [], invocations: [] });
      await renderRun();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Show the run trace" }));
      });
      expect(screen.getByTestId("run-trace-read")).toHaveTextContent(/read at \d\d:\d\d:\d\d/);
      expect(screen.queryByText("out of date")).not.toBeInTheDocument();

      // The run detail's own refresh shows a new invocation: the trace is marked, never re-read by itself.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORKFLOW_REFRESH_MS);
      });
      expect(screen.getByText("out of date")).toBeInTheDocument();
      expect(api.getRunTrace).toHaveBeenCalledTimes(1);

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Refresh the trace" }));
      });
      expect(api.getRunTrace).toHaveBeenCalledTimes(2);
      expect(screen.queryByText("out of date")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-reads an unfinished run periodically, and stops once it has finished", async () => {
    vi.useFakeTimers();
    try {
      const running = { ...detail, workflowRun: { ...detail.workflowRun, status: "in_progress" } };
      api.getWorkflowRun.mockResolvedValueOnce(running).mockResolvedValueOnce(running).mockResolvedValue(detail);
      await renderRun();
      expect(api.getWorkflowRun).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORKFLOW_REFRESH_MS);
      });
      expect(api.getWorkflowRun).toHaveBeenCalledTimes(2);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORKFLOW_REFRESH_MS);
      });
      const callsWhenFinished = api.getWorkflowRun.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORKFLOW_REFRESH_MS * 3);
      });
      expect(callsWhenFinished).toBe(3);
      expect(api.getWorkflowRun.mock.calls.length).toBe(callsWhenFinished);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says why steps cannot be shown instead of rendering an empty run", async () => {
    api.getWorkflowRun.mockResolvedValueOnce({ ...detail, steps: [], stepsUnavailableReason: "the workflow definition's graph is not a valid linear graph" });
    await renderRun();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Steps cannot be shown: .*not a valid linear graph/);
  });

  it("says a missing run was not found, with Retry", async () => {
    api.getWorkflowRun.mockRejectedValueOnce(new Error("API request failed: GET /workflow-runs/x -> 404 Not Found"));
    await renderRun("x");
    expect(await screen.findByText("This workflow run wasn't found.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
