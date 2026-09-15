/**
 * An Agent Definition's execution profile (V1.1): what the agent asks of the
 * runtime, never how it is served.
 *
 * - `preferredTier`: the logical tier its model calls start from (CHEAP / MID /
 *   STRONG). Plans express it as the LLM spec's `taskDifficulty`, so the Model
 *   Router still applies the risk floor, the retry escalation floor, measured
 *   performance (upward only) and the budget fallback. It never names a model.
 * - `provider`: restricts routing to one configured provider. The Router serves
 *   the call from that provider's candidates or refuses it; it never uses another
 *   provider instead (no silent fallback, spec §10.6.7). Absent, the Router's
 *   configured candidate order applies (Claude subscription first).
 * - `loop`: defaults for this agent's `agent_objective` steps, each at most the
 *   operator's ceilings (`../governance/autonomyLimits.ts`).
 *
 * Unknown keys are refused, so a typo never reads as a setting that is honoured.
 */
import { MODEL_TIERS, type ModelTier } from "../router/types.js";
import { providerCandidates, type ProviderName } from "../router/tierConfig.js";
import { MAX_ACTIVE_SECONDS, MAX_LOOP_ITERATIONS } from "../governance/autonomyLimits.js";

export type LoopLimits = { maxIterations?: number; maxActiveSeconds?: number };

export type ExecutionProfile = {
  preferredTier?: ModelTier;
  provider?: ProviderName;
  loop?: LoopLimits;
};

export const MIN_ACTIVE_SECONDS = 60;

/** The providers the router has candidates for: the only names a profile may require. */
export function configuredProviders(): ProviderName[] {
  return [...new Set(providerCandidates.map((c) => c.provider))];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function onlyKeys(v: Record<string, unknown>, allowed: string[], where: string): string | null {
  const extra = Object.keys(v).filter((k) => !allowed.includes(k));
  return extra.length > 0 ? `${where} has unknown field(s): ${extra.join(", ")}.` : null;
}

/** Validates loop limits against the operator's ceilings. Shared by profiles and `agent_objective` step parameters. */
export function parseLoopLimits(v: unknown, where: string): { ok: true; limits: LoopLimits } | { ok: false; reason: string } {
  if (v === undefined) return { ok: true, limits: {} };
  if (!isObject(v)) return { ok: false, reason: `${where} must be an object.` };
  const unknown = onlyKeys(v, ["maxIterations", "maxActiveSeconds"], where);
  if (unknown) return { ok: false, reason: unknown };
  const limits: LoopLimits = {};
  if (v.maxIterations !== undefined) {
    if (typeof v.maxIterations !== "number" || !Number.isInteger(v.maxIterations) || v.maxIterations < 1 || v.maxIterations > MAX_LOOP_ITERATIONS) {
      return { ok: false, reason: `${where}.maxIterations must be an integer from 1 to ${MAX_LOOP_ITERATIONS}.` };
    }
    limits.maxIterations = v.maxIterations;
  }
  if (v.maxActiveSeconds !== undefined) {
    if (
      typeof v.maxActiveSeconds !== "number" ||
      !Number.isInteger(v.maxActiveSeconds) ||
      v.maxActiveSeconds < MIN_ACTIVE_SECONDS ||
      v.maxActiveSeconds > MAX_ACTIVE_SECONDS
    ) {
      return { ok: false, reason: `${where}.maxActiveSeconds must be an integer from ${MIN_ACTIVE_SECONDS} to ${MAX_ACTIVE_SECONDS}.` };
    }
    limits.maxActiveSeconds = v.maxActiveSeconds;
  }
  return { ok: true, limits };
}

export function parseExecutionProfile(v: unknown): { ok: true; profile: ExecutionProfile } | { ok: false; reason: string } {
  if (v === undefined || v === null) return { ok: true, profile: {} };
  if (!isObject(v)) return { ok: false, reason: `"executionProfile" must be an object.` };
  const unknown = onlyKeys(v, ["preferredTier", "provider", "loop"], `"executionProfile"`);
  if (unknown) return { ok: false, reason: unknown };
  const profile: ExecutionProfile = {};
  if (v.preferredTier !== undefined) {
    if (!MODEL_TIERS.includes(v.preferredTier as ModelTier)) {
      return { ok: false, reason: `"executionProfile.preferredTier" must be one of ${MODEL_TIERS.join(", ")}.` };
    }
    profile.preferredTier = v.preferredTier as ModelTier;
  }
  if (v.provider !== undefined) {
    const providers = configuredProviders();
    if (!providers.includes(v.provider as ProviderName)) {
      return { ok: false, reason: `"executionProfile.provider" must be a configured provider: ${providers.join(", ")}.` };
    }
    profile.provider = v.provider as ProviderName;
  }
  const loop = parseLoopLimits(v.loop, `"executionProfile.loop"`);
  if (!loop.ok) return loop;
  if (Object.keys(loop.limits).length > 0) profile.loop = loop.limits;
  return { ok: true, profile };
}

/** A tier preference expressed the way plans already speak to the Router (§10.2 `task_difficulty`). */
export const TIER_DIFFICULTY: Record<ModelTier, "simple" | "standard" | "complex"> = {
  CHEAP: "simple",
  MID: "standard",
  STRONG: "complex",
};
