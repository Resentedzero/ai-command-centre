/**
 * Subscription quota guardrail (Phase 7C) — the ADVISORY provider-quota policy.
 *
 * This is mechanism B of three, and the three are deliberately never merged:
 *
 *   A. HARD ACCOUNTING CONTROL   Budget Governor / resource-unit reservation
 *                                (`./budget.ts`). Transactional, authoritative,
 *                                and fully functional with ZERO quota telemetry.
 *   B. ADVISORY QUOTA GUARDRAIL  this module. Reads the provider-reported gauge
 *                                and can only ever REFUSE — it never authorizes.
 *   C. PROVIDER ENFORCEMENT      Claude itself rejecting the invocation. B makes
 *                                C rarer; it can never replace it, and the
 *                                provider remains authoritative for what it
 *                                actually accepts.
 *
 * WHAT THIS MODULE MUST NEVER DO
 * ------------------------------
 * Utilization is a provider-reported GAUGE, not a counter: it was measured
 * oscillating 0.47 -> 0.48 -> 0.47 inside a single second, and an 8-call burst
 * moved it less than a 2-call burst. So nothing here converts utilization into
 * tokens, dollars, invocations remaining, or consumption, in either direction.
 * It writes no `budget_counters` row, touches no `subscription_tokens` amount,
 * and imports neither `./budget.ts` nor any resource-unit type — asserted
 * structurally by the tests.
 *
 * Telemetry can CONSTRAIN dispatch. It can never widen authorization: every
 * path below returns either "allow" (leaving mechanism A as the only real
 * control) or a refusal. There is no branch that grants anything.
 *
 * WHY A SEPARATE RESULT TYPE FROM `./policy.ts`
 * --------------------------------------------
 * `evaluatePolicy`'s `ALLOW | DENY | REQUIRE_APPROVAL` answers "is this agent
 * authorized to attempt this action", from a Capability Grant, a permission and
 * a trust level — none of which exist here. This decision has no grant, no
 * capability and no approval path, and needs to distinguish "refused on the
 * gauge" from "the provider says it is unhealthy" from "we have no telemetry
 * and are allowing anyway". Reusing `PolicyDecision` would either lose those
 * distinctions or force alien branches into the Capability policy engine.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { events } from "../db/schema.js";
import { emitEvent, type DrizzleTransaction } from "../events/emit.js";
import { getQuotaState } from "./subscriptionQuotaState.js";

// ---------------------------------------------------------------------------
// CONFIGURATION — this is where the guardrail is turned on.
// ---------------------------------------------------------------------------

export type QuotaWindowThresholds = {
  /** At or above this utilization, dispatch CLOSES. */
  upper: number;
  /** At or below this utilization, dispatch may REOPEN. Must be < upper. */
  lower: number;
};

export type QuotaGuardrailConfig = {
  enabled: boolean;
  fiveHour?: QuotaWindowThresholds;
  sevenDay?: QuotaWindowThresholds;
  /**
   * How long a reading stays FRESH, in milliseconds. Optional and deliberately
   * unset by default: `observed_at` is a LOCAL RECEIPT time (Phase 7B), and no
   * evidence exists for any particular expiry, so inventing one would be an
   * unexplained production constant. With it unset, readings never go stale and
   * the FRESH/STALE distinction simply does not apply.
   */
  freshnessMs?: number;
};

/**
 * SHIPPED CONFIGURATION — DISABLED.
 *
 * Phase 7C ships the mechanism, not the policy. With `enabled: false` this
 * module cannot refuse anything: `evaluateQuotaGuardrail` returns ALLOW before
 * reading any state at all, so runtime behaviour is byte-for-byte what it was
 * before Phase 7C.
 *
 * No thresholds are configured either. The 0.90/0.80 pair discussed during
 * Phase 6 design was a starting suggestion derived from nothing measurable —
 * the absolute capacity behind the gauge remains UNKNOWN — so it is deliberately
 * NOT enshrined here as production policy.
 */
export const quotaGuardrailConfig: Record<string, QuotaGuardrailConfig> = {
  claude_subscription: { enabled: false },
};

/**
 * Rejects an unusable threshold pair loudly rather than silently behaving
 * oddly. A `lower >= upper` pair has no hysteresis band at all and would flap
 * on exactly the jitter this design exists to absorb.
 */
export function validateQuotaGuardrailConfig(provider: string, config: QuotaGuardrailConfig): void {
  for (const [windowName, thresholds] of [
    ["fiveHour", config.fiveHour],
    ["sevenDay", config.sevenDay],
  ] as const) {
    if (!thresholds) continue;

    const { upper, lower } = thresholds;
    for (const [name, value] of [
      ["upper", upper],
      ["lower", lower],
    ] as const) {
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(
          `quota guardrail config for "${provider}": ${windowName}.${name} must be a finite utilization` +
            ` fraction between 0 and 1; received ${value}.`
        );
      }
    }
    if (lower >= upper) {
      throw new Error(
        `quota guardrail config for "${provider}": ${windowName}.lower (${lower}) must be strictly below` +
          ` ${windowName}.upper (${upper}), or there is no hysteresis band and the decision will flap.`
      );
    }
  }
  if (config.freshnessMs !== undefined && (!Number.isFinite(config.freshnessMs) || config.freshnessMs <= 0)) {
    throw new Error(
      `quota guardrail config for "${provider}": freshnessMs must be a positive number of milliseconds.`
    );
  }
}

// ---------------------------------------------------------------------------
// DECISION
// ---------------------------------------------------------------------------

/**
 * A policy INTERPRETATION, never a provider outcome. `REFUSE_QUOTA` means this
 * runtime declined to dispatch; it says nothing about what the provider would
 * have done, and `ALLOW` guarantees nothing about future availability.
 */
export type QuotaGuardrailDecision =
  | { decision: "ALLOW"; reason: "disabled" | "not_configured" | "below_threshold" }
  | { decision: "UNKNOWN_ALLOWED"; reason: "no_observation" | "stale_observation" }
  | { decision: "REFUSE_QUOTA"; reason: "five_hour_upper" | "seven_day_upper" | "latched_closed" }
  | { decision: "PROVIDER_REJECTED"; reason: "status_not_allowed" | "overage_status_unexpected" };

/** Whether dispatch is currently latched open or closed for a provider. */
export type GuardrailState = "OPEN" | "CLOSED";

export const QUOTA_GUARDRAIL_STATE_CHANGED = "quota_guardrail_state_changed";
export const QUOTA_GUARDRAIL_STATE_CHANGED_VERSION = 1;

/** The value the provider is currently expected to report for overage. */
const EXPECTED_OVERAGE_STATUS = "rejected";

/**
 * Reads the latched state from the last transition event for this provider.
 *
 * The event log IS the latch — there is no separate state table and no
 * in-memory flag. That keeps the hysteresis memory durable across restarts,
 * consistent across processes, and auditable, without adding schema or making
 * the provider-fact projection carry a policy interpretation.
 *
 * `OPEN` when no transition has ever been recorded: the guardrail starts open,
 * because it can only ever close in response to an observation.
 *
 * ponytail: unindexed scan of `events` filtered by type + payload provider.
 * Fine at MVP volume; add a partial index on `event_type` if the event table
 * grows enough for this to show up.
 */
export async function readLatchedState(tx: DrizzleTransaction, provider: string): Promise<GuardrailState> {
  const rows = await tx
    .select({ payload: events.payload })
    .from(events)
    .where(
      and(
        eq(events.eventType, QUOTA_GUARDRAIL_STATE_CHANGED),
        sql`${events.payload}->>'provider' = ${provider}`
      )
    )
    .orderBy(desc(events.globalSeq))
    .limit(1);

  const to = rows[0]?.payload?.to;
  return to === "CLOSED" ? "CLOSED" : "OPEN";
}

type WindowVerdict = "ABOVE_UPPER" | "BELOW_LOWER" | "BETWEEN" | "NOT_EVALUABLE";

/**
 * Classifies one window against its configured thresholds.
 *
 * `NOT_EVALUABLE` covers both "no thresholds configured for this window" and
 * "the provider reported no utilization for it". Those are treated identically
 * on purpose: in neither case is there a basis to judge the window, so it can
 * neither close dispatch nor contribute to reopening it.
 */
function classifyWindow(utilization: string | null, thresholds: QuotaWindowThresholds | undefined): WindowVerdict {
  if (!thresholds || utilization === null) return "NOT_EVALUABLE";

  const value = Number(utilization);
  // Untrusted provider data: a non-finite utilization is unusable, never
  // coerced into a comparison that would silently read as "plenty of room".
  if (!Number.isFinite(value)) return "NOT_EVALUABLE";

  if (value >= thresholds.upper) return "ABOVE_UPPER";
  if (value <= thresholds.lower) return "BELOW_LOWER";
  return "BETWEEN";
}

export type QuotaGuardrailResult = {
  decision: QuotaGuardrailDecision;
  /** The latched state AFTER this evaluation. */
  state: GuardrailState;
  /** True when this evaluation moved the latch (and emitted a transition event). */
  changed: boolean;
};

/**
 * Evaluates the guardrail for one provider and, when the latch moves, records
 * that transition as an Event in the caller's transaction.
 *
 * SEMANTICS
 * ---------
 * Disabled (the shipped default) returns ALLOW immediately, having read
 * nothing: enabling is the only way this module can affect dispatch.
 *
 * Provider status is judged BEFORE utilization, because an unhealthy provider
 * is not a question of headroom:
 *   - `status` other than `"allowed"`          -> PROVIDER_REJECTED
 *   - `overageStatus` present and not "rejected" -> PROVIDER_REJECTED. The
 *     economics of exhaustion changed; per Phase 6 that warrants human policy
 *     review, not an automatic decision by this function.
 * Neither is ordinary "unknown" state, and neither is latched — they reflect
 * what the provider is saying right now.
 *
 * FRESHNESS: an observation older than `freshnessMs` (when configured) is
 * STALE. Stale and absent observations are both UNKNOWN_ALLOWED.
 *
 * WHY UNKNOWN ALLOWS, even when latched CLOSED: quota telemetry arrives ONLY as
 * a by-product of invocations. Refusing while unknown would mean a closed
 * guardrail could never observe its own recovery — it would deadlock shut with
 * no path back. Allowing keeps the escape hatch open while leaving mechanism A,
 * the transactional reservation, as the real control. An UNKNOWN evaluation
 * therefore does NOT clear the latch: the next fresh observation is judged
 * against the state that was already latched.
 *
 * WINDOW INTERACTION: the two windows are NOT collapsed into "whichever is
 * larger". Either window reaching its upper threshold CLOSES dispatch; BOTH
 * configured windows must be at or below their lower thresholds to REOPEN it.
 * Closing on either is the conservative direction (a seven-day ceiling can bind
 * while the five-hour window looks clear), and requiring both to recover
 * prevents one window's dip from reopening dispatch the other still forbids.
 * Anything in between retains the latched state — that band is the hysteresis
 * that absorbs the measured 0.47/0.48 jitter.
 *
 * Reset timestamps are stored state only. Nothing here predicts capacity,
 * extrapolates utilization, or synthesizes a reset event; after a real reset the
 * provider's next observation reopens the guardrail through the normal rules.
 */
export async function evaluateQuotaGuardrail(
  tx: DrizzleTransaction,
  input: { provider: string; now?: Date; invocationId?: string | null; runId?: string | null },
  configs: Record<string, QuotaGuardrailConfig> = quotaGuardrailConfig
): Promise<QuotaGuardrailResult> {
  const config = configs[input.provider];

  if (!config) {
    return { decision: { decision: "ALLOW", reason: "not_configured" }, state: "OPEN", changed: false };
  }
  if (!config.enabled) {
    return { decision: { decision: "ALLOW", reason: "disabled" }, state: "OPEN", changed: false };
  }

  validateQuotaGuardrailConfig(input.provider, config);

  const now = input.now ?? new Date();
  const state = await getQuotaState(tx, input.provider);
  const latched = await readLatchedState(tx, input.provider);

  if (!state) {
    return { decision: { decision: "UNKNOWN_ALLOWED", reason: "no_observation" }, state: latched, changed: false };
  }

  // Explicit provider unhealthiness is judged first, and is never latched.
  if (state.status !== "allowed") {
    return {
      decision: { decision: "PROVIDER_REJECTED", reason: "status_not_allowed" },
      state: latched,
      changed: false,
    };
  }
  if (state.overageStatus !== null && state.overageStatus !== EXPECTED_OVERAGE_STATUS) {
    return {
      decision: { decision: "PROVIDER_REJECTED", reason: "overage_status_unexpected" },
      state: latched,
      changed: false,
    };
  }

  if (config.freshnessMs !== undefined && now.getTime() - state.observedAt.getTime() > config.freshnessMs) {
    return {
      decision: { decision: "UNKNOWN_ALLOWED", reason: "stale_observation" },
      state: latched,
      changed: false,
    };
  }

  const fiveHour = classifyWindow(state.fiveHourUtilization, config.fiveHour);
  const sevenDay = classifyWindow(state.sevenDayUtilization, config.sevenDay);

  const evaluable = [fiveHour, sevenDay].filter((v) => v !== "NOT_EVALUABLE");
  if (evaluable.length === 0) {
    // Enabled, but nothing judgeable: no thresholds configured, or the provider
    // reported no usable utilization. Not a refusal — there is no basis for one.
    return { decision: { decision: "ALLOW", reason: "not_configured" }, state: latched, changed: false };
  }

  let next: GuardrailState = latched;
  let decision: QuotaGuardrailDecision;

  if (fiveHour === "ABOVE_UPPER" || sevenDay === "ABOVE_UPPER") {
    next = "CLOSED";
    decision = {
      decision: "REFUSE_QUOTA",
      reason: fiveHour === "ABOVE_UPPER" ? "five_hour_upper" : "seven_day_upper",
    };
  } else if (evaluable.every((v) => v === "BELOW_LOWER")) {
    next = "OPEN";
    decision = { decision: "ALLOW", reason: "below_threshold" };
  } else {
    // In the hysteresis band: retain whatever was latched.
    decision =
      latched === "CLOSED"
        ? { decision: "REFUSE_QUOTA", reason: "latched_closed" }
        : { decision: "ALLOW", reason: "below_threshold" };
  }

  const changed = next !== latched;
  if (changed) {
    await emitEvent(tx, {
      // Keyed on the OBSERVATION that caused the transition, so re-evaluating
      // the same observation cannot record the same transition twice.
      idempotencyKey: `${QUOTA_GUARDRAIL_STATE_CHANGED}:${input.provider}:${state.observationEventId}`,
      eventType: QUOTA_GUARDRAIL_STATE_CHANGED,
      eventVersion: QUOTA_GUARDRAIL_STATE_CHANGED_VERSION,
      causationId: state.observationEventId,
      correlation: {
        goalId: null,
        workflowRunId: null,
        taskInstanceId: null,
        runId: input.runId ?? null,
        invocationId: input.invocationId ?? null,
      },
      actor: "system",
      producer: "quota-guardrail",
      payload: {
        provider: input.provider,
        from: latched,
        to: next,
        reason: decision.reason,
        // The reading this was decided from, recorded so an operator can see
        // the interpretation and the fact side by side. Utilizations are copied
        // verbatim; nothing is derived from them.
        fiveHourUtilization: state.fiveHourUtilization,
        sevenDayUtilization: state.sevenDayUtilization,
        observedAt: state.observedAt.toISOString(),
        thresholds: { fiveHour: config.fiveHour ?? null, sevenDay: config.sevenDay ?? null },
      },
      // A policy decision consumes nothing. Never a usage record.
      usage: null,
    });
  }

  return { decision, state: next, changed };
}
