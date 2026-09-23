"use client";

import Link from "next/link";
import { use } from "react";
import { AgentRoster, useAgentRoster } from "../../components/agents/roster";
import { PixelButton, RefreshNotice, Skeleton, StateNotice, StatusMark, cx, px } from "../../components/pixel/Pixel";
import { WorkshopCloseup, type WorkshopState } from "../../components/world/Workshop";
import { formatTime } from "../../lib/keep";
import a from "../agents/agents.module.css";

/**
 * Registry (spec 15.1 screen 6; Figma "Registry — pixel armory (gated:
 * read-only)"): what are agents allowed to do? Reached from Agents (no top-bar
 * slot). One key per grant in the agent's workshop, then every Definition from
 * `GET /registry`. Read-only by design frame: autonomy and grant changes are
 * safety-critical (spec 9.4) and have no approved controls here.
 */
export default function RegistryPage({ searchParams }: { searchParams: Promise<{ agent?: string }> }) {
  const { agent } = use(searchParams);
  const roster = useAgentRoster();
  const reg = roster.registry;
  // An unknown id is said to be unknown; another agent is never substituted for it.
  const def = reg ? (agent ? reg.agentDefinitions.find((d) => d.id === agent) : reg.agentDefinitions[0]) : undefined;
  const unknownAgent = reg !== null && agent !== undefined && def === undefined;
  const grants = def
    ? reg!.capabilityGrants.filter((g) => g.agentDefinitionId === def.id && g.agentDefinitionVersion === def.version).sort((x, y) => (x.id < y.id ? -1 : 1))
    : [];
  // Capabilities this version holds an unrevoked grant for; the capability list itself is registry-wide.
  const granted = new Set(grants.filter((g) => g.revokedAt === null).map((g) => g.capabilityId));
  const rosterFailed = !reg && roster.error !== null;
  const capabilityName = (id: string) => reg?.capabilities.find((c) => c.id === id)?.name ?? "capability not in the Registry";
  const entry = roster.entries.find((e) => e.id === def?.id);
  const roomState: WorkshopState = !def
    ? null
    : roster.activeUnreadable
      ? "unknown"
      : !roster.activeLoaded
        ? null
        : entry?.state === "stopped" || entry?.state === "active" || entry?.state === "awaiting_approval" || entry?.state === "pending"
          ? entry.state
          : "idle";

  return (
    <main className={cx(a.screen, !def && !rosterFailed && a.noWorld)}>
      <AgentRoster roster={roster} selectedId={def?.id} hrefFor={(x) => `/registry?agent=${x}`} />
      {def ? (
        <WorkshopCloseup
          agentId={def.id}
          state={roomState}
          label={`${def.name}'s keys`}
          keys={grants.map((g, i) => ({ n: i + 1, revoked: g.revokedAt !== null }))}
          definitions={reg!.agentDefinitions}
        />
      ) : (
        // Unloaded means unlit, not absent: the workshop stays, dark, with no actor or keys.
        rosterFailed && <WorkshopCloseup agentId="" state="unknown" label="Workshop, state unknown" />
      )}
      <section className={cx(px.board, a.board)} aria-label="Registry">
        {!reg && roster.error ? (
          <StateNotice role="alert" message="Couldn't load the Registry." detail="Retry from the roster on the left." />
        ) : !reg ? (
          <StateNotice role="status" message={<>Loading the Registry <Skeleton /></>} />
        ) : (
          <>
            <header className={a.header}>
              <h1 className={px.heading}>{def ? `Registry · ${def.name} v${def.version}` : "Registry"}</h1>
              {unknownAgent && (
                <StateNotice role="alert" message="That agent isn't in the Registry." detail={`agent definition ${agent}`} />
              )}
              {roster.error && <RefreshNotice error={roster.error} />}
              <p className={px.parchment} data-testid="read-only">
                Read-only. This screen changes nothing: definitions and grants are created, versioned and revoked through the Registry API.
              </p>
              {def && (
                <Link href={`/agents/${def.id}`} className={a.link}>
                  Back to the agent
                </Link>
              )}
            </header>

            <div className={a.columns}>
              {def && (
                <section className={a.section} aria-label="Keys">
                  <span className={px.tab}>Keys</span>
                  {grants.length === 0 ? (
                    <p className={px.dim}>No capability grants for this version.</p>
                  ) : (
                    <div className={a.cards}>
                      {grants.map((g, i) => (
                        <div key={g.id} className={px.parchment} data-testid="grant">
                          <div className={px.label}>
                            Key {i + 1} · {capabilityName(g.capabilityId)}
                          </div>
                          <div>
                            {g.permissions.join(", ")} · {g.autonomyState} · <span className={px.nowrap}>trust ≥ {g.maxTrustLevelRequired}</span>
                          </div>
                          {g.scope && Object.keys(g.scope).length > 0 && (
                            <ul className={cx(px.vellum, a.plainList)} aria-label="Grant scope">
                              {Object.entries(g.scope).map(([k, v]) => (
                                <li key={k}>
                                  {k}: {typeof v === "string" ? v : JSON.stringify(v)}
                                </li>
                              ))}
                            </ul>
                          )}
                          <div>granted {formatTime(g.createdAt)}</div>
                          {g.revokedAt && (
                            <StatusMark state="revoked" tone="neutral" surface="parchment">
                              revoked {formatTime(g.revokedAt)}
                            </StatusMark>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              )}

              <section className={a.section} aria-label="Capabilities">
                <span className={px.tab}>Capabilities</span>
                {reg.capabilities.length === 0 ? (
                  <p className={px.dim}>No capabilities exist yet.</p>
                ) : (
                  <div className={a.cards}>
                    {reg.capabilities.map((c) => (
                      <div key={c.id} className={px.vellum} data-testid="capability">
                        <div>
                          {c.name} <span className={px.dim}>· risk {c.staticRiskTag}</span>
                        </div>
                        {def && !granted.has(c.id) && (
                          <StatusMark state="none" tone="neutral">
                            not granted to this agent
                          </StatusMark>
                        )}
                        {c.description && <div className={px.dim}>{c.description}</div>}
                        {c.toolBindings.length === 0 ? (
                          <div className={px.dim}>No tool bindings.</div>
                        ) : (
                          c.toolBindings.map((b) => (
                            <div key={b.id}>
                              {b.kind} v{b.version} · trust {b.trustLevel}
                              {b.internalFunction ? ` · ${b.internalFunction}` : ""}
                            </div>
                          ))
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className={a.section} aria-label="Task definitions">
                <span className={px.tab}>Task definitions</span>
                {reg.taskDefinitions.length === 0 ? (
                  <p className={px.dim}>No task definitions exist yet.</p>
                ) : (
                  <ul className={cx(px.vellum, a.plainList)}>
                    {reg.taskDefinitions.map((t) => (
                      <li key={t.id}>
                        {t.name} v{t.version} <span className={px.dim}>· {t.kind} · {t.planRegistered ? "plan registered" : "no plan registered"}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className={a.section} aria-label="Workflow definitions">
                <span className={px.tab}>Workflow definitions</span>
                {reg.workflowDefinitions.length === 0 ? (
                  <p className={px.dim}>No workflow definitions exist yet.</p>
                ) : (
                  <ul className={cx(px.vellum, a.plainList)}>
                    {reg.workflowDefinitions.map((w) => (
                      <li key={w.id}>
                        {w.name} v{w.version}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
