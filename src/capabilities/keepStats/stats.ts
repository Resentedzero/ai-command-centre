/**
 * The statistics behind `system.keep_stats`: deterministic aggregates over the `events` table for one
 * window. Semantics are fixed and stated in the result, so a reader never has to guess:
 *
 * WINDOW. Events whose `occurred_at` is in [asOf − W, asOf), with `asOf` the database clock when the
 * statistics are read. `occurred_at` is the only timestamp an event has (the database's `now()` at insert).
 * Each metric counts ITS OWN event type inside the window, independently: a goal completed in the window
 * counts even if it was created before it. Nothing here is current state or a lifetime total.
 *
 * NOT MEASURABLE, reported as unknown instead of estimated: USD spend (only pre-call estimates exist),
 * tokens of secondary models inside a provider call (not persisted), durations (run timestamps are
 * mutable projection columns, and runs straddle the window edge).
 */
import { sql } from "drizzle-orm";
import type { DrizzleTransaction } from "../../events/emit.js";
import { KEEP_STATS_WINDOWS, type KeepStatsWindow } from "./capability.js";

export type KeepStatsResult = {
  window: { label: KeepStatsWindow; from: string; to: string; basis: string };
  results: { metric: string; value: number; semantics: string }[];
  agents: { name: string; runsCompleted: number; subscriptionTokens: number }[];
  unknown: string[];
  sources: { label: string; ref: string }[];
};

/** At most this many agents are listed (by runs completed); the rest are only counted. */
const MAX_AGENTS = 10;

type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined ? 0 : Math.round(Number(v)));

export async function computeKeepStats(tx: DrizzleTransaction, window: KeepStatsWindow): Promise<KeepStatsResult> {
  const hours = KEEP_STATS_WINDOWS[window];
  const [clock] = (await tx.execute(sql`SELECT now() AS "to", now() - make_interval(hours => ${hours}) AS "from"`)).rows as { to: Date | string; from: Date | string }[];
  const to = new Date(clock!.to);
  const from = new Date(clock!.from);
  const inWindow = sql`e.occurred_at >= ${from} AND e.occurred_at < ${to}`;

  const [c] = (
    await tx.execute(sql`
      SELECT
        count(*) FILTER (WHERE e.event_type = 'goal_created') AS goals_created,
        count(*) FILTER (WHERE e.event_type = 'goal_completed') AS goals_completed,
        count(DISTINCT e.goal_id) FILTER (WHERE e.event_type = 'goal_failed' AND e.goal_id NOT IN (SELECT h.goal_id FROM events h WHERE h.event_type = 'run_halted' AND h.goal_id IS NOT NULL AND h.occurred_at >= ${from} AND h.occurred_at < ${to})) AS goals_failed,
        count(DISTINCT e.goal_id) FILTER (WHERE e.event_type = 'run_halted') AS goals_stopped,
        count(*) FILTER (WHERE e.event_type = 'workflow_run_started') AS workflow_runs_started,
        count(*) FILTER (WHERE e.event_type = 'workflow_run_completed') AS workflow_runs_completed,
        count(*) FILTER (WHERE e.event_type = 'workflow_run_failed') AS workflow_runs_failed,
        count(*) FILTER (WHERE e.event_type = 'run_completed') AS runs_completed,
        count(*) FILTER (WHERE e.event_type = 'run_failed') AS runs_failed,
        count(*) FILTER (WHERE e.event_type = 'run_halted') AS runs_halted,
        count(*) FILTER (WHERE e.event_type = 'invocation_failed') AS invocations_failed,
        coalesce(sum(e.cost_amount) FILTER (WHERE e.event_type = 'invocation_completed' AND e.cost_unit = 'subscription_tokens'), 0) AS subscription_tokens,
        count(*) FILTER (WHERE e.event_type = 'approval_required') AS approvals_required,
        count(*) FILTER (WHERE e.event_type = 'approval_granted') AS approvals_granted,
        count(*) FILTER (WHERE e.event_type = 'approval_rejected') AS approvals_rejected,
        count(*) FILTER (WHERE e.event_type = 'approval_expired') AS approvals_expired,
        count(*) FILTER (WHERE e.event_type = 'execution_stop_engaged') AS stops_engaged,
        count(*) FILTER (WHERE e.event_type = 'execution_stop_lifted') AS stops_lifted,
        count(*) FILTER (WHERE e.event_type = 'artifact_created' AND e.payload->>'type' IN ('deliverable', 'report', 'keeper_answer')) AS deliverables_created,
        count(*) FILTER (WHERE e.event_type = 'manager_plan_validated') AS manager_plans_validated,
        count(*) FILTER (WHERE e.event_type = 'manager_plan_rejected') AS manager_plans_rejected,
        count(*) FILTER (WHERE e.event_type = 'manager_review_decided' AND e.payload->>'decision' = 'complete') AS manager_reviews_complete,
        count(*) FILTER (WHERE e.event_type = 'manager_review_decided' AND e.payload->>'decision' <> 'complete') AS manager_reviews_not_complete
      FROM events e
      WHERE ${inWindow}`)
  ).rows as Row[];

  const kinds = (
    await tx.execute(sql`
      SELECT i.kind AS kind, count(*) AS n
      FROM events e JOIN invocations i ON i.id = e.invocation_id
      WHERE ${inWindow} AND e.event_type = 'invocation_completed'
      GROUP BY i.kind`)
  ).rows as { kind: string; n: unknown }[];
  const kind = (k: string) => num(kinds.find((r) => r.kind === k)?.n);

  const agentRows = (
    await tx.execute(sql`
      SELECT ad.name AS name,
        count(*) FILTER (WHERE e.event_type = 'run_completed') AS runs_completed,
        coalesce(sum(e.cost_amount) FILTER (WHERE e.event_type = 'invocation_completed' AND e.cost_unit = 'subscription_tokens'), 0) AS tokens
      FROM events e JOIN runs r ON r.id = e.run_id JOIN agent_definitions ad ON ad.id = r.agent_definition_id
      WHERE ${inWindow} AND e.event_type IN ('run_completed', 'invocation_completed')
      GROUP BY ad.name
      HAVING count(*) FILTER (WHERE e.event_type = 'run_completed') > 0
      ORDER BY runs_completed DESC, name ASC`)
  ).rows as { name: string; runs_completed: unknown; tokens: unknown }[];

  const metric = (name: string, value: unknown, semantics: string) => ({ metric: name, value: num(value), semantics });
  const results = [
    metric("goals_created", c!.goals_created, "goal_created events"),
    metric("goals_completed", c!.goals_completed, "goal_completed events"),
    metric("goals_failed", c!.goals_failed, "goals with a goal_failed event and no emergency stop in the window"),
    metric("goals_stopped", c!.goals_stopped, "goals with a run halted by an emergency stop"),
    metric("workflow_runs_started", c!.workflow_runs_started, "workflow_run_started events"),
    metric("workflow_runs_completed", c!.workflow_runs_completed, "workflow_run_completed events"),
    metric("workflow_runs_failed", c!.workflow_runs_failed, "workflow_run_failed events"),
    metric("runs_completed", c!.runs_completed, "run_completed events (agent task attempts that finished)"),
    metric("runs_failed", c!.runs_failed, "run_failed events"),
    metric("runs_halted", c!.runs_halted, "run_halted events (stopped by an emergency stop)"),
    metric("llm_calls", kind("llm"), "completed model invocations"),
    metric("tool_calls", kind("tool"), "completed tool invocations (capabilities used)"),
    metric("deterministic_steps", kind("deterministic"), "completed deterministic invocations"),
    metric("invocations_failed", c!.invocations_failed, "invocation_failed events"),
    metric("subscription_tokens", c!.subscription_tokens, "provider-reported subscription tokens on completed model calls: every model entry the provider reported, summed"),
    metric("agents_that_worked", agentRows.length, "distinct agents with at least one completed run"),
    metric("approvals_required", c!.approvals_required, "approval_required events"),
    metric("approvals_granted", c!.approvals_granted, "approval_granted events"),
    metric("approvals_rejected", c!.approvals_rejected, "approval_rejected events"),
    metric("approvals_expired", c!.approvals_expired, "approval_expired events"),
    metric("stops_engaged", c!.stops_engaged, "execution_stop_engaged events"),
    metric("stops_lifted", c!.stops_lifted, "execution_stop_lifted events"),
    metric("deliverables_created", c!.deliverables_created, "deliverable, report and keeper_answer artifacts created"),
    metric("manager_plans_validated", c!.manager_plans_validated, "Manager plans accepted by validation"),
    metric("manager_plans_rejected", c!.manager_plans_rejected, "Manager plans refused by validation or escalated"),
    metric("manager_reviews_complete", c!.manager_reviews_complete, "Manager reviews whose code decision was complete"),
    metric("manager_reviews_not_complete", c!.manager_reviews_not_complete, "Manager reviews that escalated or started a follow-up"),
  ];
  const agents = agentRows.slice(0, MAX_AGENTS).map((a) => ({ name: a.name, runsCompleted: num(a.runs_completed), subscriptionTokens: num(a.tokens) }));
  return {
    window: { label: window, from: from.toISOString(), to: to.toISOString(), basis: "events with occurred_at in [from, to); each metric counts its own event type in the window" },
    results,
    agents,
    unknown: [
      "USD spend: no provider has ever reported one. A usd amount here would be provider-reported TOKENS priced at a local list rate — an estimate, not a measured or billed cost.",
      "Which model did what inside a provider call, when the CLI merges an internal secondary call into the primary's own entry: the tokens are counted, but at source there is nothing to split. Where the CLI does report separate entries, the split is recorded on the invocation.",
      "Durations: run timestamps are not events, and runs can straddle the window edge.",
      ...(agentRows.length > MAX_AGENTS ? [`${agentRows.length - MAX_AGENTS} more agents worked; only the top ${MAX_AGENTS} by runs completed are listed.`] : []),
    ],
    sources: [{ label: "events (immutable), with invocations and runs for kinds and agents", ref: "events" }],
  };
}
