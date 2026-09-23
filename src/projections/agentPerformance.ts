/**
 * `agent_performance` projector (spec §8.3 asynchronous projections, §8.8, §10.5;
 * roadmap V2).
 *
 * RECOMPUTED, NOT INCREMENTAL. Each refresh rebuilds the whole table from Events in
 * one transaction. `events.global_seq` comes from a Postgres sequence, so a
 * transaction can commit a lower value after a higher one is already visible; a
 * watermark over it would skip that event forever. A full rebuild has no watermark
 * to get wrong, is idempotent by construction (replaying changes nothing), and a
 * crash mid-refresh rolls back to the previous rows. At operator scale the query is
 * cheap. Revisit with a commit-ordered cursor when it is not.
 *
 * DEFINITIONS (spec §8.8 names the measures; these are the rules):
 * - Sample: a Run with a bound Agent Definition version whose terminal event is
 *   `run_completed` or `run_failed`, EXCEPT outcomes that are not the agent's:
 *   a Run with any `run_halted` (an operator's emergency stop), and a failed Run
 *   whose last `invocation_failed` reason is in NOT_AGENT_OUTCOMES (governance,
 *   budget, the operator not answering, a changed binding, a crash) or whose
 *   `errorCode` is in NOT_AGENT_ERROR_CODES (a provider refusal that consumed
 *   nothing, a context that did not fit, a database error, a pre-dispatch refusal),
 *   and a Run whose step could not be built or executed (`execution_error`). Every other
 *   failure counts, including a human rejecting the work and any reason not listed:
 *   an unrecognized reason lowers the rate, which can never widen autonomy.
 * - Group: (Agent Definition id, version, Task Definition id, model tier).
 * - Model tier: `resultingTier` of the Run's last model `invocation_started`
 *   (the Model Router's own record); "none" for a Run that made no model call.
 * - Autonomous loops (R2, operator decision 2026-09-16): a Run that completed is a
 *   SUCCESS only if its loop, when it has one, concluded `complete`
 *   (`agent_loop_iteration_recorded` terminal status: `evidence_sufficient`, or
 *   `agent_finished`). A loop that concluded `incomplete` at its iteration or
 *   active-time limit is a sample and a FAILURE: the agent did not finish within its
 *   bounds, however cleanly the Run itself ended. A loop stopped by the Budget
 *   Governor's headroom check (LOOP_STOPS_NOT_AGENT) is not a sample, exactly as
 *   `insufficient_budget` is not. Runs with no loop keep the rule above.
 * - success_rate: successful samples / samples.
 * - avg_retries: (samples - distinct Task Instances) / distinct Task Instances — the
 *   extra Runs per Task Instance. Always 0 until retries exist.
 * - avg_cost: per resource unit, the sum of the samples' `budget_consumed` amounts
 *   / samples. Units are never combined (§10.5 "total cost including retries").
 *   Reported and estimate-basis charges are both included (a tool's are always
 *   estimates), and a Run's whole cost is attributed to its last tier.
 * - Values are stored with trailing zeros trimmed; a repeating quotient is cut at
 *   Postgres's numeric division scale.
 *
 * NOT FULLY EVENT-SOURCED: the Agent binding comes from `runs` and the Task
 * Definition from `task_instances`, both written in the same transaction as the
 * Run's events. No event records the binding itself.
 *
 * NOT YET: average duration and approval-rejection rate (§8.8 lists them; Phase 12's
 * table has no columns). Decisions read this table only through the minimum sample
 * criterion (`../governance/performanceEligibility.ts`), and only the Model Router's
 * tier preference does; `tests/execution/structuralInvariants.test.ts` enforces it.
 */
import { sql } from "drizzle-orm";
import { agentPerformance } from "../db/schema.js";
import { RUN_SAMPLES_CTES } from "./runSamples.js";
import type { DrizzleTransaction } from "../events/emit.js";

/** Same lock class as the Registry's own transaction-scoped locks; keys are prefixed per use. */
const LOCK_CLASS_ID = 20260914;

export async function refreshAgentPerformance(tx: DrizzleTransaction): Promise<void> {
  // One refresh at a time; readers keep seeing the previous rows until commit.
  await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_CLASS_ID}::int, hashtext('projection:agent_performance'))`);
  await tx.delete(agentPerformance);
  await tx.execute(sql`
    WITH ${RUN_SAMPLES_CTES},
    groups AS (
      SELECT
        agent_definition_id, agent_definition_version, task_definition_id, model_tier,
        COUNT(*) AS sample_count,
        trim_scale(AVG(CASE WHEN succeeded THEN 1 ELSE 0 END)::numeric) AS success_rate,
        trim_scale((COUNT(*) - COUNT(DISTINCT task_instance_id))::numeric / COUNT(DISTINCT task_instance_id)) AS avg_retries
      FROM samples
      GROUP BY agent_definition_id, agent_definition_version, task_definition_id, model_tier
    ),
    unit_costs AS (
      SELECT
        s.agent_definition_id, s.agent_definition_version, s.task_definition_id, s.model_tier,
        c.payload->>'resourceUnit' AS unit,
        SUM((c.payload->>'amount')::numeric) AS total
      FROM samples s
      JOIN events c ON c.run_id = s.run_id AND c.event_type = 'budget_consumed' AND c.payload ? 'resourceUnit'
      GROUP BY s.agent_definition_id, s.agent_definition_version, s.task_definition_id, s.model_tier, c.payload->>'resourceUnit'
    )
    INSERT INTO agent_performance
      (agent_definition_id, agent_definition_version, task_definition_id, model_tier,
       success_rate, avg_cost, avg_retries, sample_count, updated_at)
    SELECT
      g.agent_definition_id, g.agent_definition_version, g.task_definition_id, g.model_tier,
      g.success_rate,
      COALESCE(
        (SELECT jsonb_object_agg(u.unit, trim_scale(u.total / g.sample_count)::text) FROM unit_costs u
         WHERE u.agent_definition_id = g.agent_definition_id
           AND u.agent_definition_version = g.agent_definition_version
           AND u.task_definition_id = g.task_definition_id
           AND u.model_tier = g.model_tier),
        '{}'::jsonb
      ),
      g.avg_retries,
      g.sample_count,
      now()
    FROM groups g
  `);
}
