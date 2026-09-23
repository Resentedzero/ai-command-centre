/**
 * The Manager's Capability contracts and mission limits (no imports: loaded by the adapter registry and seed).
 */
export const MANAGER_INSPECT_WORKFORCE_CAPABILITY = {
  id: "manager.inspect_workforce",
  description: "Read a compact roster of the existing agents: role, tier, availability and the capabilities each may use",
  staticRiskTag: "low" as const,
  costProfile: { costClass: "local_retrieval" as const },
};

export const MANAGER_DELEGATE_CAPABILITY = {
  id: "manager.delegate",
  description: "Start a validated, bounded plan of work for existing agents as a Workflow Run on the mission's Goal",
  staticRiskTag: "low" as const,
  costProfile: { costClass: "local_retrieval" as const },
};
export const MANAGER_DELEGATE_PERMISSION = "CREATE";

/**
 * `manager.inspect_history` (READ, R2 Stage 10): what the Keep DID recently — missions and their
 * outcomes, meetings and what they decided, and follow-ups still outstanding. Bounded by code (a fixed
 * window and limit; no free text, no query the model can widen) and made of FACTS, never bodies: ids,
 * hashes, statuses and the runtime's own reason codes. A prior deliverable's content is not in here; it
 * is an artifact id, and reaches a model fenced as untrusted like any other document.
 *
 * Reading history changes nothing. It is evidence for the Manager's reasoning, not an instruction to it.
 */
export const MANAGER_INSPECT_HISTORY_CAPABILITY = {
  id: "manager.inspect_history",
  description: "Read a bounded record of what the Keep recently did: missions and outcomes, meetings and decisions, and outstanding follow-ups",
  staticRiskTag: "low" as const,
  costProfile: { costClass: "local_retrieval" as const },
};

/** Deterministic, observable mission limits. */
export const MISSION_LIMITS = {
  /** Tasks in one plan. */
  maxTasksPerPlan: 3,
  /** Worker tasks across a whole mission, follow-ups included. */
  maxTasksPerMission: 4,
  /** Workflow Runs a mission may PLAN: the plan, the delegated work, and one follow-up. */
  maxWorkflowRuns: 3,
  /**
   * Further Workflow Runs a RECOVERY may add on top of `maxWorkflowRuns`: the recovery step itself and the
   * one run it delegates. Held apart deliberately — a review's follow-up must never be able to spend the
   * allowance that exists to answer a failure.
   */
  maxRecoveryWorkflowRuns: 2,
  /** Loop iterations per delegated worker step. */
  maxWorkerIterations: 3,
  /** Calls per tool per worker step. */
  maxToolCalls: 2,
  /** A follow-up is only started this long after the mission began. */
  maxMissionMinutes: 30,
  /** Recovery rounds after a delegated Workflow Run failed. One: the Manager gets a second try, not a loop. */
  maxRecoveryRounds: 1,
  textChars: 1_000,
} as const;


/** The internal functions behind the two Capabilities (binding `config.function`). */
export const MANAGER_WORKFORCE_READ = "manager.workforce.read";
export const MANAGER_DELEGATE_RECORD = "manager.delegate.record";
export const MANAGER_HISTORY_READ = "manager.history.read";
/** The one window the history capability reads, fixed in code so no model can widen it. */
export const HISTORY_DAYS = 7;
/** Records of each kind the Manager is given. Small on purpose: planning context, not an archive. */
export const HISTORY_LIMIT = 8;

/**
 * Deterministic mission reasons (hardening pass). Codes come only from code and runtime facts; a
 * `detail` may quote the model, and is labelled as detail, never used to decide.
 */
export const MISSION_REASONS = [
  "validation_rejected",
  "manager_escalated",
  "worker_failed",
  "worker_timed_out",
  "worker_unavailable",
  "budget_denied",
  "approval_required",
  "approval_rejected",
  "emergency_stopped",
  "capability_unavailable",
  "evidence_invalid",
  "deliverable_invalid",
  "verification_failed",
  "mission_limit_reached",
  "manager_planning_failed",
  "manager_review_failed",
  // Recovery after a delegated Workflow Run failed (decided by code from the runtime's records).
  "manager_recovery_failed",
  "provider_unavailable",
  "recovery_rejected",
  "recovery_exhausted",
  // Workplace: why a meeting could not be scheduled, moved or cancelled (decided by code).
  "invalid_meeting",
  "duplicate_meeting",
  "unknown_participant",
  "participant_unavailable",
  "participant_conflict",
  "outside_working_hours",
  "room_not_found",
  "room_inactive",
  "insufficient_room_capacity",
  "room_conflict",
  "no_common_availability",
  "meeting_not_found",
  "meeting_not_changeable",
] as const;
export type MissionReason = (typeof MISSION_REASONS)[number];
export type Blocker = { code: MissionReason; detail: string };

/**
 * Which review findings may be answered with the bounded follow-up: the worker ran without an authority
 * or integrity problem and simply did not produce enough. Budget, stops, approvals, missing capabilities
 * and failed verification are never retried by delegation; they escalate.
 */
export const RECOVERABLE_REASONS: readonly MissionReason[] = ["evidence_invalid", "deliverable_invalid", "worker_timed_out"];

/**
 * What a recovery may do about a failure, and nothing else. The model proposes one of these; code checks
 * the proposal against the failure's own category, so a budget denial or an emergency stop can never be
 * answered by running the same work again.
 *
 * - `retry`: the same task, the same agent — only where the failure was not the agent's doing and cost nothing.
 * - `reassign`: the same task, another agent that holds what the task needs.
 * - `modify`: a narrower task for the same or another agent (the brief changes; the objective does not).
 * - `escalate`: tell the operator; always allowed, and the only option for an authority or money failure.
 */
export const RECOVERY_ACTIONS = ["retry", "reassign", "modify", "escalate"] as const;
export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number];

export const RECOVERY_BY_REASON: Readonly<Record<MissionReason, readonly RecoveryAction[]>> = Object.freeze({
  // The runtime or a provider failed, not the work: another attempt is honest.
  provider_unavailable: ["retry", "reassign", "escalate"],
  worker_timed_out: ["reassign", "modify", "escalate"],
  worker_failed: ["reassign", "modify", "escalate"],
  deliverable_invalid: ["reassign", "modify", "escalate"],
  evidence_invalid: ["reassign", "modify", "escalate"],
  worker_unavailable: ["reassign", "escalate"],
  validation_rejected: ["modify", "escalate"],
  // Authority, money, stops and approvals are the operator's to answer — never retried by the Manager.
  budget_denied: ["escalate"],
  approval_required: ["escalate"],
  approval_rejected: ["escalate"],
  emergency_stopped: ["escalate"],
  capability_unavailable: ["escalate"],
  verification_failed: ["escalate"],
  mission_limit_reached: ["escalate"],
  manager_escalated: ["escalate"],
  manager_planning_failed: ["escalate"],
  manager_review_failed: ["escalate"],
  manager_recovery_failed: ["escalate"],
  recovery_rejected: ["escalate"],
  recovery_exhausted: ["escalate"],
  invalid_meeting: ["escalate"],
  duplicate_meeting: ["escalate"],
  unknown_participant: ["escalate"],
  participant_unavailable: ["escalate"],
  participant_conflict: ["escalate"],
  outside_working_hours: ["escalate"],
  room_not_found: ["escalate"],
  room_inactive: ["escalate"],
  insufficient_room_capacity: ["escalate"],
  room_conflict: ["escalate"],
  no_common_availability: ["escalate"],
  meeting_not_found: ["escalate"],
  meeting_not_changeable: ["escalate"],
});
