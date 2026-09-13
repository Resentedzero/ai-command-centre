/**
 * `proposeInvocation` / `authorizeInvocation` / `completeInvocation` /
 * `failInvocation` — the Invocation lifecycle primitives Unit 6's Executor
 * sequences (Phase 11.1).
 *
 * Design note on module boundaries (why Grant/Tool-Binding resolution live
 * HERE as their own exported functions, separate from `authorizeInvocation`):
 * the brief's "Tests required" list demands a spy-based order-of-operations
 * test proving Grant-check -> Policy -> Budget -> Approval run in that exact
 * sequence. For a `vi.spyOn` on an exported function to reliably intercept a
 * call under this project's Vitest+TS setup, the call must cross a module
 * boundary (a different file calling the export) — this is the same
 * constraint `policyCallHelper.ts` documents and proves for Unit 5's tests.
 * So `resolveCapabilityGrant` and `resolveToolBindingTrustLevel` are called
 * directly BY `executor.ts` (not internally by `authorizeInvocation` in this
 * same file), keeping every spied step a genuine cross-module call.
 * `authorizeInvocation` itself is consequently a thin, already-resolved-input
 * wrapper around Unit 3's `evaluatePolicy` — matching the "executeRun stays
 * thin, call the existing function instead of duplicating logic" constraint.
 *
 * `mapTrustLevel` / the integer-trustLevel gap (undocumented by any prior
 * unit — a genuine Unit 6 design decision, not a transcription):
 * `tool_bindings.trust_level` is an INTEGER column (Phase 12's schema), but
 * `evaluatePolicy`/`computeRiskTier` (Unit 3, frozen per the original MVP
 * plan) take a three-category STRING trust classification
 * ("first_party" | "verified_third_party" | "unverified_third_party"). No
 * unit before this one defines the mapping between them. Resolution: treat
 * higher trustLevel as MORE trusted (the only plausible ordinal reading,
 * consistent with `capability_grants.max_trust_level_required` acting as a
 * minimum bar a binding must clear), with illustrative MVP thresholds, and
 * fail closed to the MOST cautious category ("unverified_third_party") for
 * anything unrecognized — never the least cautious. This mirrors
 * `policy.ts`'s own `readAmountOrScope`/`readIsNovelAction` convention of
 * refusing to silently under-read toward less governance.
 */
import { and, eq } from "drizzle-orm";
import { capabilityGrants, invocations, runs, toolBindings } from "../db/schema.js";
import type { DrizzleTransaction } from "../events/emit.js";
import { emitEvent } from "../events/emit.js";
import { evaluatePolicy } from "../governance/policy.js";
import type { CapabilityGrant, CapabilityPermission, PolicyDecision } from "../governance/policy.js";
import type { RiskTier } from "../governance/risk.js";
import type { CostClass } from "../governance/costClass.js";
import type { InvocationKind } from "./types.js";

export function buildInvocationIdempotencyKey(runId: string, seqNo: number): string {
  return `run:${runId}:seq:${seqNo}`;
}

// ---------------------------------------------------------------------------
// proposeInvocation
// ---------------------------------------------------------------------------

export type ProposeInvocationParams = {
  runId: string;
  seqNo: number;
  kind: InvocationKind;
  costClass: CostClass;
  taskInstanceId: string;
  capabilityId?: string | null;
  permission?: string | null;
  proposedActionSnapshot?: Record<string, unknown> | null;
  /**
   * Whether to emit `invocation_started` ourselves. Default true (tool,
   * deterministic, retrieval — Units 2-4 never emit this). Pass `false` for
   * "llm" kind: Unit 5's `authorizeRoute` already emits it (Ruling 3) — a
   * second emission here would be a duplicate (guarded further by
   * `emitEvent`'s own idempotency, but the flag keeps intent explicit).
   */
  emitStarted?: boolean;
  startedPayload?: Record<string, unknown>;
};

/**
 * Creates the `invocations` row (status "proposed") and, unless
 * `emitStarted: false`, emits `invocation_started` correlated to
 * runId/taskInstanceId/invocationId — the "propose" half of the Invocation
 * lifecycle (Phase 11.1).
 */
export async function proposeInvocation(
  tx: DrizzleTransaction,
  params: ProposeInvocationParams
): Promise<{ invocationId: string; idempotencyKey: string }> {
  const idempotencyKey = buildInvocationIdempotencyKey(params.runId, params.seqNo);

  const [row] = await tx
    .insert(invocations)
    .values({
      runId: params.runId,
      seqNo: params.seqNo,
      kind: params.kind,
      costClass: params.costClass,
      status: "proposed",
      idempotencyKey,
      capabilityId: params.capabilityId ?? null,
      permission: params.permission ?? null,
      proposedActionSnapshot: params.proposedActionSnapshot ?? null,
    })
    .returning();

  const invocationId = row!.id;

  const emitStarted = params.emitStarted ?? true;
  if (emitStarted) {
    await emitEvent(tx, {
      idempotencyKey: `invocation_started:${invocationId}`,
      eventType: "invocation_started",
      eventVersion: 1,
      causationId: null,
      correlation: {
        goalId: null,
        workflowRunId: null,
        taskInstanceId: params.taskInstanceId,
        runId: params.runId,
        invocationId,
      },
      actor: "system",
      producer: "executor",
      payload: { kind: params.kind, ...(params.startedPayload ?? {}) },
      usage: null,
    });
  }

  return { invocationId, idempotencyKey };
}

// ---------------------------------------------------------------------------
// Grant / Tool Binding resolution (called directly by executor.ts — see
// module header for why these are separate exported functions)
// ---------------------------------------------------------------------------

/**
 * Resolves the governing Capability Grant for `(run's agentDefinitionId,
 * agentDefinitionVersion, capabilityId)`, filtered to rows that are unrevoked
 * and cover `permission` — the same lookup shape `reauthorize` (Unit 3) uses,
 * kept consistent deliberately. Returns `null` (never throws) when no
 * qualifying Grant exists: that is a legitimate "no Grant" outcome for
 * `evaluatePolicy` to DENY on, not a caller error.
 */
export async function resolveCapabilityGrant(
  tx: DrizzleTransaction,
  params: { runId: string; capabilityId: string; permission: CapabilityPermission }
): Promise<CapabilityGrant | null> {
  const runRow = await tx.query.runs.findFirst({ where: eq(runs.id, params.runId) });
  if (!runRow) {
    throw new Error(`resolveCapabilityGrant: no run found for id "${params.runId}"`);
  }

  if (runRow.agentDefinitionId === null || runRow.agentDefinitionVersion === null) {
    return null; // no bound agent -> no Grant can possibly match
  }

  const candidates = await tx.query.capabilityGrants.findMany({
    where: and(
      eq(capabilityGrants.agentDefinitionId, runRow.agentDefinitionId),
      eq(capabilityGrants.agentDefinitionVersion, runRow.agentDefinitionVersion),
      eq(capabilityGrants.capabilityId, params.capabilityId)
    ),
  });

  const match = candidates.find(
    (g) => g.revokedAt === null && Array.isArray(g.permissions) && g.permissions.includes(params.permission)
  );
  if (!match) return null;

  return {
    agentDefinitionId: match.agentDefinitionId,
    agentDefinitionVersion: match.agentDefinitionVersion,
    capabilityId: match.capabilityId,
    permissions: match.permissions as CapabilityPermission[],
    // Finding 2: the Grant's declared trust bar, previously dropped here and
    // therefore never enforceable by Policy. Passed through verbatim from the
    // row — never defaulted, never recomputed.
    maxTrustLevelRequired: match.maxTrustLevelRequired,
    autonomyState: match.autonomyState as CapabilityGrant["autonomyState"],
  };
}

export type PolicyTrustLevel = "first_party" | "verified_third_party" | "unverified_third_party";

/** See module header for the full rationale — an undocumented gap this unit resolves. */
export function mapTrustLevel(trustLevel: number): PolicyTrustLevel {
  if (!Number.isFinite(trustLevel)) return "unverified_third_party";
  if (trustLevel >= 2) return "first_party";
  if (trustLevel === 1) return "verified_third_party";
  return "unverified_third_party"; // trustLevel <= 0, or anything else unrecognized
}

export type ResolvedToolBindingTrust = {
  /** The three-category classification Policy/risk speak (Phase 6). */
  trustLevel: PolicyTrustLevel;
  /**
   * The raw `tool_bindings.trust_level` integer, for Policy's comparison
   * against the Grant's `max_trust_level_required` (Finding 2).
   */
  bindingTrustLevel: number;
};

/**
 * Returns BOTH projections of the binding's trust from a SINGLE read of the
 * `tool_bindings` row: the raw integer (what Policy compares against the
 * Grant's bar) and its category (what Policy/risk classify by). Returning
 * them together, rather than exposing two functions or two reads, is what
 * makes them consistent by construction — there is no window in which a
 * caller can pair one binding's integer with another binding's category, and
 * no path by which either value originates anywhere but this row.
 */
export async function resolveToolBindingTrustLevel(
  tx: DrizzleTransaction,
  toolBindingId: string
): Promise<ResolvedToolBindingTrust> {
  const row = await tx.query.toolBindings.findFirst({ where: eq(toolBindings.id, toolBindingId) });
  if (!row) {
    throw new Error(`resolveToolBindingTrustLevel: no tool_bindings row found for id "${toolBindingId}"`);
  }
  return { trustLevel: mapTrustLevel(row.trustLevel), bindingTrustLevel: row.trustLevel };
}

// ---------------------------------------------------------------------------
// authorizeInvocation
// ---------------------------------------------------------------------------

/**
 * Thin wrapper around Unit 3's `evaluatePolicy`, taking already-resolved
 * Grant/trustLevel (resolved by `executor.ts` via the two functions above —
 * see module header for why). This is the "authorize" step of the Invocation
 * lifecycle; it contains no policy logic of its own.
 */
export async function authorizeInvocation(
  tx: DrizzleTransaction,
  params: {
    grant: CapabilityGrant | null;
    permission: CapabilityPermission;
    proposedActionSnapshot: Record<string, unknown>;
    trustLevel: PolicyTrustLevel;
    bindingTrustLevel: number;
  }
): Promise<{ decision: PolicyDecision; riskTier: RiskTier }> {
  return evaluatePolicy(tx, params);
}

// ---------------------------------------------------------------------------
// completeInvocation / failInvocation
// ---------------------------------------------------------------------------

export type CompleteInvocationParams = {
  invocationId: string;
  runId: string;
  taskInstanceId: string;
  payload?: Record<string, unknown>;
  /**
   * Default true (tool, deterministic, retrieval). Pass `false` for "llm"
   * kind: Unit 5's `callModel` already emitted `invocation_completed`
   * (Ruling 3) — this flag only updates the `invocations.status` column.
   */
  emitEvent?: boolean;
};

export async function completeInvocation(tx: DrizzleTransaction, params: CompleteInvocationParams): Promise<void> {
  await tx
    .update(invocations)
    .set({ status: "completed", completedAt: new Date() })
    .where(eq(invocations.id, params.invocationId));

  const shouldEmit = params.emitEvent ?? true;
  if (shouldEmit) {
    await emitEvent(tx, {
      idempotencyKey: `invocation_completed:${params.invocationId}`,
      eventType: "invocation_completed",
      eventVersion: 1,
      causationId: null,
      correlation: {
        goalId: null,
        workflowRunId: null,
        taskInstanceId: params.taskInstanceId,
        runId: params.runId,
        invocationId: params.invocationId,
      },
      actor: "system",
      producer: "executor",
      payload: params.payload ?? {},
      usage: null,
    });
  }
}

export type FailInvocationParams = {
  invocationId: string;
  runId: string;
  taskInstanceId: string;
  reason: string;
};

/**
 * Always emits `invocation_failed` — including for the "llm" kind. Unlike
 * `invocation_started`/`invocation_completed`, Unit 5's `callModel` and
 * `authorizeRoute` deliberately never emit a failure event themselves (see
 * `modelRouter.ts`'s own header: "Emitting invocation_failed uniformly...
 * is the future Unit 6 Executor's responsibility"), so there is no
 * possibility of a duplicate here and no flag is needed.
 */
export async function failInvocation(tx: DrizzleTransaction, params: FailInvocationParams): Promise<void> {
  await tx
    .update(invocations)
    .set({ status: "failed", completedAt: new Date() })
    .where(eq(invocations.id, params.invocationId));

  await emitEvent(tx, {
    idempotencyKey: `invocation_failed:${params.invocationId}`,
    eventType: "invocation_failed",
    eventVersion: 1,
    causationId: null,
    correlation: {
      goalId: null,
      workflowRunId: null,
      taskInstanceId: params.taskInstanceId,
      runId: params.runId,
      invocationId: params.invocationId,
    },
    actor: "system",
    producer: "executor",
    payload: { reason: params.reason },
    usage: null,
  });
}
