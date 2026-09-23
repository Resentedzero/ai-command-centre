"use client";

import type { Appearance, AppearanceOptions } from "../../lib/api";
import { WORKSHOP_CLOSEUPS, type AgentLook } from "../../lib/keep";
import { buttonClass, cx, px } from "../pixel/Pixel";
import { AgentSprite, world } from "../world/World";
import b from "./builder.module.css";

/** Every part at its catalogue default, with any known option from `from` kept. */
export function appearanceFrom(options: AppearanceOptions, from?: Appearance | null): Appearance {
  return Object.fromEntries(
    Object.entries(options.parts).map(([key, part]) => [key, from?.[key] && part.options.includes(from[key]!) ? from[key]! : part.default])
  );
}

/**
 * Character station (R2 visual identity): how a persistent agent looks. A preview on the
 * workshop floor, standing and walking in two facings, the catalogue's presets, and one
 * choice per catalogue part. Presentation
 * only: nothing here reaches keys, budgets, routing or policy, and the preview is not a run.
 * Without `onChange` it is read-only (a new version keeps its agent's look).
 */
export function CharacterStation({
  options,
  value,
  onChange,
  disabled = false,
  note,
}: {
  options: AppearanceOptions;
  /** null = the agent has no chosen look and keeps its default character. */
  value: Appearance | null;
  onChange?: (next: Appearance) => void;
  disabled?: boolean;
  note?: React.ReactNode;
}) {
  const look: AgentLook = { character: "knight", appearance: value };
  return (
    <fieldset className={cx(px.board, b.group)} aria-label="Character">
      <legend className={px.tab}>Character</legend>
      <p className={px.detail}>
        How this agent looks on every screen, across all of its versions. It changes nothing the agent may do, spend or use.
      </p>
      <div className={b.station}>
        <div className={b.stage} role="img" aria-label={value ? "Character preview" : "Default character"}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={WORKSHOP_CLOSEUPS[0]} width={768} height={640} alt="" className={b.stageRoom} draggable={false} />
          <div className={world.night} />
          {value ? (
            <>
              <AgentSprite look={look} pose="idle" footX={64} footY={176} scale={2} />
              <AgentSprite look={look} pose="idle" kitPose="walk" facing="right" footX={164} footY={176} scale={2} />
              <AgentSprite look={look} pose="idle" kitPose="walk" facing="up" footX={264} footY={176} scale={2} />
            </>
          ) : (
            <p className={b.stageNote}>Default character</p>
          )}
          <span className={b.stageCaption}>preview · not a run</span>
        </div>
        {value && (
          <div className={b.parts}>
            {options.presets && options.presets.length > 0 && onChange && (
              <div className={b.field} role="group" aria-label="Presets">
                <span className={px.label}>Presets</span>
                <span>
                  {options.presets.map((p) => (
                    <button key={p.id} type="button" className={buttonClass()} disabled={disabled} onClick={() => onChange(appearanceFrom(options, p.appearance))}>
                      {p.name}
                    </button>
                  ))}
                </span>
              </div>
            )}
            {Object.entries(options.parts).map(([key, part]) => (
              <label key={key} className={b.field}>
                <span className={px.label}>{part.label}</span>
                <select
                  className={px.input}
                  value={value[key]}
                  onChange={(e) => onChange?.({ ...value, [key]: e.target.value })}
                  disabled={disabled || !onChange}
                >
                  {part.options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        )}
      </div>
      {note}
    </fieldset>
  );
}
