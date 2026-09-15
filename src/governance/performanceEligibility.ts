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
 * The only consumer is the Model Router's tier preference (§10.2, §10.5). Policy does
 * not read performance: §9.4's CONDITIONAL rule needs thresholds that are not yet
 * decided, so CONDITIONAL still requires approval. `tests/execution/structuralInvariants.test.ts`
 * enforces both.
 */
import { and, asc, eq } from "drizzle-orm";
import { agentPerformance, runs, taskInstances } from "../db/schema.js";
import type { DrizzleTransaction } from "../events/emit.js";

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
