"use client";

import { WORKSHOP_CLOSEUPS, lookFor, preferredSlot, type KnownAgent } from "../../lib/keep";
import { StatusMark, cx } from "../pixel/Pixel";
import { AgentSprite, world } from "./World";
import s from "./workshop.module.css";

/** `null` = not loaded; `unknown` = the read failed; `idle` = no unfinished Run. */
export type WorkshopState = "active" | "awaiting_approval" | "pending" | "stopped" | "idle" | "unknown" | null;

/** A grant drawn as a key: `n` matches the "Key n" card beside it. */
export type KeyMark = { n: number; revoked: boolean };

/**
 * One workshop at 4x (Agents and Registry): a centred crop of the close-up art,
 * lit by the agent's real state. `state` null = not loaded (unlit, no actor).
 * Awaiting approval: dark and empty (the agent is at the council seal).
 * Pending: unlit, character absent. Stopped: a barrier, sprite frozen on frame 1.
 */
export function WorkshopCloseup({
  agentId,
  state,
  label,
  keys = [],
  definitions,
}: {
  /** "" when no agent could be read: the first close-up, unlit (`state="unknown"` draws no actor). */
  agentId: string;
  state: WorkshopState;
  label: string;
  keys?: KeyMark[];
  /** The Registry's Agent Definitions, so the agent looks the same as on every other screen. */
  definitions?: KnownAgent[];
}) {
  const look = lookFor(agentId, definitions);
  const sprite =
    state === "active" ? "run" : state === "idle" || state === "stopped" ? "idle" : null;
  return (
    <div className={cx(s.closeup)} role="img" aria-label={label}>
      <div className={s.room}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={WORKSHOP_CLOSEUPS[preferredSlot(look.name)]} width={768} height={640} alt="" className={world.base} draggable={false} />
        <div className={world.night} />
        {state === "active" && <img className={world.light} src="/world/light-active-4x.png" style={{ left: 32, top: 128 }} alt="" />}
        {sprite && <AgentSprite look={look} pose={sprite} footX={384} footY={540} scale={2} frozen={state === "stopped"} />}
        {state === "stopped" && <div className={world.barrier} style={{ left: 304, top: 600, width: 160 }} />}
        {keys.map((k, i) => (
          <div key={k.n} className={cx(s.key, k.revoked && s.revoked)} style={{ left: 384 - ((keys.length - 1) * 88) / 2 + i * 88 - 32, top: 188 }}>
            <span className={s.keyIcon} />
            <span className={s.keyTag}>{k.n}</span>
          </div>
        ))}
        <span className={cx(world.plaque, world.plaqueStatic)} style={{ left: 384, top: 150 }}>
          {state === null ? (
            <StatusMark state={null} />
          ) : state === "idle" ? (
            <StatusMark state="none" tone="neutral">
              no active run
            </StatusMark>
          ) : state === "unknown" ? (
            <StatusMark state="none" tone="neutral">
              state unknown
            </StatusMark>
          ) : (
            <StatusMark state={state} />
          )}
        </span>
      </div>
    </div>
  );
}
