"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { createGoal, listGoals, type ProjectGoals } from "../../lib/api";
import { useRefetchOnEvents } from "../../components/live";
import { RefreshNotice, PixelButton, Skeleton, StateNotice, StatusMark, cx, px } from "../../components/pixel/Pixel";
import { world } from "../../components/world/World";
import { countLabel, errorText, formatTime } from "../../lib/keep";
import g from "./goals.module.css";

const GOAL_LIST_CAP = 500;

/**
 * Goals & Projects (spec 15.1 screen 5; Figma "Goals — pixel (war room)"):
 * what missions exist, and how are they going? The start-goal form keeps its
 * cost and non-idempotency warnings; the war room frames a real list: projects
 * as wings, goals as banners, each goal's workflow runs as small corridors.
 * Starting a goal is a plain call; every governance check runs server-side.
 */
export default function GoalsPage() {
  const [projects, setProjects] = useState<ProjectGoals[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [started, setStarted] = useState<{ workflowRunId: string; status: string } | null>(null);

  const refetch = useCallback(async () => {
    try {
      setProjects(await listGoals());
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);
  useRefetchOnEvents(refetch);

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
      setStartError(errorText(err));
    } finally {
      setStarting(false);
      await refetch();
    }
  }

  const goalCount = projects?.reduce((n, p) => n + p.goals.length, 0) ?? 0;
  const withGoals = projects?.filter((p) => p.goals.length > 0) ?? [];
  const runs = projects?.flatMap((p) => p.goals.flatMap((goal) => goal.workflowRuns)) ?? [];

  return (
    <main className={g.screen}>
      <form onSubmit={handleSubmit} className={cx(px.board, g.form)} aria-label="Start a goal">
        <span className={px.tab}>Start a goal</span>
        <label className={g.field}>
          <span className={px.label}>Goal title</span>
          <input className={px.input} value={title} onChange={(e) => setTitle(e.target.value)} disabled={starting} />
        </label>
        <label className={g.field}>
          <span className={px.label}>Description (optional)</span>
          <textarea className={cx(px.input, g.textarea)} value={description} onChange={(e) => setDescription(e.target.value)} disabled={starting} />
        </label>
        <p className={g.warning}>Starting a goal runs its workflow now. It can take a few minutes and uses model quota.</p>
        <PixelButton type="submit" disabled={starting || !title.trim()}>
          Start goal
        </PixelButton>
        {starting && (
          <p role="status" className={g.note}>
            Starting: the workflow is running <Skeleton />
          </p>
        )}
        {startError && (
          <div role="alert" className={g.error}>
            <p className={g.errorMessage}>Couldn&apos;t confirm the goal started.</p>
            <p className={px.detail}>{startError}</p>
            <p className={g.note}>The goal may still have been created and started, so refresh the goals and check before trying again.</p>
            <PixelButton onClick={() => void refetch()}>Refresh goals</PixelButton>
          </div>
        )}
        {started && (
          <p className={g.note} role="status">
            Started. <Link href={`/workflows/${started.workflowRunId}`} className={g.link}>View the workflow run</Link> ({started.status.replace(/_/g, " ")})
          </p>
        )}
      </form>

      <section className={g.room} aria-label="Goals">
        <div className={g.top}>
          <div className={g.vignette} role="img" aria-label="War room">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/world/room-v5-war-2x.png" width={352} height={256} alt="" className={world.base} draggable={false} />
            <div className={world.night} />
          </div>
          <div className={cx(px.parchment, g.summary)}>
            <h1 className={px.heading}>Goals</h1>
            {!projects ? (
              loadError ? <span className={px.dim}>n/a</span> : <Skeleton />
            ) : (
              <>
                <div>
                  {countLabel(goalCount, GOAL_LIST_CAP)} goal{goalCount === 1 ? "" : "s"} in {withGoals.length} project{withGoals.length === 1 ? "" : "s"}
                </div>
                <div className={g.row}>
                  {(["in_progress", "paused", "failed", "completed"] as const).map((s) => {
                    const n = runs.filter((r) => r.status === s).length;
                    // A zero count is neutral, never a state colour.
                    return (
                      <StatusMark key={s} state={s} tone={n === 0 ? "neutral" : undefined} surface="parchment">
                        {n} {s.replace(/_/g, " ")}
                      </StatusMark>
                    );
                  })}
                </div>
                <div className={px.detail}>Workflow runs of the goals listed{goalCount >= GOAL_LIST_CAP ? " (the newest 500 goals)" : ""}.</div>
              </>
            )}
          </div>
        </div>

        {!projects && loadError ? (
          <StateNotice
            role="alert"
            className={px.board}
            message="Couldn't load the goals."
            detail={loadError}
            action={<PixelButton onClick={() => void refetch()}>Retry</PixelButton>}
          />
        ) : !projects ? (
          <StateNotice role="status" className={px.board} message={<>Loading the goals <Skeleton /></>} />
        ) : goalCount === 0 ? (
          <StateNotice className={px.board} message="No goals yet. Start one with the form." />
        ) : (
          <>
            {loadError && (
              <RefreshNotice error={loadError} />
            )}
            {withGoals.map((project) => (
              <section key={project.id} className={cx(px.board, g.wing)} data-testid="project" aria-label={project.name}>
                <div className={g.row}>
                  <h2 className={px.label}>{project.name}</h2>
                  {project.description && <span className={px.dim}>{project.description}</span>}
                </div>
                <ul className={g.banners}>
                  {project.goals.map((goal) => (
                    <li key={goal.id} className={cx(px.parchment, g.banner)} data-testid="goal">
                      <div className={g.row}>
                        <span className={px.label}>{goal.title}</span>
                        <StatusMark state={goal.status} tone="neutral" surface="parchment" />
                      </div>
                      {goal.description && <div>{goal.description}</div>}
                      <div className={px.detail}>created {formatTime(goal.createdAt)}</div>
                      {goal.workflowRuns.length === 0 ? (
                        <div className={px.detail}>No workflow runs.</div>
                      ) : (
                        <div className={g.corridor}>
                          {goal.workflowRuns.map((run) => (
                            <Link key={run.id} href={`/workflows/${run.id}`} className={cx(px.plaque, g.runChip)}>
                              Workflow run
                              <StatusMark state={run.status} />
                            </Link>
                          ))}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </>
        )}
      </section>
    </main>
  );
}
