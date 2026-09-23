/**
 * Model Router types (Phase 10, Unit 5). Base shapes are the brief's frozen
 * interfaces; two fields are added per documented rulings below — both
 * additions, never removals or narrowings, so nothing that already typechecks
 * against the brief's original shapes stops typechecking.
 */
import type { RiskTier } from "../governance/risk.js";
import type { ResourceUnit } from "../governance/resourceUnit.js";
import type { QuotaObservation } from "../governance/subscriptionQuotaState.js";
import type { CandidateCapability, ProviderName } from "./tierConfig.js";
import type { CompiledContext, ContextBudget } from "../context/types.js";
import type { UsageAccounting } from "./usageAccounting.js";

/**
 * The model-quality ladder. Ordered least to most capable.
 *
 * A tier is a QUALITY FLOOR, not a price band: it names how capable the model
 * serving an invocation must be. It maps to no provider, no pricing table, and
 * no share of any provider's quota — `providerCandidates` decides which model
 * and which resource unit actually serves each tier.
 *
 * MID added in Phase 7H.
 */
export const MODEL_TIERS = ["CHEAP", "MID", "STRONG"] as const;

export type ModelTier = (typeof MODEL_TIERS)[number];

/**
 * Per-token pricing for one tier, split by direction. Input and output are
 * separate rates because real provider pricing is asymmetric (output costs
 * ~5x input on both currently-configured Anthropic models), and a single
 * blended rate cannot represent that: blending necessarily under-prices
 * output-heavy invocations and over-prices input-heavy ones, and the error
 * lands in `budget_counters.consumed_amount` as if it were dollars.
 *
 * Lives here rather than in `tierConfig.ts` so the provider wrappers can
 * import the type without importing V1 config — `tests/router/providers/
 * anthropic.test.ts` asserts the provider source never names `tierConfig`.
 */
export type TierPricing = {
  inputPerToken: number;
  outputPerToken: number;
};

/**
 * How a tier's consumption is accounted (amended Phase 10.3, 2026-09-13).
 *
 * A DISCRIMINATED UNION, not a unit plus optional rates, so "a non-monetary
 * provider carrying a fabricated price" is structurally unrepresentable rather
 * than merely discouraged. A `pricePerToken: 0` on a subscription tier would
 * silently turn the Budget Governor into a no-op for that tier while it kept
 * emitting events asserting enforcement — the single worst failure mode
 * available here, so the type forbids it.
 *
 * Token-denominated units carry no rate at all: the amount IS the token count.
 */
export type TierAccounting =
  | { unit: "usd"; pricing: TierPricing }
  | { unit: "subscription_tokens" }
  | { unit: "local_tokens" };

/** Usage a provider adapter reports back, always tagged with its own unit. */
export type ProviderUsage = {
  tokensIn: number;
  tokensOut: number;
  /** Denominated in `costUnit` — NOT always dollars. */
  costAmount: number;
  costUnit: ResourceUnit;
  /** Non-primary model usage the provider reported; already included in `costAmount`. */
  secondaryUsage?: Array<{ modelId: string; tokensIn: number; tokensOut: number }>;
  /**
   * R2: provider-side tool activity this call performed, for the Event log. Absent when
   * the provider reported nothing usable — which is recorded as unavailable, never as
   * zero: a search that happened but was not counted must not read as "no search".
   */
  toolActivity?: {
    webSearchRequests: number | null;
    queries: string[];
    sources: Array<{ url: string; title: string }>;
  };
  /** The provider reported reading input from its prompt cache (§5.11). Diagnostic: never changes `costAmount`. */
  cacheHit?: boolean;
  /**
   * R2 Task 42: the per-category record of what the provider actually measured, and what it never
   * mentioned (`./usageAccounting.ts`). Telemetry only — it changes no counted amount, no budget and
   * no route. Absent when an adapter does not build one.
   */
  accounting?: UsageAccounting;
};

export type ProviderCallResult = {
  result: unknown;
  usage: ProviderUsage;
  /**
   * Quota state the provider volunteered alongside the result (Phase 7B).
   *
   * OPTIONAL and orthogonal to `usage`, which is the point: a quota reading is
   * what the provider says about its own windows, NOT a quantity consumed.
   * Nothing may be derived from it into `usage`, and vice versa — the two are
   * independent by design. Providers that report no such telemetry (the
   * Anthropic and OpenAI adapters) simply omit it.
   */
  quotaObservation?: QuotaObservation;
};

/**
 * Quota telemetry a provider attached to a FAILURE (Phase 8).
 *
 * The provider-agnostic half of the contract above: an adapter that received a
 * quota reading before failing MAY attach it to the error it throws as
 * `quotaObservation`, so the invocation's terminal state still records it
 * (design Part 4 — emission is tied to the invocation terminating, not to its
 * success). That matters most for a quota-exhaustion failure, whose reading
 * explains it.
 *
 * Read structurally rather than by `instanceof`, so the Router never imports a
 * provider-specific error class. Anything that is not an object carrying an
 * object-valued `quotaObservation` yields undefined — never a guessed reading.
 */
/**
 * What a FAILED provider call may have consumed (Phase 9).
 *
 * - `none`: provably nothing — the adapter refused before sending anything
 *   (no executable, no credential, misconfigured unit, oversized input) or the
 *   provider refused the request outright (expired login, exhausted quota).
 * - `unknown`: anything else — a timeout, a crash mid-stream, a missing usage
 *   report. The work may have been done.
 *
 * The accounting rule this drives (`completeModelDispatch`): `none` releases
 * the reservation; `unknown` CHARGES it at its estimate, exactly like an
 * interrupted Invocation. Releasing on `unknown` would hand back capacity the
 * provider may already have spent — widening effective authorization on the
 * strength of an unknown.
 *
 * Adapters opt INTO `none` by attaching `consumption: "none"` to the error they
 * throw. Read structurally, like `quotaObservation`, so the Router never imports
 * a provider's error class. Absent, malformed, or any other value reads as
 * `unknown`: the conservative default, so a new failure mode is charged until
 * someone proves it consumes nothing.
 */
export type ProviderConsumption = "none" | "unknown";

export function providerConsumptionFrom(error: unknown): ProviderConsumption {
  if (typeof error !== "object" || error === null) return "unknown";
  return (error as { consumption?: unknown }).consumption === "none" ? "none" : "unknown";
}

export function quotaObservationFrom(error: unknown): QuotaObservation | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = (error as { quotaObservation?: unknown }).quotaObservation;
  return typeof candidate === "object" && candidate !== null ? (candidate as QuotaObservation) : undefined;
}

/**
 * The one shape every provider adapter implements (Phase 10.1's interface,
 * unchanged). Uniform across adapters so `dispatchModelCall` can dispatch through a
 * map rather than a conditional — see `modelRouter.ts`'s PROVIDERS.
 */
export type ProviderAdapter = (
  modelId: string,
  compiledContext: CompiledContext,
  expectedOutputShape: Record<string, unknown>,
  accounting: TierAccounting,
  /**
   * R2: provider-side tools this call may use, named by the Capability Grant that
   * authorized them and by nothing else — never by configuration, the compiled context,
   * model output or retrieved content. Absent or empty means the V1 posture: no tools at
   * all. An adapter that cannot honour a non-empty list must refuse the call rather than
   * silently run without the tools it was asked for.
   */
  options?: { tools?: readonly string[] }
) => Promise<ProviderCallResult>;

export type RouteRequest = {
  taskDifficulty: "simple" | "standard" | "complex";
  riskTier: RiskTier; // "high"/"highest" forces STRONG — QUALITY FLOOR ONLY
  contextBudget: ContextBudget;
  runId: string;
  taskInstanceId: string;
  // Pre-dispatch ruling addition: the brief's frozen RouteRequest has no
  // invocationId, but its own "Tests required" list demands the routing
  // decision be captured as structured payload on the `invocation_started`
  // event — impossible without something to attach the event to. The caller
  // (the Executor) is expected to have already created the
  // `invocations` row before calling `authorizeRoute`; this unit never
  // creates Invocation rows itself.
  invocationId: string;
  /**
   * Capabilities a candidate MUST support to serve this invocation (Phase 7D).
   * OPTIONAL, and an absent value means "no requirement" — deliberately not
   * defaulted to a list, because any non-empty default would start excluding
   * candidates and silently change routing.
   */
  requiredCapabilities?: CandidateCapability[];
  /**
   * Resource units this invocation may be accounted in (Phase 7D). Same rule:
   * absent means unrestricted. Present, it narrows candidates only — it can
   * never make one eligible that was not already.
   */
  allowedResourceUnits?: ResourceUnit[];
  /**
   * V1.1: the one provider this invocation may be served by (an Agent Definition's
   * execution profile). Absent, the configured candidate order applies. Present,
   * every other provider's candidates are excluded as `provider_mismatch`; with none
   * left the route is refused, never served by another provider.
   */
  requiredProvider?: ProviderName;
  /**
   * R2: provider-side tools this invocation is authorized to use (a Capability Grant's,
   * resolved by the Executor). Absent means none. Carried through to the route so the
   * adapter receives exactly what was authorized.
   */
  tools?: readonly string[];
};

export type RouteResult = {
  tier: ModelTier;
  modelId: string;
  reservationId: string;
  /**
   * The routed candidate's provider and accounting (Phase 7D). Carried so
   * `dispatchModelCall` dispatches to the adapter that was actually SELECTED, rather
   * than re-deriving it from the tier's primary candidate — which would send a
   * non-primary candidate's call to the wrong provider.
   */
  provider: ProviderName;
  accounting: TierAccounting;
  /** R2: the authorized provider-side tools, carried from the request to the adapter. */
  tools?: readonly string[];
  /** The routed model's context window (spec §5.17). */
  contextWindowTokens: number;
  /**
   * The input budget the Context Compiler packs to (§10.7 Pass 2): the Task's
   * `maxInputTokens`, capped at the model's window less `expectedOutputTokens`.
   */
  effectiveMaxInputTokens: number;
  /**
   * The Context Budget this call runs under: the request's, or — when the Budget
   * Governor degraded it to fit a reservation (`degradedContextBudget`) — the tightened
   * one. The Executor compiles to this, never to the Task's original budget.
   */
  contextBudget: ContextBudget;
  /** How the Budget Governor authorized this route (recorded on `invocation_started` as `budgetAuthorization.outcome`). */
  budgetOutcome: "authorized" | "downgraded" | "degraded";
  // Further addition (this unit's own resolution, in the same spirit as the
  // invocationId ruling above): the brief's frozen RouteResult has no
  // invocationId either, but `emitModelInvocationCompleted` is separately
  // required (same pre-dispatch ruling, point 3) to emit `invocation_completed`
  // correlated to an invocation — and the Router's dispatch/finalize functions
  // receive only `RouteResult` besides the compiled context and outcome.
  // Without carrying invocationId forward from `authorizeRoute`'s
  // `req.invocationId` into its returned `RouteResult`, they would have no way
  // to know which invocation they are completing.
  // This is a minimal, additive extension of the same gap, not a new
  // architectural choice.
  invocationId: string;
  // Fix round 1 addition (independent review, Important #1): the Router's
  // `invocation_completed` emission was correlating with `runId: null` /
  // `taskInstanceId: null` because RouteResult didn't carry them, even
  // though every invocation belongs to a real, non-null run. Per Unit 1's
  // `emit.ts`, a `runId: null` event falls into the shared GLOBAL sequence
  // bucket instead of the per-run monotonic counter — breaking "all events
  // for run X in order" queries and needlessly contending a shared advisory
  // lock across unrelated runs. Same additive-extension pattern as
  // `invocationId` above: `authorizeRoute` already has `req.runId`/
  // `req.taskInstanceId`, so it now carries them forward too.
  runId: string;
  taskInstanceId: string;
};
