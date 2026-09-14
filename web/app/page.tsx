"use client";

import { useEffect, useState } from "react";
import { listActiveAgents, type AgentCardData } from "../lib/api";
import { AgentCard } from "../components/AgentCard";
import { ActivityFeed } from "../components/ActivityFeed";

/**
 * Overview page (task-11-brief.md's V1 UI scope): a list of Active Agent
 * cards (from `listActiveAgents()`) plus the live Activity Feed. Renders
 * only what the API returns — no policy/budget/workflow logic here.
 */
export default function OverviewPage() {
  const [agents, setAgents] = useState<AgentCardData[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listActiveAgents()
      .then((data) => {
        if (!cancelled) setAgents(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main>
      <h1>Overview</h1>

      <section>
        <h2>Active Agents</h2>
        {loadError && <p style={{ color: "#b00020" }}>Failed to load active agents: {loadError}</p>}
        {!loadError && agents === null && <p>Loading…</p>}
        {agents?.length === 0 && <p>No agents are currently active.</p>}
        {agents?.map((agent) => (
          <AgentCard key={agent.runId} agent={agent} />
        ))}
      </section>

      <section>
        <ActivityFeed />
      </section>
    </main>
  );
}
