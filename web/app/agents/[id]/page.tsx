"use client";

import { use, useCallback, useEffect, useState } from "react";
import { engageAgentStop, getAgentDetail, liftAgentStop, type AgentDetail } from "../../../lib/api";

/**
 * Agent Detail (spec 15.1 screen 2) for one Agent Definition version. Renders
 * only what `GET /agents/:id` returns.
 *
 * The one control is the agent-scope emergency stop (spec 9.7): it refuses this
 * agent's next Invocation everywhere, and lifting it is forward-only. There is
 * no per-agent pause mechanism, so none is offered. Performance is shown as
 * unavailable, not approximated, until its projection exists.
 */
export default function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      setDetail(await getAgentDetail(id));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  async function act(action: () => Promise<void>): Promise<void> {
    setActing(true);
    setActionError(null);
    try {
      await action();
      setReason("");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(false);
      await refetch();
    }
  }

  if (loadError && !detail) {
    return (
      <main>
        <p style={{ color: "#b00020" }}>Failed to load agent: {loadError}</p>
      </main>
    );
  }
  if (!detail) {
    return (
      <main>
        <p>Loading…</p>
      </main>
    );
  }

  return (
    <main>
      <h1>
        {detail.agent.name} v{detail.agent.version}
      </h1>
      <div>Role: {detail.agent.role}</div>
      <div>Objective: {detail.agent.objective}</div>

      <section data-testid="agent-controls" style={{ border: "1px solid #ccc", borderRadius: 6, padding: 12, marginTop: 12 }}>
        <h2>Controls</h2>
        {detail.activeStop ? (
          <>
            <p style={{ color: "#b00020" }}>
              Stopped{detail.activeStop.reason ? `: ${detail.activeStop.reason}` : ""}
            </p>
            <button type="button" disabled={acting} onClick={() => act(() => liftAgentStop(detail.agent.id))}>
              Lift stop
            </button>
            <p style={{ fontSize: 12, color: "#555" }}>Lifting does not revive work the stop already failed.</p>
          </>
        ) : (
          <>
            <label htmlFor="stop-reason">Reason (optional)</label>
            <br />
            <input id="stop-reason" value={reason} onChange={(e) => setReason(e.target.value)} />{" "}
            <button
              type="button"
              disabled={acting}
              onClick={() => act(() => engageAgentStop(detail.agent.id, reason.trim() || undefined))}
            >
              Stop agent
            </button>
            <p style={{ fontSize: 12, color: "#555" }}>
              Stopping refuses this agent&apos;s next action everywhere. A call already running finishes.
            </p>
          </>
        )}
        {actionError && (
          <p role="alert" style={{ color: "#b00020" }}>
            {actionError}
          </p>
        )}
      </section>

      <section>
        <h2>Work</h2>
        {detail.runs.length === 0 && <p>No runs yet.</p>}
        {detail.runs.map((run) => (
          <div key={run.runId} data-testid="agent-run" style={{ marginBottom: 8 }}>
            {run.goal && run.workflowRunId ? (
              <a href={`/workflows/${run.workflowRunId}`}>{run.goal.title}</a>
            ) : (
              <span>{run.goal?.title ?? "Standalone task"}</span>
            )}
            {run.taskDefinitionName && ` · ${run.taskDefinitionName}`} · run {run.status}
            {run.latestInvocation &&
              ` · latest #${run.latestInvocation.seqNo} ${run.latestInvocation.kind} ${run.latestInvocation.status}`}
            {run.outcomeReason && ` · ${run.outcomeReason}`}
          </div>
        ))}
      </section>

      <section>
        <h2>Permissions</h2>
        {detail.grants.length === 0 ? (
          <p>No capability grants.</p>
        ) : (
          <ul data-testid="agent-grants">
            {detail.grants.map((grant) => (
              <li key={grant.id}>
                {grant.capabilityName}: {grant.permissions.join(", ")} · {grant.autonomyState} · trust ≥{" "}
                {grant.maxTrustLevelRequired}
                {grant.revoked && " · revoked"}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Usage</h2>
        {detail.budgetTotals.length === 0 ? (
          <p>No consumption recorded.</p>
        ) : (
          <ul data-testid="agent-usage">
            {detail.budgetTotals.map((total) => (
              <li key={total.resourceUnit}>
                {total.resourceUnit}: {total.consumed} consumed
                {Number(total.reserved) > 0 && ` (${total.reserved} reserved)`}
              </li>
            ))}
          </ul>
        )}
        <p style={{ fontSize: 12, color: "#555" }}>Per unit, across this agent&apos;s recent runs. Units are never combined.</p>
      </section>

      <section>
        <h2>Latest context</h2>
        {detail.contextLineage ? (
          <div data-testid="agent-context">
            ~{detail.contextLineage.estimatedInputTokens ?? "?"} of {detail.contextLineage.maxInputTokens ?? "?"} input tokens
            · {detail.contextLineage.included.length} included · {detail.contextLineage.excluded.length} excluded
            {detail.contextLineage.excluded.length > 0 && (
              <ul>
                {detail.contextLineage.excluded.map((e) => (
                  <li key={`${e.id}-${e.reason}`}>
                    {e.id}: {e.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <p>No model calls yet.</p>
        )}
      </section>

      <section>
        <h2>Outputs</h2>
        {detail.outputs.length === 0 ? (
          <p>No outputs yet.</p>
        ) : (
          <ul data-testid="agent-outputs">
            {detail.outputs.map((output) => (
              <li key={output.id}>
                {output.type} · {output.size} bytes · {output.createdAt}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Recent actions</h2>
        <ul data-testid="agent-events">
          {detail.recentEvents.map((event) => (
            <li key={event.eventId}>
              {event.eventType} · {event.occurredAt}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Performance</h2>
        <p>Not available yet: the agent performance projection has not been built.</p>
      </section>
    </main>
  );
}
