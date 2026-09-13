/**
 * The FROZEN canonical Event envelope — Phase 8.1 in full, as specified by
 * Unit 1's brief. Do not add, remove, or flatten fields here without
 * updating the spec first: this type is the reviewable contract for every
 * other unit that emits or consumes events.
 *
 * AMENDED 2026-09-13, spec first (Phase 12 "Execution ledger"): `usage` gained
 * a REQUIRED `costUnit` and an optional `secondaryUsage`. Additive only — no
 * existing field changed meaning, and pre-existing rows are backfilled to
 * `usd` by migration 0006. See `../governance/resourceUnit.ts`.
 */
import type { ResourceUnit } from "../governance/resourceUnit.js";

export type EventEnvelope = {
  eventId: string; // generated UUID, primary key
  idempotencyKey: string; // caller-supplied, unique constraint — the actual dedup key
  eventType: string;
  eventVersion: number; // payload shape version for this eventType (Phase 20 risk #9)
  occurredAt: Date; // display only, never used for ordering
  sequenceNo: number; // monotonic, scoped per runId — authoritative for ordering
  causationId: string | null; // the event/invocation that directly caused this one
  correlation: {
    goalId: string | null;
    workflowRunId: string | null;
    taskInstanceId: string | null;
    runId: string | null;
    invocationId: string | null;
  };
  actor: string; // "agent:<id>@<version>" | "human:<id>" | "system"
  producer: string; // which module emitted this, e.g. "executor" | "workflow-interpreter" | "api"
  payload: Record<string, unknown>; // typed per eventType by convention; not a discriminated union for MVP
  usage: {
    tokensIn: number;
    tokensOut: number;
    cacheHit: boolean;
    costAmount: number;
    /**
     * The unit `costAmount` is denominated in (amended Phase 12, 2026-09-13).
     * REQUIRED, deliberately not optional: `costAmount` is meaningless without
     * it now that more than one unit exists, and an optional field would let an
     * emitter omit it and leave every downstream reader guessing — the precise
     * failure this exists to close. Readers must group by it and must never
     * total across units.
     */
    costUnit: ResourceUnit;
    modelId: string;
    /**
     * Model usage the provider reported BEYOND the primary model — e.g. the
     * internal secondary model call the subscription CLI performs per
     * invocation. Recorded so the event log shows WHAT was consumed, not just
     * a total; its tokens are already included in `costAmount`.
     */
    secondaryUsage?: Array<{ modelId: string; tokensIn: number; tokensOut: number }>;
  } | null; // present only for LLM-related events; never flattened onto the envelope itself
};

// ---------------------------------------------------------------------------
// Event payload typing — the convention, and why there is NO discriminated
// union (final-review Finding 1)
// ---------------------------------------------------------------------------
//
// `EventEnvelope.payload` above is deliberately `Record<string, unknown>`:
// this codebase types payloads BY CONVENTION, per `eventType`, and the
// envelope's own comment says so explicitly ("not a discriminated union for
// MVP"). Every event type that predates the final review —
// `invocation_started` / `invocation_completed` / `invocation_failed` — has
// no payload type whatsoever; its shape exists only at its emission site.
//
// Finding 1 added Phase 8.2's three GOVERNANCE approval events. They get
// explicit payload interfaces below, which is strictly more typing than any
// existing event has — but deliberately NOT a discriminated union keyed on
// `eventType`. Retrofitting a union covering only three of the codebase's six
// event types would make the taxonomy less uniform rather than more, and
// discriminating `payload` on `eventType` would mean changing the FROZEN
// envelope above, which its own header forbids without amending the spec
// first. The interfaces are load-bearing rather than decorative because each
// emission site annotates the object it passes as `payload` with one of them.
//
// `riskTier` is typed `string` here rather than importing `RiskTier` from
// `../governance/risk.js` (whose vocabulary it does carry: "low" | "medium" |
// "high" | "highest"). `events/` is the lower layer — `governance/` already
// imports from it — and inverting that dependency merely to narrow one field
// is not worth the cycle.

/**
 * `approval_required` (Governance). Emitted in the SAME transaction that
 * creates the `approvals` row, when Policy returned REQUIRE_APPROVAL —
 * Phase 9.5's "Approval created ... status: pending" step, made visible to
 * the Activity feed (Phase 18.1a).
 */
export type ApprovalRequiredPayload = {
  approvalId: string;
  riskTier: string;
  /** The Capability + permission being gated — Phase 9.5 requires the EXACT action be identifiable, never just a category. */
  capabilityId: string;
  permission: string;
};

/**
 * `approval_granted` / `approval_rejected` (Governance) — Phase 9.5's
 * "resolution event recorded" step. Emitted in the SAME transaction as the
 * `approvals.status` update, exactly one of the two per resolution.
 */
export type ApprovalResolvedPayload = {
  approvalId: string;
  riskTier: string;
  /** Who resolved it, as recorded on `approvals.resolved_by`; mirrored onto the envelope's `actor`. */
  resolvedBy: string;
};

/**
 * One quota window exactly as the provider reported it. Both members are
 * independently nullable so an omitted field is recorded as ABSENT rather than
 * replaced with a fabricated zero — a missing utilization and a utilization of
 * 0.0 mean very different things to a future policy.
 */
export type QuotaWindowObservation = {
  utilization: number | null;
  /** ISO-8601. The reset instant as reported; no remaining-duration is derived. */
  resetsAt: string | null;
};

/**
 * `provider_quota_observed` (Phase 7A; design Part 4). The immutable FACT
 * "at time T, provider P reported quota state Q".
 *
 * It is an observation, never current state: the `subscription_quota_state`
 * projection is what answers "what is true now", and it is rebuilt from these
 * payloads. This payload therefore carries everything the projection needs, so
 * the projection is reconstructible from the event log alone.
 *
 * Carries NO `usage` on its envelope. A quota reading is not consumption, and
 * attaching a `costAmount` here would invite exactly the utilization -> tokens
 * conflation the design forbids.
 */
export type ProviderQuotaObservedPayload = {
  provider: string;
  /** ISO-8601 instant the provider reported this. Ordering key for the projection. */
  observedAt: string;
  status: string;
  overageStatus: string | null;
  /** Which mechanism produced the reading, e.g. "rate_limit_event". */
  source: string;
  fiveHour: QuotaWindowObservation | null;
  sevenDay: QuotaWindowObservation | null;
  /**
   * How many raw provider readings this event summarizes (design Part 4:
   * one event per invocation, carrying the LAST reading seen). 1 when the
   * provider reported once. Recorded so the event says how much it collapsed;
   * it is a count of readings and never a quantity of anything consumed.
   */
  observationCount: number;
};
