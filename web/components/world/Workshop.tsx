"use client";

import { WORKSHOP_CLOSEUPS, characterFor, preferredSlot } from "../../lib/keep";
import { StatusMark, cx } from "../pixel/Pixel";
import { AgentSprite, world } from "./World";
import s from "./workshop.module.css";

/** A grant drawn as a key: `n` matches the "Key n" card beside it. */
export type KeyMark = { n: number; revoked: boolean };

/**
 * One workshop at 4x (Agents and Registry): a centred crop of the close-up art,
 * lit by the agent's real state. `state` null = not loaded (unlit, no actor).
 * Awaiting approval: the workshop is dark and empty (the agent is at the
 * council seal). Stopped: a barrier, sprite frozen on frame 1.
 */
export function WorkshopCloseup({
  agentId,
  state,
  label,
  keys = [],
}: {
  agentId: string;
  state: "active" | "awaiting_approval" | "stopped" | "idle" | null;
  label: string;
  keys?: KeyMark[];
}) {
  const character = characterFor(agentId);
  const sprite =
    state === "active" ? "run" : state === "idle" || state === "stopped" ? "idle" : null;
  return (
    <div className={cx(s.closeup)} role="img" aria-label={label}>
      <div className={s.room}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={WORKSHOP_CLOSEUPS[preferredSlot(agentId)]} width={768} height={640} alt="" className={world.base} draggable={false} />
        <div className={world.night} />
        {state === "active" && <img className={world.light} src="/world/light-active-4x.png" style={{ left: 32, top: 128 }} alt="" />}
        {sprite && <AgentSprite character={character} pose={sprite} footX={384} footY={540} scale={2} frozen={state === "stopped"} />}
        {state === "stopped" && <div className={world.barrier} style={{ left: 304, top: 600, width: 160 }} />}
        {keys.map((k, i) => (
          <div key={k.n} className={cx(s.key, k.revoked && s.revoked)} style={{ left: 384 - ((keys.length - 1) * 72) / 2 + i * 72 - 24, top: 196 }}>
            <span className={s.keyIcon} />
            <span className={s.keyTag}>{k.n}</span>
          </div>
        ))}
        <span className={world.plaque} style={{ left: 384, top: 150, cursor: "default" }}>
          {state === null ? <StatusMark state={null} /> : state === "idle" ? <StatusMark state="none" tone="neutral">no active run</StatusMark> : <StatusMark state={state} />}
        </span>
      </div>
    </div>
  );
}
