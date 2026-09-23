"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { getMission, getWorkplaceSettings, listMissions, startMission, type MissionDetail, type MissionStatus } from "../../lib/api";
import { hhmm } from "../../lib/keepTime";
import { AgentLabel, AgentLabels } from "../../components/agents/RoleIcon";
import { useRefetchOnEvents } from "../../components/live";
import { Markdown } from "../../components/deliverable/DocumentView";
import { PixelButton, RefreshNotice, Skeleton, StateNotice, StatusMark, cx, px } from "../../components/pixel/Pixel";
import { errorText, formatTime } from "../../lib/keep";
import c from "./command.module.css";

const MISSION_POLL_MS = 3_000;
const MAX_OBJECTIVE = 2_000;

const STATUS_WORDS: Record<MissionStatus, string> = {
  planning: "the Manager is planning",
  working: "agents are working",
  awaiting_approval: "waiting for your approval",
  paused: "paused",
  completed: "completed",
  escalated: "escalated to you",
  failed: "failed",
  stopped: "stopped",
  finished_without_report: "finished without a report",
};
const TONES: Record<MissionStatus, "active" | "wait" | "done" | "fail" | "neutral"> = {
  planning: "active",
  working: "active",
  awaiting_approval: "wait",
  paused: "wait",
  completed: "done",
  escalated: "wait",
  failed: "fail",
  stopped: "fail",
  finished_without_report: "neutral",
};
/** A mission that can still change by itself or by an operator decision elsewhere keeps being re-read. */
const unfinished = (s: MissionStatus) => s === "planning" || s === "working" || s === "awaiting_approval" || s === "paused";
/** Plain words for the deterministic reason codes; the code itself is shown too. */
const REASON_WORDS: Record<string, string> = {
  validation_rejected: "the plan failed validation",
  manager_escalated: "the Manager escalated",
  worker_failed: "a worker failed",
  worker_timed_out: "a worker ran out of time",
  worker_unavailable: "an agent was not available",
  budget_denied: "budget refused",
  approval_required: "waiting for an approval",
  approval_rejected: "an approval was rejected or expired",
  emergency_stopped: "an emergency stop",
  capability_unavailable: "a capability was not available",
  evidence_invalid: "work judged insufficient",
  deliverable_invalid: "a worker did not finish its task",
  verification_failed: "a deliverable failed verification",
  mission_limit_reached: "a mission limit was reached",
  manager_planning_failed: "the Manager's planning failed",
  manager_review_failed: "the Manager's review failed",
  invalid_meeting: "the meeting request was invalid",
  duplicate_meeting: "that meeting is already scheduled",
  unknown_participant: "a participant does not exist",
  participant_unavailable: "a participant is unavailable",
  participant_conflict: "a participant is already booked",
  outside_working_hours: "outside working hours",
  room_not_found: "no such room",
  room_inactive: "the room is not in use",
  insufficient_room_capacity: "no room seats everyone",
  room_conflict: "the room is already booked",
  no_common_availability: "no time when everyone is free",
  meeting_not_found: "no such meeting",
  meeting_not_changeable: "the meeting can no longer be changed",
};
/**
 * The phase of the mission each recorded fact belongs to, and its tone. Fixed maps over the event types
 * the mission trace carries — the phase is READ from the event, never inferred from anything else.
 */
const PHASE_OF: Record<string, string> = {
  goal_created: "opened",
  manager_plan_validated: "planned",
  manager_plan_rejected: "refused",
  manager_work_delegated: "delegated",
  workflow_run_started: "working",
  approval_required: "waiting",
  approval_granted: "approved",
  approval_rejected: "refused",
  approval_expired: "expired",
  manager_review_decided: "reviewed",
  manager_recovery_started: "recovering",
  manager_recovery_decided: "recovering",
  meeting_scheduled: "meeting",
  meeting_rescheduled: "meeting",
  meeting_cancelled: "meeting",
  run_halted: "stopped",
  invocation_failed: "failed",
  run_failed: "failed",
  workflow_run_failed: "failed",
  budget_denied: "refused",
  policy_evaluated: "checked",
  workflow_run_completed: "done",
  goal_completed: "done",
  goal_failed: "failed",
};

const TRACE_TONES: Record<string, "active" | "wait" | "done" | "fail" | "neutral"> = {
  goal_completed: "done",
  workflow_run_completed: "done",
  approval_granted: "done",
  manager_plan_validated: "done",
  goal_failed: "fail",
  run_failed: "fail",
  workflow_run_failed: "fail",
  invocation_failed: "fail",
  manager_plan_rejected: "fail",
  approval_rejected: "fail",
  budget_denied: "fail",
  run_halted: "fail",
  approval_required: "wait",
  approval_expired: "wait",
  manager_recovery_started: "wait",
  manager_recovery_decided: "wait",
  workflow_run_started: "active",
  manager_work_delegated: "active",
};

const refusalText = (err: unknown) => errorText(err).replace(/^API request failed: \S+ \S+ -> \d+ [^:]*: /, "");

/**
 * Command (R2 management layer): give the Manager an objective and follow the mission. Everything shown
 * is read from the mission's records (`GET /manager/missions/:goalId`): the code-validated plan, the
 * Workflow Runs and their steps, the Manager's review and its code-made decision, blockers and links.
 * The Manager organises; the Keeper explains; specialist agents do the work; the runtime decides.
 */
export default function CommandPage() {
  const [objective, setObjective] = useState("");
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [list, setList] = useState<Awaited<ReturnType<typeof listMissions>> | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [mission, setMission] = useState<MissionDetail | null>(null);
  const [missionError, setMissionError] = useState<string | null>(null);

  // The URL follows the selection, so a mission a notice or the Keeper linked to can be linked to again.
  useEffect(() => {
    if (!selected || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("goal") === selected) return;
    url.searchParams.set("goal", selected);
    window.history.replaceState(null, "", url);
  }, [selected]);

  useEffect(() => {
    const goal = new URLSearchParams(window.location.search).get("goal");
    if (goal) setSelected(goal);
  }, []);

  const loadList = useCallback(async () => {
    try {
      const l = await listMissions();
      setList(l);
      setListError(null);
      setSelected((current) => current ?? l.missions[0]?.goal.id ?? null);
    } catch (err) {
      setListError(errorText(err));
    }
  }, []);
  const loadMission = useCallback(async () => {
    if (!selected) return;
    try {
      setMission(await getMission(selected));
      setMissionError(null);
    } catch (err) {
      setMissionError(errorText(err));
    }
  }, [selected]);

  useEffect(() => {
    void loadList();
  }, [loadList]);
  useEffect(() => {
    setMission(null);
    void loadMission();
  }, [loadMission]);
  useRefetchOnEvents(() => {
    void loadList();
    void loadMission();
  });
  // While the mission runs, re-read on a steady cadence too (events may arrive between steps).
  const running = mission !== null && unfinished(mission.status);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void loadMission(), MISSION_POLL_MS);
    return () => clearInterval(t);
  }, [running, loadMission]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const text = objective.trim();
    if (!text) return;
    setSending(true);
    setRefusal(null);
    try {
      const started = await startMission(text);
      setObjective("");
      setSelected(started.goalId);
      await loadList();
    } catch (err) {
      setRefusal(refusalText(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <main className={c.screen}>
      <section className={cx(px.board, c.intake)} aria-label="Give the Manager an objective">
        <span className={px.tab}>Command</span>
        <p className={px.detail}>
          The Manager turns an objective into bounded work for the right existing agents, checks what they produce and reports back. It can only use
          agents and capabilities that exist, under their own keys, budgets and approvals. The Keeper explains; the Manager organises.
        </p>
        <form onSubmit={submit} className={c.form} aria-label="New mission">
          <label className={c.field}>
            <span className={px.label}>Objective</span>
            <textarea
              className={px.input}
              rows={4}
              maxLength={MAX_OBJECTIVE}
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              placeholder="Ask an appropriate agent to brainstorm three ideas for …, then summarise them."
              disabled={sending}
            />
          </label>
          <PixelButton type="submit" kind="approve" disabled={sending || !objective.trim()}>
            {sending ? "Giving…" : "Give to the Manager"}
          </PixelButton>
          {refusal && (
            <p role="alert" className={c.error}>
              Not started: {refusal}
            </p>
          )}
        </form>

        <div className={c.missions}>
          <span className={px.label}>Missions</span>
          {!list && listError ? (
            <StateNotice role="alert" message="Couldn't load missions." detail={listError} action={<PixelButton onClick={() => void loadList()}>Retry</PixelButton>} />
          ) : !list ? (
            <Skeleton />
          ) : list.missions.length === 0 ? (
            <p className={px.dim}>{list.manager ? "No missions yet." : "The Manager is not set up yet (run the seed)."}</p>
          ) : (
            <ul className={c.list}>
              {list.missions.map((m) => (
                <li key={m.goal.id}>
                  <button type="button" className={cx(c.row, m.goal.id === selected && c.rowSelected)} onClick={() => setSelected(m.goal.id)} aria-pressed={m.goal.id === selected}>
                    <span className={c.rowTitle}>{m.goal.objective ?? m.goal.title}</span>
                    <StatusMark state={m.status} tone={TONES[m.status]}>
                      {STATUS_WORDS[m.status]}
                    </StatusMark>
                    {/* What the operator needs to see without opening it: overdue, and how many blockers. */}
                    {m.goal.overdue && (
                      <StatusMark state="overdue" tone="wait">
                        overdue
                      </StatusMark>
                    )}
                    {m.blockers > 0 && <span className={px.dim}>{m.blockers} blocker(s)</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className={cx(px.board, c.detail)} aria-label="Mission">
        {!selected ? (
          <StateNotice message="Give the Manager an objective to start a mission." />
        ) : !mission && missionError ? (
          <StateNotice role="alert" message="Couldn't load the mission." detail={missionError} action={<PixelButton onClick={() => void loadMission()}>Retry</PixelButton>} />
        ) : !mission ? (
          <StateNotice role="status" message={<>Loading the mission <Skeleton /></>} />
        ) : (
          <MissionView mission={mission} error={missionError} />
        )}
      </section>
    </main>
  );
}

function MissionView({ mission, error }: { mission: MissionDetail; error: string | null }) {
  const plan = mission.plan;
  // A meeting's time is the Keep's (Settings → General), never this browser's clock.
  const [tz, setTz] = useState<string | null>(null);
  const hasMeeting = Boolean(plan?.meeting?.startsAt);
  useEffect(() => {
    if (!hasMeeting) return;
    getWorkplaceSettings()
      .then((d) => setTz(d.settings.timezone))
      .catch(() => setTz(null));
  }, [hasMeeting]);
  const report = mission.report;
  return (
    <div className={c.mission} data-testid="mission">
      {error && <RefreshNotice error={error} />}
      <header className={c.head}>
        <h1 className={px.heading}>{mission.goal.objective ?? mission.goal.title}</h1>
        <StatusMark state={mission.status} tone={TONES[mission.status]}>
          {STATUS_WORDS[mission.status]}
        </StatusMark>
        {mission.reason && (
          <span className={c.reason} data-testid="mission-reason">
            {REASON_WORDS[mission.reason] ?? mission.reason} <code>{mission.reason}</code>
          </span>
        )}
        <span className={px.dim}>started {formatTime(mission.goal.createdAt)}</span>
        {/* The operator's deadline. Overdue is read from the clock by the server: late is never failed. */}
        {mission.goal.dueAt && (
          <span className={mission.goal.overdue ? c.reason : px.dim} data-testid="mission-due">
            {mission.goal.overdue ? "overdue — was due " : "due "}
            {formatTime(mission.goal.dueAt)}
          </span>
        )}
      </header>

      {/* What this mission answers, when it answers a decision a meeting reached. */}
      {mission.fromDecision && (
        <p className={px.dim} data-testid="mission-from-decision">
          Started from a decision in{" "}
          <Link href={`/calendar?meeting=${mission.fromDecision.meetingId}`} className={c.link}>
            the meeting that reached it
          </Link>
          {mission.fromDecision.text ? `: “${mission.fromDecision.text}”` : "."}
        </p>
      )}

      {/* One governed recovery round, when the runtime started one. Facts only: who failed, what was decided. */}
      {mission.recovery && (
        <div className={cx(px.parchment, c.blockers)} data-testid="mission-recovery">
          <div className={px.label}>Recovery</div>
          <p>
            Round {mission.recovery.round} after {mission.recovery.failures.length > 0 ? mission.recovery.failures.map((f) => REASON_WORDS[f] ?? f).join(", ") : "a failure"}.{" "}
            {mission.recovery.action ? <>The Manager decided to <strong>{mission.recovery.action}</strong>.</> : "The Manager has not decided yet."}
          </p>
        </div>
      )}

      {/* Gated on the structured reasons it actually renders — `blockers` is the same facts as plain text. */}
      {mission.reasons.length > 0 && (
        <div className={cx(px.parchment, c.blockers)} role={["failed", "escalated", "stopped", "awaiting_approval", "paused"].includes(mission.status) ? "alert" : undefined} data-testid="mission-blockers">
          <div className={px.label}>Blockers</div>
          <ul>
            {mission.reasons.map((r) => (
              <li key={`${r.code}:${r.detail}`}>
                <code className={c.code}>{r.code}</code> {r.detail}
                {/* Provenance: the run the reason was read from. */}
                {r.runId && (
                  <>
                    {" "}
                    <Link href={`/workflows/${mission.workflowRuns.find((w) => w.steps.some((st) => st.runId === r.runId))?.id ?? mission.workflowRuns.at(-1)?.id ?? ""}`} className={c.link}>
                      the run
                    </Link>
                  </>
                )}
              </li>
            ))}
          </ul>
          {mission.pendingApprovals.length > 0 && (
            <Link href="/approvals" className={c.link}>
              Review approvals
            </Link>
          )}
        </div>
      )}

      <div className={c.block} data-testid="mission-plan">
        <div className={px.label}>Plan</div>
        {!plan ? (
          <p className={px.dim}>{mission.status === "planning" ? "The Manager is reading the workforce and planning." : "No plan was recorded."}</p>
        ) : plan.meeting ? (
          <div data-testid="mission-meeting">
            <p>
              Meeting {plan.status}: <strong>{plan.meeting.title}</strong>
              {plan.meeting.startsAt ? ` · ${tz ? `${new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(new Date(plan.meeting.startsAt))} ${hhmm(plan.meeting.startsAt, tz)}–${hhmm(plan.meeting.endsAt!, tz)} (${tz})` : "· · ·"} · ${plan.meeting.roomName}` : ""}
            </p>
            <p className={px.dim}>
              {plan.meeting.participants.length} participant(s): <AgentLabels names={plan.meeting.participants} />. Time, room and availability were decided by code.
            </p>
            <Link href={`/calendar?meeting=${plan.meeting.meetingId}`} className={c.link}>
              Open in the calendar
            </Link>
          </div>
        ) : plan.status === "delegated" ? (
          <ol className={c.tasks}>
            {plan.tasks.map((t) => (
              <li key={t.stepId}>
                <strong><AgentLabel name={t.agentName} /></strong> — {t.brief}
                <div className={px.dim}>
                  done when: {t.completionCriteria}
                  {t.dependsOn.length > 0 ? ` · after ${t.dependsOn.join(", ")}` : ""}
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p>{plan.status === "escalated" ? "The Manager escalated instead of planning." : "Validation refused the plan; nothing was delegated."}</p>
        )}
        {plan && (
          <Link href={`/artifacts/${plan.artifactId}`} className={c.link}>
            Plan record
          </Link>
        )}
      </div>

      <div className={c.block} data-testid="mission-work">
        <div className={px.label}>Work</div>
        {mission.workflowRuns.map((wr, i) => (
          <div key={wr.id} className={cx(px.vellum, c.run)}>
            <div className={c.runHead}>
              <Link href={`/workflows/${wr.id}`} className={c.link}>
                {i === 0 ? "Manager plan" : i === 1 ? "Delegated work" : "Follow-up"}
              </Link>
              <StatusMark state={wr.status}>{wr.status.replace(/_/g, " ")}</StatusMark>
            </div>
            {wr.steps.length === 0 ? (
              <p className={px.dim}>No step has started yet.</p>
            ) : (
              <ul className={c.steps}>
                {wr.steps.map((s) => (
                  <li key={s.taskInstanceId} data-testid="mission-step">
                    <span>{s.agentName ? <AgentLabel name={s.agentName} /> : "—"}</span>
                    <span className={px.dim}>{s.kind === "manager_plan" ? "plan" : s.kind === "manager_review" ? "review" : "task"}</span>
                    <StatusMark state={s.taskStatus}>{s.taskStatus.replace(/_/g, " ")}</StatusMark>
                    {s.deliverableArtifactId && (
                      <Link href={`/artifacts/${s.deliverableArtifactId}`} className={c.link}>
                        output
                      </Link>
                    )}
                    {s.completion?.status && s.completion.status !== "complete" && <span className={c.failure}>loop ended {s.completion.status} ({s.completion.reason})</span>}
                    {s.failure && (
                      <span className={c.failure}>
                        {s.failureCode && <code className={c.code}>{s.failureCode}</code>} {s.failure}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>

      {report && (
        <div className={c.block} data-testid="mission-result">
          <div className={px.label}>{report.status === "completed" ? "Result" : report.status === "follow_up_started" ? "Review: follow-up started" : "Review: escalated"}</div>
          {report.status === "follow_up_started" && report.followUpWorkflowRunId && (
            <Link href={`/workflows/${report.followUpWorkflowRunId}`} className={c.link}>
              Follow-up run
            </Link>
          )}
          {report.body && (
            <div className={c.result}>
              <Markdown text={report.body} />
            </div>
          )}
          <div className={px.label}>Evidence</div>
          <ul className={c.steps}>
            {report.work.map((w) => (
              <li key={w.artifactId}>
                <span><AgentLabel name={w.agentName} /></span>
                <span className={w.verified ? undefined : c.failure}>{w.verified ? "verified by code" : `not verified: ${w.problems.join("; ")}`}</span>
                {w.workerLoop && w.workerLoop.status !== "complete" && <span className={c.failure}>loop ended {w.workerLoop.status} ({w.workerLoop.reason})</span>}
                <Link href={`/artifacts/${w.artifactId}`} className={c.link}>
                  deliverable
                </Link>
              </li>
            ))}
          </ul>
          <Link href={`/artifacts/${report.artifactId}`} className={c.link}>
            Mission report
          </Link>
        </div>
      )}

      {/*
        The mission's timeline: the runtime's own recorded sequence (`trace`), not a story assembled here.
        Each line is one event, in order, with the phase it belongs to READ from the event type. Rendered
        even when empty, because "nothing recorded yet" is the honest answer rather than a missing section.
      */}
      {(
        <div className={c.block} data-testid="mission-trace">
          <div className={px.label}>Timeline · {mission.trace.length} recorded facts</div>
          <ol className={c.trace}>
            {mission.trace.map((e) => (
              <li key={e.seq} className={c.traceLine}>
                <StatusMark state={PHASE_OF[e.type] ?? "recorded"} tone={TRACE_TONES[e.type] ?? "neutral"} surface="parchment" />
                <span className={px.dim}>{formatTime(e.at, true)}</span> <code className={c.code}>{e.type}</code> {e.summary}
                {e.runId && <span className={px.dim}> · run {e.runId.slice(0, 8)}</span>}
                {e.actor && e.actor !== "system" && <span className={px.dim}> · {e.actor.replace(/^agent:/, "")}</span>}
              </li>
            ))}
          </ol>
          {mission.trace.length === 0 && <p className={px.dim}>Nothing has been recorded for this mission yet.</p>}
        </div>
      )}

      <p className={px.dim}>
        Provenance: <Link href={`/history?q=${encodeURIComponent(mission.goal.title)}`} className={c.link}>goal in History</Link>. The Manager&apos;s words are not status: status comes from the runs and
        code-checked records.
      </p>
    </div>
  );
}
