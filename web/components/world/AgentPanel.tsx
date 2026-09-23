"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { getAgentProgression, getAgentSchedule, talkToAgent, type AgentProgression, type AgentSchedule } from "../../lib/api";
import { hhmm } from "../../lib/keepTime";
import type { Desire } from "../../lib/living";
import { errorText } from "../../lib/keep";
import { readRunAnswer } from "../../lib/workAnswer";
import { Markdown } from "../deliverable/DocumentView";
import { PixelButton, StatusMark, cx, px } from "../pixel/Pixel";
import { RoleIcon } from "../agents/RoleIcon";
import s from "./living.module.css";

export const TALK_POLL_MS = 2_000;
const SLOW_AFTER_MS = 60_000;
const MAX_MESSAGE = 2_000;

/**
 * The status line, from the runtime only. Ambient walking, resting or gathering is "Idle": it is never
 * worded as work. `activityLabel` is the real run's activity ("thinking", "research").
 */
export function statusLine(desire: Desire, activityLabel: string | null, areaName: string | null): { text: string; tone: "active" | "wait" | "fail" | "neutral" } {
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
  switch (desire.kind) {
    case "stopped":
      return { text: "Stopped", tone: "fail" };
    case "wait":
      return { text: "Awaiting approval", tone: "wait" };
    case "paused":
      return { text: "Paused", tone: "wait" };
    case "work":
      return { text: `Working · ${cap(activityLabel ?? "working")}`, tone: "active" };
    case "queued":
      return { text: "Queued to start", tone: "neutral" };
    case "waiting_dependency":
      return { text: `Waiting · ${desire.detail}`, tone: "wait" };
    case "break":
      return { text: `On a break${desire.until ? ` · back around ${new Date(desire.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}`, tone: "neutral" };
    case "off":
      return { text: desire.detail, tone: "neutral" };
    case "meeting":
      return { text: `${desire.phase === "in_meeting" ? "In a meeting" : "Gathering for a meeting"} · ${desire.title}`, tone: "neutral" };
    case "idle":
      return { text: `Idle${areaName ? ` · ${areaName}` : ""}`, tone: "neutral" };
  }
}

type Talk =
  | { phase: "closed" }
  | { phase: "writing" }
  | { phase: "sending" }
  | { phase: "refused"; error: string }
  | { phase: "working"; workflowRunId: string; since: number; slow: boolean }
  /** Talking to the Manager starts a mission: followed in Command, not polled here as a reply. */
  | { phase: "mission"; goalId: string }
  | { phase: "answered"; workflowRunId: string; artifactId: string; reply: string }
  | { phase: "failed"; workflowRunId: string | null; error: string };

/** The API's refusal sentence, without the request line around it. */
const refusalText = (err: unknown) => errorText(err).replace(/^API request failed: \S+ \S+ -> \d+ [^:]*: /, "");

/**
 * The small panel attached to a character in the world (R2 character interaction): who the agent is
 * (level, XP, speciality from its progression), what the runtime says it is doing and where it stands,
 * and Talk. A talk is real governed work (`POST /agents/:id/talk`): the panel only sends the message and
 * then reads the run's own records — working, failed with the recorded reason, or the reply document.
 */
export function AgentPanel({
  name,
  agentDefinitionId,
  desire,
  activityLabel,
  areaName,
  onClose,
}: {
  name: string;
  /** The latest version's id; the API resolves the persistent agent from it. */
  agentDefinitionId: string;
  desire: Desire;
  activityLabel: string | null;
  areaName: string | null;
  onClose: () => void;
}) {
  const [progress, setProgress] = useState<AgentProgression | "error" | null>(null);
  const [schedule, setSchedule] = useState<AgentSchedule | "error" | null>(null);
  const [talk, setTalk] = useState<Talk>({ phase: "closed" });
  const [message, setMessage] = useState("");
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  const box = useRef<HTMLElement>(null);
  // Once, on opening: pan the world just enough to show the whole panel. It never chases the character afterwards.
  useEffect(() => {
    box.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, []);

  useEffect(() => {
    let live = true;
    getAgentProgression(name)
      .then((p) => live && setProgress(p))
      .catch(() => live && setProgress("error"));
    getAgentSchedule(name)
      .then((sc) => live && setSchedule(sc))
      .catch(() => live && setSchedule("error"));
    return () => {
      live = false;
    };
  }, [name]);
  useEffect(
    () => () => {
      if (poll.current) clearInterval(poll.current);
    },
    []
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const status = statusLine(desire, activityLabel, areaName);
  const talking = talk.phase === "sending" || talk.phase === "working";
  // The API refuses these too; saying so first spares a request that would only be refused.
  const busyReason =
    talking || talk.phase === "answered" || talk.phase === "mission"
      ? null
      : desire.kind === "stopped"
        ? `${name} is stopped.`
        : desire.kind === "wait"
          ? `${name} is waiting for an approval.`
          : desire.kind === "paused"
            ? `${name} has paused work.`
            : desire.kind === "work" || desire.kind === "queued"
              ? `${name} is working. Talk when it is free.`
              : desire.kind === "meeting" && desire.phase === "in_meeting"
                ? `${name} is in a meeting until ${schedule && schedule !== "error" ? hhmm(desire.endsAt, schedule.timezone) : "it ends"}.`
                : null;

  async function send(e: FormEvent) {
    e.preventDefault();
    const text = message.trim();
    if (!text) return;
    setTalk({ phase: "sending" });
    try {
      const { workflowRunId, goalId, mission } = await talkToAgent(agentDefinitionId, text);
      if (mission) return setTalk({ phase: "mission", goalId });
      const since = Date.now();
      setTalk({ phase: "working", workflowRunId, since, slow: false });
      if (poll.current) clearInterval(poll.current);
      poll.current = setInterval(() => {
        readRunAnswer(workflowRunId, "deliverable")
          .then((a) => {
            if (a.phase === "working") return setTalk({ phase: "working", workflowRunId, since, slow: Date.now() - since > SLOW_AFTER_MS });
            if (poll.current) clearInterval(poll.current);
            if (a.phase === "answered") setTalk({ phase: "answered", workflowRunId, artifactId: a.artifactId, reply: a.doc.body });
            else if (a.phase === "failed") setTalk({ phase: "failed", workflowRunId, error: `The talk failed${a.reason ? `: ${a.reason.replace(/_/g, " ")}` : ""}.` });
            else setTalk({ phase: "failed", workflowRunId, error: "The talk finished without a readable reply." });
          })
          .catch((err) => setTalk({ phase: "failed", workflowRunId, error: errorText(err) }));
      }, TALK_POLL_MS);
    } catch (err) {
      setTalk({ phase: "refused", error: refusalText(err) });
    }
  }

  const p = progress && progress !== "error" ? progress : null;
  const filled = p ? Math.max(0, Math.min(10, Math.floor(((p.xp - p.levelStartXp) / Math.max(1, p.nextLevelXp - p.levelStartXp)) * 10))) : 0;

  return (
    <section ref={box} className={cx(px.board, s.panel)} aria-label={`${name} in the world`} data-testid="agent-panel" onPointerDown={(e) => e.stopPropagation()}>
      <header className={s.panelHead}>
        <span className={s.panelName}>
          <RoleIcon agentName={name} size={14} /> {name}
        </span>
        {p && (
          <span className={s.panelLevel} aria-label={`Level ${p.level}`}>
            Lv {p.level}
          </span>
        )}
        <button type="button" className={s.panelClose} onClick={onClose} aria-label={`Close ${name}`}>
          ×
        </button>
      </header>
      {progress === null ? (
        <p className={px.dim}>· · ·</p>
      ) : progress === "error" ? (
        <p className={px.dim}>Progress unavailable.</p>
      ) : (
        <div className={s.panelXp}>
          <span className={s.panelBar} role="img" aria-label={`${p!.xp - p!.levelStartXp} of ${p!.nextLevelXp - p!.levelStartXp} XP toward level ${p!.level + 1}`}>
            {Array.from({ length: 10 }, (_, i) => (
              <span key={i} className={cx(s.panelSeg, i < filled && s.panelSegOn)} />
            ))}
          </span>
          <span>{p!.xp.toLocaleString("en-GB")} XP</span>
          {p!.specialisation && <span className={px.dim}>{p!.specialisation.domain} specialist</span>}
        </div>
      )}
      <div className={s.panelStatus} data-testid="agent-status">
        <StatusMark state={desire.kind === "idle" ? "none" : desire.kind} tone={status.tone}>
          {status.text}
        </StatusMark>
      </div>
      {areaName && desire.kind !== "idle" && <div className={px.dim}>At {areaName}</div>}
      {desire.kind === "meeting" && (
        <div className={px.dim}>
          {desire.roomName}
          {desire.areaName ? "" : " (not on the map)"}
        </div>
      )}
      <div className={s.panelSchedule} data-testid="agent-schedule">
        {schedule === null ? (
          <span className={px.dim}>· · ·</span>
        ) : schedule === "error" ? (
          <span className={px.dim}>Schedule unavailable.</span>
        ) : (
          <>
            <span className={s.panelScheduleHead}>Today ({schedule.timezone})</span>
            {schedule.meetings.length + schedule.entries.length === 0 ? (
              <span className={px.dim}>Nothing scheduled.</span>
            ) : (
              <ul className={s.panelScheduleList}>
                {[
                  ...schedule.meetings.map((m) => ({ key: m.id, at: m.startsAt, text: `${hhmm(m.startsAt, schedule.timezone)}–${hhmm(m.endsAt, schedule.timezone)} ${m.title} · ${m.roomName}${m.status === "cancelled" ? " (cancelled)" : m.status === "completed" ? " (done)" : ""}` })),
                  ...schedule.entries.map((e) => ({ key: e.id, at: e.startsAt, text: `${hhmm(e.startsAt, schedule.timezone)}–${hhmm(e.endsAt, schedule.timezone)} ${e.kind.replace("_", " ")}: ${e.title}` })),
                ]
                  .sort((a, b) => a.at.localeCompare(b.at))
                  .slice(0, 4)
                  .map((i) => (
                    <li key={i.key}>{i.text}</li>
                  ))}
              </ul>
            )}
            {schedule.next && (
              <span>
                Next meeting: {schedule.next.title} · {new Intl.DateTimeFormat("en-GB", { timeZone: schedule.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(schedule.next.startsAt))} · {schedule.next.roomName}
              </span>
            )}
            <Link href={`/calendar?agent=${encodeURIComponent(name)}`} className={s.panelLink}>
              Calendar
            </Link>
          </>
        )}
      </div>

      {talk.phase === "closed" || talk.phase === "refused" ? (
        <div className={s.panelActions}>
          <PixelButton onClick={() => setTalk({ phase: "writing" })} disabled={busyReason !== null}>
            Talk to {name}
          </PixelButton>
          <Link href={`/agents/${agentDefinitionId}`} className={s.panelLink}>
            View profile
          </Link>
        </div>
      ) : null}
      {busyReason && talk.phase === "closed" && <p className={px.dim}>{busyReason}</p>}
      {talk.phase === "refused" && (
        <p role="alert" className={s.panelError}>
          Not started: {talk.error}
        </p>
      )}

      {(talk.phase === "writing" || talk.phase === "sending") && (
        <form onSubmit={send} className={s.panelForm} aria-label={`Talk to ${name}`}>
          <textarea
            className={px.input}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={MAX_MESSAGE}
            rows={3}
            placeholder={`Ask ${name} something`}
            aria-label="Message"
            disabled={talk.phase === "sending"}
            autoFocus
          />
          <p className={px.dim}>Real work: uses {name}&apos;s own keys and budget. It can answer and propose, not act.</p>
          <div className={s.panelActions}>
            <PixelButton type="submit" kind="approve" disabled={talk.phase === "sending" || !message.trim()}>
              {talk.phase === "sending" ? "Sending…" : "Send"}
            </PixelButton>
            <PixelButton onClick={() => setTalk({ phase: "closed" })} disabled={talk.phase === "sending"}>
              Cancel
            </PixelButton>
          </div>
        </form>
      )}

      {talk.phase === "mission" && (
        <div role="status" className={s.panelWork} data-testid="agent-mission">
          <StatusMark state="active" tone="active">
            Mission started: {name} is planning the work
          </StatusMark>
          <Link href={`/command?goal=${talk.goalId}`} className={s.panelLink}>
            Follow it in Command
          </Link>
        </div>
      )}

      {talk.phase === "working" && (
        <div role="status" className={s.panelWork}>
          <StatusMark state="active" tone="active">
            {name} is working on it
          </StatusMark>
          {talk.slow && <p className={px.dim}>Still working after a minute.</p>}
          <Link href={`/workflows/${talk.workflowRunId}`} className={s.panelLink}>
            Watch the run
          </Link>
        </div>
      )}

      {talk.phase === "answered" && (
        <div className={s.panelReply} data-testid="agent-reply">
          <div className={s.panelQuote}>
            <Markdown text={talk.reply} />
          </div>
          <div className={s.panelActions}>
            <Link href={`/workflows/${talk.workflowRunId}`} className={s.panelLink}>
              View full work
            </Link>
            <Link href={`/artifacts/${talk.artifactId}`} className={s.panelLink}>
              Reply artifact
            </Link>
            <PixelButton
              onClick={() => {
                setMessage("");
                setTalk({ phase: "writing" });
              }}
            >
              Talk again
            </PixelButton>
          </div>
        </div>
      )}

      {talk.phase === "failed" && (
        <div role="alert" className={s.panelError}>
          {talk.error}{" "}
          {talk.workflowRunId && (
            <Link href={`/workflows/${talk.workflowRunId}`} className={s.panelLink}>
              Open the run
            </Link>
          )}
        </div>
      )}
    </section>
  );
}
