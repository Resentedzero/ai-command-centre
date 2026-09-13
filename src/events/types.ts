/**
 * The FROZEN canonical Event envelope — Phase 8.1 in full, as specified by
 * Unit 1's brief. Do not add, remove, or flatten fields here without
 * updating the spec first: this type is the reviewable contract for every
 * other unit that emits or consumes events.
 */
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
    modelId: string;
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
