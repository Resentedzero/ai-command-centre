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
 *   1. Selects a tier (`selectTier`, below), then applies measured tier
 *      preference (`preferTier`), which only an eligible performance sample can move.
 *   2. Estimates worst-case cost (`estimateCost`, below) from
 *      `contextBudget.maxInputTokens + contextBudget.expectedOutputTokens`.
 *   3. Reserves that estimate via Unit 2's `reserveBudget` against scope
 *      `"run"` / `req.runId`, cost class `"llm"`.
 *   4. On `{authorized: false}`, returns immediately — no event emitted, no
 *      provider called (nothing started).
 *   5. On success, emits `invocation_started` (pre-dispatch ruling) carrying
 *      the full routing decision as its payload, then returns the route.
 *
 * Pass 2+3 are TWO functions, split across a transaction boundary (Phase 9):
 * `dispatchModelCall` calls the provider wrapper selected by the route with NO
 * transaction open, and `finalizeModelCall` records the outcome in a fresh
 * transaction — reconciling actual usage via Unit 2's `reconcileBudget`. It
 * emits no event: the Executor calls `emitModelInvocationCompleted` only after
 * the result is persisted, so a failed persist cannot leave both a completed
 * and a failed event. That event carries usage, correlated to `invocationId`, `runId`, AND
 * `taskInstanceId` (all three carried on `RouteResult` — see `./types.ts`;
 * `runId`/`taskInstanceId` added in fix round 1 after independent review
 * flagged that a `runId: null` event falls into `emit.ts`'s shared GLOBAL
 * sequence bucket instead of the per-run one, breaking per-run event
 * ordering queries). On a provider error, `finalizeModelCall`
 * does NOT emit `invocation_failed` itself — it rethrows the error. Emitting
 * `invocation_failed` uniformly (across LLM, tool,
 * retrieval, and deterministic invocation kinds alike) is the Unit 6
 * Executor's responsibility, not this module's — this module only knows
 * about LLM invocations and has no business defining the failure-event
 * contract for every other kind.
 */
import type { DrizzleTransaction } from "../events/emit.js";
import { emitEvent } from "../events/emit.js";
import { reserveBudget, reconcileBudget } from "../governance/budget.js";
import { evaluateQuotaGuardrail } from "../governance/quotaGuardrail.js";
import { recordInvocationQuotaObservation } from "../governance/quotaTelemetry.js";
import type { ResourceUnit } from "../governance/resourceUnit.js";
import type { ArtifactReferenceMeasurement, CompiledContext } from "../context/types.js";
import {
  providerCandidates,
  type CandidateCapability,
  type ProviderCandidate,
  type ProviderName,
} from "./tierConfig.js";
import { callAnthropicModel } from "./providers/anthropic.js";
import { callOpenAiModel } from "./providers/openai.js";
import { callClaudeSubscriptionModel } from "./providers/claudeSubscription.js";
import type {
  ModelTier,
  ProviderAdapter,
  ProviderCallResult,
  RouteRequest,
  RouteResult,
  TierAccounting,
} from "./types.js";
import { MODEL_TIERS, quotaObservationFrom } from "./types.js";
import { readTierPerformance, type TierPerformanceRow, type TierPerformanceSnapshot } from "../governance/performanceEligibility.js";

/**
 * Provider dispatch table. DELIBERATELY a total map keyed by `ProviderName`,
 * not a conditional.
 *
 * The previous `config.provider === "anthropic" ? anthropic : openai` ternary
 * routed EVERY non-"anthropic" value to OpenAI. Adding a third provider to the
 * union would therefore have silently misrouted subscription calls to the
 * OpenAI adapter — a billable call instead of a quota one — and because the
 * ternary's else-branch accepts anything, the type system would NOT have
 * caught it. `Record<ProviderName, ProviderAdapter>` inverts that: omitting a
 * provider is now a compile error, and there is no fall-through branch for a
 * value to land in by accident.
 */
const PROVIDERS: Record<ProviderName, ProviderAdapter> = {
  anthropic: callAnthropicModel,
  openai: callOpenAiModel,
  claude_subscription: callClaudeSubscriptionModel,
};

/**
 * Why authorization failed, so the Executor can record the real reason rather
 * than reporting every refusal as a budget problem. A quota refusal and an
 * exhausted budget are different operator situations with different remedies.
 */
export type AuthorizationFailure =
  | "insufficient_budget"
  | "quota_guardrail"
  | "provider_quota_rejected"
  | "no_eligible_candidate";

// ---------------------------------------------------------------------------
// Candidate selection (Phase 7D)
// ---------------------------------------------------------------------------

/** Why a configured candidate was not eligible for THIS routing decision. */
export type ExclusionReason =
  | "disabled"
  | "tier_mismatch"
  | "capability_mismatch"
  | "resource_mismatch"
  | "quota_refused"
  | "provider_unavailable";

export type ExcludedCandidate = {
  provider: ProviderName;
  modelId: string;
  reason: ExclusionReason;
};

export type CandidateRouting =
  | { status: "routed"; candidates: ProviderCandidate[]; excluded: ExcludedCandidate[] }
  | { status: "no_eligible_candidate"; reason: ExclusionReason | "none_configured"; excluded: ExcludedCandidate[] };

/**
 * Static exclusion checks, cheapest first, in a FIXED order so the reported
 * reason for a candidate excluded on several grounds is deterministic:
 * disabled -> tier -> capability -> resource. Ordering them this way also means
 * a candidate already excluded on static grounds never costs a quota query.
 *
 * Returns null when the candidate survives every static check.
 */
function staticExclusion(
  candidate: ProviderCandidate,
  tier: ModelTier,
  requiredCapabilities: CandidateCapability[],
  allowedResourceUnits: ResourceUnit[] | undefined
): ExclusionReason | null {
  if (!candidate.enabled) return "disabled";
  if (!candidate.tiers.includes(tier)) return "tier_mismatch";
  if (!requiredCapabilities.every((required) => candidate.capabilities.includes(required))) {
    return "capability_mismatch";
  }
  if (allowedResourceUnits && !allowedResourceUnits.includes(candidate.accounting.unit)) {
    return "resource_mismatch";
  }
  return null;
}

/**
 * Produces the ORDERED, ELIGIBLE candidates for a request — and nothing else.
 *
 * It does not dispatch, does not reserve budget, and does not decide how many
 * candidates a caller may try. Returning a list is deliberately NOT permission
 * to fall through it: Phase 7D implements ordering and eligibility only, and
 * `authorizeRoute` below still takes exactly the first candidate and stops.
 *
 * Candidate order is the configured order (`providerCandidates`). There is no
 * provider-name branch anywhere in this function: adding a provider to the
 * config changes routing with no code change here, which is the property the
 * total-map dispatch already gives `dispatchModelCall`.
 *
 * QUOTA: consumed as the guardrail's POLICY RESULT only. This function never
 * reads a utilization number, a threshold, or a reset time — duplicating that
 * logic is exactly how two subsystems drift into disagreeing. `REFUSE_QUOTA`
 * and `PROVIDER_REJECTED` make a candidate ineligible; `ALLOW` and
 * `UNKNOWN_ALLOWED` leave it eligible.
 *
 * Routing can only ever NARROW what is attempted. No branch here makes a
 * candidate eligible that its configuration did not already permit, so routing
 * cannot widen Capability/Policy authority — those remain authoritative above
 * this layer, and a candidate being cheaper, stronger, or quota-unknown never
 * promotes it.
 */
export async function selectCandidates(
  tx: DrizzleTransaction,
  req: {
    tier: ModelTier;
    requiredCapabilities?: CandidateCapability[];
    allowedResourceUnits?: ResourceUnit[];
    invocationId?: string | null;
    runId?: string | null;
  },
  candidates: ProviderCandidate[] = providerCandidates
): Promise<CandidateRouting> {
  const requiredCapabilities = req.requiredCapabilities ?? [];
  const eligible: ProviderCandidate[] = [];
  const excluded: ExcludedCandidate[] = [];

  for (const candidate of candidates) {
    const staticReason = staticExclusion(candidate, req.tier, requiredCapabilities, req.allowedResourceUnits);
    if (staticReason) {
      excluded.push({ provider: candidate.provider, modelId: candidate.modelId, reason: staticReason });
      continue;
    }

    const guardrail = await evaluateQuotaGuardrail(tx, {
      provider: candidate.provider,
      invocationId: req.invocationId ?? null,
      runId: req.runId ?? null,
    });

    // A RUNTIME REFUSAL STOPS THE SCAN — it never promotes a lower-ranked
    // candidate (Phase 7G).
    //
    // Static exclusions above `continue`, because "disabled" or "wrong tier" are
    // configuration facts about which candidates apply at all. A quota refusal
    // or a provider rejection is different in kind: it is a live refusal to do
    // THIS work now. Skipping past it would hand the invocation to whatever is
    // ranked next — since Phase 7F that is the billable Anthropic API, which has
    // no guardrail configured and would therefore always be allowed. That is
    // exactly the silent fallback amended Phase 10.6.7 forbids: a quota refusal
    // converted into unbudgeted spend, with no Policy decision, no separate
    // reservation, and nothing in the event log marking the switch.
    //
    // Breaking here means routing fails explicitly instead. Falling back to
    // another provider remains possible only as a deliberate configuration
    // change or an explicit future Policy decision — never as a side effect of
    // one candidate being refused.
    if (guardrail.decision.decision === "REFUSE_QUOTA") {
      excluded.push({ provider: candidate.provider, modelId: candidate.modelId, reason: "quota_refused" });
      break;
    }
    if (guardrail.decision.decision === "PROVIDER_REJECTED") {
      excluded.push({ provider: candidate.provider, modelId: candidate.modelId, reason: "provider_unavailable" });
      break;
    }

    eligible.push(candidate);
  }

  if (eligible.length === 0) {
    // An explicit failure with a reason, never an empty list the caller has to
    // interpret. When every candidate was excluded for the same reason, report
    // it; a mixture reports the first exclusion, which is the highest-priority
    // candidate's reason.
    // A RUNTIME refusal is the decisive reason whenever one occurred: it is why
    // the scan stopped. Reporting an incidental static skip instead (a
    // higher-ranked candidate that simply serves another tier) would tell an
    // operator "tier_mismatch" when what actually happened is "the provider
    // refused" — the single most misleading answer available here.
    const runtimeRefusal = excluded.find(
      (e) => e.reason === "quota_refused" || e.reason === "provider_unavailable"
    );
    const reasons = new Set(excluded.map((e) => e.reason));
    const reason =
      excluded.length === 0
        ? "none_configured"
        : runtimeRefusal
          ? runtimeRefusal.reason
          : reasons.size === 1
            ? [...reasons][0]!
            : excluded[0]!.reason;
    return { status: "no_eligible_candidate", reason, excluded };
  }

  return { status: "routed", candidates: eligible, excluded };
}

/**
 * Tier selection (documented MVP heuristic — Phase 10.7 leaves the exact
 * mapping, beyond the risk-floor rule, unspecified):
 *   - `riskTier` "high"/"highest" forces STRONG, regardless of
 *     `taskDifficulty` — the brief's explicit quality-floor rule.
 *   - Otherwise the three difficulty levels map 1:1 onto the three tiers:
 *     "simple" -> CHEAP, "standard" -> MID, "complex" -> STRONG. A simple,
 *     deterministic difficulty->tier mapping. Measured performance may then move
 *     it up (`preferTier`); confidence-based escalation (§10.4) is not built.
 *
 * PHASE 7H: "standard" previously mapped to CHEAP, because MID did not exist
 * and the ladder had nowhere else to put it. It now maps to MID, which is the
 * point of adding the tier — a standard-difficulty task gets a mid-capability
 * model rather than the cheapest one. The risk FLOOR is untouched: high/highest
 * still forces STRONG regardless of difficulty, and no path lowers a tier.
 *
 * The requested tier is never silently downgraded or upgraded: if no candidate
 * serves it, routing fails explicitly rather than falling back to another tier.
 */
const DIFFICULTY_TIER: Record<RouteRequest["taskDifficulty"], ModelTier> = {
  simple: "CHEAP",
  standard: "MID",
  complex: "STRONG",
};

function selectTier(req: RouteRequest): ModelTier {
  if (req.riskTier === "high" || req.riskTier === "highest") {
    return "STRONG";
  }
  // A total map, like the provider dispatch table: adding a difficulty level
  // becomes a compile error rather than a silent fall-through to a default.
  return DIFFICULTY_TIER[req.taskDifficulty];
}

/**
 * Tier preference from measured performance (spec §10.2, §10.5). An efficiency
 * choice, never an authorization: the result is still reserved and
 * candidate-checked exactly like the default, and a refusal at the preferred tier
 * fails the Invocation rather than falling back to the default.
 *
 * Deterministic and conservative where the spec leaves the rule open:
 *   - Only rows eligible under the minimum sample criterion count, and the default
 *     tier's own row must be eligible: nothing is compared against unknown data.
 *   - Upward only. The default already carries the risk floor, and §10.5's case is a
 *     cheaper tier costing more per success; moving below the default is undecided.
 *   - Cost per successful outcome is `avg_cost / success_rate` per resource unit
 *     (retries are already inside `avg_cost`). Units are never summed or converted, so
 *     a tier wins only if it is cheaper per success in some unit and dearer in none;
 *     an absent unit is a cost of 0, and a success rate of 0 costs infinitely much.
 *   - Strictly cheaper, and the nearest such tier above the default wins. Ties keep
 *     the default, including ties that differ only by the projection's decimal
 *     rounding (a relative tolerance of 1e-9).
 */
export function preferTier(defaultTier: ModelTier, performance: TierPerformanceSnapshot): ModelTier {
  if (!performance.consulted) return defaultTier;
  const eligible = new Map(performance.rows.filter((row) => row.eligibility.eligible).map((row) => [row.tier, row]));
  const current = eligible.get(defaultTier);
  if (!current) return defaultTier;
  for (const tier of MODEL_TIERS.slice(MODEL_TIERS.indexOf(defaultTier) + 1)) {
    const row = eligible.get(tier);
    if (row && cheaperPerSuccess(row, current)) return tier;
  }
  return defaultTier;
}

function costPerSuccess(row: TierPerformanceRow, unit: string): number {
  const rate = Number(row.successRate);
  return rate === 0 ? Infinity : Number(row.avgCost[unit] ?? "0") / rate;
}

function cheaperPerSuccess(candidate: TierPerformanceRow, current: TierPerformanceRow): boolean {
  const units = [...new Set([...Object.keys(candidate.avgCost), ...Object.keys(current.avgCost)])];
  // No consumption recorded in either: compare on success rate alone, as a cost of 0.
  const pairs = (units.length > 0 ? units : [""]).map((unit) => [costPerSuccess(candidate, unit), costPerSuccess(current, unit)] as const);
  return pairs.every(([c, d]) => !clearlyLess(d, c)) && pairs.some(([c, d]) => clearlyLess(c, d));
}

/** `a < b` beyond rounding, for non-negative costs (Infinity included). */
function clearlyLess(a: number, b: number): boolean {
  return a < b && (b === Infinity || b - a > 1e-9 * b);
}

/**
 * Pass-1 worst-case cost estimate: the full context-budget input ceiling
 * priced at the tier's INPUT rate, plus expected output tokens priced at its
 * OUTPUT rate. The two rates are applied separately because output costs ~5x
 * input on both configured models — summing the token counts first and
 * applying one blended rate would under-price output-heavy work.
 *
 * Still deliberately WORST-CASE: it reserves against the budget ceiling, not
 * a prediction of actual usage, so `reserveBudget` refuses work it cannot
 * afford before anything is dispatched.
 */
function estimateCost(accounting: TierAccounting, contextBudget: RouteRequest["contextBudget"]): number {
  if (accounting.unit === "usd") {
    return (
      contextBudget.maxInputTokens * accounting.pricing.inputPerToken +
      contextBudget.expectedOutputTokens * accounting.pricing.outputPerToken
    );
  }

  // Token-denominated units (subscription_tokens, local_tokens): the amount IS
  // the token count, so the worst-case estimate is the ceiling itself. No
  // rate, no imputed price, and explicitly NOT zero — this consumes a real,
  // finite entitlement and is reserved against a counter in its own unit.
  return contextBudget.maxInputTokens + contextBudget.expectedOutputTokens;
}

/**
 * A refused route still made a routing decision (§10.7 "every routing decision's
 * complete input set"): the Executor records `decision` on `invocation_failed`.
 */
export type RouteRefusal = { authorized: false; reason: AuthorizationFailure; decision: Record<string, unknown> };

export type AuthorizeRouteOptions = {
  /**
   * The minimum sample criterion's N. Omitted: the configured value
   * (`MIN_PERFORMANCE_SAMPLES`, the operator's N = 10).
   * Production never passes it.
   */
  minPerformanceSamples?: number | null;
};

export async function authorizeRoute(
  tx: DrizzleTransaction,
  req: RouteRequest,
  options: AuthorizeRouteOptions = {}
): Promise<RouteResult | RouteRefusal> {
  const defaultTier = selectTier(req);
  const historicalPerformance = await readTierPerformance(tx, req.runId, options.minPerformanceSamples);
  const tier = preferTier(defaultTier, historicalPerformance);
  const inputs = {
    taskDifficulty: req.taskDifficulty,
    riskTier: req.riskTier,
    contextBudget: req.contextBudget,
    defaultTier,
    historicalPerformance,
  };

  // Step 1 — ROUTING (Phase 7D): which candidates are eligible, in what order.
  // Advisory only; it reserves nothing, so ranking a candidate never costs
  // budget. Quota eligibility is folded in here, which is why this precedes the
  // reservation — see the ordering note in this module's header.
  const routing = await selectCandidates(tx, {
    tier,
    requiredCapabilities: req.requiredCapabilities,
    allowedResourceUnits: req.allowedResourceUnits,
    invocationId: req.invocationId,
    runId: req.runId,
  });

  if (routing.status === "no_eligible_candidate") {
    // Never silently downgraded or upgraded to another tier, and never switched
    // to a provider the configuration did not rank for this tier.
    return {
      authorized: false,
      reason:
        routing.reason === "quota_refused"
          ? "quota_guardrail"
          : routing.reason === "provider_unavailable"
            ? "provider_quota_rejected"
            : "no_eligible_candidate",
      decision: { ...inputs, attemptedTier: tier, excludedCandidates: routing.excluded },
    };
  }

  // SINGLE DISPATCH, deliberately preserved. `routing.candidates` may hold more
  // than one entry, but Phase 7D takes the first and stops: falling through to
  // the next on failure would be automatic provider fallback, which requires an
  // explicit Policy/Budget decision and is NOT implemented here.
  const candidate = routing.candidates[0]!;
  const modelId = candidate.modelId;
  const estimatedCost = estimateCost(candidate.accounting, req.contextBudget);
  // Pass 2 (§5.17, §10.7): the Compiler packs to the chosen model's window, never past it.
  // The reservation above stays priced at the Task's budget, the pessimistic estimate.
  const effectiveMaxInputTokens = Math.min(
    req.contextBudget.maxInputTokens,
    candidate.contextWindowTokens - req.contextBudget.expectedOutputTokens
  );

  // Step 2 — the HARD control. Budget authorization is last and is decisive:
  // nothing above can overturn it, and a denial here is a denial outright.
  const reservation = await reserveBudget(
    tx,
    "run",
    req.runId,
    "llm",
    candidate.accounting.unit,
    estimatedCost
  );
  if (!reservation.authorized) {
    return {
      authorized: false,
      reason: "insufficient_budget",
      decision: {
        ...inputs,
        attemptedTier: tier,
        budgetAuthorization: {
          authorized: false,
          provider: candidate.provider,
          modelId,
          resourceUnit: candidate.accounting.unit,
          estimatedAmount: estimatedCost,
        },
      },
    };
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
    // §10.7's complete input set: difficulty, risk, the whole Context Budget, the
    // budget authorization, the historical-performance snapshot consulted (and the
    // tier before it), then the result.
    payload: {
      ...inputs,
      contextBudgetMaxInputTokens: req.contextBudget.maxInputTokens,
      contextWindowTokens: candidate.contextWindowTokens,
      effectiveMaxInputTokens,
      budgetAuthorization: {
        authorized: true,
        provider: candidate.provider,
        resourceUnit: candidate.accounting.unit,
        estimatedAmount: estimatedCost,
      },
      resultingTier: tier,
      resultingModelId: modelId,
    },
    usage: null,
  });

  return {
    tier,
    modelId,
    provider: candidate.provider,
    accounting: candidate.accounting,
    contextWindowTokens: candidate.contextWindowTokens,
    effectiveMaxInputTokens,
    reservationId: reservation.reservationId,
    invocationId: req.invocationId,
    runId: req.runId,
    taskInstanceId: req.taskInstanceId,
  };
}

/**
 * The outcome of ONE provider dispatch, captured rather than thrown so it can
 * cross a transaction boundary intact: the dispatch happens with no transaction
 * open, and the outcome is recorded afterwards by `finalizeModelCall` in a fresh
 * one (Phase 9).
 */
export type ModelDispatchOutcome =
  | { ok: true; providerResult: ProviderCallResult }
  | { ok: false; error: unknown };

/**
 * Pass 2 — the provider call itself, and NOTHING else.
 *
 * Deliberately takes no transaction and touches no database. A `claude -p`
 * child can run for minutes; doing that inside a transaction would hold the
 * run's event-sequence advisory lock, its budget counter locks and the shared
 * quota-state row for the whole call. The caller commits the Invocation as
 * `executing` (with its reservation recorded) BEFORE calling this, so an
 * interruption leaves a durable, recoverable record rather than nothing.
 *
 * Never throws: a provider failure is returned as `{ ok: false }` so it reaches
 * `finalizeModelCall`, which records its quota observation. No retry, no
 * fallback — exactly one dispatch to the routed candidate.
 */
export async function dispatchModelCall(
  route: RouteResult,
  compiledContext: CompiledContext,
  expectedOutputShape: Record<string, unknown>
): Promise<ModelDispatchOutcome> {
  try {
    // The ROUTED candidate's provider and accounting, carried on the route —
    // never re-derived from the tier, which would dispatch a non-primary
    // candidate's call to the primary candidate's adapter.
    const providerResult = await PROVIDERS[route.provider](
      route.modelId,
      compiledContext,
      expectedOutputShape,
      route.accounting
    );
    return { ok: true, providerResult };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Pass 3 — records a dispatch outcome, inside the transaction the Executor
 * completes or fails the Invocation in.
 *
 * On failure: records the quota observation the failure carried, then throws
 * the provider's error unchanged, so the Executor settles the reservation (see
 * `providerConsumptionFrom`) and fails the Invocation in this same transaction.
 * On success: records the observation, refuses a cross-unit usage report, and
 * reconciles.
 *
 * It does NOT emit `invocation_completed`: the Executor emits it through
 * `emitModelInvocationCompleted` only once the result is durably persisted, in
 * the same transaction. Emitting it here, before persistence, meant a
 * persistence failure afterwards left one Invocation with BOTH a completed and a
 * failed event in the immutable log.
 */
export async function finalizeModelCall(
  tx: DrizzleTransaction,
  route: RouteResult,
  outcome: ModelDispatchOutcome
): Promise<ProviderCallResult> {
  const invocation = { invocationId: route.invocationId, runId: route.runId, taskInstanceId: route.taskInstanceId };

  if (!outcome.ok) {
    // provider failure -> quota observation -> record -> (Executor) invocation
    // failure. Telemetry only; the failure itself is rethrown unchanged.
    await recordInvocationQuotaObservation(tx, invocation, quotaObservationFrom(outcome.error));
    throw outcome.error;
  }
  const providerResult = outcome.providerResult;

  // provider result -> quota observation -> record -> invocation completion.
  // Advisory telemetry only; it cannot fail the invocation (see quotaTelemetry.ts).
  await recordInvocationQuotaObservation(tx, invocation, providerResult.quotaObservation);

  // Mechanism A must never reconcile across resource units. The reservation id
  // already pins the COUNTER's unit, so a provider (or a mis-arranged mock)
  // reporting tokens for a usd route would otherwise be silently reconciled as
  // dollars. Refuse instead; the Executor releases the reservation.
  if (providerResult.usage.costUnit !== route.accounting.unit) {
    throw new Error(
      `finalizeModelCall: the provider reported usage in "${providerResult.usage.costUnit}" but this route was ` +
        `reserved in "${route.accounting.unit}". Refusing to reconcile across resource units.`
    );
  }

  await reconcileBudget(tx, route.reservationId, providerResult.usage.costAmount);
  return providerResult;
}

/**
 * Emits `invocation_completed` for a finalized model call, carrying its usage.
 * Called by the Executor after the result is persisted — see
 * `finalizeModelCall` for why the two are separate.
 */
export async function emitModelInvocationCompleted(
  tx: DrizzleTransaction,
  route: RouteResult,
  providerResult: ProviderCallResult,
  /** §5.16: which included artifacts the output referenced, measured by the Executor. */
  artifactReferences?: ArtifactReferenceMeasurement
): Promise<void> {
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
      ...(artifactReferences ? { artifactReferences } : {}),
    },
    usage: {
      tokensIn: providerResult.usage.tokensIn,
      tokensOut: providerResult.usage.tokensOut,
      // The adapter's own report (§5.11); false when it reported none.
      cacheHit: providerResult.usage.cacheHit === true,
      costAmount: providerResult.usage.costAmount,
      // The provider's OWN declared unit, never re-derived here: the adapter
      // is the only thing that knows what it actually consumed.
      costUnit: providerResult.usage.costUnit,
      modelId: route.modelId,
      ...(providerResult.usage.secondaryUsage ? { secondaryUsage: providerResult.usage.secondaryUsage } : {}),
    },
  });
}
