/**
 * The minimum sample criterion for `agent_performance` (spec Phase 19 V2/V4, Phase 20
 * Risk #10). Decided 2026-09-14: an Agent Definition version's performance for one
 * Task Definition and model tier is eligible to influence a decision only when that
 * group has at least N samples (`sample_count`: finished Runs attributable to the
 * agent, as the projector defines them). Below N, or with no N configured, it influences
 * nothing; it stays displayable either way.
 *
 * N = 10, CHOSEN BY THE OPERATOR 2026-09-15 (ROADMAP_STATUS §6 D2): ten samples for the
 * same Agent Definition version, Task Definition and tier. Null would mean no criterion
 * (nothing eligible), the same config pattern as `./dailyBudgetPolicy.ts`. Callers may
 * pass a different N only through an explicit option, which production never does.
 *
 * Two decisions read it, both through this gate: the Model Router's tier preference
 * (§10.2, §10.5), and Policy's Conditional Autonomy rule (§9.4, decided 2026-09-15), whose
 * evidence `readConditionalEvidence` resolves for the Invocation lifecycle to hand to
 * Policy. The read APIs display each row's eligibility through
 * `../api/performanceEligibilityFields.ts`, deciding nothing.
 * `tests/execution/structuralInvariants.test.ts` enforces the importers.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { agentPerformance, events, runs, taskInstances } from "../db/schema.js";
import type { DrizzleTransaction } from "../events/emit.js";
import type { ConditionalPerformanceEvidence } from "./policy.js";

/** N, the operator's value (2026-09-15). Null would mean no criterion configured: nothing eligible. */
export const MIN_PERFORMANCE_SAMPLES: number | null = 10;

export type PerformanceEligibility = { eligible: true } | { eligible: false; reason: "no_criterion" | "insufficient_samples" };

/** Fails closed on a malformed N: a zero or fractional minimum is not a criterion. */
export function performanceEligibility(sampleCount: number, minSamples: number | null = MIN_PERFORMANCE_SAMPLES): PerformanceEligibility {
  if (minSamples === null) return { eligible: false, reason: "no_criterion" };
  if (!Number.isInteger(minSamples) || minSamples < 1) {
    throw new Error(`performanceEligibility: the minimum sample count must be a positive integer (received ${minSamples}).`);
  }
  return sampleCount >= minSamples ? { eligible: true } : { eligible: false, reason: "insufficient_samples" };
}

export type TierPerformanceRow = {
  tier: string;
  sampleCount: number;
  successRate: string;
  avgCost: Record<string, string>;
  updatedAt: string;
  eligibility: PerformanceEligibility;
};

export type TierPerformanceSnapshot =
  | { consulted: false; reason: "no_criterion" | "unbound_run" }
  | { consulted: true; minSamples: number; rows: TierPerformanceRow[] };

/**
 * The performance rows for a Run's own (Agent Definition version, Task Definition),
 * one per tier, each with its eligibility. Read in one statement, so a concurrent
 * projection refresh is seen entirely or not at all (READ COMMITTED: the previous
 * rows until it commits). Missing rows are simply absent: absent data is ineligible.
 */
export async function readTierPerformance(
  tx: DrizzleTransaction,
  runId: string,
  minSamples: number | null = MIN_PERFORMANCE_SAMPLES
): Promise<TierPerformanceSnapshot> {
  if (minSamples === null) return { consulted: false, reason: "no_criterion" };
  performanceEligibility(0, minSamples); // validates N even when there are no rows

  const [binding] = await tx
    .select({ agentDefinitionId: runs.agentDefinitionId, agentDefinitionVersion: runs.agentDefinitionVersion, taskDefinitionId: taskInstances.taskDefinitionId })
    .from(runs)
    .innerJoin(taskInstances, eq(taskInstances.id, runs.taskInstanceId))
    .where(eq(runs.id, runId));
  if (!binding || binding.agentDefinitionId === null || binding.agentDefinitionVersion === null) {
    return { consulted: false, reason: "unbound_run" };
  }

  const rows = await tx
    .select()
    .from(agentPerformance)
    .where(
      and(
        eq(agentPerformance.agentDefinitionId, binding.agentDefinitionId),
        eq(agentPerformance.agentDefinitionVersion, binding.agentDefinitionVersion),
        eq(agentPerformance.taskDefinitionId, binding.taskDefinitionId)
      )
    )
    .orderBy(asc(agentPerformance.modelTier));

  return {
    consulted: true,
    minSamples,
    rows: rows.map((r) => ({
      tier: r.modelTier,
      sampleCount: r.sampleCount,
      successRate: r.successRate,
      avgCost: r.avgCost,
      updatedAt: r.updatedAt.toISOString(),
      eligibility: performanceEligibility(r.sampleCount, minSamples),
    })),
  };
}

/**
 * The evidence Policy's Conditional Autonomy rule consults for a tool action in `runId`:
 * the row for the Run's own Agent Definition version and Task Definition at the tier the
 * Model Router selected — the `resultingTier` of its latest route in this Run. A Run that
 * has routed no model call has no selected tier, and so no applicable row: never another
 * tier's, another Task's or an aggregate. The Executor is sequential, so at `resume` and
 * `pre_dispatch` nothing has routed since `propose` and the tier is the same.
 */
export async function readConditionalEvidence(
  tx: DrizzleTransaction,
  runId: string,
  minSamples: number | null = MIN_PERFORMANCE_SAMPLES
): Promise<ConditionalPerformanceEvidence> {
  const snapshot = await readTierPerformance(tx, runId, minSamples);
  const none = {
    agentDefinitionId: null,
    agentDefinitionVersion: null,
    taskDefinitionId: null,
    effectiveTier: null,
    sampleCount: null,
    successRate: null,
    minSamples,
    eligible: false,
  } as const;
  if (!snapshot.consulted) return { ...none, eligibilityReason: snapshot.reason };

  const [binding] = await tx
    .select({ agentDefinitionId: runs.agentDefinitionId, agentDefinitionVersion: runs.agentDefinitionVersion, taskDefinitionId: taskInstances.taskDefinitionId })
    .from(runs)
    .innerJoin(taskInstances, eq(taskInstances.id, runs.taskInstanceId))
    .where(eq(runs.id, runId));
  const scope = { ...none, agentDefinitionId: binding!.agentDefinitionId, agentDefinitionVersion: binding!.agentDefinitionVersion, taskDefinitionId: binding!.taskDefinitionId };

  const [route] = await tx
    .select({ tier: sql<string>`${events.payload}->>'resultingTier'` })
    .from(events)
    .where(
      and(
        eq(events.runId, runId),
        eq(events.eventType, "invocation_started"),
        // The Router's own record only: no other producer's started event can name a tier.
        eq(events.producer, "model-router"),
        sql`${events.payload} ? 'resultingTier'`
      )
    )
    .orderBy(desc(events.sequenceNo))
    .limit(1);
  if (!route?.tier) return { ...scope, eligibilityReason: "no_routed_tier" };

  const row = snapshot.rows.find((r) => r.tier === route.tier);
  if (!row) return { ...scope, effectiveTier: route.tier, eligibilityReason: "no_performance_row" };
  return {
    ...scope,
    effectiveTier: route.tier,
    sampleCount: row.sampleCount,
    successRate: row.successRate,
    eligible: row.eligibility.eligible,
    eligibilityReason: row.eligibility.eligible ? null : row.eligibility.reason,
  };
}
