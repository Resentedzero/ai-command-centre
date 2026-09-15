"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  getRegistry,
  listActiveAgents,
  listActiveStops,
  listGoals,
  listPendingApprovals,
  listWorkflowRuns,
  type ActiveStop,
  type AgentCardData,
} from "../lib/api";
import { isStale, useLive, useRefetchOnEvents } from "../components/live";
import { RefreshNotice, PixelButton, Skeleton, StateNotice, StatusMark, buttonClass, cx, px } from "../components/pixel/Pixel";
import { StopControl } from "../components/StopControl";
import { stopFor } from "../components/agents/roster";
import { AgentSprite, WorldViewport, world } from "../components/world/World";
import {
  KEEP,
  SYSTEM_ROOMS,
  WORKSHOP_SLOTS,
  agentState,
  characterFor,
  placeInWorkshops,
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

const WORKFLOW_LIST_CAP = 100;
const OVERVIEW_REFRESH_MS = 30_000;
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
  const { status } = useLive();
  const [agents, setAgents] = useState<AgentCardData[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<Read<number>>(null);
  const [stops, setStops] = useState<Read<ActiveStop[]>>(null);
  const [goalCount, setGoalCount] = useState<Read<number>>(null);
  const [inProgress, setInProgress] = useState<Read<{ n: number; capped: boolean }>>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [definitions, setDefinitions] = useState<Read<{ id: string; name: string; version: number }[]>>(null);
  // The newest workflow run (`GET /workflow-runs` is newest first) when it failed: act-now history the board points at.
  const [latestFailed, setLatestFailed] = useState<{ id: string; title: string | null } | null>(null);

  const load = useCallback(async () => {
    const settle = <T,>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
    const [a, ap, st, g, w, r] = await Promise.all([
      settle(listActiveAgents()),
      settle(listPendingApprovals()),
      settle(listActiveStops()),
      settle(listGoals()),
      settle(listWorkflowRuns()),
      settle(getRegistry()),
    ]);
    setDefinitions(r.ok ? r.v.agentDefinitions : "error");
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
    if (w.ok) setLatestFailed(w.v[0]?.status === "failed" ? { id: w.v[0].id, title: w.v[0].goal?.title ?? null } : null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useRefetchOnEvents(load);
  // An Approval can expire with no event; re-read on the same cadence as the top bar.
  useEffect(() => {
    const timer = setInterval(() => void load(), OVERVIEW_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const groups = useMemo<Group[]>(() => {
    const byKey = new Map<string, Group>();
    for (const row of agents ?? []) {
      const key = row.agentDefinitionId ?? `run:${row.runId}`;
      const group = byKey.get(key) ?? { key, id: row.agentDefinitionId, name: row.agentName, runs: [], state: "", stop: null };
      group.runs.push(row);
      byKey.set(key, group);
    }
    return [...byKey.values()].map((g) => ({
      ...g,
      state: agentState(g.runs.map((r) => r.taskStatus)),
      stop: g.id ? stopFor(stops, g.id) : null,
    }));
  }, [agents, stops]);

  // Each active Agent Definition takes its preferred workshop; any past the two are listed on the board.
  const slots = useMemo(() => placeInWorkshops(groups), [groups]);
  const placed = useMemo(() => slots.filter((g): g is Group => g !== undefined), [slots]);
  const needsAttention = (g: Group) => g.stop !== null || g.state === "awaiting_approval";
  const selected = groups.find((g) => g.key === selectedKey) ?? groups.find(needsAttention) ?? groups[0] ?? null;
  // Pin the first automatic choice, so a refresh never moves the board (and its Stop) to another agent.
  useEffect(() => {
    if (selectedKey === null && selected) setSelectedKey(selected.key);
  }, [selectedKey, selected]);
  const onSeal = placed.filter((g) => g.state === "awaiting_approval" && !g.stop);
  const pendingN = typeof pending === "number" ? pending : 0;

  const focus = useMemo(() => {
    if (selected) {
      const slot = slots.indexOf(selected);
      if (onSeal.includes(selected)) return centreOf(SYSTEM_ROOMS.approvals);
      if (slot >= 0) return centreOf(WORKSHOP_SLOTS[slot]!);
    }
    return pendingN > 0 ? centreOf(SYSTEM_ROOMS.approvals) : centreOf(SYSTEM_ROOMS.runtime);
  }, [selected, slots, onSeal, pendingN]);

  const loaded = agents !== null;
  const definitionIds = Array.isArray(definitions) ? definitions.map((d) => d.id) : undefined;
  const count = (v: Read<number>, cap?: number) => (v === null ? <Skeleton /> : v === "error" ? "n/a" : cap ? countLabel(v, cap) : v);

  return (
    <main className={o.screen}>
      <WorldViewport width={KEEP.width} height={KEEP.height} focus={focus} label="Keep map" className={cx(o.world, (isStale(status) || (agents !== null && loadError !== null)) && world.stale)}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={KEEP.src} width={KEEP.width} height={KEEP.height} className={world.base} alt="" draggable={false} />
        <div className={world.night} />

        {/* Council hall: lit amber while any approval is pending; waiting agents stand on its seal. */}
        <Floor rect={SYSTEM_ROOMS.approvals}>
          {loaded && pendingN > 0 && <img className={world.light} src="/world/light-wait-2x.png" style={{ left: 64, top: -48 }} alt="" />}
          {loaded && (pendingN > 0 || onSeal.length > 0) && <div className={world.seal} style={{ left: 184, top: 96 }} />}
          {onSeal.map((g, i) => (
            <AgentSprite key={g.key} character={characterFor(g.id!, definitionIds)} pose="idle" footX={240 + (i - (onSeal.length - 1) / 2) * 72} footY={116} />
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
          const g = slots[slot];
          if (!g) return null;
          const pose = g.state === "awaiting_approval" && !g.stop ? null : poseFor(g.state, g.stop !== null);
          return (
            <Floor key={g.key} rect={rect}>
              {g.state === "active" && !g.stop && <img className={world.light} src="/world/light-active-2x.png" style={{ left: 0, top: 0 }} alt="" />}
              {pose && <AgentSprite character={characterFor(g.id!, definitionIds)} pose={pose} footX={176} footY={200} frozen={g.stop !== null} />}
              {g.stop && <div className={world.barrier} style={{ left: 128, top: 0, width: 96 }} />}
            </Floor>
          );
        })}

        <SystemPlaque rect={SYSTEM_ROOMS.approvals} href="/approvals" name="Approvals">
          {pending === null ? (
            <StatusMark state={null} />
          ) : pending === "error" ? (
            <span className={px.dim}>n/a</span>
          ) : (
            <StatusMark state="pending" tone={pending > 0 ? "wait" : "neutral"}>
              {pending} pending
            </StatusMark>
          )}
        </SystemPlaque>
        <SystemPlaque rect={SYSTEM_ROOMS.goals} href="/goals" name="Goals">
          <span className={px.dim}>{goalCount === null || goalCount === "error" ? count(goalCount) : `${countLabel(goalCount, GOAL_LIST_CAP)} goals`}</span>
        </SystemPlaque>
        <SystemPlaque rect={SYSTEM_ROOMS.workflows} href="/workflows" name="Workflows">
          {inProgress === null ? (
            <StatusMark state={null} />
          ) : inProgress === "error" ? (
            <span className={px.dim}>n/a</span>
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
        <span className={cx(world.plaque, world.plaqueStatic)} style={plaqueAt(SYSTEM_ROOMS.runtime)}>
          Runtime
        </span>

        {slots.map((g, slot) => g && (
          <button
            key={g.key}
            type="button"
            className={cx(world.plaque, selected?.key === g.key && world.plaqueSelected)}
            style={plaqueAt(WORKSHOP_SLOTS[slot]!)}
            aria-pressed={selected?.key === g.key}
            onClick={() => setSelectedKey(g.key)}
          >
            {g.name}
            <StatusMark state={g.stop ? "stopped" : g.state} />
            {/* One flash when a stop engages (mounted per stop), then steady; the button keeps its focus. */}
            {g.stop && <span key={g.stop.id} className={world.flashFail} aria-hidden />}
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
          <>
            <StateNotice
              message="Nothing is running. Start a goal to run a workflow."
              action={
                <Link href="/goals" className={buttonClass()}>
                  Start a goal
                </Link>
              }
            />
            {latestFailed && (
              <Link href={`/workflows/${latestFailed.id}`} className={cx(px.plaque, o.failedRun)} data-testid="latest-failed-run">
                <StatusMark state="failed">Latest run failed · {latestFailed.title ?? "Goal not found"}</StatusMark>
              </Link>
            )}
            {Array.isArray(definitions) && definitions.length > 0 && (
              <ul className={o.roster} aria-label="Agents">
                {definitions.map((d) => (
                  <li key={d.id}>
                    <Link href={`/agents/${d.id}`} className={px.plaque}>
                      <span className={o.grow}>
                        {d.name} <span className={px.dim}>v{d.version}</span>
                      </span>
                      <StatusMark state="none" tone="neutral">
                        no active run
                      </StatusMark>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          selected && (
            <AgentBoard
              groups={groups}
              selected={selected}
              definitionIds={definitionIds}
              placed={placed.includes(selected)}
              stopsUnreadable={stops === "error"}
              onSelect={setSelectedKey}
              onChanged={load}
            />
          )
        )}
        {loaded && loadError && (
          <RefreshNotice error={loadError} />
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
  definitionIds,
  placed,
  stopsUnreadable,
  onSelect,
  onChanged,
}: {
  groups: Group[];
  selected: Group;
  definitionIds: string[] | undefined;
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

      <div className={o.nameRow}>
        {selected.id && (
          // The 4x portrait shows only on screens at least 1080 px tall (screens.md laptop rule).
          <div className={o.portrait} aria-hidden>
            <AgentSprite character={characterFor(selected.id, definitionIds)} pose="idle" footX={72} footY={140} scale={2} frozen={selected.stop !== null} />
          </div>
        )}
        <h2 className={px.heading}>{selected.name}</h2>
      </div>
      {selected.id && (
        <StopControl agentId={selected.id} name={selected.name} stop={selected.stop} stopsUnreadable={stopsUnreadable} onChanged={onChanged} />
      )}
      {!placed && (
        <p className={px.detail}>
          {selected.id
            ? "No workshop is free for this agent, so it is listed here only."
            : "This run has no agent bound yet, so it has no workshop."}
        </p>
      )}

      <div className={o.runs}>
        {selected.runs.map((run) => (
          <div key={run.runId} className={px.parchment} data-testid="agent-run">
            <div className={px.label}>{run.taskDefinitionName ?? "Task definition not found"}</div>
            <div>{run.goalTitle ?? "no goal"}</div>
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
                <span className={cx(px.dim, o.ellipsis)} title={e.occurredAt}>
                  {formatTime(e.occurredAt)}
                </span>
                <span>{stateWord(e.eventType)}</span>
                <span className={px.dim}>{e.eventCursor === undefined ? "" : `#${e.eventCursor}`}</span>
              </li>
            ))}
        </ol>
      )}
    </section>
  );
}
