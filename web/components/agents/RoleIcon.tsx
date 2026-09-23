"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getRoleIcons, type RoleIconCatalogue, type RoleIconEntry } from "../../lib/api";
import s from "./roleIcon.module.css";

/**
 * The small pixel symbol beside an agent's name: who it is, at a glance.
 *
 * IDENTITY, NEVER STATUS. A role colour says which role; it is never a runtime state (no cyan working,
 * amber waiting, green done, red failed — those stay in the status marks beside it). Every role also has
 * its own shape, so the icons are still told apart without colour. An icon grants nothing and implies no
 * capability: the API decides what an agent may do, and says so in the Registry.
 *
 * Icons come from the governed catalogue (`GET /role-icons`), drawn from its 12x12 bitmaps. An agent with
 * no icon yet (or an unreadable catalogue) simply shows its name: an honest absence, never a guess.
 */
export type RoleIcons = { catalogue: RoleIconCatalogue | null; byAgent: Map<string, string> };

const RoleIconContext = createContext<RoleIcons>({ catalogue: null, byAgent: new Map() });

export function RoleIconsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<RoleIcons>({ catalogue: null, byAgent: new Map() });
  const load = useCallback(() => {
    getRoleIcons()
      .then((d) => setState({ catalogue: d.catalogue, byAgent: new Map(d.agents.map((a: RoleIconEntry) => [a.name, a.iconId])) }))
      // Unreadable: names are drawn without icons rather than with invented ones.
      .catch(() => setState((current) => current));
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  return <RoleIconContext.Provider value={state}>{children}</RoleIconContext.Provider>;
}

export const useRoleIcons = () => useContext(RoleIconContext);

/** One agent's icon definition, or null when the catalogue or the agent is unknown. */
export function useRoleIcon(agentName: string | null | undefined) {
  const { catalogue, byAgent } = useRoleIcons();
  return useMemo(() => {
    if (!catalogue || !agentName) return null;
    const id = byAgent.get(agentName);
    return catalogue.icons.find((i) => i.id === id) ?? null;
  }, [catalogue, byAgent, agentName]);
}

/** The icon alone (decorative: the name beside it carries the meaning). `title` gives it a tooltip. */
export function RoleIcon({ agentName, size = 12, className }: { agentName: string | null | undefined; size?: number; className?: string }) {
  const icon = useRoleIcon(agentName);
  const grid = useRoleIcons().catalogue?.size ?? 12;
  if (!icon) return null;
  const px = Math.max(1, Math.round(size / grid));
  return (
    <svg
      className={[s.icon, className].filter(Boolean).join(" ")}
      width={px * grid}
      height={px * grid}
      viewBox={`0 0 ${grid} ${grid}`}
      /* Decorative: the name beside it is the label. The tooltip still says which role it is. */
      aria-hidden="true"
      focusable="false"
      style={{ ["--role" as string]: `var(${icon.colorToken})` }}
      shapeRendering="crispEdges"
    >
      <title>{`${icon.name}: ${icon.description}`}</title>
      {icon.pixels.flatMap((row, y) =>
        [...row].map((cell, x) => (cell === "." ? null : <rect key={`${x},${y}`} x={x} y={y} width={1} height={1} className={cell === "+" ? s.outline : s.fill} />))
      )}
    </svg>
  );
}

/**
 * `[icon] Name` wherever an agent is named. The icon is decorative and secondary; the name is the label,
 * and any suffix (a version, a status) follows it unchanged.
 */
export function AgentLabel({ name, suffix, size, className }: { name: string; suffix?: ReactNode; size?: number; className?: string }) {
  return (
    <span className={[s.label, className].filter(Boolean).join(" ")} data-agent-label={name}>
      <RoleIcon agentName={name} {...(size === undefined ? {} : { size })} />
      <span className={s.name}>{name}</span>
      {suffix === undefined ? null : <> {suffix}</>}
    </span>
  );
}

/** Agent names joined for prose ("Manager, Researcher"), each with its icon. */
export function AgentLabels({ names, size }: { names: string[]; size?: number }) {
  return (
    <>
      {names.map((n, i) => (
        <span key={n}>
          {i > 0 ? ", " : ""}
          <AgentLabel name={n} {...(size === undefined ? {} : { size })} />
        </span>
      ))}
    </>
  );
}
