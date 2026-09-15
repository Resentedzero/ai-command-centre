/**
 * The authoritative Policy decision record of a tool Invocation, as read models
 * expose it (spec §8.2, §9.3). It is exactly what Policy recorded on each
 * `policy_evaluated` event, one record per evaluation checkpoint (`propose`,
 * `resume`, `pre_dispatch`) in sequence order: the last is the current decision.
 * Nothing is re-derived here, and a UI must not derive a decision either.
 *
 * - `basis`: why Policy decided (`PolicyBasis` in `../governance/policy.ts`). Null for
 *   evaluations recorded before the basis was (2026-09-15).
 * - `performanceEvidence`: always null. Policy consults no performance: the §9.4
 *   CONDITIONAL rule's values are undecided (ROADMAP_STATUS §6), so a CONDITIONAL Grant
 *   requires approval with basis `autonomy_conditional_rule_undecided`.
 *
 * LLM, deterministic and retrieval Invocations never go through Policy and have no
 * record. Only named facts are returned, never the raw payload.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { events } from "../db/schema.js";
import type { ApiDeps } from "./server.js";

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
  performanceEvidence: null;
};

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

export function toPolicyDecisionRecord(payload: unknown): PolicyDecisionRecord {
  const p = (payload ?? {}) as Record<string, unknown>;
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
    performanceEvidence: null,
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
