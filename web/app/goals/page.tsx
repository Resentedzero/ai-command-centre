"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { createGoal, listGoals, type ProjectGoals } from "../../lib/api";

/**
 * Goals & Projects (spec 15.1 screen 5): Goals grouped by Project, each with
 * its Workflow Runs, plus the "start a Goal" command (spec 15.2). Renders only
 * what the API returns; starting a Goal is a plain call — every governance
 * check (Policy, budget, stops, approvals) runs server-side.
 */
export default function GoalsPage() {
  const [projects, setProjects] = useState<ProjectGoals[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [started, setStarted] = useState<{ workflowRunId: string; status: string } | null>(null);

  const refetch = useCallback(async () => {
    try {
      setProjects(await listGoals());
      setLoaded(true);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;
    setStarting(true);
    setStartError(null);
    setStarted(null);
    try {
      const result = await createGoal(trimmedTitle, description.trim() || undefined);
      setStarted({ workflowRunId: result.workflowRunId, status: result.status });
      setTitle("");
      setDescription("");
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
      await refetch();
    }
  }

  const goalCount = projects.reduce((n, p) => n + p.goals.length, 0);

  return (
    <main>
      <h1>Goals</h1>

      <form onSubmit={handleSubmit} style={{ border: "1px solid #ccc", borderRadius: 6, padding: 12, marginBottom: 16 }}>
        <div>
          <label htmlFor="goal-title">Goal title</label>
          <br />
          <input id="goal-title" value={title} onChange={(e) => setTitle(e.target.value)} style={{ width: "100%" }} />
        </div>
        <div style={{ marginTop: 8 }}>
          <label htmlFor="goal-description">Description (optional)</label>
          <br />
          <textarea
            id="goal-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            style={{ width: "100%" }}
          />
        </div>
        <button type="submit" disabled={starting || !title.trim()} style={{ marginTop: 8 }}>
          Start goal
        </button>
        <p style={{ fontSize: 12, color: "#555" }}>
          Starting a goal runs its workflow now. It can take a few minutes and uses model quota.
        </p>
        {starting && <p>Starting… the workflow is running.</p>}
        {startError && (
          <p role="alert" style={{ color: "#b00020" }}>
            The request failed: {startError}. The goal may still have been created and started, so check the list
            below before trying again.
          </p>
        )}
        {started && (
          <p>
            Started — <a href={`/workflows/${started.workflowRunId}`}>view workflow run</a> ({started.status})
          </p>
        )}
      </form>

      {loadError && <p style={{ color: "#b00020" }}>Failed to load goals: {loadError}</p>}
      {loaded && goalCount === 0 && <p>No goals yet.</p>}

      {projects
        .filter((project) => project.goals.length > 0)
        .map((project) => (
          <section key={project.id} data-testid="project" style={{ marginBottom: 16 }}>
            <h2>{project.name}</h2>
            {project.goals.map((goal) => (
              <div
                key={goal.id}
                data-testid="goal"
                style={{ border: "1px solid #ccc", borderRadius: 6, padding: 12, marginBottom: 8 }}
              >
                <div style={{ fontWeight: "bold" }}>{goal.title}</div>
                {goal.description && <div>{goal.description}</div>}
                <div>Status: {goal.status}</div>
                {goal.workflowRuns.length === 0 ? (
                  <div>No workflow runs.</div>
                ) : (
                  <ul>
                    {goal.workflowRuns.map((run) => (
                      <li key={run.id}>
                        <a href={`/workflows/${run.id}`}>Workflow run</a> — {run.status}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </section>
        ))}
    </main>
  );
}
