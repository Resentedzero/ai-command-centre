"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useState } from "react";
import {
  getRunTrace,
  getWorkflowRun,
  listWorkflowRuns,
  type RunDetail,
  type RunTrace,
  type WorkflowRunDetail,
  type WorkflowRunSummary,
  type WorkflowStepDetail,
} from "../../lib/api";
import { useRefetchOnEvents } from "../../components/live";
import { RefreshNotice, ButtonMark, PixelButton, Skeleton, StateNotice, StatusMark, UnitGauge, buttonClass, cx, px } from "../../components/pixel/Pixel";
import { WorldViewport, world } from "../../components/world/World";
import { budgetFallbackTitle, countLabel, errorText, formatAmount, formatTime, hashOf, policyEvidenceTitle, policyToken, policyTone, routeTitle, routeToken, stateWord } from "../../lib/keep";
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

/** Step room art per Task Definition (presentation only): the same definition always gets the same room. */
const STEP_ROOMS = [
  { src: "/world/room-v5-engine-2x.png", h: 256 },
  { src: "/world/room-v5-researcher-2x.png", h: 352 },
  { src: "/world/room-v5-publisher-2x.png", h: 352 },
];
function roomFor(taskDefinitionId: string | undefined) {
  return taskDefinitionId ? STEP_ROOMS[hashOf(taskDefinitionId) % STEP_ROOMS.length]! : STEP_ROOMS[0]!;
}

/** Unloaded means unlit, not absent: while a read has failed, one dark engine room with no plaque. */
function UnlitCorridor() {
  return (
    <WorldViewport width={ROOM_W + 2 * HALL_W} height={ROOM_H} label="Workflow corridor, not loaded" className={cx(w.corridor, world.stale)}>
      {[0, HALL_W + ROOM_W].map((left) => (
        <div key={left} className={w.hall} style={{ left, width: HALL_W, height: ROOM_H }}>
          <div className={world.night} />
        </div>
      ))}
      <div className={w.room} style={{ left: HALL_W, width: ROOM_W, height: ROOM_H }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={STEP_ROOMS[0]!.src} width={ROOM_W} height={STEP_ROOMS[0]!.h} alt="" className={world.base} draggable={false} />
        <div className={world.night} />
      </div>
    </WorldViewport>
  );
}

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

export function WorkflowsScreen({ id: routeId }: { id?: string }) {
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

  // With no run in the URL, open the one needing attention (failed, in progress, paused, else the newest), once.
  const [autoId, setAutoId] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (routeId || autoId || !runs || runs.length === 0) return;
    const pick = ["failed", "in_progress", "paused"].map((st) => runs.find((r) => r.status === st)).find(Boolean) ?? runs[0]!;
    setAutoId(pick.id);
  }, [routeId, autoId, runs]);
  const id = routeId ?? autoId;

  return (
    <main className={w.screen}>
      <nav className={cx(px.board, w.runs)} aria-label="Workflow runs">
        <span className={px.tab}>Runs{runs ? ` · ${countLabel(runs.length, RUN_LIST_CAP)}` : ""}</span>
        <Link href="/workflows/new" className={buttonClass()}>
          Build a workflow
        </Link>
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
                  <span className={w.title} title={r.goal?.title}>{r.goal?.title ?? "Goal not found"}</span>
                  <StatusMark state={r.status} />
                  <span className={cx(px.dim, w.meta)}>
                    {r.workflowDefinition ? `${r.workflowDefinition.name} v${r.workflowDefinition.version}` : "definition not found"} ·{" "}
                    <span className={px.nowrap}>{formatTime(r.createdAt)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {runs && runsError && (
          <RefreshNotice error={runsError} message="Couldn't refresh the list." />
        )}
        <Link href="/costs" className={w.link}>
          Open the cost ledger
        </Link>
      </nav>

      {id ? (
        <RunView key={id} id={id} />
      ) : (
        <section className={cx(px.board, w.detail)}>
          {!runs && runsError ? (
            <>
              <UnlitCorridor />
              <StateNotice message="No run is open: the list couldn't be read." />
            </>
          ) : !runs ? (
            <StateNotice role="status" message={<>Loading workflow runs <Skeleton /></>} />
          ) : (
            <StateNotice message="Nothing to show until a goal starts a workflow." />
          )}
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
          <>
            <UnlitCorridor />
            <StateNotice
              role="alert"
              message={/ 404 /.test(loadError) ? "This workflow run wasn't found." : "Couldn't load this workflow run."}
              detail={loadError}
              action={<PixelButton onClick={() => void load()}>Retry</PixelButton>}
            />
          </>
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
        <RefreshNotice error={loadError} />
      )}

      {detail.stepsUnavailableReason ? (
        <StateNotice role="alert" className={px.board} message={`Steps cannot be shown: ${detail.stepsUnavailableReason}.`} />
      ) : steps.length === 0 ? (
        <StateNotice className={px.board} message="This workflow definition has no steps." />
      ) : (
        <>
          <Corridor steps={steps} selected={current} attention={attention} onSelect={setSelected} stale={loadError !== null} />
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
  stale,
}: {
  stale: boolean;
  steps: WorkflowStepDetail[];
  selected: number;
  attention: number;
  onSelect: (i: number) => void;
}) {
  const x = (i: number) => HALL_W + i * (ROOM_W + HALL_W);
  const width = x(steps.length);
  return (
    <WorldViewport width={width} height={ROOM_H} focus={{ x: x(attention) + ROOM_W / 2, y: ROOM_H / 2 }} label="Workflow corridor" className={cx(w.corridor, stale && world.stale)}>
      {Array.from({ length: steps.length + 1 }, (_, i) => (
        <div key={`hall-${i}`} className={w.hall} style={{ left: x(i) - HALL_W, width: HALL_W, height: ROOM_H }}>
          <div className={world.night} />
        </div>
      ))}
      {steps.map((s, i) => {
        const state = stepState(s);
        const art = roomFor(s.taskDefinition?.id);
        return (
          <div key={s.index}>
            <div className={cx(w.room, state === null && w.unstarted)} style={{ left: x(i), width: ROOM_W, height: ROOM_H }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={art.src} width={ROOM_W} height={art.h} alt="" className={world.base} draggable={false} />
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

/** What the run looked like when its trace was read; a later run detail that differs makes the trace out of date. */
export type TraceRead = { at: string; status: string; invocations: number };

export function traceOutOfDate(read: TraceRead | null, run: RunDetail | null): boolean {
  return read !== null && run !== null && (read.status !== run.status || read.invocations !== run.invocations.length);
}

function StepDetail({ step }: { step: WorkflowStepDetail }) {
  const run = step.run;
  // On demand only: the trace is never re-read on a timer, and a refresh keeps the last read on screen.
  const [trace, setTrace] = useState<RunTrace | null>(null);
  const [traceRead, setTraceRead] = useState<TraceRead | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const [traceError, setTraceError] = useState<string | null>(null);
  const outOfDate = traceOutOfDate(traceRead, run);

  async function readTrace(r: RunDetail) {
    const read = { at: new Date().toISOString(), status: r.status, invocations: r.invocations.length };
    setTraceLoading(true);
    setTraceError(null);
    try {
      setTrace(await getRunTrace(r.id));
      setTraceRead(read);
    } catch (err) {
      setTraceError(errorText(err));
    } finally {
      setTraceLoading(false);
    }
  }

  return (
    <section className={cx(px.board, w.detail, w.step)} aria-label="Step detail" data-testid="step-detail">
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
                      {/* Retry lineage and tier floor as recorded by the Interpreter; plain words, no state colour. */}
                      {a.retryCause && <span className={px.dim}>retry · {stateWord(a.retryCause)}</span>}
                      {a.minimumModelTier && <span className={px.dim}>floor {a.minimumModelTier}</span>}
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

            <div className={cx(w.col, w.wide)}>
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
                        <th>policy</th>
                        <th>budget</th>
                        <th>time</th>
                        <th>outputs</th>
                      </tr>
                    </thead>
                    <tbody>
                      {run.invocations.map((inv) => (
                        <Fragment key={inv.id}>
                          <tr data-testid="invocation-row">
                            <td>{inv.seqNo}</td>
                            <td data-testid="invocation-kind" title={routeTitle(inv.route)}>
                              {inv.kind}
                              {routeToken(inv.route) && ` · ${routeToken(inv.route)}`}
                            </td>
                            <td>
                              <StatusMark state={inv.status} />
                            </td>
                            {/* Policy's recorded decision, as the API returns it; blank where Policy does not govern the kind.
                                Red for a denial, amber only while this Invocation waits on a human. */}
                            <td data-testid="invocation-policy" data-tone={policyTone(inv.policyDecision, inv.status === "awaiting_approval")} title={policyEvidenceTitle(inv.policyDecision)}>
                              {policyTone(inv.policyDecision, inv.status === "awaiting_approval") !== "neutral" && (
                                <ButtonMark tone={policyTone(inv.policyDecision, inv.status === "awaiting_approval")} />
                              )}
                              {policyToken(inv.policyDecision, true)}
                            </td>
                            {/* The Governor's outcome as the API returns it: a denial is red; authorized, downgraded and degraded are neutral. */}
                            <td
                              data-testid="invocation-budget"
                              data-tone={inv.budgetOutcome === "denied" ? "fail" : "neutral"}
                              title={budgetFallbackTitle(inv.route?.budgetFallback)}
                            >
                              {inv.budgetOutcome === "denied" && <ButtonMark tone="fail" />}
                              {inv.budgetOutcome ?? ""}
                            </td>
                            <td>
                              {formatTime(inv.startedAt)}
                              {inv.completedAt ? ` → ${formatTime(inv.completedAt)}` : ""}
                            </td>
                            <td>
                              {inv.artifactIds.map((artifactId, k) => (
                                <Link key={artifactId} href={`/artifacts/${artifactId}`} className={w.link}>
                                  output {k + 1}
                                </Link>
                              ))}
                            </td>
                          </tr>
                          {/* What failed answers this screen's question, so it gets a full-width line that no scroll can hide. */}
                          {(inv.failureReason || inv.errorCode) && (
                            <tr data-testid="invocation-failure">
                              <td colSpan={7} className={w.failure}>
                                <ButtonMark tone="fail" />
                                {inv.failureReason ?? "no reason recorded"}
                                {inv.errorCode && <span className={px.dim}> ({inv.errorCode})</span>}
                              </td>
                            </tr>
                          )}
                        </Fragment>
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
                    <div title={`${c.consumedAmount} consumed of ${c.limitAmount} · ${c.reservedAmount} reserved`}>
                      {formatAmount(c.consumedAmount)} consumed of {formatAmount(c.limitAmount)} · {formatAmount(c.reservedAmount)} reserved
                    </div>
                  </div>
                ))
              )}
              <p className={px.detail}>Hatched: reserved.</p>
            </div>

            <div className={cx(w.col, w.wide)}>
              <span className={px.tab}>Run trace</span>
              {trace === null ? (
                traceLoading ? (
                  <Skeleton />
                ) : (
                  <PixelButton onClick={() => void readTrace(run)}>Show the run trace</PixelButton>
                )
              ) : (
                <>
                  <div className={w.row} data-testid="run-trace-read">
                    <span className={px.dim}>read at {formatTime(traceRead?.at)}</span>
                    {outOfDate && (
                      <StatusMark state="none" tone="neutral">
                        out of date
                      </StatusMark>
                    )}
                    <PixelButton onClick={() => void readTrace(run)} disabled={traceLoading}>
                      Refresh the trace
                    </PixelButton>
                  </div>
                  {trace.events.length === 0 ? (
                    <p className={px.dim}>No events recorded for this run.</p>
                  ) : (
                    <ol className={cx(px.vellum, w.plain, outOfDate && w.outOfDate)} data-testid="run-trace">
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
                </>
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
