"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAgentDetail, revokeCapabilityGrant, type AgentDetail } from "../../lib/api";
import { useRefetchOnEvents } from "../../components/live";
import { AgentRoster, useAgentRoster } from "../../components/agents/roster";
import { StopControl, type ShownStop } from "../../components/StopControl";
import { RefreshNotice, PixelButton, Skeleton, StateNotice, StatusMark, cx, px } from "../../components/pixel/Pixel";
import { WorkshopCloseup, type WorkshopState } from "../../components/world/Workshop";
import { agentState, eligibilityWord, errorText, formatAmount, formatTime, stateWord } from "../../lib/keep";
import a from "./agents.module.css";
import { DelegateObjective } from "../../components/agents/DelegateObjective";

/**
 * Agents (spec 15.1 screen 2; Figma "Agents v2 — pixel"): what is this agent
 * doing, why, and can I stop it? Roster of every Agent Definition, the agent's
 * workshop at 4x lit by its real state with one key per grant, and a dense
 * board: Stop under the name, then lineage, keys, usage per unit, context
 * lineage, outputs, recent actions and measured performance. Renders only what
 * `GET /registry`, `GET /agents/active`, `GET /execution-stops` and
 * `GET /agents/:id` return.
 */
export function AgentsScreen({ id: routeId }: { id?: string }) {
  const roster = useAgentRoster();
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // With no agent in the URL, open the one needing attention (else the first), once.
  const [autoId, setAutoId] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (routeId || autoId || roster.entries.length === 0) return;
    setAutoId((roster.entries.find((e) => e.stop || e.state === "awaiting_approval") ?? roster.entries[0])!.id);
  }, [routeId, autoId, roster.entries]);
  const id = routeId ?? autoId;

  // Only the latest read may land: an older refetch resolving late must not overwrite a newer one.
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!id) return;
    const n = ++seq.current;
    try {
      const d = await getAgentDetail(id);
      if (n === seq.current) {
        setDetail(d);
        setLoadError(null);
      }
    } catch (err) {
      if (n === seq.current) setLoadError(errorText(err));
    }
  }, [id]);

  useEffect(() => {
    setDetail(null);
    setLoadError(null);
    void load();
  }, [load]);
  useRefetchOnEvents(load);

  const { reload: reloadRoster, registry, error: rosterError } = roster;
  const reloadAll = useCallback(async () => {
    await Promise.all([load(), reloadRoster()]);
  }, [load, reloadRoster]);

  const taskName = useMemo(() => {
    const names = new Map((registry?.taskDefinitions ?? []).map((t) => [t.id, `${t.name} v${t.version}`]));
    return (taskDefinitionId: string) =>
      names.get(taskDefinitionId) ?? (registry ? "task definition not in the Registry" : rosterError ? "task name unavailable" : "· · ·");
  }, [registry, rosterError]);

  const hrefFor = (x: string) => `/agents/${x}`;

  if (!id) {
    // Unloaded means unlit, not absent: a failed roster keeps the workshop on screen, dark and empty.
    const rosterFailed = !roster.registry && roster.error !== null;
    return (
      <main className={cx(a.screen, !rosterFailed && a.noWorld)}>
        <AgentRoster roster={roster} hrefFor={hrefFor} />
        {rosterFailed && <WorkshopCloseup agentId="" state="unknown" label="Workshop, state unknown" />}
        <section className={cx(px.board, a.board)} aria-label="Agent detail">
          {!roster.registry && !roster.error ? (
            <StateNotice role="status" message={<>Loading the roster <Skeleton /></>} />
          ) : (
            <StateNotice
              message={roster.registry ? "No agent definitions exist yet." : "No agent is open: the roster couldn't be read."}
              action={
                roster.registry ? (
                  <Link href="/agents/new" className={a.link}>
                    Recruit an agent
                  </Link>
                ) : (
                  <Link href="/registry" className={a.link}>
                    Open the Registry (read-only)
                  </Link>
                )
              }
            />
          )}
        </section>
      </main>
    );
  }

  const unfinished = detail?.runs.filter((r) => r.status !== "completed" && r.status !== "failed") ?? [];
  const current = unfinished.length > 0 ? agentState(unfinished.map((r) => r.status)) : null;
  const globalStop = roster.entries.find((e) => e.id === id)?.stop;
  const shownStop = detail?.activeStop ?? (globalStop?.scope === "global" ? globalStop : null);
  const roomState: WorkshopState = !detail
    ? loadError
      ? "unknown"
      : null
    : shownStop
      ? "stopped"
      : current === "active" || current === "awaiting_approval" || current === "pending"
        ? current
        : "idle";
  const grants = detail ? [...detail.grants].sort((x, y) => (x.id < y.id ? -1 : 1)) : [];

  return (
    <main className={a.screen}>
      <AgentRoster roster={roster} selectedId={id} hrefFor={hrefFor} />
      <WorkshopCloseup
        agentId={id}
        state={roomState}
        label={detail ? `${detail.agent.name}'s workshop` : "Workshop"}
        keys={grants.map((g, i) => ({ n: i + 1, revoked: g.revoked }))}
        definitionIds={registry?.agentDefinitions.map((d) => d.id)}
      />
      <section className={cx(px.board, a.board)} aria-label="Agent detail">
        {!detail && loadError ? (
          <StateNotice
            role="alert"
            message={/ 404 /.test(loadError) ? "This agent wasn't found." : "Couldn't load this agent."}
            detail={loadError}
            action={<PixelButton onClick={() => void load()}>Retry</PixelButton>}
          />
        ) : !detail ? (
          <StateNotice role="status" message={<>Loading this agent <Skeleton /></>} />
        ) : (
          <AgentBoard
            detail={detail}
            grants={grants}
            shownStop={shownStop}
            taskName={taskName}
            refreshError={loadError}
            onChanged={reloadAll}
            versions={(registry?.agentDefinitions ?? []).filter((d) => d.name === detail.agent.name).map((d) => ({ id: d.id, version: d.version }))}
          />
        )}
      </section>
    </main>
  );
}

/** Revocation (spec §9.7) is one confirmed act per key; the API closes the key's pending approvals. */
function RevokeKey({ grantId, label, onChanged }: { grantId: string; label: string; onChanged: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revoke() {
    setBusy(true);
    setError(null);
    try {
      await revokeCapabilityGrant(grantId);
      await onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div className={a.revoke}>
      {!confirming ? (
        <PixelButton onClick={() => setConfirming(true)} disabled={busy}>
          Revoke
        </PixelButton>
      ) : (
        <>
          <span>Revoke {label}? Its pending approvals close.</span>
          <PixelButton kind="danger" onClick={() => void revoke()} disabled={busy}>
            Confirm revoke
          </PixelButton>
          <PixelButton onClick={() => setConfirming(false)} disabled={busy}>
            Keep
          </PixelButton>
        </>
      )}
      {error && (
        <p role="alert" className={px.detail}>
          Couldn&apos;t revoke. {error}
        </p>
      )}
    </div>
  );
}

function AgentBoard({
  detail,
  grants,
  shownStop,
  taskName,
  refreshError,
  onChanged,
  versions,
}: {
  detail: AgentDetail;
  grants: AgentDetail["grants"];
  shownStop: ShownStop | null;
  taskName: (id: string) => string;
  refreshError: string | null;
  onChanged: () => Promise<void>;
  versions: { id: string; version: number }[];
}) {
  const { agent, contextLineage: ctx } = detail;
  const tiers = ctx ? [...new Set(ctx.included.map((i) => i.tier))].sort((x, y) => x - y) : [];
  const profile = agent.executionProfile ?? {};
  const [delegating, setDelegating] = useState(false);

  return (
    <>
      <header className={a.header}>
        <h1 className={px.heading}>
          {agent.name} v{agent.version}
        </h1>
        <StopControl agentId={agent.id} name={agent.name} version={agent.version} stop={shownStop} onChanged={onChanged} />
        <nav className={a.builderLinks} aria-label="Agent builder">
          <Link href={`/agents/new?from=${agent.id}`} className={a.link}>
            New version
          </Link>
          <Link href="/agents/new" className={a.link}>
            Recruit an agent
          </Link>
          {versions.length > 1 && (
            <span className={a.versions} data-testid="agent-versions">
              versions:{" "}
              {[...versions]
                .sort((x, y) => x.version - y.version)
                .map((v) =>
                  v.id === agent.id ? (
                    <span key={v.id} aria-current="page">
                      v{v.version}
                    </span>
                  ) : (
                    <Link key={v.id} href={`/agents/${v.id}`} className={a.link}>
                      v{v.version}
                    </Link>
                  )
                )}
            </span>
          )}
        </nav>
        {!shownStop && detail.runs.some((r) => r.status === "awaiting_approval") && (
          <Link href="/approvals" className={a.link}>
            Waiting at the council hall: review the approval
          </Link>
        )}
      </header>
      {refreshError && (
        <RefreshNotice error={refreshError} />
      )}
      <div className={px.parchment}>
        <div className={px.label}>{agent.role}</div>
        <div>{agent.objective}</div>
        <div data-testid="agent-profile">
          {profile.preferredTier || profile.provider || profile.loop
            ? [
                profile.preferredTier && `tier ${profile.preferredTier}`,
                profile.provider && `provider ${profile.provider} only`,
                profile.loop?.maxIterations !== undefined && `≤ ${profile.loop.maxIterations} iterations`,
                profile.loop?.maxActiveSeconds !== undefined && `≤ ${profile.loop.maxActiveSeconds / 60} active min`,
              ]
                .filter(Boolean)
                .join(" · ")
            : "runtime defaults"}
        </div>
      </div>

      <section className={a.section} aria-label="Objective">
        <span className={px.tab}>Give an objective</span>
        {delegating ? (
          <DelegateObjective agent={agent} grants={grants} />
        ) : (
          <PixelButton onClick={() => setDelegating(true)}>Give {agent.name} an objective</PixelButton>
        )}
      </section>

      <section className={a.section} aria-label="Work">
        <span className={px.tab}>Work</span>
        {detail.runs.length === 0 ? (
          <p className={px.dim}>No runs yet.</p>
        ) : (
          <ol className={a.lineage}>
            {detail.runs.map((run) => (
              <li key={run.runId} className={cx(px.vellum, a.lineageRow)} data-testid="agent-run">
                {run.goal && run.workflowRunId ? (
                  <Link href={`/workflows/${run.workflowRunId}`} className={a.link}>
                    {run.goal.title}
                  </Link>
                ) : (
                  <span>{run.goal?.title ?? "no goal"}</span>
                )}
                <span className={px.dim}>›</span>
                <span>{run.taskDefinitionName ?? "task definition not found"}</span>
                <StatusMark state={run.status} />
                {run.latestInvocation && (
                  <span>
                    latest #{run.latestInvocation.seqNo} {run.latestInvocation.kind} · {stateWord(run.latestInvocation.status)}
                  </span>
                )}
                {run.outcomeReason && <span className={px.dim}>{run.outcomeReason}</span>}
                <span className={px.dim}>{formatTime(run.startedAt)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <div className={a.columns}>
        <section className={a.section} aria-label="Keys">
          <span className={px.tab}>Keys</span>
          {grants.length === 0 ? (
            <p className={px.dim}>No capability grants.</p>
          ) : (
            <div className={a.cards} data-testid="agent-grants">
              {grants.map((g, i) => (
                <div key={g.id} className={px.parchment}>
                  <div className={px.label}>
                    Key {i + 1} · {g.capabilityName}
                  </div>
                  <div>
                    {g.permissions.join(", ")} · {g.autonomyState} · <span className={px.nowrap}>trust ≥ {g.maxTrustLevelRequired}</span>
                  </div>
                  {g.revoked ? (
                    <StatusMark state="revoked" tone="neutral" surface="parchment" />
                  ) : (
                    <RevokeKey grantId={g.id} label={`Key ${i + 1} · ${g.capabilityName}`} onChanged={onChanged} />
                  )}
                </div>
              ))}
            </div>
          )}
          <Link href={`/registry?agent=${agent.id}`} className={a.link}>
            Open in the Registry (read-only)
          </Link>
        </section>

        <section className={a.section} aria-label="Usage">
          <span className={px.tab}>Usage</span>
          {detail.budgetTotals.length === 0 ? (
            <p className={px.dim}>No consumption recorded.</p>
          ) : (
            <ul className={cx(px.vellum, a.plainList)} data-testid="agent-usage">
              {detail.budgetTotals.map((t) => (
                <li key={t.resourceUnit}>
                  <div className={px.dim}>{t.resourceUnit}</div>
                  <div title={`${t.consumed} consumed · ${t.reserved} reserved`}>
                    {formatAmount(t.consumed)} consumed · {formatAmount(t.reserved)} reserved
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className={px.detail}>Per unit, across the runs under Work. Units are never combined.</p>
          <Link href="/costs" className={a.link}>
            Open the cost ledger
          </Link>
        </section>

        <section className={a.section} aria-label="Latest context">
          <span className={px.tab}>Latest context</span>
          {!ctx ? (
            // Only each run's latest invocation is known, so "no model calls" can never be claimed; say what is absent.
            <p className={px.dim}>
              {detail.runs.some((r) => r.latestInvocation?.kind === "llm") ? "No context was recorded for its model calls." : "No compiled context recorded."}
            </p>
          ) : (
            <div className={px.vellum} data-testid="agent-context">
              {ctx.intent && <div>intent: {ctx.intent}</div>}
              <div>
                {ctx.estimatedInputTokens !== null && ctx.maxInputTokens !== null
                  ? `~${ctx.estimatedInputTokens} of ${ctx.effectiveMaxInputTokens ?? ctx.maxInputTokens} input tokens`
                  : "input token estimate not recorded"}
              </div>
              {/* The Budget Governor tightened this call's Context Budget; the Task's own ceiling is named, never implied. */}
              {ctx.budgetOutcome && ctx.taskMaxInputTokens != null && (
                <div data-testid="agent-context-budget">
                  budget {stateWord(ctx.budgetOutcome)} · task ceiling {ctx.taskMaxInputTokens} input tokens
                </div>
              )}
              {tiers.map((t) => (
                <div key={t}>
                  tier {t}: {ctx.included.filter((i) => i.tier === t).length} included
                </div>
              ))}
              {ctx.excluded.length === 0 ? (
                <div className={px.dim}>nothing excluded</div>
              ) : (
                ctx.excluded.map((e) => (
                  <div key={`${e.id}-${e.reason}`}>
                    excluded {e.id}: {e.reason}
                  </div>
                ))
              )}
              <div className={px.dim}>{formatTime(ctx.occurredAt)}</div>
            </div>
          )}
        </section>

        <section className={a.section} aria-label="Outputs">
          <span className={px.tab}>Outputs</span>
          {detail.outputs.length === 0 ? (
            <p className={px.dim}>No outputs yet.</p>
          ) : (
            <ul className={a.cards} data-testid="agent-outputs">
              {detail.outputs.map((o) => (
                <li key={o.id}>
                  <Link href={`/artifacts/${o.id}`} className={cx(px.plaque, a.output)}>
                    <span className={a.chest} aria-hidden />
                    <span>
                      {o.type} · {o.size} bytes
                    </span>
                    <span className={px.dim}>{formatTime(o.createdAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={cx(a.section, a.wide)} aria-label="Recent actions">
          <span className={px.tab}>Recent actions</span>
          {detail.recentEvents.length === 0 ? (
            <p className={px.dim}>No events for this agent&apos;s runs yet.</p>
          ) : (
            <ol className={cx(px.vellum, a.events)} data-testid="agent-events">
              {detail.recentEvents.map((e) => (
                <li key={e.eventId} title={`${e.eventType} · ${e.occurredAt} · #${e.eventCursor}`}>
                  <span className={cx(px.dim, a.ellipsis)}>{formatTime(e.occurredAt, true)}</span>
                  <span>{stateWord(e.eventType)}</span>
                  <span className={px.dim}>#{e.eventCursor}</span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className={cx(a.section, a.wide)} aria-label="Performance">
          <span className={px.tab}>Performance</span>
          {detail.performance.length === 0 ? (
            <p className={px.dim}>No performance measured for this version yet.</p>
          ) : (
            <div className={cx(px.vellum, a.scrollX)}>
              <table className={a.table} data-testid="agent-performance">
                <thead>
                  <tr>
                    <th>task</th>
                    <th>model tier</th>
                    <th>samples</th>
                    <th>success rate</th>
                    <th>avg retries</th>
                    <th>avg cost</th>
                    <th>routing</th>
                  </tr>
                </thead>
                <tbody>
                  {/* Stable order (task, then tier), never by success: a measurement, not a leaderboard. */}
                  {[...detail.performance]
                    .sort((x, y) => taskName(x.taskDefinitionId).localeCompare(taskName(y.taskDefinitionId)) || x.modelTier.localeCompare(y.modelTier))
                    .map((p) => (
                    <tr key={`${p.taskDefinitionId}-${p.modelTier}`}>
                      <td>{taskName(p.taskDefinitionId)}</td>
                      <td>{p.modelTier}</td>
                      <td>{p.sampleCount}</td>
                      <td>{p.successRate}</td>
                      <td>{p.avgRetries}</td>
                      <td>
                        {Object.entries(p.avgCost)
                          .map(([unit, v]) => `${v} ${unit}`)
                          .join(" · ") || "none recorded"}
                      </td>
                      {/* The runtime's eligibility gate, as the API returns it; never sampleCount compared here. */}
                      <td>{eligibilityWord(p)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className={px.detail}>
            A measurement, rebuilt after runs finish, so it lags recent work. An eligible row can steer the Model Router&apos;s tier
            choice; it never approves or runs anything.
          </p>
        </section>
      </div>
    </>
  );
}
