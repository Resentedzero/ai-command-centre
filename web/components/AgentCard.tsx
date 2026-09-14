import type { AgentCardData } from "../lib/api";

/**
 * Renders one active agent's card: name, current task status, latest
 * activity. Deliberately does NOT render a revenue stat — there is no
 * revenue projection anywhere in this MVP (task-11-brief.md's explicit
 * "Out of scope"), and `AgentCardData` has no such field, so this is
 * trivially satisfied rather than something this component has to actively
 * avoid.
 *
 * Plain inline styles only (Ruling 4 — no Tailwind/shadcn/design system for
 * this MVP).
 */
export function AgentCard({ agent }: { agent: AgentCardData }) {
  return (
    <div
      data-testid="agent-card"
      style={{
        border: "1px solid #ccc",
        borderRadius: 6,
        padding: 12,
        marginBottom: 8,
      }}
    >
      <div style={{ fontWeight: "bold" }}>
        {agent.agentDefinitionId ? <a href={`/agents/${agent.agentDefinitionId}`}>{agent.agentName}</a> : agent.agentName}
      </div>
      <div>Task status: {agent.taskStatus}</div>
      <div>Latest activity: {agent.latestActivitySummary ?? "No activity yet"}</div>
    </div>
  );
}
