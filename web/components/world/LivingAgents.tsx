"use client";

import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { ActiveStop, AgentCardData, MeetingPresence, AgentState } from "../../lib/api";
import { activityOf, desireFor } from "../../lib/activity";
import { KEEP, type AgentLook } from "../../lib/keep";
import { active, allocateWorkstations, crowdOf, inside, spawn, step, type AgentSim, type Desire, type LivingWorld, type Presence } from "../../lib/living";
import { AgentSprite, world as w } from "./World";
import { RoleIcon } from "../agents/RoleIcon";
import s from "./living.module.css";

export type LivingAgent = {
  name: string;
  /** Every version's Agent Definition id (stops name a version). */
  definitionIds: string[];
  /** Its persistent look (appearance, else its default character), as every other screen draws it. */
  look: AgentLook;
  /** This agent's unfinished Runs, from `GET /agents/active`. The only source of real work. */
  rows: AgentCardData[];
  /** Its real meeting now (gathering or in it), from `GET /workplace/presence`. The only source of a meeting. */
  meeting?: MeetingPresence | null;
  /** What the server says it is doing (`GET /agents/state`): the only source of a break, time off the clock or waiting. */
  state?: AgentState | null;
};

const TICK_MS = 250;
/** Above this y the panel opens below the character: a 420 px panel above it would leave the map. */
export const PANEL_BELOW_Y = 500;

/** The desk each agent is at or walking to, so allocation keeps it. */
function heldDesks(sims: Map<string, AgentSim>): Map<string, string> {
  return new Map([...sims].flatMap(([name, sim]) => (sim.intent.startsWith("work:") ? [[name, sim.intent.slice(5)] as [string, string]] : [])));
}

const PRESENCE_WORDS: Record<Presence, string> = {
  walking: "walking",
  standing: "idle",
  resting: "resting",
  socialising: "with the others",
  working: "working",
  waiting: "waiting for approval",
  queued: "queued to start",
  stopped: "stopped",
  meeting: "in a meeting",
  away: "not at work",
};

/** What a character is shown doing, in words. Real states name the run's activity; ambient ones say they are ambient. */
export function presenceLabel(sim: AgentSim, desire: Desire, shared: boolean, activityLabel: string | null): string {
  if (desire.kind === "work") return sim.presence === "working" ? `working: ${activityLabel}${shared ? " (shared desk)" : ""}` : `on the way to work: ${activityLabel}`;
  if (desire.kind === "wait") return sim.presence === "waiting" ? "waiting for approval" : "on the way to the approval";
  if (desire.kind === "queued") return "queued to start";
  if (desire.kind === "waiting_dependency") return sim.presence === "waiting" ? `waiting: ${desire.detail}` : "on the way to wait";
  if (desire.kind === "break") return sim.presence === "resting" ? "on a break" : "on the way to a break";
  if (desire.kind === "off") return desire.detail;
  if (desire.kind === "paused") return "paused";
  if (desire.kind === "stopped") return "stopped";
  if (desire.kind === "meeting") {
    if (sim.intent.startsWith("nowhere:")) return `in a meeting: ${desire.title} (${desire.roomName} is not on the map)`;
    if (sim.presence !== "meeting") return `on the way to a meeting: ${desire.title}`;
    return desire.phase === "in_meeting" ? `in a meeting: ${desire.title}` : `gathering for a meeting: ${desire.title}`;
  }
  if (sim.intent.startsWith("nowhere:")) return "working, with no workstation in the world to draw it at";
  return `${PRESENCE_WORDS[sim.presence]} (ambient, no work)`;
}

/**
 * The inhabitants of the world map (plan §13). Real work, waiting and stops come only from the
 * runtime rows and stops passed in; walking there and ambient life in between are client-side
 * presentation stepped by `lib/living.ts` and never persisted or sent. Characters move between
 * waypoints with a CSS transition while their walk strip plays facing the way they go (reduced
 * motion removes both, so they appear at each waypoint).
 */
export function LivingAgents({
  world,
  agents,
  stops,
  selected,
  onSelect,
  figureFor,
  stopsUnreadable = false,
  selectable,
  ambient = true,
  nameTags = "real",
  panelFor = null,
  renderPanel,
}: {
  world: LivingWorld;
  agents: LivingAgent[];
  stops: ActiveStop[];
  selected: string | null;
  onSelect: (name: string) => void;
  /** When the stops could not be read, real work is labelled as unconfirmed rather than drawn as certain. */
  stopsUnreadable?: boolean;
  /** The agent whose world panel is open (R2 character interaction), drawn beside the character and moving with it. */
  panelFor?: string | null;
  /** The panel's content, given what the runtime says the agent is doing and where it stands. With it, every character is pressable. */
  renderPanel?: (info: { agent: LivingAgent; desire: Desire; activityLabel: string | null; areaName: string | null }) => ReactNode;
  /** Settings → General: idle agents wander (default) or stay put until real work moves them. */
  ambient?: boolean;
  /** Settings → General: name tags for real work only (default), every agent, or none. The selected agent keeps its tag. */
  nameTags?: "real" | "all" | "none";
  /** Names with something to show on the board (unfinished runs); others are not pressable. Default: all. */
  selectable?: Set<string>;
  /** A character's own figure when it has no chosen appearance (the Keeper's Rogue). Null: the default character. */
  figureFor?: (name: string) => ReactNode | null;
}) {
  const live = active(world);
  const sims = useRef(new Map<string, AgentSim>());
  const [, setTick] = useState(0);
  const inputs = useRef({ live, agents, stops, ambient });
  inputs.current = { live, agents, stops, ambient };

  useEffect(() => {
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      const { live: lw, agents: list, stops: st, ambient: wander } = inputs.current;
      if (lw.areas.length === 0) return;
      const now = performance.now();
      const desires = new Map(list.map((a) => [a.name, desireFor(a.rows, st, a.definitionIds, a.meeting ?? null, a.state ?? null)]));
      // Rooms hosting a real meeting are not somewhere to wander into: idle life avoids them (paths still cross them).
      const meetingRooms = new Set(list.flatMap((a) => (a.meeting?.locationAreaName ? [a.meeting.locationAreaName] : [])));
      const ambientWorld = meetingRooms.size === 0 ? lw : { ...lw, areas: lw.areas.map((area) => (meetingRooms.has(area.name) ? { ...area, purpose: "meeting" } : area)) };
      const workers = list.flatMap((a) => {
        const d = desires.get(a.name)!;
        return d.kind === "work" ? [{ name: a.name, activity: d.activity }] : [];
      });
      const placements = allocateWorkstations(workers, lw, heldDesks(sims.current));
      const next = new Map<string, AgentSim>();
      for (const a of list) {
        // Crowding counts the choices already made this tick, so agents deciding together spread out.
        const crowd = crowdOf([...next.values(), ...[...sims.current].filter(([n]) => !next.has(n) && n !== a.name).map(([, sim]) => sim)]);
        const current = sims.current.get(a.name) ?? spawn(a.name, lw, now, crowd);
        // Ambient life off: an idle agent that has arrived stays where it is (real work still moves it).
        if (!wander && desires.get(a.name)!.kind === "idle" && current.path.length === 0 && now >= current.stepEnds && !current.intent.startsWith("work:") && !current.intent.startsWith("wait:") && !current.intent.startsWith("queued:") && current.intent !== "stopped") {
          next.set(a.name, { ...current, until: now + TICK_MS, presence: current.presence === "walking" ? "standing" : current.presence, stepMs: 0 });
          continue;
        }
        next.set(a.name, step(current, desires.get(a.name)!, ambientWorld, placements.get(a.name), now, crowd));
      }
      sims.current = next;
      setTick((t) => t + 1);
    };
    tick();
    const timer = setInterval(tick, TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const desires = new Map(agents.map((a) => [a.name, desireFor(a.rows, stops, a.definitionIds, a.meeting ?? null, a.state ?? null)]));
  const workers = agents.flatMap((a) => {
    const d = desires.get(a.name)!;
    return d.kind === "work" ? [{ name: a.name, activity: d.activity }] : [];
  });
  const placements = allocateWorkstations(workers, live, heldDesks(sims.current));
  const litAreas = new Set(
    agents.flatMap((a) => {
      const sim = sims.current.get(a.name);
      const placement = placements.get(a.name);
      return sim?.presence === "working" && placement ? [placement.station.areaId] : [];
    })
  );

  // Rooms with a real meeting now, from the same records that put the agents there: one marker per room.
  const meetingRooms = new Map<string, { title: string; roomName: string; phase: "gathering" | "in_meeting"; count: number }>();
  for (const a of agents) {
    const m = a.meeting;
    if (!m?.locationAreaName) continue;
    const seen = meetingRooms.get(m.locationAreaName);
    meetingRooms.set(m.locationAreaName, { title: m.title, roomName: m.roomName, phase: seen?.phase === "in_meeting" ? "in_meeting" : m.phase, count: (seen?.count ?? 0) + 1 });
  }

  return (
    <>
      {[...meetingRooms].flatMap(([areaName, meeting]) => {
        const area = live.areas.find((x) => x.name === areaName);
        return area
          ? [
              <span key={`meeting-${areaName}`} className={s.roomMarker} style={{ left: area.x + area.w / 2, top: area.y + 6 }} data-testid="meeting-marker">
                {meeting.roomName} · {meeting.title} · {meeting.phase === "in_meeting" ? "in a meeting" : "gathering"} ({meeting.count})
              </span>,
            ]
          : [];
      })}
      {live.areas
        .filter((area) => litAreas.has(area.id))
        .map((area) => (
          // Cyan light only where an agent is really at work (visual-language: light = state).
          <div key={`light-${area.id}`} className={s.lightFloor} style={{ left: area.x, top: area.y, width: area.w, height: area.h }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className={w.light} src="/world/light-active-2x.png" alt="" style={{ left: Math.max(0, area.w / 2 - 176), top: Math.max(0, area.h / 2 - 128) }} />
          </div>
        ))}
      {agents.map((a) => {
        const sim = sims.current.get(a.name);
        if (!sim) return null;
        const desire = desires.get(a.name)!;
        const placement = placements.get(a.name);
        const activityRow = desire.kind === "work" ? a.rows.find((r) => r.taskStatus === "active")?.activity : null;
        const label = presenceLabel(sim, desire, placement?.shared ?? false, desire.kind === "work" ? activityOf(activityRow).label : null) + (stopsUnreadable && desire.kind !== "idle" ? " (stops unreadable)" : "");
        const pressable = renderPanel ? true : selectable ? selectable.has(a.name) : true;
        const real = desire.kind !== "idle";
        const figure = !a.look.appearance ? figureFor?.(a.name) : null;
        const style = {
          left: sim.at.x,
          top: sim.at.y,
          transition: sim.stepMs > 0 ? `left ${sim.stepMs}ms linear, top ${sim.stepMs}ms linear` : "none",
          zIndex: Math.round(sim.at.y),
        } as CSSProperties;
        const panelOpen = renderPanel !== undefined && panelFor === a.name;
        // Where it stands: the smallest configured area around its feet.
        const areaName = panelOpen ? (live.areas.filter((ar) => inside(sim.at, ar, 2)).sort((x, y) => x.w * x.h - y.w * y.h)[0]?.name ?? null) : null;
        return (
          <Fragment key={a.name}>
          <button
            type="button"
            className={s.agent}
            style={style}
            onClick={() => pressable && onSelect(a.name)}
            aria-pressed={pressable ? selected === a.name : undefined}
            aria-label={`${a.name}: ${label}`}
            title={`${a.name}: ${label}`}
            data-presence={sim.presence}
            data-agent={a.name}
          >
            {figure ?? (
              <AgentSprite
                look={a.look}
                pose={sim.presence === "working" ? "run" : "idle"}
                kitPose={sim.presence === "walking" ? "walk" : undefined}
                facing={sim.facing}
                footX={0}
                footY={0}
                frozen={sim.presence === "stopped"}
              />
            )}
            {sim.presence === "stopped" && <span className={w.barrier} style={{ left: -32, top: -6, width: 64, height: 12 }} aria-hidden />}
            {(selected === a.name || (nameTags === "all" && !real) || (real && nameTags !== "none")) && (
              <span className={s.tag} data-real={real}>
                <RoleIcon agentName={a.name} />
                {a.name}
                {real ? ` · ${label}` : ""}
              </span>
            )}
          </button>
          {panelOpen && (
            <div
              className={s.panelAnchor}
              data-below={sim.at.y < PANEL_BELOW_Y}
              style={{ left: Math.min(Math.max(sim.at.x, 170), KEEP.width - 170), top: sim.at.y, transition: style.transition }}
            >
              {renderPanel!({ agent: a, desire, activityLabel: desire.kind === "work" ? activityOf(activityRow).label : null, areaName })}
            </div>
          )}
          </Fragment>
        );
      })}
    </>
  );
}
