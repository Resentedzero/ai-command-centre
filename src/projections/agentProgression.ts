/**
 * Agent progression projector (R2): XP awards, achievements, specialisation evidence and peer
 * endorsements, rebuilt from Events and operator actions. Rules and constants:
 * `./progressionRules.ts`. Plan: docs/superpowers/plans/2026-09-16-r2.0-plan.md §11.
 *
 * AN INTERPRETATION OF REAL WORK. Work XP is earned only by Runs that are performance success
 * samples — the same rule `agent_performance` uses (`./runSamples.ts`), so a Run stopped at its
 * iteration or time limit, refused by budget or Policy, or halted by an operator earns nothing.
 * A validated deliverable needs the loop's code-verified `evidence_sufficient`, never the model's
 * say-so. Quality XP comes only from `quality_verdict_recorded`, which only the operator's route
 * writes. Endorsements, approvals, tokens, appearance, versions and names earn nothing.
 *
 * KEYED ON THE PERSISTENT NAME. Every row names the agent, not a Definition version, so v1, v2
 * and v3 share one history and a new version resets nothing.
 *
 * RECOMPUTED, NOT INCREMENTAL, exactly like `agentPerformance.ts` (see its header): one
 * transaction deletes and rebuilds every table, so replaying or rebuilding can never duplicate an
 * award, and every award has a deterministic key (`rule:subject`) as its primary key besides.
 *
 * NEVER AUTHORITY. Nothing in governance, the Model Router, execution or the Context Compiler
 * reads these tables (`tests/execution/structuralInvariants.test.ts`).
 *
 * NOT FULLY EVENT-SOURCED, like the performance projector: agent binding comes from `runs`,
 * capability use from `invocations`, and an endorsement's proven snapshot from
 * `invocations.proposed_action_snapshot` (written by code after its proof, `../capabilities/peerEndorse`).
 */
import { sql } from "drizzle-orm";
import { agentAchievements, agentDomainWork, agentEndorsements, agentXpAwards } from "../db/schema.js";
import type { DrizzleTransaction } from "../events/emit.js";
import { RUN_SAMPLES_CTES } from "./runSamples.js";
import { ENDORSEMENT_CAPABILITY_NAME, domainOfCapabilityUse, earnsCapabilityXp, taskKindsEarningNoProgression } from "../capabilities/progressionFacts.js";
import {
  QUALITY_VERDICTS,
  SEASONED_MIN_RUNS,
  VERDICT_XP,
  XP,
  type Domain,
  type QualityVerdict,
} from "./progressionRules.js";

const LOCK_CLASS_ID = 20260914;

type Award = typeof agentXpAwards.$inferInsert;
type Achievement = typeof agentAchievements.$inferInsert;

type SuccessRun = {
  run_id: string;
  task_instance_id: string;
  agent_name: string;
  loop_reason: string | null;
  workflow_run_id: string | null;
  goal_id: string | null;
  ended_at: Date;
  capabilities: string[];
  /** Each completed capability use with its binding's function (null for one without a binding). */
  uses: { name: string; fn: string | null }[];
  verified: { capability?: string; runId?: string }[] | null;
  deliverable: { id: string; hash: string } | null;
};

const at = (value: Date | string) => (value instanceof Date ? value : new Date(value));

async function rows<T>(tx: DrizzleTransaction, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await tx.execute(query)).rows as T[];
}

export async function refreshAgentProgression(tx: DrizzleTransaction): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_CLASS_ID}::int, hashtext('projection:agent_progression'))`);
  await tx.delete(agentXpAwards);
  await tx.delete(agentAchievements);
  await tx.delete(agentDomainWork);
  await tx.delete(agentEndorsements);

  // Attendance is not work. The kinds come from capability code, so this file still names none of them,
  // and the filter sits on `successes` so a meeting earns no task, capability, workflow, mission or
  // domain XP and no achievement — one exclusion rather than six.
  const excludedKinds = taskKindsEarningNoProgression();
  const notWork = excludedKinds.length === 0 ? sql`TRUE` : sql`td.kind NOT IN (${sql.join(excludedKinds.map((k) => sql`${k}`), sql`, `)})`;
  const successes = await rows<SuccessRun>(
    tx,
    sql`
    WITH ${RUN_SAMPLES_CTES}
    SELECT
      s.run_id, s.task_instance_id, s.loop_reason, ad.name AS agent_name,
      ti.workflow_run_id, wr.goal_id,
      (SELECT e.occurred_at FROM events e WHERE e.run_id = s.run_id AND e.event_type = 'run_completed'
       ORDER BY e.sequence_no DESC LIMIT 1) AS ended_at,
      (SELECT COALESCE(jsonb_agg(DISTINCT c.name), '[]'::jsonb) FROM invocations i JOIN capabilities c ON c.id = i.capability_id
       WHERE i.run_id = s.run_id AND i.status = 'completed') AS capabilities,
      (SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object('name', c.name, 'fn', tb.config->>'function')), '[]'::jsonb)
       FROM invocations i JOIN capabilities c ON c.id = i.capability_id LEFT JOIN tool_bindings tb ON tb.id = i.tool_binding_id
       WHERE i.run_id = s.run_id AND i.status = 'completed') AS uses,
      (SELECT l.payload->'terminal'->'evidence'->'verified' FROM events l
       WHERE l.run_id = s.run_id AND l.event_type = 'agent_loop_iteration_recorded' AND l.payload ? 'terminal'
       ORDER BY l.sequence_no DESC LIMIT 1) AS verified,
      (SELECT jsonb_build_object('id', a.id, 'hash', a.hash) FROM artifacts a JOIN invocations i ON i.id = a.producing_invocation_id
       WHERE i.run_id = s.run_id AND a.type = 'deliverable' ORDER BY a.created_at DESC, a.id LIMIT 1) AS deliverable
    FROM samples s
    JOIN agent_definitions ad ON ad.id = s.agent_definition_id
    JOIN task_instances ti ON ti.id = s.task_instance_id
    JOIN task_definitions td ON td.id = ti.task_definition_id AND td.version = ti.task_definition_version
    LEFT JOIN workflow_runs wr ON wr.id = ti.workflow_run_id
    WHERE s.succeeded AND ${notWork}
    ORDER BY ended_at, s.run_id
  `
  );

  // Which agent ran each handed-over Run, so a handoff counts only across agents.
  const handedRunIds = [...new Set(successes.flatMap((s) => (s.verified ?? []).filter((v) => v.capability === "handoff" && v.runId).map((v) => v.runId!)))];
  const handedBy = new Map(
    handedRunIds.length === 0
      ? []
      : (
          await rows<{ id: string; name: string }>(
            tx,
            sql`SELECT r.id, ad.name FROM runs r JOIN agent_definitions ad ON ad.id = r.agent_definition_id WHERE r.id IN (${sql.join(handedRunIds.map((id) => sql`${id}::uuid`), sql`, `)})`
          )
        ).map((r) => [r.id, r.name])
  );
  const handoffFromOther = (s: SuccessRun) =>
    (s.verified ?? []).some((v) => v.capability === "handoff" && v.runId && handedBy.has(v.runId) && handedBy.get(v.runId) !== s.agent_name);

  const awards = new Map<string, Award>();
  const award = (a: Award) => {
    const id = JSON.stringify([a.agentName, a.awardKey]);
    if (!awards.has(id)) awards.set(id, a);
  };
  const domainWork: (typeof agentDomainWork.$inferInsert)[] = [];

  for (const s of successes) {
    const earnedAt = at(s.ended_at);
    const base = { agentName: s.agent_name, runId: s.run_id, workflowRunId: s.workflow_run_id, goalId: s.goal_id, earnedAt };
    award({ ...base, awardKey: `task:${s.task_instance_id}`, rule: "task", xp: XP.task, artifactId: null, evidence: { runId: s.run_id, taskInstanceId: s.task_instance_id } });
    // Domains come from the capability code's own declaration; fixed test data is not research.
    const domains: Domain[] = [...new Set(s.uses.map((u) => domainOfCapabilityUse(u.name, u.fn)).filter((d): d is Domain => d !== null))];
    const research = [...new Set(s.uses.filter((u) => domainOfCapabilityUse(u.name, u.fn) === "research").map((u) => u.name))];
    if (research.length > 0) {
      award({ ...base, awardKey: `research:${s.task_instance_id}`, rule: "research", xp: XP.research, artifactId: null, evidence: { runId: s.run_id, capabilities: research } });
    }
    for (const capability of s.capabilities.filter(earnsCapabilityXp)) {
      award({ ...base, awardKey: `capability:${s.run_id}:${capability}`, rule: "capability", xp: XP.capability, artifactId: null, evidence: { runId: s.run_id, capability } });
    }
    if (s.loop_reason === "evidence_sufficient" && s.deliverable) {
      award({
        ...base,
        awardKey: `artifact:${s.deliverable.id}`,
        rule: "validated_artifact",
        xp: XP.validatedArtifact,
        artifactId: s.deliverable.id,
        evidence: { runId: s.run_id, artifactId: s.deliverable.id, hash: s.deliverable.hash, loopReason: s.loop_reason },
      });
    }
    if (s.loop_reason === "evidence_sufficient" && handoffFromOther(s)) domains.push("analysis");
    for (const domain of domains) domainWork.push({ agentName: s.agent_name, domain, runId: s.run_id, earnedAt });
  }

  // Workflow Runs and Goals that completed, to each agent that succeeded inside them.
  const completions = await rows<{ event_type: string; workflow_run_id: string | null; goal_id: string | null; occurred_at: Date }>(
    tx,
    sql`SELECT DISTINCT ON (event_type, COALESCE(workflow_run_id, goal_id)) event_type, workflow_run_id, goal_id, occurred_at FROM events
        WHERE event_type = 'workflow_run_completed' OR (event_type = 'goal_completed' AND goal_id IS NOT NULL)
        ORDER BY event_type, COALESCE(workflow_run_id, goal_id), global_seq`
  );
  const completedWorkflows = new Map(completions.filter((c) => c.event_type === "workflow_run_completed" && c.workflow_run_id).map((c) => [c.workflow_run_id!, at(c.occurred_at)]));
  const completedGoals = new Map<string, Date>();
  for (const c of completions.filter((c) => c.event_type === "goal_completed")) {
    if (!completedGoals.has(c.goal_id!)) completedGoals.set(c.goal_id!, at(c.occurred_at));
  }
  for (const s of successes) {
    const wrAt = s.workflow_run_id ? completedWorkflows.get(s.workflow_run_id) : undefined;
    if (wrAt) {
      award({ agentName: s.agent_name, awardKey: `workflow:${s.workflow_run_id}`, rule: "workflow", xp: XP.workflow, runId: s.run_id, workflowRunId: s.workflow_run_id, goalId: s.goal_id, artifactId: null, evidence: { workflowRunId: s.workflow_run_id, runId: s.run_id }, earnedAt: wrAt });
    }
    const goalAt = s.goal_id ? completedGoals.get(s.goal_id) : undefined;
    if (goalAt) {
      award({ agentName: s.agent_name, awardKey: `mission:${s.goal_id}`, rule: "mission", xp: XP.mission, runId: s.run_id, workflowRunId: s.workflow_run_id, goalId: s.goal_id, artifactId: null, evidence: { goalId: s.goal_id, runId: s.run_id }, earnedAt: goalAt });
    }
  }

  // The operator's latest quality verdict on each artifact, to the agent whose Run produced it (re-derived, not trusted from the payload).
  const verdicts = await rows<{ artifact_id: string; verdict: string; event_id: string; occurred_at: Date; agent_name: string | null; run_id: string | null }>(
    tx,
    sql`
    WITH latest AS (
      SELECT DISTINCT ON (payload->>'artifactId') payload->>'artifactId' AS artifact_id, payload->>'verdict' AS verdict, id AS event_id, occurred_at
      FROM events WHERE event_type = 'quality_verdict_recorded' AND actor LIKE 'human:%'
      ORDER BY payload->>'artifactId', global_seq DESC
    )
    SELECT l.*, ad.name AS agent_name, r.id AS run_id
    FROM latest l
    JOIN artifacts a ON a.id::text = l.artifact_id
    LEFT JOIN invocations i ON i.id = a.producing_invocation_id
    LEFT JOIN runs r ON r.id = i.run_id
    LEFT JOIN agent_definitions ad ON ad.id = r.agent_definition_id
  `
  );
  for (const v of verdicts) {
    if (!v.agent_name || !(QUALITY_VERDICTS as readonly string[]).includes(v.verdict)) continue;
    award({
      agentName: v.agent_name,
      awardKey: `verdict:${v.artifact_id}`,
      rule: "quality_verdict",
      xp: VERDICT_XP[v.verdict as QualityVerdict],
      runId: v.run_id,
      workflowRunId: null,
      goalId: null,
      artifactId: v.artifact_id,
      evidence: { verdict: v.verdict, eventId: v.event_id, artifactId: v.artifact_id },
      earnedAt: at(v.occurred_at),
    });
  }

  // Achievements: the earliest fact satisfying each condition.
  const achievements = new Map<string, Achievement>();
  const achieve = (a: Achievement) => {
    const id = JSON.stringify([a.agentName, a.achievement]);
    if (!achievements.has(id)) achievements.set(id, a);
  };
  for (const s of successes) {
    const earnedAt = at(s.ended_at);
    achieve({ agentName: s.agent_name, achievement: "first_success", evidence: { runId: s.run_id }, earnedAt });
    const verifiedResearch = (s.verified ?? []).some((v) => typeof v.capability === "string" && s.uses.some((u) => u.name === v.capability && domainOfCapabilityUse(u.name, u.fn) === "research"));
    if (s.loop_reason === "evidence_sufficient" && verifiedResearch) {
      achieve({ agentName: s.agent_name, achievement: "verified_research", evidence: { runId: s.run_id }, earnedAt });
    }
    if (s.loop_reason === "evidence_sufficient" && handoffFromOther(s)) {
      achieve({ agentName: s.agent_name, achievement: "handoff", evidence: { runId: s.run_id }, earnedAt });
    }
    if (s.loop_reason === "evidence_sufficient" && s.deliverable) {
      achieve({ agentName: s.agent_name, achievement: "validated_artifact", evidence: { runId: s.run_id, artifactId: s.deliverable.id }, earnedAt });
    }
  }
  const byDomain = new Map<string, (typeof agentDomainWork.$inferInsert)[]>();
  for (const w of domainWork) byDomain.set(JSON.stringify([w.agentName, w.domain]), [...(byDomain.get(JSON.stringify([w.agentName, w.domain])) ?? []), w]);
  for (const work of byDomain.values()) {
    if (work.length < SEASONED_MIN_RUNS) continue;
    const nth = work[SEASONED_MIN_RUNS - 1]!;
    achieve({ agentName: nth.agentName, achievement: `seasoned:${nth.domain}`, evidence: { runIds: work.slice(0, SEASONED_MIN_RUNS).map((w) => w.runId) }, earnedAt: nth.earnedAt });
  }

  const endorsements = await endorsementsFromInvocations(tx);

  if (awards.size > 0) await tx.insert(agentXpAwards).values([...awards.values()]);
  if (achievements.size > 0) await tx.insert(agentAchievements).values([...achievements.values()]);
  if (domainWork.length > 0) await tx.insert(agentDomainWork).values(domainWork);
  if (endorsements.length > 0) await tx.insert(agentEndorsements).values(endorsements);
}

/**
 * Every completed `peer.endorse` Invocation, proven again from the record rather than trusted:
 * the endorsing Run's compiled context held the artifact with that exact hash, the artifact is a
 * deliverable, and another agent produced it. An agent endorsing the same artifact twice counts
 * once. A pair of agents endorsing each other is marked `mutual`.
 */
async function endorsementsFromInvocations(tx: DrizzleTransaction): Promise<(typeof agentEndorsements.$inferInsert)[]> {
  const found = await rows<{
    invocation_id: string;
    endorser_run_id: string;
    endorser_name: string | null;
    artifact_id: string | null;
    artifact_hash: string | null;
    snapshot_run_id: string | null;
    stored_hash: string | null;
    artifact_type: string | null;
    endorsed_name: string | null;
    in_context: boolean;
    recorded_at: Date;
  }>(
    tx,
    sql`
    SELECT
      i.id AS invocation_id, i.run_id AS endorser_run_id, ead.name AS endorser_name,
      i.proposed_action_snapshot->>'artifactId' AS artifact_id,
      i.proposed_action_snapshot->>'artifactHash' AS artifact_hash,
      i.proposed_action_snapshot->>'endorserRunId' AS snapshot_run_id,
      a.hash AS stored_hash, a.type AS artifact_type, pad.name AS endorsed_name,
      EXISTS (
        SELECT 1 FROM events cc WHERE cc.run_id = i.run_id AND cc.event_type = 'context_compiled'
          AND cc.payload->'included' @> jsonb_build_array(jsonb_build_object('id', i.proposed_action_snapshot->>'artifactId', 'hash', i.proposed_action_snapshot->>'artifactHash'))
      ) AS in_context,
      COALESCE(i.completed_at, i.started_at) AS recorded_at
    FROM invocations i
    JOIN capabilities c ON c.id = i.capability_id AND c.name = ${ENDORSEMENT_CAPABILITY_NAME}
    JOIN runs er ON er.id = i.run_id
    LEFT JOIN agent_definitions ead ON ead.id = er.agent_definition_id
    LEFT JOIN artifacts a ON a.id::text = i.proposed_action_snapshot->>'artifactId'
    LEFT JOIN invocations pi ON pi.id = a.producing_invocation_id
    LEFT JOIN runs pr ON pr.id = pi.run_id
    LEFT JOIN agent_definitions pad ON pad.id = pr.agent_definition_id
    WHERE i.status = 'completed'
    ORDER BY recorded_at, i.id
  `
  );

  const seen = new Set<string>();
  const out = found
    .filter((f) => f.endorser_name && f.artifact_id && f.artifact_hash)
    .map((f) => {
      const excludedReason =
        f.snapshot_run_id !== f.endorser_run_id
          ? "run_mismatch"
          : f.stored_hash === null
            ? "artifact_not_found"
            : f.stored_hash !== f.artifact_hash
              ? "hash_mismatch"
              : f.artifact_type !== "deliverable"
                ? "not_a_deliverable"
                : !f.in_context
                  ? "not_in_context"
                  : !f.endorsed_name || f.endorsed_name === f.endorser_name
                    ? "same_lineage"
                    : seen.has(JSON.stringify([f.endorser_name, f.artifact_id]))
                      ? "duplicate"
                      : null;
      if (excludedReason === null) seen.add(JSON.stringify([f.endorser_name, f.artifact_id]));
      return {
        invocationId: f.invocation_id,
        endorserName: f.endorser_name!,
        endorserRunId: f.endorser_run_id,
        endorsedName: f.endorsed_name,
        artifactId: f.artifact_id!,
        artifactHash: f.artifact_hash!,
        verified: excludedReason === null,
        mutual: false,
        excludedReason,
        recordedAt: at(f.recorded_at),
      };
    });
  const pairs = new Set(out.filter((e) => e.verified).map((e) => JSON.stringify([e.endorserName, e.endorsedName])));
  for (const e of out) e.mutual = e.verified && pairs.has(JSON.stringify([e.endorsedName, e.endorserName]));
  return out;
}
