"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getAgentDetail, type AgentDetail } from "../../lib/api";
import { useRefetchOnEvents } from "../../components/live";
import { AgentRoster, useAgentRoster } from "../../components/agents/roster";
import { StopControl } from "../../components/StopControl";
import { PixelButton, Skeleton, StateNotice, StatusMark, cx, px } from "../../components/pixel/Pixel";
import { WorkshopCloseup } from "../../components/world/Workshop";
import { agentState, errorText, formatTime, stateWord } from "../../lib/keep";
import a from "./agents.module.css";

/**
 * Agents (spec 15.1 screen 2; Figma "Agents v2 — pixel"): what is this agent
 * doing, why, and can I stop it? Roster of every Agent Definition, the agent's
 * workshop at 4x lit by its real state with one key per grant, and a dense
 * board: Stop under the name, then lineage, keys, usage per unit, context
 * lineage, outputs, recent actions and measured performance. Renders only what
 * `GET /registry`, `GET /agents/active`, `GET /execution-stops` and
 * `GET /agents/:id` return.
 */
export function AgentsScreen({ id }: { id?: string }) {
  const roster = useAgentRoster();
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setDetail(await getAgentDetail(id));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err));
    }
  }, [id]);

  useEffect(() => {
    setDetail(null);
    setLoadError(null);
    void load();
  }, [load]);
  useRefetchOnEvents(load);

  const { reload: reloadRoster, registry } = roster;
  const reloadAll = useCallback(async () => {
    await Promise.all([load(), reloadRoster()]);
  }, [load, reloadRoster]);

  const taskName = useMemo(() => {
    const names = new Map((registry?.taskDefinitions ?? []).map((t) => [t.id, `${t.name} v${t.version}`]));
    return (taskDefinitionId: string) => names.get(taskDefinitionId) ?? (registry ? "task definition not in the Registry" : "· · ·");
  }, [registry]);

  const hrefFor = (x: string) => `/agents/${x}`;

  if (!id) {
    return (
      <main className={cx(a.screen, a.noWorld)}>
        <AgentRoster roster={roster} hrefFor={hrefFor} />
        <section className={cx(px.board, a.board)} aria-label="Agent detail">
          <StateNotice
            message="Choose an agent from the roster to see what it is doing."
            detail="The roster lists every Agent Definition version in the Registry."
            action={
              <Link href="/registry" className={a.link}>
                Open the Registry (read-only)
              </Link>
            }
          />
        </section>
      </main>
    );
  }

  const unfinished = detail?.runs.filter((r) => r.status !== "completed" && r.status !== "failed") ?? [];
  const current = unfinished.length > 0 ? agentState(unfinished.map((r) => r.status)) : null;
  const roomState = !detail
    ? null
    : detail.activeStop
      ? "stopped"
      : current === "active" || current === "awaiting_approval"
        ? current
        : "idle";

  return (
    <main className={a.screen}>
      <AgentRoster roster={roster} selectedId={id} hrefFor={hrefFor} />
      <WorkshopCloseup
        agentId={id}
        state={roomState}
        label={detail ? `${detail.agent.name}'s workshop` : "Workshop"}
        keys={detail?.grants.map((g, i) => ({ n: i + 1, revoked: g.revoked })) ?? []}
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
          <AgentBoard detail={detail} taskName={taskName} refreshError={loadError} onChanged={reloadAll} />
        )}
      </section>
    </main>
  );
}

function AgentBoard({
  detail,
  taskName,
  refreshError,
  onChanged,
}: {
  detail: AgentDetail;
  taskName: (id: string) => string;
  refreshError: string | null;
  onChanged: () => Promise<void>;
}) {
  const { agent, contextLineage: ctx } = detail;
  const tiers = ctx ? [...new Set(ctx.included.map((i) => i.tier))].sort((x, y) => x - y) : [];

  return (
    <>
      <header className={a.header}>
        <h1 className={px.heading}>
          {agent.name} v{agent.version}
        </h1>
        <StopControl agentId={agent.id} name={agent.name} version={agent.version} stop={detail.activeStop} onChanged={onChanged} />
        {!detail.activeStop && detail.runs.some((r) => r.status === "awaiting_approval") && (
          <Link href="/approvals" className={a.link}>
            Waiting at the council hall: review the approval
          </Link>
        )}
      </header>
      {refreshError && (
        <p role="alert" className={px.detail}>
          Couldn&apos;t refresh; showing the last read. {refreshError}
        </p>
      )}
      <div className={px.parchment}>
        <div className={px.label}>{agent.role}</div>
        <div>{agent.objective}</div>
      </div>

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
                  <span>{run.goal?.title ?? "Standalone task"}</span>
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
          {detail.grants.length === 0 ? (
            <p className={px.dim}>No capability grants.</p>
          ) : (
            <div className={a.cards} data-testid="agent-grants">
              {detail.grants.map((g, i) => (
                <div key={g.id} className={px.parchment}>
                  <div className={px.label}>
                    Key {i + 1} · {g.capabilityName}
                  </div>
                  <div>
                    {g.permissions.join(", ")} · {g.autonomyState} · trust ≥ {g.maxTrustLevelRequired}
                  </div>
                  {g.revoked && (
                    <StatusMark state="revoked" tone="fail" surface="parchment" />
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
                  <div>
                    {t.consumed} consumed · {t.reserved} reserved
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
            <p className={px.dim}>No model calls yet.</p>
          ) : (
            <div className={px.vellum} data-testid="agent-context">
              {ctx.intent && <div>intent: {ctx.intent}</div>}
              <div>
                {ctx.estimatedInputTokens !== null && ctx.maxInputTokens !== null
                  ? `~${ctx.estimatedInputTokens} of ${ctx.maxInputTokens} input tokens`
                  : "input token estimate not recorded"}
              </div>
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

        <section className={a.section} aria-label="Recent actions">
          <span className={px.tab}>Recent actions</span>
          {detail.recentEvents.length === 0 ? (
            <p className={px.dim}>No events for this agent&apos;s runs yet.</p>
          ) : (
            <ol className={cx(px.vellum, a.events)} data-testid="agent-events">
              {detail.recentEvents.map((e) => (
                <li key={e.eventId}>
                  <span className={px.dim}>{formatTime(e.occurredAt)}</span> {stateWord(e.eventType)}{" "}
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
                  </tr>
                </thead>
                <tbody>
                  {detail.performance.map((p) => (
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className={px.detail}>A measurement, rebuilt after runs finish, so it lags recent work. It ranks and recommends nothing.</p>
        </section>
      </div>
    </>
  );
}
