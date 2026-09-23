"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { archiveFinished, getHistory, getHistoryWorkflowRuns, setGoalArchived, type HistoryData, type HistoryGoal, type HistoryWorkflowRun } from "../../lib/api";
import { useRefetchOnEvents } from "../../components/live";
import { PixelButton, RefreshNotice, Skeleton, StateNotice, StatusMark, cx, px } from "../../components/pixel/Pixel";
import { errorText, formatTime } from "../../lib/keep";
import h from "./history.module.css";
import { AgentLabels } from "../../components/agents/RoleIcon";

const LIFECYCLE_WORDS: Record<string, string> = {
  active: "active",
  awaiting_approval: "awaiting approval",
  paused: "paused",
  completed: "completed",
  failed: "failed",
  stopped: "stopped (emergency stop)",
};
const TONES: Record<string, "active" | "wait" | "done" | "fail" | "neutral"> = {
  active: "active",
  awaiting_approval: "wait",
  paused: "wait",
  completed: "done",
  failed: "fail",
  stopped: "fail",
};

type Filters = {
  lifecycle: string;
  archived: string;
  agent: string;
  workflow: string;
  from: string;
  to: string;
  q: string;
};
const EMPTY: Filters = {
  lifecycle: "",
  archived: "include",
  agent: "",
  workflow: "",
  from: "",
  to: "",
  q: "",
};

const RUN_TONES: Record<string, "active" | "wait" | "done" | "fail"> = {
  in_progress: "active",
  paused: "wait",
  completed: "done",
  failed: "fail",
};
const AGES: [number, string][] = [
  [24, "more than a day ago"],
  [168, "more than a week ago"],
  [720, "more than 30 days ago"],
  [0, "at any time"],
];

/**
 * Bulk archive (plan §14): every finished goal idle longer than the chosen age, in one confirmed
 * action. The count comes from the API's dry run and the archive repeats it, so it never archives
 * more than was shown. Nothing is deleted; each goal stays here, under "archived".
 */
function BulkArchive({ onDone }: { onDone: () => Promise<void> }) {
  const [hours, setHours] = useState(168);
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(confirmCount?: number) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await archiveFinished(hours, confirmCount);
      if (confirmCount === undefined) setCount(result.count);
      else {
        setCount(null);
        setMessage(`Archived ${result.count} goal${result.count === 1 ? "" : "s"}. Nothing was deleted.`);
        await onDone();
      }
    } catch (err) {
      setCount(null);
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={h.bulk} role="group" aria-label="Archive finished work">
      <span className={px.label}>Archive finished work</span>
      <label className={h.field}>
        <span className={px.dim}>Finished</span>
        <select
          className={px.input}
          value={hours}
          onChange={(e) => {
            setHours(Number(e.target.value));
            setCount(null);
          }}
          disabled={busy}
        >
          {AGES.map(([v, words]) => (
            <option key={v} value={v}>
              {words}
            </option>
          ))}
        </select>
      </label>
      {count === null ? (
        <PixelButton onClick={() => void run()} disabled={busy}>
          Count
        </PixelButton>
      ) : count === 0 ? (
        <p className={px.detail}>No unarchived finished goals match.</p>
      ) : (
        <PixelButton kind="approve" onClick={() => void run(count)} disabled={busy}>
          Archive {count} goal{count === 1 ? "" : "s"}
        </PixelButton>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className={h.error}>
          {error}
        </p>
      )}
    </div>
  );
}

/** Every Workflow Run, flat, newest first — each links to its full record (tasks, runs, invocations, events, artifacts, costs, approvals). */
function RunsList({
  filters,
}: {
  filters: {
    status: string;
    archived: string;
    workflow: string;
    from: string;
    to: string;
    q: string;
  };
}) {
  const [data, setData] = useState<{
    workflowRuns: HistoryWorkflowRun[];
    capped: boolean;
    limit: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await getHistoryWorkflowRuns(filters));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [filters]);
  useEffect(() => {
    void load();
  }, [load]);
  useRefetchOnEvents(load);
  if (error && !data)
    return <StateNotice role="alert" message="Couldn't load the workflow runs." detail={error} action={<PixelButton onClick={() => void load()}>Retry</PixelButton>} />;
  if (!data)
    return (
      <StateNotice
        role="status"
        message={
          <>
            Loading workflow runs <Skeleton />
          </>
        }
      />
    );
  return (
    <>
      {error && <RefreshNotice error={error} />}
      <p className={px.detail} data-testid="history-count">
        {data.workflowRuns.length === 0
          ? "No workflow runs match."
          : `${data.workflowRuns.length}${data.capped ? "+" : ""} workflow run(s), newest first${data.capped ? ` — showing the newest ${data.limit}` : ""}.`}
      </p>
      <ul className={h.list}>
        {data.workflowRuns.map((wr) => (
          <li key={wr.id} className={cx(px.vellum, h.goal, wr.goal.archivedAt && h.archived)} data-testid="history-run">
            <div className={h.head}>
              <Link href={`/workflows/${wr.id}`} className={h.title}>
                {wr.workflow ?? "workflow run"} · {wr.goal.title}
              </Link>
              <StatusMark state={wr.status} tone={RUN_TONES[wr.status] ?? "neutral"}>
                {wr.status.replace(/_/g, " ")}
              </StatusMark>
              {wr.goal.archivedAt && <span className={h.badge}>archived</span>}
            </div>
            <div className={px.dim}>
              started {formatTime(wr.createdAt)}
              {wr.completedAt ? ` · finished ${formatTime(wr.completedAt)}` : ""}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * History / Archive (plan §13): every Goal and its work, current or finished, filtered. Archiving
 * moves a finished Goal out of the current-work lists; nothing is deleted, and the Goal, its runs,
 * artifacts, costs and explanations stay reachable from here. Lifecycles are the runtime's own
 * states — there is no draft or cancellation in the runtime, so neither is shown.
 */
export default function HistoryPage() {
  // `?q=` and `?agent=`, read once on mount. Command links here with the goal's title; before this the
  // query was silently ignored and the link landed on an unfiltered list.
  const [filters, setFilters] = useState<Filters>(() => {
    if (typeof window === "undefined") return EMPTY;
    const params = new URLSearchParams(window.location.search);
    const q = params.get("q") ?? "";
    const agent = params.get("agent") ?? "";
    return { ...EMPTY, ...(q ? { q: q.slice(0, 200) } : {}), ...(agent ? { agent } : {}) };
  });
  const [tab, setTab] = useState<"goals" | "runs">("goals");
  const [runStatus, setRunStatus] = useState("");
  const runFilters = useMemo(() => {
    const instant = (day: string, time: string) => (day ? new Date(`${day}T${time}`).toISOString() : "");
    return {
      status: runStatus,
      archived: filters.archived,
      workflow: filters.workflow,
      from: instant(filters.from, "00:00:00"),
      to: instant(filters.to, "23:59:59.999"),
      q: filters.q,
    };
  }, [filters, runStatus]);
  const [data, setData] = useState<HistoryData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { from, to, ...rest } = filters;
      // Dates are days in the operator's own time zone, sent as exact instants: from its start, to the end of "to".
      const instant = (day: string, time: string) => (day ? new Date(`${day}T${time}`).toISOString() : "");
      setData(
        await getHistory({
          ...rest,
          from: instant(from, "00:00:00"),
          to: instant(to, "23:59:59.999"),
        }),
      );
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);
  useRefetchOnEvents(load);

  const set = (key: keyof Filters) => (e: { target: { value: string } }) => setFilters((f) => ({ ...f, [key]: e.target.value }));

  async function toggleArchive(goal: HistoryGoal) {
    setBusy(goal.id);
    setActionError(null);
    try {
      await setGoalArchived(goal.id, goal.archivedAt === null);
      await load();
    } catch (err) {
      setActionError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className={h.screen}>
      <section className={cx(px.board, h.filters)} aria-label="Filter history">
        <span className={px.tab}>History</span>
        <p className={px.detail}>Current and finished work. Archiving a finished goal moves it out of the current lists; nothing is deleted.</p>
        <div className={h.tabs} role="group" aria-label="Show">
          <PixelButton aria-pressed={tab === "goals"} onClick={() => setTab("goals")}>
            Goals
          </PixelButton>
          <PixelButton aria-pressed={tab === "runs"} onClick={() => setTab("runs")}>
            Workflow runs
          </PixelButton>
        </div>
        <label className={h.field}>
          <span className={px.label}>Search titles</span>
          <input className={px.input} value={filters.q} onChange={set("q")} placeholder="retrieval-augmented" maxLength={200} />
        </label>
        {tab === "runs" ? (
          <label className={h.field}>
            <span className={px.label}>Run status</span>
            <select className={px.input} value={runStatus} onChange={(e) => setRunStatus(e.target.value)}>
              <option value="">any</option>
              {Object.keys(RUN_TONES).map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className={h.field}>
            <span className={px.label}>Status</span>
            <select className={px.input} value={filters.lifecycle} onChange={set("lifecycle")}>
              <option value="">any</option>
              {(data?.filters.lifecycles ?? Object.keys(LIFECYCLE_WORDS)).map((l) => (
                <option key={l} value={l}>
                  {LIFECYCLE_WORDS[l] ?? l}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className={h.field}>
          <span className={px.label}>Archive</span>
          <select className={px.input} value={filters.archived} onChange={set("archived")}>
            <option value="include">current and archived</option>
            <option value="exclude">current only</option>
            <option value="only">archived only</option>
          </select>
        </label>
        {tab === "goals" && (
          <label className={h.field}>
            <span className={px.label}>Agent</span>
            <select className={px.input} value={filters.agent} onChange={set("agent")}>
              <option value="">any</option>
              {data?.filters.agents.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className={h.field}>
          <span className={px.label}>Workflow</span>
          <select className={px.input} value={filters.workflow} onChange={set("workflow")}>
            <option value="">any</option>
            {data?.filters.workflows.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </label>
        <div className={h.dates}>
          <label className={h.field}>
            <span className={px.label}>From</span>
            <input className={px.input} type="date" value={filters.from} onChange={set("from")} />
          </label>
          <label className={h.field}>
            <span className={px.label}>To</span>
            <input className={px.input} type="date" value={filters.to} onChange={set("to")} />
          </label>
        </div>
        <PixelButton
          onClick={() => {
            setFilters(EMPTY);
            setRunStatus("");
          }}
        >
          Clear filters
        </PixelButton>
        <BulkArchive onDone={load} />
      </section>

      <section className={cx(px.board, h.results)} aria-label={tab === "goals" ? "Goals" : "Workflow runs"}>
        {tab === "runs" ? (
          <RunsList filters={runFilters} />
        ) : error && !data ? (
          <StateNotice role="alert" message="Couldn't load the history." detail={error} action={<PixelButton onClick={() => void load()}>Retry</PixelButton>} />
        ) : !data ? (
          <StateNotice
            role="status"
            message={
              <>
                Loading the history <Skeleton />
              </>
            }
          />
        ) : (
          <>
            {error && <RefreshNotice error={error} />}
            {actionError && (
              <p role="alert" className={h.error}>
                {actionError}
              </p>
            )}
            <p className={px.detail} data-testid="history-count">
              {data.goals.length === 0
                ? "No goals match."
                : `${data.goals.length}${data.capped ? "+" : ""} goal(s), newest first${data.capped ? ` — showing the newest ${data.limit}` : ""}.`}
            </p>
            <ul className={h.list}>
              {data.goals.map((goal) => (
                <li key={goal.id} className={cx(px.vellum, h.goal, goal.archivedAt && h.archived)} data-testid="history-goal">
                  <div className={h.head}>
                    {/*
                      A mission's goal opens in Command, where its plan, blockers, recovery and timeline
                      live. Only a mission: Command reads the Manager's own Project and 404s anything else,
                      so a link from an ordinary goal would be a link to a refusal.
                    */}
                    {goal.project === "Missions" ? (
                      <Link href={`/command?goal=${goal.id}`} className={cx(h.title, h.link)}>
                        {goal.title}
                      </Link>
                    ) : (
                      <span className={h.title}>{goal.title}</span>
                    )}
                    <StatusMark state={goal.lifecycle} tone={TONES[goal.lifecycle] ?? "neutral"}>
                      {LIFECYCLE_WORDS[goal.lifecycle] ?? goal.lifecycle}
                    </StatusMark>
                    {goal.archivedAt && <span className={h.badge}>archived {formatTime(goal.archivedAt, true)}</span>}
                  </div>
                  <div className={px.dim}>
                    {goal.project} · started {formatTime(goal.createdAt)}
                    {goal.agents.length > 0 ? (
                      <>
                        {" · "}
                        <AgentLabels names={goal.agents} />
                      </>
                    ) : null}
                  </div>
                  <div className={h.runs}>
                    {goal.workflowRuns.map((wr) => (
                      <Link key={wr.id} href={`/workflows/${wr.id}`} className={h.link}>
                        {wr.workflow ?? "workflow run"} · {wr.status.replace(/_/g, " ")}
                      </Link>
                    ))}
                  </div>
                  {goal.status !== "active" && (
                    <PixelButton onClick={() => void toggleArchive(goal)} disabled={busy === goal.id} aria-label={`${goal.archivedAt ? "Unarchive" : "Archive"} ${goal.title}`}>
                      {goal.archivedAt ? "Unarchive" : "Archive"}
                    </PixelButton>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </main>
  );
}
