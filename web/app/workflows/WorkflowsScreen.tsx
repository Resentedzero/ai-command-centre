"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  getRunTrace,
  getWorkflowRun,
  listWorkflowRuns,
  type RunTrace,
  type WorkflowRunDetail,
  type WorkflowRunSummary,
  type WorkflowStepDetail,
} from "../../lib/api";
import { useRefetchOnEvents } from "../../components/live";
import { PixelButton, Skeleton, StateNotice, StatusMark, UnitGauge, buttonClass, cx, px } from "../../components/pixel/Pixel";
import { WorldViewport, world } from "../../components/world/World";
import { countLabel, errorText, formatTime, stateWord } from "../../lib/keep";
import w from "./workflows.module.css";

/**
 * Workflows (spec 15.1 screen 3; Figma "Workflows — pixel (corridor of
 * steps)"): where is this run in its sequence, and what failed? A runs board,
 * then a corridor of step rooms in graph order lit by step state and panned to
 * the step needing attention, then the selected step's attempts, invocation
 * timeline, per-unit budget and, on demand, its Run trace. Linear graphs only.
 * Renders only what `GET /workflow-runs[/:id]` and `GET /runs/:id/trace` return.
 */

/** How often an unfinished run's detail is re-read. */
export const WORKFLOW_REFRESH_MS = 5_000;
const RUN_LIST_CAP = 100;
const ROOM_W = 352;
const ROOM_H = 256;
const HALL_W = 48;

/** A step's runtime state, or null when no Task Instance exists yet (not started). */
function stepState(step: WorkflowStepDetail): string | null {
  return step.taskInstance?.status ?? null;
}

/** The step needing attention: failed, then waiting, then working, then the first not started. */
function attentionIndex(steps: WorkflowStepDetail[]): number {
  for (const s of ["failed", "awaiting_approval", "active", "pending"]) {
    const i = steps.findIndex((x) => stepState(x) === s);
    if (i >= 0) return i;
  }
  const next = steps.findIndex((x) => stepState(x) === null);
  return next >= 0 ? next : Math.max(steps.length - 1, 0);
}

export function WorkflowsScreen({ id }: { id?: string }) {
  const [runs, setRuns] = useState<WorkflowRunSummary[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);

  const loadRuns = useCallback(async () => {
    try {
      setRuns(await listWorkflowRuns());
      setRunsError(null);
    } catch (err) {
      setRunsError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);
  useRefetchOnEvents(loadRuns);

  return (
    <main className={w.screen}>
      <nav className={cx(px.board, w.runs)} aria-label="Workflow runs">
        <span className={px.tab}>Runs{runs ? ` · ${countLabel(runs.length, RUN_LIST_CAP)}` : ""}</span>
        {!runs && runsError ? (
          <StateNotice role="alert" message="Couldn't load workflow runs." detail={runsError} action={<PixelButton onClick={() => void loadRuns()}>Retry</PixelButton>} />
        ) : !runs ? (
          <StateNotice role="status" message={<Skeleton />} />
        ) : runs.length === 0 ? (
          <StateNotice
            message="No workflow runs yet."
            action={
              <Link href="/goals" className={buttonClass()}>
                Start a goal
              </Link>
            }
          />
        ) : (
          <ul className={w.list}>
            {runs.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/workflows/${r.id}`}
                  data-testid="workflow-run-row"
                  className={cx(px.plaque, w.entry, r.id === id && px.selected)}
                  aria-current={r.id === id ? "page" : undefined}
                >
                  <span className={w.title}>{r.goal?.title ?? "Goal not found"}</span>
                  <StatusMark state={r.status} />
                  <span className={cx(px.dim, w.meta)}>
                    {r.workflowDefinition ? `${r.workflowDefinition.name} v${r.workflowDefinition.version}` : "definition not found"} · {formatTime(r.createdAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {runs && runsError && (
          <p role="alert" className={px.detail}>
            Couldn&apos;t refresh the list. {runsError}
          </p>
        )}
        <Link href="/costs" className={w.link}>
          Open the cost ledger
        </Link>
      </nav>

      {id ? (
        <RunView key={id} id={id} />
      ) : (
        <section className={cx(px.board, w.detail)}>
          <StateNotice message="Choose a workflow run to see where it is in its sequence." />
        </section>
      )}
    </main>
  );
}

function RunView({ id }: { id: string }) {
  const [detail, setDetail] = useState<WorkflowRunDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await getWorkflowRun(id));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Re-read while the run can still change; finishing only stops the timer (no extra read).
  const finished = detail?.workflowRun.status === "completed" || detail?.workflowRun.status === "failed";
  useEffect(() => {
    if (finished) return;
    const timer = setInterval(() => void load(), WORKFLOW_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, finished]);

  if (!detail) {
    return (
      <section className={cx(px.board, w.detail)}>
        {loadError ? (
          <StateNotice
            role="alert"
            message={/ 404 /.test(loadError) ? "This workflow run wasn't found." : "Couldn't load this workflow run."}
            detail={loadError}
            action={<PixelButton onClick={() => void load()}>Retry</PixelButton>}
          />
        ) : (
          <StateNotice role="status" message={<>Loading the workflow run <Skeleton /></>} />
        )}
      </section>
    );
  }

  const steps = detail.steps;
  const attention = attentionIndex(steps);
  const current = selected !== null && selected < steps.length ? selected : attention;
  const step = steps[current];

  return (
    <div className={w.run}>
      <header className={cx(px.parchment, w.header)}>
        <h1 className={w.heading}>{detail.goal?.title ?? "Goal not found"}</h1>
        <div className={w.row}>
          <StatusMark state={detail.workflowRun.status} surface="parchment" />
          <span>{detail.workflowDefinition ? `${detail.workflowDefinition.name} v${detail.workflowDefinition.version}` : "Workflow definition not found"}</span>
          <span>started {formatTime(detail.workflowRun.createdAt)}</span>
          {detail.workflowRun.completedAt && <span>ended {formatTime(detail.workflowRun.completedAt)}</span>}
        </div>
        {detail.goal?.description && <div>{detail.goal.description}</div>}
      </header>
      {loadError && (
        <p role="alert" className={px.detail}>
          Couldn&apos;t refresh; showing the last read. {loadError}
        </p>
      )}

      {detail.stepsUnavailableReason ? (
        <StateNotice role="alert" className={px.board} message={`Steps cannot be shown: ${detail.stepsUnavailableReason}.`} />
      ) : steps.length === 0 ? (
        <StateNotice className={px.board} message="This workflow definition has no steps." />
      ) : (
        <>
          <Corridor steps={steps} selected={current} attention={attention} onSelect={setSelected} />
          {step && <StepDetail key={`${step.index}-${step.run?.id ?? "none"}`} step={step} />}
        </>
      )}
    </div>
  );
}

function Corridor({
  steps,
  selected,
  attention,
  onSelect,
}: {
  steps: WorkflowStepDetail[];
  selected: number;
  attention: number;
  onSelect: (i: number) => void;
}) {
  const x = (i: number) => HALL_W + i * (ROOM_W + HALL_W);
  const width = x(steps.length);
  return (
    <WorldViewport width={width} height={ROOM_H} focus={{ x: x(attention) + ROOM_W / 2, y: ROOM_H / 2 }} label="Workflow corridor" className={w.corridor}>
      {Array.from({ length: steps.length + 1 }, (_, i) => (
        <div key={`hall-${i}`} className={w.hall} style={{ left: x(i) - HALL_W, width: HALL_W, height: ROOM_H }}>
          <div className={world.night} />
        </div>
      ))}
      {steps.map((s, i) => {
        const state = stepState(s);
        return (
          <div key={s.index}>
            <div className={cx(w.room, state === null && w.unstarted)} style={{ left: x(i), width: ROOM_W, height: ROOM_H }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/world/room-v5-engine-2x.png" width={ROOM_W} height={ROOM_H} alt="" className={world.base} draggable={false} />
              <div className={world.night} />
              {state === "active" && <img className={world.light} src="/world/light-active-2x.png" style={{ left: 0, top: 0 }} alt="" />}
            </div>
            <button
              type="button"
              data-testid="workflow-step"
              className={cx(world.plaque, w.stepPlaque, i === selected && world.plaqueSelected)}
              style={{ left: x(i) + ROOM_W / 2, top: 20 }}
              aria-pressed={i === selected}
              onClick={() => onSelect(i)}
            >
              <span>
                Step {i + 1} · {s.taskDefinition?.name ?? "task definition not found"}
              </span>
              {state === null ? (
                <StatusMark state="not started" tone="neutral" />
              ) : (
                <StatusMark state={state} />
              )}
            </button>
          </div>
        );
      })}
    </WorldViewport>
  );
}

function StepDetail({ step }: { step: WorkflowStepDetail }) {
  const run = step.run;
  const [trace, setTrace] = useState<RunTrace | "loading" | null>(null);
  const [traceError, setTraceError] = useState<string | null>(null);

  async function showTrace(runId: string) {
    setTrace("loading");
    setTraceError(null);
    try {
      setTrace(await getRunTrace(runId));
    } catch (err) {
      setTrace(null);
      setTraceError(errorText(err));
    }
  }

  return (
    <section className={cx(px.board, w.detail)} aria-label="Step detail" data-testid="step-detail">
      <div className={w.row}>
        <h2 className={px.label}>
          Step {step.index + 1} · {step.taskDefinition ? `${step.taskDefinition.name} v${step.taskDefinition.version}` : "task definition not found"}
        </h2>
        {step.taskInstance ? <StatusMark state={step.taskInstance.status} /> : <StatusMark state="not started" tone="neutral" />}
      </div>

      {!run ? (
        <p className={px.dim} style={{ margin: 0 }}>
          No run has started for this step.
        </p>
      ) : (
        <>
          <div className={w.row}>
            <span>
              run <StatusMark state={run.status} />
            </span>
            <span>{run.agent ? `${run.agent.name} v${run.agent.version}` : "no agent bound"}</span>
            {run.outcomeReason && <span className={px.dim}>outcome: {run.outcomeReason}</span>}
            <span className={px.dim}>
              {formatTime(run.startedAt)}
              {run.completedAt ? ` → ${formatTime(run.completedAt)}` : ""}
            </span>
          </div>

          <div className={w.columns}>
            {step.attempts && step.attempts.length > 1 && (
              <div className={cx(w.col, w.wide)}>
                <span className={px.tab}>Attempts</span>
                <ol className={cx(px.vellum, w.plain)} data-testid="attempts">
                  {step.attempts.map((a) => (
                    <li key={a.id} className={w.row}>
                      <span>attempt {a.attempt}</span>
                      <StatusMark state={a.status} />
                      {a.outcomeReason && <span className={px.dim}>{a.outcomeReason}</span>}
                      {a.failureReason && (
                        <span>
                          {a.failureReason}
                          {a.errorCode ? ` (${a.errorCode})` : ""}
                        </span>
                      )}
                      <span className={px.dim}>{formatTime(a.startedAt)}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            <div className={w.col}>
              <span className={px.tab}>Invocations</span>
              {run.invocations.length === 0 ? (
                <p className={px.dim}>No invocations yet.</p>
              ) : (
                <div className={cx(px.vellum, w.scrollX)}>
                  <table className={w.table}>
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>kind</th>
                        <th>status</th>
                        <th>time</th>
                        <th>failure</th>
                        <th>outputs</th>
                      </tr>
                    </thead>
                    <tbody>
                      {run.invocations.map((inv) => (
                        <tr key={inv.id} data-testid="invocation-row">
                          <td>{inv.seqNo}</td>
                          <td>{inv.kind}</td>
                          <td>
                            <StatusMark state={inv.status} />
                          </td>
                          <td>
                            {formatTime(inv.startedAt)}
                            {inv.completedAt ? ` → ${formatTime(inv.completedAt)}` : ""}
                          </td>
                          <td>
                            {inv.failureReason ?? ""}
                            {inv.errorCode ? ` (${inv.errorCode})` : ""}
                          </td>
                          <td>
                            {inv.artifactIds.map((artifactId, k) => (
                              <Link key={artifactId} href={`/artifacts/${artifactId}`} className={w.link}>
                                output {k + 1}
                              </Link>
                            ))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className={w.col} data-testid="run-budget">
              <span className={px.tab}>Budget</span>
              {run.budget.length === 0 ? (
                <p className={px.dim}>No budget counters for this run.</p>
              ) : (
                run.budget.map((c) => (
                  <div key={c.resourceUnit} className={cx(px.vellum, w.counter)}>
                    <div className={px.dim}>{c.resourceUnit}</div>
                    <UnitGauge consumed={c.consumedAmount} reserved={c.reservedAmount} limit={c.limitAmount} />
                    <div>
                      {c.consumedAmount} consumed of {c.limitAmount} · {c.reservedAmount} reserved
                    </div>
                  </div>
                ))
              )}
              <p className={px.detail}>One counter per unit, never combined. Hatched: reserved.</p>
            </div>

            <div className={cx(w.col, w.wide)}>
              <span className={px.tab}>Run trace</span>
              {trace === null ? (
                <PixelButton onClick={() => void showTrace(run.id)}>Show the run trace</PixelButton>
              ) : trace === "loading" ? (
                <Skeleton />
              ) : trace.events.length === 0 ? (
                <p className={px.dim}>No events recorded for this run.</p>
              ) : (
                <ol className={cx(px.vellum, w.plain)} data-testid="run-trace">
                  {trace.events.map((e) => (
                    <li key={e.eventId}>
                      <span className={px.dim}>{e.sequenceNo}</span> {stateWord(e.eventType)}{" "}
                      <span className={px.dim}>
                        {formatTime(e.occurredAt)} · {e.actor}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
              {traceError && (
                <p role="alert" className={px.detail}>
                  Couldn&apos;t load the trace. {traceError}
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
