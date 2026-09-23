"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  cancelMeeting,
  getCalendar,
  getRegistry,
  listNotifications,
  recordMeetingOutcome,
  rescheduleMeeting,
  scheduleMeeting,
  sendWorkplaceMessage,
  startWorkFromDecision,
  type CalendarData,
  type CalendarEntry,
  type Meeting,
  type MeetingStatus,
  type WorkplaceNotification,
  markNotificationRead,
} from "../../lib/api";
import { useRefetchOnEvents } from "../../components/live";
import { PixelButton, RefreshNotice, Skeleton, StateNotice, StatusMark, buttonClass, cx, px } from "../../components/pixel/Pixel";
import { errorText } from "../../lib/keep";
import { AgentLabel, AgentLabels } from "../../components/agents/RoleIcon";
import { WEEKDAY_NAMES, addDays, dateKey, fromWall, hhmm, minutesLabel, wall } from "../../lib/keepTime";
import c from "./calendar.module.css";

const STATUS_WORDS: Record<MeetingStatus, string> = { scheduled: "scheduled", starting: "starting", in_progress: "in progress", completed: "completed", cancelled: "cancelled" };
const TONES: Record<MeetingStatus, "active" | "wait" | "done" | "fail" | "neutral"> = { scheduled: "neutral", starting: "neutral", in_progress: "active", completed: "done", cancelled: "fail" };
const TIMINGS: [string, string][] = [
  ["asap", "As soon as everyone is free"],
  ["today", "Today"],
  ["this_afternoon", "This afternoon"],
  ["tomorrow", "Tomorrow"],
  ["tomorrow_morning", "Tomorrow morning"],
  ["tomorrow_afternoon", "Tomorrow afternoon"],
  ["this_week", "This week"],
  ["next_week", "Next week"],
];
const refusalText = (err: unknown) => errorText(err).replace(/^API request failed: \S+ \S+ -> \d+ [^:]*: /, "");
const CALENDAR_POLL_MS = 30_000;

type View = "day" | "week";
type Item = { kind: "meeting"; meeting: Meeting } | { kind: "entry"; entry: CalendarEntry };

/**
 * The Command Keep's calendar (workplace). Everything shown is read from `GET /workplace/calendar`:
 * meetings (with their derived status, room and participants) and calendar entries, laid out in the Keep's
 * configured timezone — never the browser's. Scheduling, moving and cancelling go through the API, which
 * checks every rule by code; this page decides nothing.
 */
export default function CalendarPage() {
  const [view, setView] = useState<View>("week");
  const [tab, setTab] = useState<"calendar" | "notifications">("calendar");
  const [anchor, setAnchor] = useState<{ year: number; month: number; day: number } | null>(null);
  const [agent, setAgent] = useState("");
  const [room, setRoom] = useState("");
  const [meetingsOnly, setMeetingsOnly] = useState(false);
  const [data, setData] = useState<CalendarData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [agents, setAgents] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("agent")) setAgent(q.get("agent")!);
    if (q.get("meeting")) setSelected(q.get("meeting"));
    getRegistry()
      .then((r) => setAgents([...new Set(r.agentDefinitions.map((a) => a.name))].sort()))
      .catch(() => setAgents([]));
  }, []);

  const tz = data?.settings.timezone ?? null;
  const range = useMemo(() => {
    if (!tz || !anchor) return null;
    const first = view === "week" ? addDays(anchor, 1 - wall(fromWall({ ...anchor, hour: 12, minute: 0 }, tz), tz).weekday) : anchor;
    const days = Array.from({ length: view === "week" ? 7 : 1 }, (_, i) => addDays(first, i));
    return { days, from: fromWall({ ...days[0]!, hour: 0, minute: 0 }, tz), to: fromWall({ ...addDays(days.at(-1)!, 1), hour: 0, minute: 0 }, tz) };
  }, [tz, anchor, view]);

  const load = useCallback(async () => {
    try {
      // The first read learns the Keep's timezone and today; later reads use the chosen range.
      const now = new Date();
      const from = range?.from ?? new Date(now.getTime() - 8 * 86_400_000);
      const to = range?.to ?? new Date(now.getTime() + 8 * 86_400_000);
      const d = await getCalendar(from, to, { ...(agent ? { agent } : {}), ...(room ? { room } : {}) });
      setData(d);
      setError(null);
      setAnchor((a) => a ?? (({ year, month, day }) => ({ year, month, day }))(wall(d.now, d.settings.timezone)));
    } catch (err) {
      setError(errorText(err));
    }
  }, [range, agent, room]);

  useEffect(() => {
    void load();
  }, [load]);
  useRefetchOnEvents(load);
  useEffect(() => {
    const t = setInterval(() => void load(), CALENDAR_POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const items: Item[] = data ? [...data.meetings.map((m) => ({ kind: "meeting" as const, meeting: m })), ...(meetingsOnly ? [] : data.entries.map((e) => ({ kind: "entry" as const, entry: e })))] : [];
  const startOf = (i: Item) => (i.kind === "meeting" ? i.meeting.startsAt : i.entry.startsAt);
  const selectedMeeting = data?.meetings.find((m) => m.id === selected) ?? null;
  const move = (n: number) => setAnchor((a) => (a ? addDays(a, view === "week" ? 7 * n : n) : a));

  return (
    <main className={c.screen}>
      <section className={cx(px.board, c.main)} aria-label="Calendar">
        <header className={c.toolbar}>
          <span className={px.tab}>Calendar</span>
          <div className={c.group} role="tablist" aria-label="Section">
            <button type="button" role="tab" aria-selected={tab === "calendar"} className={cx(c.toggle, tab === "calendar" && c.toggleOn)} onClick={() => setTab("calendar")}>
              Schedule
            </button>
            <button type="button" role="tab" aria-selected={tab === "notifications"} className={cx(c.toggle, tab === "notifications" && c.toggleOn)} onClick={() => setTab("notifications")}>
              Notifications
            </button>
          </div>
          {tab === "calendar" && (
            <>
              <div className={c.group} aria-label="View">
                {(["day", "week"] as const).map((v) => (
                  <button key={v} type="button" aria-pressed={view === v} className={cx(c.toggle, view === v && c.toggleOn)} onClick={() => setView(v)}>
                    {v === "day" ? "Day" : "Week"}
                  </button>
                ))}
              </div>
              <div className={c.group} aria-label="Move">
                <PixelButton onClick={() => move(-1)}>‹</PixelButton>
                <PixelButton onClick={() => data && setAnchor((({ year, month, day }) => ({ year, month, day }))(wall(new Date(), data.settings.timezone)))}>Today</PixelButton>
                <PixelButton onClick={() => move(1)}>›</PixelButton>
              </div>
              <label className={c.filter}>
                <span className={px.label}>Agent</span>
                <select className={px.input} value={agent} onChange={(e) => setAgent(e.target.value)}>
                  <option value="">Everyone</option>
                  {agents.map((a) => (
                    <option key={a}>{a}</option>
                  ))}
                </select>
              </label>
              <label className={c.filter}>
                <span className={px.label}>Room</span>
                <select className={px.input} value={room} onChange={(e) => setRoom(e.target.value)}>
                  <option value="">Any room</option>
                  {(data?.rooms ?? []).map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className={c.check}>
                <input type="checkbox" checked={meetingsOnly} onChange={(e) => setMeetingsOnly(e.target.checked)} /> Meetings only
              </label>
              <PixelButton kind="approve" onClick={() => setCreating((v) => !v)}>
                {creating ? "Close" : "New meeting"}
              </PixelButton>
            </>
          )}
        </header>

        {tab === "notifications" ? (
          <Notifications agents={agents} tz={tz} />
        ) : !data && error ? (
          <StateNotice role="alert" message="Couldn't load the calendar." detail={error} action={<PixelButton onClick={() => void load()}>Retry</PixelButton>} />
        ) : !data || !range || !tz ? (
          <Skeleton />
        ) : (
          <>
            {error && <RefreshNotice error={error} />}
            <p className={px.dim} data-testid="calendar-clock">
              Times in {tz} (the Keep&apos;s timezone). Working hours {minutesLabel(data.settings.workStartMinute)}–{minutesLabel(data.settings.workEndMinute)}. Now {hhmm(data.now, tz)}.
            </p>
            {creating && <NewMeeting agents={agents} rooms={data.rooms.filter((r) => r.active).map((r) => r.name)} defaultMinutes={data.settings.defaultMeetingMinutes} onDone={(id) => { setCreating(false); setSelected(id); void load(); }} />}
            <div className={cx(c.grid, view === "day" && c.gridDay)} data-testid="calendar-grid">
              {range.days.map((d) => {
                const key = dateKey(d);
                const today = dateKey(wall(data.now, tz)) === key;
                const dayItems = items.filter((i) => dateKey(wall(startOf(i), tz)) === key).sort((a, b) => startOf(a).localeCompare(startOf(b)));
                return (
                  <div key={key} className={cx(c.day, today && c.today)} data-testid="calendar-day">
                    <span className={c.dayHead}>
                      {WEEKDAY_NAMES[wall(fromWall({ ...d, hour: 12, minute: 0 }, tz), tz).weekday - 1]} {d.day}/{d.month}
                    </span>
                    {dayItems.length === 0 ? (
                      <span className={px.dim}>—</span>
                    ) : (
                      dayItems.map((i) =>
                        i.kind === "meeting" ? (
                          <button
                            key={i.meeting.id}
                            type="button"
                            className={cx(c.event, c.meeting, i.meeting.status === "cancelled" && c.cancelled, i.meeting.id === selected && c.eventSelected)}
                            onClick={() => setSelected(i.meeting.id)}
                            aria-pressed={i.meeting.id === selected}
                            data-testid="calendar-meeting"
                          >
                            <span className={c.time}>
                              {hhmm(i.meeting.startsAt, tz)}–{hhmm(i.meeting.endsAt, tz)}
                            </span>
                            <span className={c.title}>{i.meeting.title}</span>
                            <span className={c.sub}>
                              {i.meeting.room.name} · {i.meeting.participants.length} agents
                            </span>
                            <StatusMark state={i.meeting.status} tone={TONES[i.meeting.status]} surface="parchment">
                              {STATUS_WORDS[i.meeting.status]}
                            </StatusMark>
                          </button>
                        ) : (
                          <div key={i.entry.id} className={cx(c.event, c.entry)} data-testid="calendar-entry">
                            <span className={c.time}>
                              {hhmm(i.entry.startsAt, tz)}
                              {i.entry.endsAt !== i.entry.startsAt ? `–${hhmm(i.entry.endsAt, tz)}` : ""}
                            </span>
                            <span className={c.title}>
                              {i.entry.kind.replace("_", " ")}: {i.entry.title}
                            </span>
                            <span className={px.dim}>{i.entry.agentName ? <AgentLabel name={i.entry.agentName} /> : "everyone"}</span>
                          </div>
                        )
                      )
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </section>

      <section className={cx(px.board, c.side)} aria-label="Meeting details">
        {!selectedMeeting ? (
          <StateNotice message={tab === "notifications" ? "Notifications are internal records: invitations, reminders, changes, cancellations, assignments and announcements." : "Choose a meeting to see who, where and why."} />
        ) : (
          <MeetingDetail meeting={selectedMeeting} tz={tz!} onChanged={() => void load()} />
        )}
      </section>
    </main>
  );
}

function MeetingDetail({ meeting, tz, onChanged }: { meeting: Meeting; tz: string; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [timing, setTiming] = useState("asap");
  const [note, setNote] = useState("");
  const [decision, setDecision] = useState("");
  const act = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await work();
      setMessage(done);
      onChanged();
    } catch (err) {
      setMessage(`Not done: ${refusalText(err)}`);
    } finally {
      setBusy(false);
    }
  };
  const started = meeting.status === "in_progress" || meeting.status === "completed";
  return (
    <div className={c.detail} data-testid="meeting-detail">
      <h1 className={px.heading}>{meeting.title}</h1>
      <StatusMark state={meeting.status} tone={TONES[meeting.status]}>
        {STATUS_WORDS[meeting.status]}
      </StatusMark>
      <dl className={c.kv}>
        <dt>When</dt>
        <dd>
          {new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(new Date(meeting.startsAt))} {hhmm(meeting.startsAt, tz)}–{hhmm(meeting.endsAt, tz)} ({tz})
        </dd>
        <dt>Room</dt>
        <dd>
          {meeting.room.name} · seats {meeting.room.capacity}
          {meeting.room.locationAreaName ? ` · ${meeting.room.locationAreaName}` : " · not on the map"}
        </dd>
        <dt>Organiser</dt>
        <dd>{meeting.organiser.startsWith("agent:") ? <AgentLabel name={meeting.organiser.slice(6)} /> : meeting.organiser}</dd>
        <dt>Participants</dt>
        <dd data-testid="meeting-participants">
          <AgentLabels names={meeting.participants.map((p) => p.agentName)} />
        </dd>
        {meeting.goalId && (
          <>
            <dt>Scheduled by</dt>
            <dd>
              <Link href={`/command?goal=${meeting.goalId}`}>the Manager&apos;s mission</Link>
            </dd>
          </>
        )}
        {meeting.revision > 1 && (
          <>
            <dt>Moved</dt>
            <dd>{meeting.revision - 1} time(s)</dd>
          </>
        )}
        {meeting.cancelReason && (
          <>
            <dt>Cancelled</dt>
            <dd>{meeting.cancelReason}</dd>
          </>
        )}
      </dl>
      {meeting.agenda && (
        <div className={c.block}>
          <span className={px.label}>Agenda</span>
          <p>{meeting.agenda}</p>
        </div>
      )}
      <div className={c.block}>
        <span className={px.label}>Notes and decisions</span>
        {meeting.notes.length + meeting.decisions.length === 0 ? (
          <p className={px.dim}>None recorded. Only what someone records here is an outcome; nothing is inferred.</p>
        ) : (
          <ul className={c.entries}>
            {meeting.notes.map((n, i) => (
              <li key={`n${i}`}>
                Note: {n.text} <span className={px.dim}>— {n.actor}</span>
              </li>
            ))}
            {meeting.decisions.map((d, i) => (
              <li key={`d${i}`}>
                Decision: {d.text} <span className={px.dim}>— {d.actor}</span>{" "}
                {meeting.actions.find((a) => a.text === d.text) ? (
                  <Link href={`/command?goal=${meeting.actions.find((a) => a.text === d.text)!.goalId}`}>work started</Link>
                ) : (
                  <PixelButton disabled={busy} onClick={() => act(() => startWorkFromDecision(meeting.id, i), "The Manager has the follow-up as a mission.")}>
                    Give to the Manager
                  </PixelButton>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {(meeting.status === "scheduled" || meeting.status === "starting") && (
        <div className={c.block}>
          <span className={px.label}>Move or cancel</span>
          <div className={c.row}>
            <select className={px.input} value={timing} onChange={(e) => setTiming(e.target.value)} aria-label="Move to">
              {TIMINGS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <PixelButton disabled={busy} onClick={() => act(() => rescheduleMeeting(meeting.id, { timing: { window: timing } }), "Moved to the earliest time everyone is free.")}>
              Move
            </PixelButton>
            <PixelButton kind="danger" disabled={busy} onClick={() => act(() => cancelMeeting(meeting.id, "cancelled by the operator"), "Cancelled. The record is kept.")}>
              Cancel meeting
            </PixelButton>
          </div>
        </div>
      )}
      {started && (
        <form
          className={c.block}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void act(() => recordMeetingOutcome(meeting.id, { ...(note.trim() ? { notes: [note.trim()] } : {}), ...(decision.trim() ? { decisions: [decision.trim()] } : {}) }), "Recorded.").then(() => {
              setNote("");
              setDecision("");
            });
          }}
        >
          <span className={px.label}>Record the outcome</span>
          <input className={px.input} value={note} onChange={(e) => setNote(e.target.value)} placeholder="A note" maxLength={2000} />
          <input className={px.input} value={decision} onChange={(e) => setDecision(e.target.value)} placeholder="A decision" maxLength={2000} />
          <PixelButton type="submit" disabled={busy || (!note.trim() && !decision.trim())}>
            Record
          </PixelButton>
        </form>
      )}
      {message && (
        <p role="status" className={c.message}>
          {message}
        </p>
      )}
    </div>
  );
}

function NewMeeting({ agents, rooms, defaultMinutes, onDone }: { agents: string[]; rooms: string[]; defaultMinutes: number; onDone: (id: string) => void }) {
  const [title, setTitle] = useState("");
  const [agenda, setAgenda] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [minutes, setMinutes] = useState(defaultMinutes);
  const [timing, setTiming] = useState("asap");
  const [roomName, setRoomName] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setRefusal(null);
    try {
      const r = await scheduleMeeting({ title: title.trim(), agenda: agenda.trim(), participants: chosen, durationMinutes: minutes, timing: { window: timing }, ...(roomName ? { roomName } : {}) });
      onDone(r.meetingId);
    } catch (err) {
      setRefusal(refusalText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className={cx(px.parchment, c.newMeeting)} onSubmit={submit} aria-label="New meeting" data-testid="new-meeting">
      <p className={px.dim}>The Keep finds the earliest time everyone is free and a room that seats them, by its own rules. You choose who, how long and roughly when.</p>
      <input className={px.input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" maxLength={120} aria-label="Title" required />
      <input className={px.input} value={agenda} onChange={(e) => setAgenda(e.target.value)} placeholder="Agenda (optional)" maxLength={2000} aria-label="Agenda" />
      <fieldset className={c.people}>
        <legend className={px.label}>Participants</legend>
        <label className={c.check}>
          <input type="checkbox" checked={chosen.length === agents.length && agents.length > 0} onChange={(e) => setChosen(e.target.checked ? agents : [])} /> Everyone
        </label>
        {agents.map((a) => (
          <label key={a} className={c.check}>
            <input type="checkbox" checked={chosen.includes(a)} onChange={(e) => setChosen((cs) => (e.target.checked ? [...cs, a] : cs.filter((x) => x !== a)))} /> <AgentLabel name={a} />
          </label>
        ))}
      </fieldset>
      <div className={c.row}>
        <label className={c.filter}>
          <span className={px.label}>Minutes</span>
          <input className={px.input} type="number" min={5} max={480} step={5} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
        </label>
        <label className={c.filter}>
          <span className={px.label}>When</span>
          <select className={px.input} value={timing} onChange={(e) => setTiming(e.target.value)}>
            {TIMINGS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className={c.filter}>
          <span className={px.label}>Room</span>
          <select className={px.input} value={roomName} onChange={(e) => setRoomName(e.target.value)}>
            <option value="">Any that fits</option>
            {rooms.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
      </div>
      <PixelButton type="submit" kind="approve" disabled={busy || !title.trim() || chosen.length === 0}>
        {busy ? "Scheduling…" : "Schedule"}
      </PixelButton>
      {refusal && (
        <p role="alert" className={c.message}>
          Not scheduled: {refusal}
        </p>
      )}
    </form>
  );
}

function Notifications({ agents, tz }: { agents: string[]; tz: string | null }) {
  const [recipient, setRecipient] = useState("");
  const [list, setList] = useState<WorkplaceNotification[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [to, setTo] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setList((await listNotifications(recipient ? `agent:${recipient}` : undefined)).notifications);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [recipient]);
  useEffect(() => {
    void load();
  }, [load]);
  useRefetchOnEvents(load);
  /** Clearing a notice changes only whether the operator has seen it: it never resolves what it describes. */
  const markRead = useCallback(
    async (id: string) => {
      try {
        await markNotificationRead(id);
        await load();
      } catch (err) {
        setError(errorText(err));
      }
    },
    [load]
  );
  async function send(e: FormEvent) {
    e.preventDefault();
    setStatus(null);
    try {
      const r = await sendWorkplaceMessage(to ? { kind: "message", recipients: [to], title: title.trim(), body: body.trim() } : { kind: "announcement", title: title.trim(), body: body.trim() });
      setStatus(`Sent to ${r.count} agent(s).`);
      setTitle("");
      setBody("");
      void load();
    } catch (err) {
      setStatus(`Not sent: ${refusalText(err)}`);
    }
  }
  return (
    <div className={c.notifications} data-testid="notifications">
      <form className={cx(px.parchment, c.newMeeting)} onSubmit={send} aria-label="Send a message">
        <p className={px.dim}>An internal record for agents to receive. No email, chat or other channel; it changes no permission, budget or work.</p>
        <div className={c.row}>
          <select className={px.input} value={to} onChange={(e) => setTo(e.target.value)} aria-label="To">
            <option value="">Announcement to everyone</option>
            {agents.map((a) => (
              <option key={a} value={a}>
                Message to {a}
              </option>
            ))}
          </select>
          <input className={px.input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" maxLength={120} aria-label="Title" />
        </div>
        <input className={px.input} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Message (optional)" maxLength={2000} aria-label="Message" />
        <PixelButton type="submit" disabled={!title.trim()}>
          Send
        </PixelButton>
        {status && <p role="status">{status}</p>}
      </form>
      <label className={c.filter}>
        <span className={px.label}>For</span>
        <select className={px.input} value={recipient} onChange={(e) => setRecipient(e.target.value)}>
          <option value="">Every agent</option>
          {agents.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
      </label>
      {!list && error ? (
        <StateNotice role="alert" message="Couldn't load notifications." detail={error} />
      ) : !list ? (
        <Skeleton />
      ) : list.length === 0 ? (
        <p className={px.dim}>No notifications delivered yet.</p>
      ) : (
        <ul className={c.entries}>
          {list.map((n) => (
            <li key={n.id} className={c.notification}>
              <span className={c.time}>{tz ? `${new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "numeric", month: "short" }).format(new Date(n.deliverAt))} ${hhmm(n.deliverAt, tz)}` : "· · ·"}</span> <strong>{n.kind.replace(/_/g, " ")}</strong> → <AgentLabel name={n.recipient.replace("agent:", "")} />: {n.title}
              {n.body && <span className={px.dim}> — {n.body}</span>}
              <span className={px.dim}> · from {n.sender}</span>
              {n.meetingId && (
                <>
                  {" "}
                  <Link href={`/calendar?meeting=${n.meetingId}`}>meeting</Link>
                </>
              )}
              {/* Provenance: a notice about a goal links to the mission it was derived from. */}
              {n.goalId && (
                <>
                  {" "}
                  <Link href={`/command?goal=${n.goalId}`}>mission</Link>
                </>
              )}
              {/* `markNotificationRead` existed and nothing called it. An operator can now clear a notice. */}
              {n.readAt === null && !n.id.startsWith("approval:") && (
                <>
                  {" "}
                  <button type="button" className={buttonClass("neutral")} onClick={() => void markRead(n.id)}>
                    Mark read
                  </button>
                </>
              )}
              {n.readAt !== null && <span className={px.dim}> · read</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
