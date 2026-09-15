/**
 * The authoritative Policy decision record of a tool Invocation, as read models
 * expose it (spec §8.2, §9.3, §9.4). It is exactly what Policy recorded on each
 * `policy_evaluated` event, one record per evaluation checkpoint (`propose`,
 * `resume`, `pre_dispatch`) in sequence order: the last is the current decision.
 * Nothing is re-derived here, and a UI must not derive a decision either.
 *
 * - `basis`: why Policy decided (`PolicyBasis` in `../governance/policy.ts`). Null for
 *   evaluations recorded before the basis was (2026-09-15); evaluations of a CONDITIONAL
 *   Grant recorded before its rule was decided carry `autonomy_conditional_rule_undecided`.
 * - `conditionalRule`: the Conditional Autonomy rule a CONDITIONAL Grant was decided by
 *   (id and thresholds); null for other autonomy states and older evaluations.
 * - `performanceEvidence`: the performance Policy consulted (Agent Definition version,
 *   Task Definition, effective tier, sample count, success rate, eligibility); null when
 *   it consulted none.
 *
 * LLM, deterministic and retrieval Invocations never go through Policy and have no
 * record. Only named facts are returned, never the raw payload.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { events } from "../db/schema.js";
import type { ApiDeps } from "./server.js";

export type PerformanceEvidenceRecord = {
  agentDefinitionId: string | null;
  agentDefinitionVersion: number | null;
  taskDefinitionId: string | null;
  effectiveTier: string | null;
  sampleCount: number | null;
  successRate: string | null;
  minSamples: number | null;
  eligible: boolean | null;
  eligibilityReason: string | null;
};

export type ConditionalRuleRecord = {
  id: string | null;
  allowAtOrAboveSuccessRate: number | null;
  requireApprovalAtOrAboveSuccessRate: number | null;
  autoAllowPermissions: string[];
  autoAllowRiskTiers: string[];
};

export type PolicyDecisionRecord = {
  checkpoint: string | null;
  decision: string | null;
  basis: string | null;
  autonomyState: string | null;
  riskTier: string | null;
  grantId: string | null;
  capabilityId: string | null;
  permission: string | null;
  toolBindingId: string | null;
  trustLevel: string | null;
  /** The threshold Policy applied: the Grant's trust bar and the binding's trust level it compared (DENY below the bar). */
  maxTrustLevelRequired: number | null;
  bindingTrustLevel: number | null;
  conditionalRule: ConditionalRuleRecord | null;
  performanceEvidence: PerformanceEvidenceRecord | null;
};

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const texts = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

export function toPolicyDecisionRecord(payload: unknown): PolicyDecisionRecord {
  const p = object(payload) ?? {};
  const rule = object(p.conditionalRule);
  const evidence = object(p.performanceEvidence);
  return {
    checkpoint: text(p.checkpoint),
    decision: text(p.decision),
    basis: text(p.basis),
    autonomyState: text(p.autonomyState),
    riskTier: text(p.riskTier),
    grantId: text(p.grantId),
    capabilityId: text(p.capabilityId),
    permission: text(p.permission),
    toolBindingId: text(p.toolBindingId),
    trustLevel: text(p.trustLevel),
    maxTrustLevelRequired: num(p.maxTrustLevelRequired),
    bindingTrustLevel: num(p.bindingTrustLevel),
    conditionalRule: rule
      ? {
          id: text(rule.id),
          allowAtOrAboveSuccessRate: num(rule.allowAtOrAboveSuccessRate),
          requireApprovalAtOrAboveSuccessRate: num(rule.requireApprovalAtOrAboveSuccessRate),
          autoAllowPermissions: texts(rule.autoAllowPermissions),
          autoAllowRiskTiers: texts(rule.autoAllowRiskTiers),
        }
      : null,
    performanceEvidence: evidence
      ? {
          agentDefinitionId: text(evidence.agentDefinitionId),
          agentDefinitionVersion: num(evidence.agentDefinitionVersion),
          taskDefinitionId: text(evidence.taskDefinitionId),
          effectiveTier: text(evidence.effectiveTier),
          sampleCount: num(evidence.sampleCount),
          successRate: text(evidence.successRate),
          minSamples: num(evidence.minSamples),
          eligible: typeof evidence.eligible === "boolean" ? evidence.eligible : null,
          eligibilityReason: text(evidence.eligibilityReason),
        }
      : null,
  };
}

/**
 * Every Policy evaluation of the given Invocations of one Run, in sequence order, keyed by
 * Invocation id. Scoped by `runId` so the read uses the `(run_id, sequence_no)` index: an
 * Invocation's evaluations all belong to its own Run.
 */
export async function readPolicyDecisions(db: ApiDeps["db"], runId: string, invocationIds: string[]): Promise<Map<string, PolicyDecisionRecord[]>> {
  const byInvocation = new Map<string, PolicyDecisionRecord[]>();
  if (invocationIds.length === 0) return byInvocation;
  const rows = await db
    .select({ invocationId: events.invocationId, payload: events.payload })
    .from(events)
    .where(and(eq(events.runId, runId), eq(events.eventType, "policy_evaluated"), inArray(events.invocationId, invocationIds)))
    .orderBy(asc(events.sequenceNo));
  for (const row of rows) {
    if (!row.invocationId) continue;
    byInvocation.set(row.invocationId, [...(byInvocation.get(row.invocationId) ?? []), toPolicyDecisionRecord(row.payload)]);
  }
  return byInvocation;
}
