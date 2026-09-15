"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getRegistry, listActiveAgents, listActiveStops, type ActiveStop, type AgentCardData, type RegistryData } from "../../lib/api";
import { agentState, errorText } from "../../lib/keep";
import { useRefetchOnEvents } from "../live";
import { PixelButton, Skeleton, StateNotice, StatusMark, cx, px } from "../pixel/Pixel";
import s from "./roster.module.css";

export type RosterEntry = {
  id: string;
  name: string;
  version: number;
  role: string;
  /** A runtime word, "stopped", or null when the agent has no unfinished Run. */
  state: string | null;
  stop: ActiveStop | null;
};

export type Roster = {
  registry: RegistryData | null;
  error: string | null;
  entries: RosterEntry[];
  activeLoaded: boolean;
  activeUnreadable: boolean;
  reload: () => Promise<void>;
};

/** Every Agent Definition (`GET /registry`) joined with active Runs (`GET /agents/active`) and stops (`GET /execution-stops`). */
export function useAgentRoster(): Roster {
  const [registry, setRegistry] = useState<RegistryData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<AgentCardData[] | "error" | null>(null);
  const [stops, setStops] = useState<ActiveStop[] | "error" | null>(null);

  const reload = useCallback(async () => {
    const [r, a, st] = await Promise.allSettled([getRegistry(), listActiveAgents(), listActiveStops()]);
    if (r.status === "fulfilled") {
      setRegistry(r.value);
      setError(null);
    } else {
      setError(errorText(r.reason));
    }
    setActive(a.status === "fulfilled" ? a.value : "error");
    setStops(st.status === "fulfilled" ? st.value : "error");
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);
  useRefetchOnEvents(reload);

  const entries = useMemo<RosterEntry[]>(
    () =>
      (registry?.agentDefinitions ?? []).map((d) => {
        const runs = Array.isArray(active) ? active.filter((a) => a.agentDefinitionId === d.id) : [];
        const stop = Array.isArray(stops)
          ? (stops.find((x) => x.scope === "agent_definition" && x.scopeRefId?.toLowerCase() === d.id.toLowerCase()) ?? null)
          : null;
        return {
          id: d.id,
          name: d.name,
          version: d.version,
          role: d.role,
          state: stop ? "stopped" : runs.length > 0 ? agentState(runs.map((r) => r.taskStatus)) : null,
          stop,
        };
      }),
    [registry, active, stops]
  );

  return { registry, error, entries, activeLoaded: active !== null, activeUnreadable: active === "error", reload };
}

export function AgentRoster({ roster, selectedId, hrefFor }: { roster: Roster; selectedId?: string; hrefFor: (id: string) => string }) {
  const { registry, error, entries, activeLoaded, activeUnreadable, reload } = roster;
  return (
    <nav className={cx(px.board, s.roster)} aria-label="Agent roster">
      <span className={px.tab}>Roster</span>
      {error && !registry ? (
        <StateNotice role="alert" message="Couldn't load the roster." detail={error} action={<PixelButton onClick={() => void reload()}>Retry</PixelButton>} />
      ) : !registry ? (
        <StateNotice role="status" message={<Skeleton />} />
      ) : entries.length === 0 ? (
        <StateNotice message="No agent definitions exist yet." />
      ) : (
        <ul className={s.list}>
          {entries.map((e) => (
            <li key={e.id}>
              <Link
                href={hrefFor(e.id)}
                className={cx(px.plaque, s.entry, e.id === selectedId && px.selected)}
                aria-current={e.id === selectedId ? "page" : undefined}
              >
                <span className={s.name}>
                  {e.name} <span className={px.dim}>v{e.version}</span>
                </span>
                {!activeLoaded ? (
                  <StatusMark state={null} />
                ) : e.state ? (
                  <StatusMark state={e.state} />
                ) : (
                  <StatusMark state="none" tone="neutral">
                    {activeUnreadable ? "state unknown" : "no active run"}
                  </StatusMark>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
