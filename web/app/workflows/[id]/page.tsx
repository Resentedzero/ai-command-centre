"use client";

import { use, useCallback, useEffect, useState } from "react";
import { getWorkflowRun, type RunDetail, type WorkflowRunDetail } from "../../../lib/api";

/**
 * Workflow Run detail (spec 15.1 screen 3): the run's steps in graph order,
 * each step's Task Instance and Run, the Run's Invocation sequence with any
 * failure reason, and its budget counters per resource unit.
 *
 * Linear graphs only (the interpreter's scope), so steps render as an ordered
 * list rather than through a graph library. Renders only what
 * `GET /workflow-runs/:id` returns — no status is derived here. `params` is a
 * Promise in this Next.js version, read with React's `use` in a client page.
 */
/** How often an unfinished run's detail is re-read. */
export const WORKFLOW_REFRESH_MS = 5_000;

export default function WorkflowRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [detail, setDetail] = useState<WorkflowRunDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await getWorkflowRun(id));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  // The initial read.
  useEffect(() => {
    void load();
  }, [load]);

  // Re-read while the run can still change, and not after it has finished.
  // Kept separate from the initial read so that the run becoming finished only
  // STOPS the timer — it must not trigger an extra read of its own. Polling, not
  // SSE: the event stream is not keyed by workflow run, and a few seconds' lag
  // is fine for this view.
  const finished = detail?.workflowRun.status === "completed" || detail?.workflowRun.status === "failed";
  useEffect(() => {
    if (finished) return;
    const timer = setInterval(() => void load(), WORKFLOW_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, finished]);

  if (loadError && !detail) {
    return (
      <main>
        <p style={{ color: "#b00020" }}>Failed to load workflow run: {loadError}</p>
      </main>
    );
  }
  if (!detail) {
    return (
      <main>
        <p>Loading…</p>
      </main>
    );
  }

  return (
    <main>
      <p>
        <a href="/workflows">← All workflow runs</a>
      </p>
      <h1>{detail.goal?.title ?? "Workflow run"}</h1>
      {detail.goal?.description && <p>{detail.goal.description}</p>}
      <div>Status: {detail.workflowRun.status}</div>
      {detail.workflowDefinition && (
        <div>
          Workflow: {detail.workflowDefinition.name} v{detail.workflowDefinition.version}
        </div>
      )}

      {loadError && (
        <p role="alert" style={{ color: "#b00020" }}>
          Could not refresh — what is shown may be out of date: {loadError}
        </p>
      )}

      <h2>Steps</h2>
      {detail.stepsUnavailableReason && (
        <p role="alert" style={{ color: "#b00020" }}>
          Steps cannot be shown: {detail.stepsUnavailableReason}.
        </p>
      )}
      <ol>
        {detail.steps.map((step) => (
          <li key={step.index} data-testid="workflow-step" style={{ marginBottom: 16 }}>
            <strong>{step.taskDefinition?.name ?? `Step ${step.index + 1}`}</strong>
            {" — "}
            {step.taskInstance ? step.taskInstance.status : "not started"}
            {step.run && <RunSection run={step.run} />}
          </li>
        ))}
      </ol>
    </main>
  );
}

function RunSection({ run }: { run: RunDetail }) {
  const outcomeReason = run.outcomeReason;
  return (
    <div style={{ marginTop: 8 }}>
      <div>
        Run: {run.status}
        {run.agent && ` · ${run.agent.name} v${run.agent.version}`}
        {outcomeReason && ` · ${outcomeReason}`}
      </div>

      <table style={{ borderCollapse: "collapse", marginTop: 4 }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left", paddingRight: 12 }}>#</th>
            <th style={{ textAlign: "left", paddingRight: 12 }}>Kind</th>
            <th style={{ textAlign: "left", paddingRight: 12 }}>Status</th>
            <th style={{ textAlign: "left" }}>Failure</th>
          </tr>
        </thead>
        <tbody>
          {run.invocations.map((invocation) => (
            <tr key={invocation.id} data-testid="invocation-row">
              <td style={{ paddingRight: 12 }}>{invocation.seqNo}</td>
              <td style={{ paddingRight: 12 }}>{invocation.kind}</td>
              <td style={{ paddingRight: 12 }}>{invocation.status}</td>
              <td>
                {invocation.failureReason ?? ""}
                {invocation.errorCode && ` (${invocation.errorCode})`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {run.budget.length > 0 && (
        <ul data-testid="run-budget" style={{ marginTop: 4 }}>
          {run.budget.map((counter) => (
            <li key={counter.resourceUnit}>
              {counter.resourceUnit}: {counter.consumedAmount} consumed of {counter.limitAmount}
              {Number(counter.reservedAmount) > 0 && ` (${counter.reservedAmount} reserved)`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
