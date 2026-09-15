"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  engageAgentStop,
  liftAgentStop,
  listActiveAgents,
  listActiveStops,
  listGoals,
  listPendingApprovals,
  listWorkflowRuns,
  type ActiveStop,
  type AgentCardData,
} from "../lib/api";
import { isStale, useLive, useRefetchOnEvents } from "../components/live";
import { ButtonMark, PixelButton, Skeleton, StateNotice, StatusMark, buttonClass, cx, px } from "../components/pixel/Pixel";
import { AgentSprite, WorldViewport, world } from "../components/world/World";
import {
  KEEP,
  SYSTEM_ROOMS,
  WORKSHOP_SLOTS,
  characterFor,
  countLabel,
  errorText,
  floorOf,
  formatTime,
  poseFor,
  stateWord,
  type Rect,
} from "../lib/keep";
import o from "./overview.module.css";

/**
 * Overview (spec 15.1 screen 1; Figma "Overview A5 — pixel keep"): is the
 * system working, and where must I act? The keep's system rooms show real
 * counts; each active Agent Definition gets a workshop, lit by its real state.
 * An agent awaiting approval stands on the council-hall seal and its workshop
 * goes dark (one approval, one place). The board shows the selected agent with
 * Stop directly under its name. Everything rendered is an API value, client
 * state (selection, pan, feed status), chrome, or an honest absence.
 */

type Group = {
  key: string;
  id: string | null;
  name: string;
  runs: AgentCardData[];
  state: string;
  stop: ActiveStop | null;
};

type Read<T> = T | "error" | null;

/** Group state: a working Run lights the room; otherwise waiting beats pending. */
function groupState(runs: AgentCardData[]): string {
  for (const s of ["active", "awaiting_approval", "pending"]) if (runs.some((r) => r.taskStatus === s)) return s;
  return runs[0]!.taskStatus;
}

const WORKFLOW_LIST_CAP = 100;
const GOAL_LIST_CAP = 500;

function plaqueAt(r: Rect) {
  return { left: r.x + r.w / 2, top: r.y + r.wall - 40 };
}
function centreOf(r: Rect) {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

function Floor({ rect, children }: { rect: Rect; children: ReactNode }) {
  return (
    <div className={world.floor} style={floorOf(rect)}>
      {children}
    </div>
  );
}

export default function OverviewPage() {
  const { status, events } = useLive();
  const [agents, setAgents] = useState<AgentCardData[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<Read<number>>(null);
  const [stops, setStops] = useState<Read<ActiveStop[]>>(null);
  const [goalCount, setGoalCount] = useState<Read<number>>(null);
  const [inProgress, setInProgress] = useState<Read<{ n: number; capped: boolean }>>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    const settle = <T,>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
    const [a, ap, st, g, w] = await Promise.all([
      settle(listActiveAgents()),
      settle(listPendingApprovals()),
      settle(listActiveStops()),
      settle(listGoals()),
      settle(listWorkflowRuns()),
    ]);
    if (a.ok) {
      setAgents(a.v);
      setLoadError(null);
    } else {
      setLoadError(errorText(a.e));
    }
    setPending(ap.ok ? ap.v.length : "error");
    setStops(st.ok ? st.v : "error");
    setGoalCount(g.ok ? g.v.reduce((n, p) => n + p.goals.length, 0) : "error");
    setInProgress(w.ok ? { n: w.v.filter((r) => r.status === "in_progress").length, capped: w.v.length >= WORKFLOW_LIST_CAP } : "error");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useRefetchOnEvents(load);

  const groups = useMemo<Group[]>(() => {
    const byKey = new Map<string, Group>();
    for (const row of agents ?? []) {
      const key = row.agentDefinitionId ?? `run:${row.runId}`;
      const group = byKey.get(key) ?? { key, id: row.agentDefinitionId, name: row.agentName, runs: [], state: "", stop: null };
      group.runs.push(row);
      byKey.set(key, group);
    }
    const stopList = Array.isArray(stops) ? stops : [];
    return [...byKey.values()].map((g) => ({
      ...g,
      state: groupState(g.runs),
      stop: g.id
        ? (stopList.find((s) => s.scope === "agent_definition" && s.scopeRefId?.toLowerCase() === g.id!.toLowerCase()) ?? null)
        : null,
    }));
  }, [agents, stops]);

  // Workshops go to active Agent Definitions in stable id order; the rest are listed on the board.
  const placed = useMemo(() => groups.filter((g) => g.id).sort((a, b) => (a.id! < b.id! ? -1 : 1)).slice(0, WORKSHOP_SLOTS.length), [groups]);
  const needsAttention = (g: Group) => g.stop !== null || g.state === "awaiting_approval";
  const selected = groups.find((g) => g.key === selectedKey) ?? groups.find(needsAttention) ?? groups[0] ?? null;
  const onSeal = placed.filter((g) => g.state === "awaiting_approval" && !g.stop);
  const pendingN = typeof pending === "number" ? pending : 0;

  const focus = useMemo(() => {
    if (selected) {
      const slot = placed.indexOf(selected);
      if (onSeal.includes(selected)) return centreOf(SYSTEM_ROOMS.approvals);
      if (slot >= 0) return centreOf(WORKSHOP_SLOTS[slot]!);
    }
    return pendingN > 0 ? centreOf(SYSTEM_ROOMS.approvals) : centreOf(SYSTEM_ROOMS.runtime);
  }, [selected, placed, onSeal, pendingN]);

  const loaded = agents !== null;
  const count = (v: Read<number>, cap?: number) => (v === null ? <Skeleton /> : v === "error" ? "n/a" : cap ? countLabel(v, cap) : v);

  return (
    <main className={o.screen}>
      <WorldViewport width={KEEP.width} height={KEEP.height} focus={focus} label="Keep map" className={cx(o.world, isStale(status) && world.stale)}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={KEEP.src} width={KEEP.width} height={KEEP.height} className={world.base} alt="" draggable={false} />
        <div className={world.night} />

        {/* Council hall: lit amber while any approval is pending; waiting agents stand on its seal. */}
        <Floor rect={SYSTEM_ROOMS.approvals}>
          {loaded && pendingN > 0 && <img className={world.light} src="/world/light-wait-2x.png" style={{ left: 64, top: -48 }} alt="" />}
          {loaded && (pendingN > 0 || onSeal.length > 0) && <div className={world.seal} style={{ left: 184, top: 96 }} />}
          {onSeal.map((g, i) => (
            <AgentSprite key={g.key} character={characterFor(g.id!)} pose="idle" footX={240 + (i - (onSeal.length - 1) / 2) * 72} footY={116} />
          ))}
        </Floor>

        {/* Runtime core: silver, glowing only while the live feed is up. */}
        <Floor rect={SYSTEM_ROOMS.runtime}>
          {status === "live" && (
            <>
              <img className={world.light} src="/world/light-core-2x.png" style={{ left: 64, top: 0 }} alt="" />
              {[
                [120, 60],
                [352, 60],
                [120, 190],
                [352, 190],
              ].map(([left, top]) => (
                <div key={`${left}-${top}`} className={world.rune} style={{ left, top }} />
              ))}
            </>
          )}
          <img className="px" src="/world/core-crystal-pedestal-2x.png" style={{ position: "absolute", left: 224, top: 108 }} alt="" />
        </Floor>

        {WORKSHOP_SLOTS.map((rect, slot) => {
          const g = placed[slot];
          if (!g) return null;
          const pose = g.state === "awaiting_approval" && !g.stop ? null : poseFor(g.state, g.stop !== null);
          return (
            <Floor key={g.key} rect={rect}>
              {g.state === "active" && !g.stop && <img className={world.light} src="/world/light-active-2x.png" style={{ left: 0, top: 0 }} alt="" />}
              {pose && <AgentSprite character={characterFor(g.id!)} pose={pose} footX={176} footY={200} frozen={g.stop !== null} />}
              {g.stop && <div className={world.barrier} style={{ left: 128, top: 0, width: 96 }} />}
            </Floor>
          );
        })}

        <SystemPlaque rect={SYSTEM_ROOMS.approvals} href="/approvals" name="Approvals">
          {pending === null || pending === "error" ? (
            <StatusMark state={null} />
          ) : (
            <StatusMark state="pending" tone={pending > 0 ? "wait" : "neutral"}>
              {pending} pending
            </StatusMark>
          )}
        </SystemPlaque>
        <SystemPlaque rect={SYSTEM_ROOMS.goals} href="/goals" name="Goals">
          <span className={px.dim}>{count(goalCount, GOAL_LIST_CAP)} goals</span>
        </SystemPlaque>
        <SystemPlaque rect={SYSTEM_ROOMS.workflows} href="/workflows" name="Workflows">
          {inProgress === null || inProgress === "error" ? (
            <StatusMark state={null} />
          ) : (
            <StatusMark state="in_progress" tone={inProgress.n > 0 ? "active" : "neutral"}>
              {inProgress.n}
              {inProgress.capped ? "+" : ""} in progress
            </StatusMark>
          )}
        </SystemPlaque>
        <SystemPlaque rect={SYSTEM_ROOMS.events} href="/events" name="Events">
          <StatusMark state={status} tone={status === "live" ? "done" : "neutral"} />
        </SystemPlaque>
        <SystemPlaque rect={SYSTEM_ROOMS.artifacts} href="/artifacts" name="Artifacts" />
        <span className={world.plaque} style={{ ...plaqueAt(SYSTEM_ROOMS.runtime), cursor: "default" }}>
          Runtime
        </span>

        {placed.map((g, slot) => (
          <button
            key={`${g.key}-${g.stop ? "stopped" : g.state}`}
            type="button"
            className={cx(world.plaque, selected?.key === g.key && world.plaqueSelected, g.stop && world.flashFail)}
            style={plaqueAt(WORKSHOP_SLOTS[slot]!)}
            aria-pressed={selected?.key === g.key}
            onClick={() => setSelectedKey(g.key)}
          >
            {g.name}
            <StatusMark state={g.stop ? "stopped" : g.state} />
          </button>
        ))}
      </WorldViewport>

      <aside className={cx(px.board, o.board)} aria-label="Selected agent">
        {!loaded && loadError ? (
          <StateNotice
            role="alert"
            message="Couldn't load the keep."
            detail={loadError}
            action={<PixelButton onClick={() => void load()}>Retry</PixelButton>}
          />
        ) : !loaded ? (
          <>
            <span className={px.tab}>Agents</span>
            <StateNotice role="status" message={<>Loading the keep <Skeleton /></>} />
          </>
        ) : groups.length === 0 ? (
          <StateNotice
            message="Nothing is running. Start a goal to run a workflow."
            action={
              <Link href="/goals" className={buttonClass()}>
                Start a goal
              </Link>
            }
          />
        ) : (
          selected && (
            <AgentBoard
              groups={groups}
              selected={selected}
              placed={placed.includes(selected)}
              stopsUnreadable={stops === "error"}
              onSelect={setSelectedKey}
              onChanged={load}
            />
          )
        )}
        {loaded && loadError && (
          <p role="alert" className={px.detail}>
            Couldn&apos;t refresh; showing the last read. {loadError}
          </p>
        )}
        <RecentEvents />
      </aside>
    </main>
  );
}

function SystemPlaque({ rect, href, name, children }: { rect: Rect; href: string; name: string; children?: ReactNode }) {
  return (
    <Link href={href} className={world.plaque} style={plaqueAt(rect)}>
      {name}
      {children}
    </Link>
  );
}

function AgentBoard({
  groups,
  selected,
  placed,
  stopsUnreadable,
  onSelect,
  onChanged,
}: {
  groups: Group[];
  selected: Group;
  placed: boolean;
  stopsUnreadable: boolean;
  onSelect: (key: string) => void;
  onChanged: () => Promise<void>;
}) {
  return (
    <>
      <div className={o.roster} role="group" aria-label="Active agents">
        {groups.map((g) => (
          <button
            key={g.key}
            type="button"
            className={cx(px.plaque, g.key === selected.key && px.selected)}
            aria-pressed={g.key === selected.key}
            onClick={() => onSelect(g.key)}
          >
            <span className={o.grow}>{g.name}</span>
            <StatusMark state={g.stop ? "stopped" : g.state} />
          </button>
        ))}
      </div>

      <h2 className={px.heading}>{selected.name}</h2>
      <StopControl group={selected} stopsUnreadable={stopsUnreadable} onChanged={onChanged} />
      {!placed && (
        <p className={px.detail}>
          {selected.id
            ? "This agent has no workshop in the keep: the keep has two, and they are taken."
            : "This run has no agent bound yet, so it has no workshop."}
        </p>
      )}

      <div className={o.runs}>
        {selected.runs.map((run) => (
          <div key={run.runId} className={px.parchment} data-testid="agent-run">
            <div className={px.label}>{run.taskDefinitionName ?? "Task definition not found"}</div>
            <div>{run.goalTitle ?? "Standalone task"}</div>
            <div className={o.row}>
              <StatusMark state={run.taskStatus} surface="parchment" />
              {run.latestActivitySummary && <span>latest: {stateWord(run.latestActivitySummary)}</span>}
            </div>
            {run.taskStatus === "awaiting_approval" && (
              <Link href="/approvals" className={o.inkLink}>
                Review the approval
              </Link>
            )}
          </div>
        ))}
      </div>
      {selected.id && (
        <Link href={`/agents/${selected.id}`} className={buttonClass()}>
          Open agent
        </Link>
      )}
    </>
  );
}

function StopControl({ group, stopsUnreadable, onChanged }: { group: Group; stopsUnreadable: boolean; onChanged: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setConfirming(false);
    setError(null);
  }, [group.key]);

  if (!group.id) return null;
  const id = group.id;

  async function act(action: () => Promise<void>) {
    setActing(true);
    setError(null);
    try {
      await action();
      setConfirming(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setActing(false);
      await onChanged();
    }
  }

  return (
    <div className={o.stop}>
      {group.stop ? (
        <>
          <div className={cx(px.parchment, o.grow)}>
            <StatusMark state="stopped" surface="parchment" /> {group.stop.reason ? `Reason: ${group.stop.reason}` : "No reason given"}
          </div>
          <PixelButton disabled={acting} onClick={() => act(() => liftAgentStop(id, group.stop!.id))}>
            Lift stop
          </PixelButton>
          <p className={px.detail}>Lifting does not revive work the stop already failed.</p>
        </>
      ) : confirming ? (
        <>
          <p className={o.confirm}>Stop {group.name}? Its next action is refused in every workflow. A call already running finishes.</p>
          <PixelButton kind="danger" disabled={acting} onClick={() => act(() => engageAgentStop(id))}>
            <ButtonMark tone="fail" />
            Confirm stop
          </PixelButton>
          <PixelButton disabled={acting} onClick={() => setConfirming(false)}>
            Cancel
          </PixelButton>
        </>
      ) : (
        <PixelButton kind="danger" onClick={() => setConfirming(true)}>
          <ButtonMark tone="fail" />
          Stop agent
        </PixelButton>
      )}
      {stopsUnreadable && !group.stop && <p className={px.detail}>Couldn&apos;t read active stops, so a stop already in place may not show.</p>}
      {error && (
        <p role="alert" className={px.detail}>
          {error}
        </p>
      )}
    </div>
  );
}

function RecentEvents() {
  const { status, events } = useLive();
  return (
    <section className={o.events} aria-label="Recent events">
      <span className={px.tab}>Recent events</span>
      {events.length === 0 ? (
        <p className={px.dim} style={{ margin: 0 }}>
          {status === "connecting" ? <Skeleton /> : "No events received yet."}
        </p>
      ) : (
        <ol className={px.vellum}>
          {events
            .slice(-8)
            .reverse()
            .map((e) => (
              <li key={e.eventId} data-testid="activity-item">
                <span className={px.dim}>{formatTime(e.occurredAt)}</span>
                <span className={o.ellipsis}>{stateWord(e.eventType)}</span>
                <span className={px.dim}>{e.eventCursor === undefined ? "" : `#${e.eventCursor}`}</span>
              </li>
            ))}
        </ol>
      )}
    </section>
  );
}
