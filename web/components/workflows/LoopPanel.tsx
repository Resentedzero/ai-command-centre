"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { getRunTrace, type RunTrace } from "../../lib/api";
import { useRefetchOnEvents } from "../live";
import { errorText, formatTime } from "../../lib/keep";
import { RefreshNotice, Skeleton, StatusMark, cx, px } from "../pixel/Pixel";
import s from "./loop.module.css";

export type LoopIteration = {
  iteration: number;
  maxIterations: number;
  action: { type: string; intent?: string; capability?: string };
  outcome: { status: string; reason?: string };
  note: string;
  decisionArtifactId: string | null;
  resultArtifactId: string | null;
  activeSeconds: number | null;
  occurredAt: string;
};

export type LoopTerminal = { status: string; reason: string; iterations: number; maxIterations: number; activeSeconds: number | null; occurredAt: string };

const LOOP_EVENT = "agent_loop_iteration_recorded";

/** The autonomous loop's progress, read only from the Run's `agent_loop_iteration_recorded` events (R4). Null when the Run has none. */
export function loopProgress(events: RunTrace["events"]): { iterations: LoopIteration[]; terminal: LoopTerminal | null } | null {
  const loop = events.filter((e) => e.eventType === LOOP_EVENT);
  if (loop.length === 0) return null;
  const iterations: LoopIteration[] = [];
  let terminal: LoopTerminal | null = null;
  for (const e of loop) {
    const p = e.payload as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" ? v : null);
    if (p.terminal && typeof p.terminal === "object") {
      const t = p.terminal as { status?: unknown; reason?: unknown };
      terminal = {
        status: String(t.status ?? "unknown"),
        reason: String(t.reason ?? "unknown"),
        iterations: num(p.iterations) ?? 0,
        maxIterations: num(p.maxIterations) ?? 0,
        activeSeconds: num(p.activeSeconds),
        occurredAt: e.occurredAt,
      };
      continue;
    }
    const action = (p.action ?? {}) as LoopIteration["action"];
    const outcome = (p.outcome ?? {}) as LoopIteration["outcome"];
    iterations.push({
      iteration: num(p.iteration) ?? 0,
      maxIterations: num(p.maxIterations) ?? 0,
      action: { type: String(action.type ?? "unknown"), intent: action.intent, capability: action.capability },
      outcome: { status: String(outcome.status ?? "unknown"), reason: outcome.reason },
      note: typeof p.note === "string" ? p.note : "",
      decisionArtifactId: typeof p.decisionArtifactId === "string" ? p.decisionArtifactId : null,
      resultArtifactId: typeof p.resultArtifactId === "string" ? p.resultArtifactId : null,
      activeSeconds: num(p.activeSeconds),
      occurredAt: e.occurredAt,
    });
  }
  return { iterations: iterations.sort((a, b) => a.iteration - b.iteration), terminal };
}

/** Why an autonomous loop ended, in plain words. The runtime's reason stays visible beside it. */
export function stopReasonWords(reason: string): string {
  switch (reason) {
    case "evidence_sufficient":
      return "the agent finished because its completion criteria were met, citing evidence that was verified";
    case "agent_finished":
      return "the agent judged the objective met, without citing verified evidence";
    case "max_iterations":
      return "it reached its iteration limit";
    case "active_time_limit":
      return "it used its active time";
    case "budget_headroom":
      return "too little budget was left for another iteration";
    default:
      return reason;
  }
}

function actionWords(a: LoopIteration["action"]): string {
  switch (a.type) {
    case "think":
      return `thought: ${a.intent ?? "unknown"}`;
    case "tool":
      return `used ${a.capability ?? "a capability"}`;
    case "gate":
      return "asked you for approval";
    case "finish":
      return "decided it was finished";
    default:
      return "made an invalid decision";
  }
}

const OUTCOME_TONE: Record<string, "done" | "neutral" | "fail"> = { completed: "done", finished: "done", refused: "neutral", skipped: "neutral" };

/**
 * Autonomous work (V1.1): what the agent decided at each iteration, what happened, and
 * why it stopped. Renders nothing for a step that is not an autonomous loop. Re-reads
 * the Run trace when events arrive; never computes state of its own.
 */
export function LoopPanel({ runId, runStatus, invocationCount }: { runId: string; runStatus: string; invocationCount: number }) {
  const [trace, setTrace] = useState<RunTrace | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTrace(await getRunTrace(runId));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load, invocationCount, runStatus]);
  useRefetchOnEvents(load);

  if (!trace) return error ? <RefreshNotice error={error} message="Couldn't read the autonomous work." /> : null;
  const progress = loopProgress(trace.events);
  if (!progress) return null;
  const last = progress.iterations.at(-1);
  const max = progress.terminal?.maxIterations ?? last?.maxIterations ?? 0;

  return (
    <section className={s.panel} aria-label="Autonomous work" data-testid="loop-panel">
      <span className={px.tab}>Autonomous work</span>
      <div className={cx(px.parchment, s.status)} data-testid="loop-status">
        {progress.terminal ? (
          <>
            <StatusMark state={progress.terminal.status} tone={progress.terminal.status === "complete" ? "done" : "neutral"} surface="parchment">
              {progress.terminal.status === "complete" ? "Finished" : "Stopped"}
            </StatusMark>
            <span>
              after {progress.terminal.iterations} of {max} iterations: {stopReasonWords(progress.terminal.reason)}
            </span>
            <span>({progress.terminal.reason})</span>
          </>
        ) : runStatus === "awaiting_approval" ? (
          <StatusMark state="awaiting_approval" surface="parchment">
            Waiting for your approval before iteration {(last?.iteration ?? 0) + 1} of {max} continues
          </StatusMark>
        ) : runStatus === "active" ? (
          <StatusMark state="active" surface="parchment">
            Working · {last ? `iteration ${last.iteration} of ${max} recorded` : "deciding its first action"}
          </StatusMark>
        ) : (
          <StatusMark state={runStatus} surface="parchment">
            The run {runStatus.replace(/_/g, " ")} before the loop concluded
          </StatusMark>
        )}
        {progress.terminal?.activeSeconds != null && <span>{Math.round(progress.terminal.activeSeconds / 60)} active min</span>}
      </div>
      <ol className={s.iterations} data-testid="loop-iterations">
        {progress.iterations.map((it) => (
          <li key={it.iteration} className={cx(px.vellum, s.iteration)}>
            <span className={px.label}>
              {it.iteration}/{it.maxIterations}
            </span>
            <span>{actionWords(it.action)}</span>
            <StatusMark state={it.outcome.status} tone={OUTCOME_TONE[it.outcome.status] ?? "neutral"}>
              {it.outcome.status}
            </StatusMark>
            {it.outcome.reason && <span className={px.dim}>{it.outcome.reason}</span>}
            {it.note && <span className={s.note}>{it.note}</span>}
            <span className={s.links}>
              {it.decisionArtifactId && (
                <Link href={`/artifacts/${it.decisionArtifactId}`} className={s.link}>
                  decision
                </Link>
              )}
              {it.resultArtifactId && (
                <Link href={`/artifacts/${it.resultArtifactId}`} className={s.link}>
                  result
                </Link>
              )}
              <span className={px.dim}>{formatTime(it.occurredAt)}</span>
            </span>
          </li>
        ))}
        {!progress.terminal && (runStatus === "active" || runStatus === "awaiting_approval") && (
          <li className={cx(px.vellum, s.iteration, s.pending)}>
            <Skeleton label="next iteration" />
          </li>
        )}
      </ol>
      <p className={px.detail}>Each iteration is a governed decision and action: its context, route, policy and budget are in the invocations below.</p>
    </section>
  );
}
