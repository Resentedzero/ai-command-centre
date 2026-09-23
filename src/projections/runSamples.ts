/**
 * Which Runs count, and which of them succeeded: the one rule shared by every projection that
 * interprets outcomes (`agentPerformance.ts`, `agentProgression.ts`), so they can never disagree.
 * Moved verbatim from the performance projector (R2 progression, 2026-09-16); the rules are
 * documented there.
 *
 * `RUN_SAMPLES_CTES` is the body of a `WITH` clause defining `terminal`, `loop_terminal` and
 * `samples` (run_id, agent_definition_id, agent_definition_version, task_definition_id,
 * task_instance_id, succeeded, loop_reason, model_tier). Callers append their own CTEs.
 */
import { sql } from "drizzle-orm";

/**
 * `invocation_failed` reasons that end a Run for reasons other than the agent's work
 * (`../execution/executor.ts`, the Model Router's `AuthorizationFailure`).
 * `approval_rejected` is deliberately absent: a human judged the work.
 */
export const NOT_AGENT_OUTCOMES = [
  "execution_stopped",
  "policy_denied",
  "reauthorization_failed",
  "reauthorization_policy_denied",
  "insufficient_budget",
  "insufficient_budget_on_resume",
  "quota_guardrail",
  "provider_quota_rejected",
  "no_eligible_candidate",
  "approval_expired",
  "resume_spec_mismatch",
  "interrupted_outcome_unknown",
];
/** Loop conclusions that are governance stopping the work, not the agent failing it. Not samples. */
export const LOOP_STOPS_NOT_AGENT = ["budget_headroom"];
const LOOP_STOPS_NOT_AGENT_SQL = sql.raw(LOOP_STOPS_NOT_AGENT.map((reason) => `'${reason}'`).join(", "));

const NOT_AGENT_OUTCOMES_SQL = sql.raw(NOT_AGENT_OUTCOMES.map((reason) => `'${reason}'`).join(", "));

/**
 * `invocation_failed.errorCode` values that are not the agent's work, for failures whose
 * `reason` is free text (added 2026-09-15 after a cross-feature review): a provider refusal
 * that consumed nothing (`claudeSubscription.ts` NO_CONSUMPTION_CODES), a context that did not
 * fit its (possibly Governor-degraded) budget, a database error, and the pre-dispatch
 * refusals (`executor.ts#toolDispatchRefusal`, `advanceWorkflowRunUntilBlocked.ts`). A
 * `timeout` still counts: with no output or turn cap, a model that runs too long times out
 * like a hung provider, and excluding it would raise the rate autonomy decides on. A step
 * that could not be built or executed (`execution_error: …`) is excluded by its prefix.
 * Without these, an operator's Policy change, a provider outage or a budget shortage lowered
 * the rate Conditional Autonomy and tier preference decide on.
 */
export const NOT_AGENT_ERROR_CODES = [
  "cli_unavailable",
  "misconfigured",
  "input_too_large",
  "auth_expired",
  "quota_exhausted",
  "context_budget_exceeded",
  "database_error",
  "policy_denied_before_dispatch",
  "reauthorization_failed_before_dispatch",
  "approval_required_before_dispatch",
  "pre_dispatch_check_failed",
];
const NOT_AGENT_ERROR_CODES_SQL = sql.raw(NOT_AGENT_ERROR_CODES.map((code) => `'${code}'`).join(", "));

export const RUN_SAMPLES_CTES = sql`
    terminal AS (
      SELECT DISTINCT ON (run_id) run_id, event_type
      FROM events
      WHERE run_id IS NOT NULL AND event_type IN ('run_completed', 'run_failed')
      ORDER BY run_id, sequence_no DESC
    ),
    loop_terminal AS (
      SELECT DISTINCT ON (run_id) run_id, payload->'terminal'->>'status' AS status, payload->'terminal'->>'reason' AS reason
      FROM events
      WHERE run_id IS NOT NULL AND event_type = 'agent_loop_iteration_recorded' AND payload ? 'terminal'
      ORDER BY run_id, sequence_no DESC
    ),
    samples AS (
      SELECT
        r.id AS run_id,
        r.agent_definition_id,
        r.agent_definition_version,
        ti.task_definition_id,
        ti.id AS task_instance_id,
        t.event_type = 'run_completed' AND (lt.run_id IS NULL OR lt.status = 'complete') AS succeeded,
        lt.reason AS loop_reason,
        COALESCE(
          (SELECT s.payload->>'resultingTier' FROM events s
           WHERE s.run_id = r.id AND s.event_type = 'invocation_started' AND s.payload ? 'resultingTier'
           ORDER BY s.sequence_no DESC LIMIT 1),
          'none'
        ) AS model_tier
      FROM terminal t
      JOIN runs r ON r.id = t.run_id
      JOIN task_instances ti ON ti.id = r.task_instance_id
      LEFT JOIN loop_terminal lt ON lt.run_id = r.id
      WHERE NOT (lt.reason IS NOT NULL AND lt.reason IN (${LOOP_STOPS_NOT_AGENT_SQL}))
        AND NOT EXISTS (SELECT 1 FROM events h WHERE h.run_id = r.id AND h.event_type = 'run_halted')
        AND NOT (
          t.event_type = 'run_failed'
          AND (
            EXISTS (
              SELECT 1 FROM (
                SELECT f.payload->>'reason' AS reason, f.payload->>'errorCode' AS code FROM events f
                WHERE f.run_id = r.id AND f.event_type = 'invocation_failed'
                ORDER BY f.sequence_no DESC LIMIT 1
              ) last_failure
              WHERE last_failure.reason IN (${NOT_AGENT_OUTCOMES_SQL})
                 OR last_failure.code IN (${NOT_AGENT_ERROR_CODES_SQL})
                 OR last_failure.reason LIKE 'execution_error:%'
            )
            OR EXISTS (
              SELECT 1 FROM events rf
              WHERE rf.run_id = r.id AND rf.event_type = 'run_failed' AND rf.payload->>'reason' = 'execution_error'
            )
          )
        )
        AND r.agent_definition_id IS NOT NULL
        AND r.agent_definition_version IS NOT NULL
    )
`;
