/**
 * Model Router (Phase 10) — provider-agnostic LLM routing interface.
 *
 * Risk-driven tier selection is a MODEL-QUALITY FLOOR ONLY. It has zero
 * effect on Policy's authorization decision (Unit 3, `governance/policy.ts`
 * / `governance/approvals.ts`), and Unit 3's output has zero effect on tier
 * selection here. Both are computed from the same `riskTier` input
 * independently, never from each other. This module never imports
 * `governance/policy.ts` or `governance/approvals.ts`, and never calls
 * `evaluatePolicy`, `createApproval`, `resolveApproval`, or `reauthorize` —
 * `tests/router/modelRouter.test.ts`'s "Zero Policy/Approval coupling" suite
 * asserts this both structurally (source-grep, matching `policy.test.ts`'s
 * own established idiom for the same claim) and via a runtime spy proving
 * the assertion is regression-proof, not just true today.
 *
 * `authorizeRoute` (Pass 1) has NO knowledge of Policy's decision and makes
 * no authorization claim of its own beyond "is there budget for this tier" —
 * it only ever answers "which model, and is there budget for it." It:
 *   1. Selects a tier (`selectTier`, below).
 *   2. Estimates worst-case cost (`estimateCost`, below) from
 *      `contextBudget.maxInputTokens + contextBudget.expectedOutputTokens`.
 *   3. Reserves that estimate via Unit 2's `reserveBudget` against scope
 *      `"run"` / `req.runId`, cost class `"llm"`.
 *   4. On `{authorized: false}`, returns immediately — no event emitted, no
 *      provider called (nothing started).
 *   5. On success, emits `invocation_started` (pre-dispatch ruling) carrying
 *      the full routing decision as its payload, then returns the route.
 *
 * `callModel` (Pass 2+3) calls the provider wrapper selected by
 * `tierConfig[route.tier].provider`, reconciles actual usage via Unit 2's
 * `reconcileBudget`, and emits `invocation_completed` with usage populated
 * (pre-dispatch ruling, point 3), correlated to `invocationId`, `runId`, AND
 * `taskInstanceId` (all three carried on `RouteResult` — see `./types.ts`;
 * `runId`/`taskInstanceId` added in fix round 1 after independent review
 * flagged that a `runId: null` event falls into `emit.ts`'s shared GLOBAL
 * sequence bucket instead of the per-run one, breaking per-run event
 * ordering queries). On a thrown provider error, `callModel`
 * does NOT emit `invocation_failed` itself — the exception propagates
 * uncaught. Emitting `invocation_failed` uniformly (across LLM, tool,
 * retrieval, and deterministic invocation kinds alike) is the future Unit 6
 * Executor's responsibility, not this module's — `callModel` only knows
 * about LLM invocations and has no business defining the failure-event
 * contract for every other kind.
 */
import type { DrizzleTransaction } from "../events/emit.js";
import { emitEvent } from "../events/emit.js";
import { reserveBudget, reconcileBudget } from "../governance/budget.js";
import type { CompiledContext } from "../context/types.js";
import { tierConfig } from "./tierConfig.js";
import { callAnthropicModel } from "./providers/anthropic.js";
import { callOpenAiModel } from "./providers/openai.js";
import type { ModelTier, RouteRequest, RouteResult } from "./types.js";

/**
 * Tier selection (documented MVP heuristic — Phase 10.7 leaves the exact
 * mapping, beyond the risk-floor rule, unspecified):
 *   - `riskTier` "high"/"highest" forces STRONG, regardless of
 *     `taskDifficulty` — the brief's explicit quality-floor rule.
 *   - Otherwise: "complex" -> STRONG; "simple"/"standard" -> CHEAP. A simple,
 *     deterministic difficulty->tier mapping — not a confidence- or
 *     performance-driven one (both explicitly out of scope).
 */
function selectTier(req: RouteRequest): ModelTier {
  if (req.riskTier === "high" || req.riskTier === "highest") {
    return "STRONG";
  }
  return req.taskDifficulty === "complex" ? "STRONG" : "CHEAP";
}

/**
 * Pass-1 worst-case cost estimate (brief-specified formula): the full
 * context-budget input ceiling plus expected output tokens, priced at the
 * selected tier's flat `pricePerToken`. A documented heuristic, not a real
 * provider pricing model.
 */
function estimateCost(tier: ModelTier, contextBudget: RouteRequest["contextBudget"]): number {
  const { pricePerToken } = tierConfig[tier];
  return (contextBudget.maxInputTokens + contextBudget.expectedOutputTokens) * pricePerToken;
}

export async function authorizeRoute(
  tx: DrizzleTransaction,
  req: RouteRequest
): Promise<RouteResult | { authorized: false }> {
  const tier = selectTier(req);
  const modelId = tierConfig[tier].modelId;
  const estimatedCost = estimateCost(tier, req.contextBudget);

  const reservation = await reserveBudget(tx, "run", req.runId, "llm", estimatedCost);
  if (!reservation.authorized) {
    return { authorized: false };
  }

  await emitEvent(tx, {
    idempotencyKey: `invocation_started:${req.invocationId}`,
    eventType: "invocation_started",
    eventVersion: 1,
    causationId: null,
    correlation: {
      goalId: null,
      workflowRunId: null,
      taskInstanceId: req.taskInstanceId,
      runId: req.runId,
      invocationId: req.invocationId,
    },
    actor: "system",
    producer: "model-router",
    payload: {
      taskDifficulty: req.taskDifficulty,
      riskTier: req.riskTier,
      contextBudgetMaxInputTokens: req.contextBudget.maxInputTokens,
      resultingTier: tier,
      resultingModelId: modelId,
    },
    usage: null,
  });

  return {
    tier,
    modelId,
    reservationId: reservation.reservationId,
    invocationId: req.invocationId,
    runId: req.runId,
    taskInstanceId: req.taskInstanceId,
  };
}

export async function callModel(
  tx: DrizzleTransaction,
  route: RouteResult,
  compiledContext: CompiledContext,
  expectedOutputShape: Record<string, unknown>
): Promise<{ result: unknown; usage: { tokensIn: number; tokensOut: number; costAmount: number } }> {
  const config = tierConfig[route.tier];

  const providerResult =
    config.provider === "anthropic"
      ? await callAnthropicModel(route.modelId, compiledContext, expectedOutputShape, config.pricePerToken)
      : await callOpenAiModel(route.modelId, compiledContext, expectedOutputShape, config.pricePerToken);

  await reconcileBudget(tx, route.reservationId, providerResult.usage.costAmount);

  await emitEvent(tx, {
    idempotencyKey: `invocation_completed:${route.invocationId}`,
    eventType: "invocation_completed",
    eventVersion: 1,
    causationId: null,
    correlation: {
      goalId: null,
      workflowRunId: null,
      taskInstanceId: route.taskInstanceId,
      runId: route.runId,
      invocationId: route.invocationId,
    },
    actor: "system",
    producer: "model-router",
    payload: {
      tier: route.tier,
      modelId: route.modelId,
    },
    usage: {
      tokensIn: providerResult.usage.tokensIn,
      tokensOut: providerResult.usage.tokensOut,
      cacheHit: false,
      costAmount: providerResult.usage.costAmount,
      modelId: route.modelId,
    },
  });

  return providerResult;
}
