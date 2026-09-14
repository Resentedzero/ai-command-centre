"use client";

import { useEffect, useState } from "react";
import { listWorkflowRuns, type WorkflowRunSummary } from "../../lib/api";

/**
 * Workflow Runs list (spec 15.1 screen 3, entry point). Renders only what
 * `GET /workflow-runs` returns; each row links to its detail view.
 */
export default function WorkflowsPage() {
  const [runs, setRuns] = useState<WorkflowRunSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listWorkflowRuns()
      .then((data) => {
        if (!cancelled) {
          setRuns(data);
          setLoaded(true);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main>
      <h1>Workflow runs</h1>
      {loadError && <p style={{ color: "#b00020" }}>Failed to load workflow runs: {loadError}</p>}
      {loaded && runs.length === 0 && <p>No workflow runs yet.</p>}
      {runs.map((run) => (
        <div
          key={run.id}
          data-testid="workflow-run-row"
          style={{ border: "1px solid #ccc", borderRadius: 6, padding: 12, marginBottom: 8 }}
        >
          <a href={`/workflows/${run.id}`} style={{ fontWeight: "bold" }}>
            {run.goal?.title ?? run.id}
          </a>
          <div>Status: {run.status}</div>
          {run.workflowDefinition && (
            <div>
              Workflow: {run.workflowDefinition.name} v{run.workflowDefinition.version}
            </div>
          )}
          <div>Started: {run.createdAt}</div>
        </div>
      ))}
    </main>
  );
}
