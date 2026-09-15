"use client";

import Link from "next/link";
import { use } from "react";
import { AgentRoster, useAgentRoster } from "../../components/agents/roster";
import { PixelButton, Skeleton, StateNotice, StatusMark, cx, px } from "../../components/pixel/Pixel";
import { WorkshopCloseup } from "../../components/world/Workshop";
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
  const def = reg ? (reg.agentDefinitions.find((d) => d.id === agent) ?? reg.agentDefinitions[0]) : undefined;
  const grants = def ? reg!.capabilityGrants.filter((g) => g.agentDefinitionId === def.id && g.agentDefinitionVersion === def.version) : [];
  const capabilityName = (id: string) => reg?.capabilities.find((c) => c.id === id)?.name ?? "capability not in the Registry";
  const entry = roster.entries.find((e) => e.id === def?.id);
  const roomState = !def || !roster.activeLoaded ? null : entry?.state === "stopped" || entry?.state === "active" || entry?.state === "awaiting_approval" ? entry.state : "idle";

  return (
    <main className={cx(a.screen, !def && a.noWorld)}>
      <AgentRoster roster={roster} selectedId={def?.id} hrefFor={(x) => `/registry?agent=${x}`} />
      {def && (
        <WorkshopCloseup
          agentId={def.id}
          state={roomState}
          label={`${def.name}'s keys`}
          keys={grants.map((g, i) => ({ n: i + 1, revoked: g.revokedAt !== null }))}
        />
      )}
      <section className={cx(px.board, a.board)} aria-label="Registry">
        {!reg && roster.error ? (
          <StateNotice
            role="alert"
            message="Couldn't load the Registry."
            detail={roster.error}
            action={<PixelButton onClick={() => void roster.reload()}>Retry</PixelButton>}
          />
        ) : !reg ? (
          <StateNotice role="status" message={<>Loading the Registry <Skeleton /></>} />
        ) : (
          <>
            <header className={a.header}>
              <h1 className={px.heading}>{def ? `${def.name} v${def.version}` : "Registry"}</h1>
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
                            {g.permissions.join(", ")} · {g.autonomyState} · trust ≥ {g.maxTrustLevelRequired}
                          </div>
                          {g.scope && <div>scope {JSON.stringify(g.scope)}</div>}
                          <div>granted {formatTime(g.createdAt)}</div>
                          {g.revokedAt && (
                            <StatusMark state="revoked" tone="fail" surface="parchment">
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
