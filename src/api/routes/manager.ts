/**
 * Command: give the Manager an objective (R2 management layer).
 *
 *   POST /manager/missions            { objective }  — start a mission (202), or refuse (409) before any work exists
 *   GET  /manager/missions                           — recent missions, newest first
 *   GET  /manager/missions/:goalId                   — one mission, derived only from its records
 *
 * A mission is an ordinary Goal in the "Missions" Project whose first Workflow Run is the seeded "Manager
 * Plan" (the Manager's `manager_plan` step). The Manager delegates by starting further Workflow Runs on
 * the same Goal through its governed `manager.delegate` Capability; this route only drives those runs
 * after they are committed (nothing else would, until a restart). No model is called here, and nothing
 * the Manager wrote is taken as status: status comes from runs, approvals and code-written records.
 *
 * Refused before any work exists (409): the Manager or everything is stopped, or the Manager is already
 * running a mission (one at a time, serialised by an advisory lock).
 */
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { ApiDeps } from "../server.js";
import type { Database } from "../../db/client.js";
import { isUuid } from "../requestGuards.js";
import { agentDefinitions, approvals, artifacts, events, goals, invocations, runs, taskDefinitions, taskInstances, workflowDefinitions, workflowRuns } from "../../db/schema.js";
import { findManagerRefs } from "../../definitions/lookupSeed.js";
import { MISSION_LIMITS, MISSION_REASONS, type MissionReason } from "../../capabilities/manager/capability.js";
import { classifyRunFailure, diagnoseWorkflowRun } from "../../capabilities/manager/failure.js";
import type { DrizzleTransaction } from "../../events/emit.js";
import { emitLifecycleEvent } from "../../events/lifecycle.js";
import { startWorkflowRun } from "../../workflow/interpreter.js";
import { MANAGER_PLAN_WORKFLOW_NAME, MANAGER_RECOVERY_WORKFLOW_NAME } from "../../definitions/seed.js";
import { findActiveStops, GLOBAL_STOP_REF } from "../../governance/executionStop.js";
import { advanceWorkflowRunUntilBlocked } from "../../workflow/advanceWorkflowRunUntilBlocked.js";
import { buildInvocationSpecsFromDefinitions } from "../../workflow/buildInvocationSpecsFromDefinitions.js";
import { createWorkflowRelay } from "../liveEventRelay.js";
import { insertGoalWithWorkflowRun } from "./goals.js";

export const MAX_OBJECTIVE = 2_000;

type Refusal = { status: 400 | 409 | 503; body: Record<string, unknown> };

/** Starts a mission for an objective, or says why not. Shared by Command and by Talk to the Manager. */
export async function startMission(deps: ApiDeps, objective: string, dueAt: Date | null = null): Promise<Refusal | { goalId: string; workflowRunId: string; agent: { id: string; name: string; version: number } }> {
  const result = await deps.db.transaction(async (tx): Promise<Refusal | { goalId: string; workflowRunId: string; agent: { id: string; name: string; version: number } }> => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('manager:missions'))`);
    const refs = await findManagerRefs(tx);
    if (!refs) return { status: 503, body: { error: 'The Manager is not set up yet: run "npm run seed".' } };
    const stops = await findActiveStops(tx, [{ scope: "global", scopeRefId: GLOBAL_STOP_REF }, ...refs.agentVersionIds.map((id) => ({ scope: "agent_definition" as const, scopeRefId: id.toLowerCase() }))]);
    if (stops.length > 0) return { status: 409, body: { reason: "stopped", error: `The Manager is stopped (${stops[0]!.scope} stop${stops[0]!.reason ? `: ${stops[0]!.reason}` : ""}). Lift the stop before giving it an objective.` } };
    const [running] = await tx
      .select({ goalId: goals.id, title: goals.title })
      .from(workflowRuns)
      .innerJoin(goals, eq(goals.id, workflowRuns.goalId))
      .where(and(eq(goals.projectId, refs.projectId), inArray(workflowRuns.status, ["in_progress", "paused"])))
      .limit(1);
    if (running) return { status: 409, body: { reason: "busy", goalId: running.goalId, error: `The Manager is already running a mission ("${running.title}"). It runs one mission at a time.` } };
    const title = `Mission: ${objective.replace(/\s+/g, " ").slice(0, 80)}`;
    const started = await insertGoalWithWorkflowRun(tx, { title, description: objective, workflowDefinitionId: refs.planWorkflowDefinitionId, projectId: refs.projectId, dueAt });
    if ("error" in started) return { status: 400, body: { error: started.error } };
    return { ...started, agent: refs.agent };
  });
  if ("status" in result) return result;
  void driveMission(deps.db, result.goalId, result.workflowRunId);
  return result;
}

/**
 * Drives a mission in this process. The driver itself continues any Workflow Run a step starts on the
 * same Goal (`advanceWorkflowRunUntilBlocked`), so the delegated work and a follow-up run on; so do an
 * approval decision's re-drive and the startup re-drive, which use the same driver.
 */
/**
 * Whether a mission is owed a recovery round, decided from its records alone. Reads rows; writes nothing,
 * locks nothing — so the mission read model can ask the SAME question the trigger asks, and never call a
 * mission settled while the runtime is about to start work on it. `maybeStartRecovery` is this plus the
 * lock and the start.
 */
export async function pendingRecovery(
  tx: DrizzleTransaction,
  goalId: string
): Promise<{ failedWorkflowRunId: string; round: number; failures: { stepId: string | null; code: string; agentName: string | null }[] } | null> {
  {
    const goal = await tx.query.goals.findFirst({ where: eq(goals.id, goalId) });
    const refs = await findManagerRefs(tx);
    // Missions only. An ordinary Goal has no Manager, so nothing here may touch it.
    if (!goal || !refs || goal.projectId !== refs.projectId) return null;
    if ((Date.now() - goal.createdAt.getTime()) / 60_000 > MISSION_LIMITS.maxMissionMinutes) return null;

    const runsOnGoal = await tx
      .select({ id: workflowRuns.id, status: workflowRuns.status, name: workflowDefinitions.name })
      .from(workflowRuns)
      .innerJoin(workflowDefinitions, eq(workflowDefinitions.id, workflowRuns.workflowDefinitionId))
      .where(eq(workflowRuns.goalId, goalId))
      .orderBy(asc(workflowRuns.createdAt));
    if (runsOnGoal.some((r) => r.status === "in_progress" || r.status === "paused")) return null;
    if (runsOnGoal.length >= MISSION_LIMITS.maxWorkflowRuns + MISSION_LIMITS.maxRecoveryWorkflowRuns) return null;
    // One recovery round per mission: a second failure is the operator's to answer.
    const round = runsOnGoal.filter((r) => r.name === MANAGER_RECOVERY_WORKFLOW_NAME).length + 1;
    if (round > MISSION_LIMITS.maxRecoveryRounds) return null;
    // Only delegated work is recovered. A Manager step that failed — planning, review, a recovery — escalates.
    const lastFailed = runsOnGoal.filter((r) => r.status === "failed").at(-1);
    if (!lastFailed || lastFailed.name === MANAGER_PLAN_WORKFLOW_NAME || lastFailed.name === MANAGER_RECOVERY_WORKFLOW_NAME) return null;
    const failures = (await diagnoseWorkflowRun(tx, lastFailed.id)).failures;
    if (failures.length === 0) return null;
    // Nothing is retried in the face of an authority, money or stop failure — the runtime decides that, not a model.
    if (!failures.some((f) => f.allowedActions.some((a) => a !== "escalate"))) return null;

    const stops = await findActiveStops(tx, [{ scope: "global", scopeRefId: GLOBAL_STOP_REF }, ...refs.agentVersionIds.map((id) => ({ scope: "agent_definition" as const, scopeRefId: id.toLowerCase() }))]);
    if (stops.length > 0) return null;
    if (!(await tx.query.workflowDefinitions.findFirst({ where: eq(workflowDefinitions.name, MANAGER_RECOVERY_WORKFLOW_NAME) }))) return null;
    return { failedWorkflowRunId: lastFailed.id, round, failures: failures.map((f) => ({ stepId: f.stepId, code: f.code, agentName: f.agentName })) };
  }
}

export async function maybeStartRecovery(db: Database, goalId: string): Promise<string | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`manager:recovery:${goalId}`}))`);
    const owed = await pendingRecovery(tx as unknown as DrizzleTransaction, goalId);
    if (!owed) return null;
    const [recovery] = await tx.select().from(workflowDefinitions).where(eq(workflowDefinitions.name, MANAGER_RECOVERY_WORKFLOW_NAME)).orderBy(desc(workflowDefinitions.version)).limit(1);
    if (!recovery) return null;
    const started = await startWorkflowRun(tx as unknown as DrizzleTransaction, recovery.id, goalId);
    await emitLifecycleEvent(tx as unknown as DrizzleTransaction, {
      eventType: "manager_recovery_started",
      subjectId: goalId,
      idempotencyKey: `manager_recovery_started:${owed.failedWorkflowRunId}`,
      correlation: { goalId, workflowRunId: started.workflowRunId, taskInstanceId: null, runId: null, invocationId: null },
      producer: "manager",
      actor: "system",
      payload: { failedWorkflowRunId: owed.failedWorkflowRunId, round: owed.round, failures: owed.failures },
    });
    return started.workflowRunId;
  });
}

/** Drives one Workflow Run to its next block, relaying its events live. */
async function drive(db: Database, workflowRunId: string): Promise<void> {
  const relay = createWorkflowRelay(db);
  await relay.track(workflowRunId, { fresh: true });
  await relay.flush();
  await advanceWorkflowRunUntilBlocked(relay.runInTx, workflowRunId, buildInvocationSpecsFromDefinitions);
}

/**
 * Missions whose delegated work failed with nobody driving them: an approval decision resumed the work in
 * another request, or the process restarted mid-mission. Those paths are generic runtime code and know
 * nothing about missions, so this periodic sweep (`api/start.ts`) is what makes recovery hold for them
 * too. It starts nothing `maybeStartRecovery` would refuse, and looks no further back than a mission's own
 * time limit.
 */
export async function sweepMissionRecoveries(db: Database): Promise<string[]> {
  const refs = await db.transaction((tx) => findManagerRefs(tx));
  if (!refs) return [];
  const candidates = await db
    .selectDistinct({ goalId: workflowRuns.goalId })
    .from(workflowRuns)
    .innerJoin(goals, eq(goals.id, workflowRuns.goalId))
    .where(and(eq(goals.projectId, refs.projectId), eq(workflowRuns.status, "failed"), gte(goals.createdAt, new Date(Date.now() - MISSION_LIMITS.maxMissionMinutes * 60_000))));
  const started: string[] = [];
  for (const { goalId } of candidates) {
    if (!goalId) continue;
    const recoveryRunId = await maybeStartRecovery(db, goalId);
    if (!recoveryRunId) continue;
    started.push(recoveryRunId);
    await drive(db, recoveryRunId);
  }
  return started;
}

export async function driveMission(db: Database, goalId: string, firstWorkflowRunId: string): Promise<void> {
  try {
    await drive(db, firstWorkflowRunId);
    // Delegated work that failed gets one governed recovery round, when the mission's limits still allow it.
    const recoveryRunId = await maybeStartRecovery(db, goalId);
    if (recoveryRunId) await drive(db, recoveryRunId);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`Driving mission ${goalId} failed; POST /workflow-runs/${firstWorkflowRunId}/advance retries:`, error);
  }
}

// ---------------------------------------------------------------------------
// The mission read model: records only
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
type Reason = { code: MissionReason; detail: string; runId?: string };

const parse = (text: string | null | undefined): Json | null => {
  try {
    const v: unknown = JSON.parse(text ?? "null");
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
  } catch {
    return null;
  }
};
const isReason = (c: unknown): c is MissionReason => typeof c === "string" && (MISSION_REASONS as readonly string[]).includes(c);
const codedBlockers = (v: unknown): Reason[] =>
  (Array.isArray(v) ? v : []).flatMap((b) => (b && typeof b === "object" && isReason((b as Json).code) && typeof (b as Json).detail === "string" ? [{ code: (b as Json).code as MissionReason, detail: (b as Json).detail as string }] : []));

/** Trace events worth an operator's attention, in order: the Manager's decisions and every governance fact. */
/** The failure codes a recovery event names, for one trace line. */
const failureCodes = (v: unknown): string =>
  (Array.isArray(v) ? v : []).map((f) => String((f as Json)?.code ?? "")).filter(Boolean).join(", ") || "no classified failure";

/**
 * Whether this mission recovered, told only by the recovery's own events: the runtime started a round, and
 * the recovery step decided an action. A mission with no such events has no `recovery` at all.
 */
function recoveryOf(rows: { type: string; payload: unknown }[]): { round: number; failures: string[]; action: string | null } | null {
  const started = rows.filter((r) => r.type === "manager_recovery_started").at(-1);
  if (!started) return null;
  const p = (started.payload ?? {}) as Json;
  const decided = rows.filter((r) => r.type === "manager_recovery_decided").at(-1);
  const action = decided ? String(((decided.payload ?? {}) as Json).action ?? "") || null : null;
  return { round: Number(p.round ?? 1), failures: (Array.isArray(p.failures) ? p.failures : []).map((f) => String((f as Json)?.code ?? "")).filter(Boolean), action };
}

const TRACE_EVENTS = [
  "goal_created",
  "workflow_run_started",
  "manager_plan_validated",
  "manager_plan_rejected",
  "manager_work_delegated",
  "manager_review_decided",
  "manager_recovery_started",
  "manager_recovery_decided",
  "meeting_scheduled",
  "meeting_rescheduled",
  "meeting_cancelled",
  "policy_evaluated",
  "budget_denied",
  "approval_required",
  "approval_granted",
  "approval_rejected",
  "approval_expired",
  "run_halted",
  "invocation_failed",
  "run_failed",
  "workflow_run_completed",
  "workflow_run_failed",
  "goal_completed",
  "goal_failed",
];

/** Why a failed Run failed: the Manager's own classifier (`capabilities/manager/failure.ts`), so a mission's recovery and this read model say the same thing. */
async function classifyFailedRun(db: Database, run: typeof runs.$inferSelect, kind: string | null, agentName: string | null): Promise<Reason> {
  const { code, detail } = await classifyRunFailure(db as unknown as DrizzleTransaction, run, kind, agentName);
  return { code, detail, runId: run.id };
}

/**
 * A mission read from ONE snapshot. The goal, its runs, steps, approvals and events are read inside a
 * read-only repeatable-read transaction, so a commit landing between queries can never produce a status
 * that mixes before and after (e.g. runs already failed while the goal still reads active).
 */
export async function readMission(db: Database, goalId: string) {
  return db.transaction((tx) => readMissionIn(tx as unknown as Database, goalId), { isolationLevel: "repeatable read", accessMode: "read only" });
}

/**
 * One mission, reconstructed from its own records. Exported (R2 Stage 9) so organisational history
 * composes THIS reader rather than growing a second one that could disagree with it.
 */
/**
 * The meeting decision a mission was started from, if any (R2 Stage 13). `goals` carries no meeting
 * column, so the link is recovered from the event the runtime wrote when the follow-up began — which is
 * why that event carries the goal in its correlation. Shared with the organisational history read model
 * so the chain reads the same from either end.
 */
export async function decisionBehind(db: Database, goalId: string): Promise<{ meetingId: string; text: string } | null> {
  const [row] = await db
    .select({ payload: events.payload })
    .from(events)
    .where(and(eq(events.goalId, goalId), eq(events.eventType, "meeting_action_started")))
    .orderBy(asc(events.globalSeq))
    .limit(1);
  const p = (row?.payload ?? null) as { meetingId?: unknown; text?: unknown } | null;
  return p && typeof p.meetingId === "string" ? { meetingId: p.meetingId, text: typeof p.text === "string" ? p.text.slice(0, 400) : "" } : null;
}

export async function readMissionIn(db: Database, goalId: string) {
  const goal = await db.query.goals.findFirst({ where: eq(goals.id, goalId) });
  if (!goal) return null;
  const wrs = await db
    .select({ wr: workflowRuns, name: workflowDefinitions.name, version: workflowDefinitions.version })
    .from(workflowRuns)
    .leftJoin(workflowDefinitions, eq(workflowDefinitions.id, workflowRuns.workflowDefinitionId))
    .where(eq(workflowRuns.goalId, goalId))
    .orderBy(asc(workflowRuns.createdAt));

  const workflowRunsOut = [];
  let plan: Json | null = null;
  let report: (Json & { artifactId: string; body: string | null }) | null = null;
  const reasons: Reason[] = [];
  let awaitingApproval = false;
  let failingStopped = false;
  for (const { wr, name, version } of wrs) {
    const steps = [];
    const tis = await db
      .select({ ti: taskInstances, kind: taskDefinitions.kind })
      .from(taskInstances)
      .leftJoin(taskDefinitions, eq(taskDefinitions.id, taskInstances.taskDefinitionId))
      .where(eq(taskInstances.workflowRunId, wr.id))
      .orderBy(asc(taskInstances.createdAt));
    for (const { ti, kind } of tis) {
      const [run] = await db.select().from(runs).where(eq(runs.taskInstanceId, ti.id)).orderBy(desc(runs.startedAt)).limit(1);
      const agent = run?.agentDefinitionId ? await db.query.agentDefinitions.findFirst({ where: eq(agentDefinitions.id, run.agentDefinitionId) }) : undefined;
      const invs = run ? await db.select({ id: invocations.id }).from(invocations).where(eq(invocations.runId, run.id)) : [];
      const docs = invs.length ? await db.select().from(artifacts).where(and(inArray(artifacts.producingInvocationId, invs.map((i) => i.id)), eq(artifacts.type, "deliverable"))) : [];
      const doc = docs[0];
      const content = parse(doc?.inlineContent);
      // Mission records are read only from the step kinds whose code writes them.
      if (kind === "manager_plan" && content?.managerPlan) plan = { ...(content.managerPlan as Json), artifactId: doc!.id, summary: content.summary ?? null };
      if (kind === "manager_review" && content?.managerReport) report = { ...(content.managerReport as Json), artifactId: doc!.id, body: typeof content.body === "string" ? content.body : null };
      let failure: Reason | null = null;
      if (run?.status === "failed") {
        failure = await classifyFailedRun(db, run, kind, agent?.name ?? null);
        reasons.push(failure);
        if (failure.code === "emergency_stopped") failingStopped = true;
      }
      if (ti.status === "awaiting_approval") {
        awaitingApproval = true;
        reasons.push({ code: "approval_required", detail: `${agent?.name ?? "A step"} is waiting for your approval.`, ...(run ? { runId: run.id } : {}) });
      }
      steps.push({
        taskInstanceId: ti.id,
        kind,
        taskStatus: ti.status,
        agentName: agent?.name ?? null,
        runId: run?.id ?? null,
        runStatus: run?.status ?? null,
        failure: failure?.detail ?? null,
        failureCode: failure?.code ?? null,
        deliverableArtifactId: doc?.id ?? null,
        completion: content?.completion ?? null,
      });
    }
    workflowRunsOut.push({ id: wr.id, status: wr.status, workflow: name ? `${name} v${version}` : null, createdAt: wr.createdAt, completedAt: wr.completedAt, steps });
  }
  const pending = wrs.length
    ? await db
        .select({ id: approvals.id })
        .from(approvals)
        .innerJoin(invocations, eq(invocations.id, approvals.invocationId))
        .innerJoin(runs, eq(runs.id, invocations.runId))
        .innerJoin(taskInstances, eq(taskInstances.id, runs.taskInstanceId))
        .where(and(eq(approvals.status, "pending"), inArray(taskInstances.workflowRunId, wrs.map((w) => w.wr.id))))
    : [];

  const planStatus = plan?.status;
  if (planStatus === "plan_rejected" || planStatus === "escalated") {
    const coded = codedBlockers(plan!.blockers);
    // Records written before reason codes existed carry only their error text: the plan status still says which kind of refusal it was.
    const legacy = (Array.isArray(plan!.errors) ? plan!.errors : []).filter((e): e is string => typeof e === "string").map((detail) => ({ code: (planStatus === "escalated" ? "manager_escalated" : "validation_rejected") as MissionReason, detail }));
    reasons.push(...(coded.length > 0 ? coded : legacy));
  }
  const reportStatus = report?.status;
  if (reportStatus === "escalated") reasons.push(...codedBlockers(report!.blockers));
  // A mission whose delegated work failed is NOT settled while the runtime still owes it a recovery round:
  // between the run failing and the recovery starting, the mission would otherwise read "failed" for a
  // moment and then come back to life. It is still working — the Manager refuses a new mission meanwhile.
  const owedRecovery = (await pendingRecovery(db as unknown as DrizzleTransaction, goalId)) !== null;
  const unfinished = owedRecovery || wrs.some((w) => w.wr.status === "in_progress" || w.wr.status === "paused");
  // A Goal with any failed Workflow Run is derived failed, and stays so. That is the truth about the Goal,
  // but not about a mission that recovered: once a recovery ran and the work it delegated finished, the
  // failure is history. It stays visible in `steps`, in `reasons` and in `recovery` — it just no longer
  // decides the mission's status. A recovery that escalated is the last run on the goal, so this is false.
  const recovered =
    wrs.some((w) => w.name === MANAGER_RECOVERY_WORKFLOW_NAME && w.wr.status === "completed") &&
    wrs.at(-1)!.wr.status === "completed" &&
    wrs.at(-1)!.name !== MANAGER_RECOVERY_WORKFLOW_NAME;
  const status =
    pending.length > 0 || awaitingApproval
      ? "awaiting_approval"
      : wrs.some((w) => w.wr.status === "paused")
        ? "paused"
        : unfinished
          ? wrs.length <= 1
            ? "planning"
            : "working"
          : goal.status === "failed" && !recovered
            ? failingStopped
              ? "stopped"
              : "failed"
            : planStatus === "plan_rejected" || planStatus === "escalated" || reportStatus === "escalated"
              ? "escalated"
              : reportStatus === "completed" || (planStatus === "scheduled" || planStatus === "rescheduled" || planStatus === "cancelled")
                ? "completed"
                : "finished_without_report";

  const traceRows = await db
    .select({ seq: events.globalSeq, type: events.eventType, at: events.occurredAt, runId: events.runId, payload: events.payload, actor: events.actor })
    .from(events)
    .where(and(eq(events.goalId, goalId), inArray(events.eventType, TRACE_EVENTS)))
    .orderBy(asc(events.globalSeq))
    .limit(300);
  const trace = traceRows.map((e) => {
    const p = (e.payload ?? {}) as Json;
    const summary =
      e.type === "policy_evaluated"
        ? `${String(p.decision)} (${String(p.basis)})`
        : e.type === "budget_denied"
          ? `${String(p.requestedAmount)} ${String(p.resourceUnit)} refused on the ${String(((p.deniedCounter ?? {}) as Json).scope)} counter`
          : e.type === "invocation_failed"
            ? [p.reason, p.errorCode].filter((x) => typeof x === "string").join(" · ").slice(0, 300)
            : e.type === "run_halted"
              ? `stopped (${String(p.stopScope)})`
              : e.type === "manager_plan_validated"
                ? p.meeting
                  ? `meeting ${String((p.meeting as Json).action)} accepted: ${String((p.meeting as Json).title)} in ${String((p.meeting as Json).roomName ?? "its room")}`
                  : `${Array.isArray(p.tasks) ? p.tasks.length : 0} task(s) accepted`
                : e.type === "manager_plan_rejected"
                  ? codedBlockers(p.blockers).map((b) => b.code).join(", ") || "rejected"
                  : e.type === "manager_work_delegated"
                    ? `${Array.isArray(p.agents) ? p.agents.join(", ") : ""} · round ${String(p.round)}${p.reusedWorkflowDefinition ? " · workflow reused" : ""}`
                    : e.type === "manager_review_decided"
                      ? `${String(p.decision)} · ${String(p.verified)}/${String(p.tasks)} verified${codedBlockers(p.blockers).length ? ` · ${codedBlockers(p.blockers).map((b) => b.code).join(", ")}` : ""}`
                      : e.type === "meeting_scheduled" || e.type === "meeting_rescheduled"
                        ? `${String(p.title)} · ${String(p.startsAt)} in ${String(p.roomName)} · ${Array.isArray(p.participants) ? p.participants.length : 0} participant(s)`
                        : e.type === "meeting_cancelled"
                          ? `${String(p.title)} cancelled`
                          : e.type === "manager_recovery_started"
                            ? `round ${String(p.round)} · ${failureCodes(p.failures)}`
                            : e.type === "manager_recovery_decided"
                              ? `${String(p.action)} · ${failureCodes(p.failures)}${codedBlockers(p.blockers).length ? ` · ${codedBlockers(p.blockers).map((b) => b.code).join(", ")}` : ""}`
                              : "";
    return { seq: e.seq, type: e.type, at: e.at, runId: e.runId, actor: e.actor, summary };
  });

  const recovery = recoveryOf(traceRows);
  // The decision this mission answers, when it answers one: the operator can walk back to the meeting.
  const fromDecision = await decisionBehind(db, goalId);
  const unique = reasons.filter((r, i) => reasons.findIndex((x) => x.code === r.code && x.detail === r.detail) === i);
  return {
    recovery,
    fromDecision,
    goal: {
      id: goal.id,
      title: goal.title,
      objective: goal.description,
      status: goal.status,
      createdAt: goal.createdAt,
      dueAt: goal.dueAt,
      // Derived from the clock, like a meeting's status. A mission is never failed for being late: the
      // operator decides what an overdue objective is worth.
      overdue: goal.dueAt !== null && goal.dueAt.getTime() < Date.now() && !["completed"].includes(status),
    },
    status,
    /** The first authoritative reason for a blocked, escalated, stopped or failed mission; null otherwise. */
    reason: ["completed", "planning", "working"].includes(status) ? null : (unique[0]?.code ?? null),
    reasons: unique,
    plan,
    report,
    workflowRuns: workflowRunsOut,
    pendingApprovals: pending.map((p) => p.id),
    blockers: unique.map((r) => r.detail),
    trace,
  };
}

export function registerManagerRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.post("/manager/missions", async (request, reply) => {
    const body = request.body;
    if (body === null || typeof body !== "object" || Array.isArray(body)) return reply.status(400).send({ error: "The request body must be a JSON object." });
    const unknown = Object.keys(body).filter((k) => k !== "objective" && k !== "dueAt");
    if (unknown.length > 0) return reply.status(400).send({ error: `unknown field(s): ${unknown.join(", ")}. A mission carries an objective and, if the operator sets one, a dueAt.` });
    const objective = (body as { objective?: unknown }).objective;
    if (typeof objective !== "string" || objective.trim() === "" || objective.length > MAX_OBJECTIVE) return reply.status(400).send({ error: `objective must be 1 to ${MAX_OBJECTIVE} characters` });
    // A deadline is the operator's, never the Manager's: only this route sets one, and only in the future.
    const rawDue = (body as { dueAt?: unknown }).dueAt;
    let dueAt: Date | null = null;
    if (rawDue !== undefined && rawDue !== null) {
      if (typeof rawDue !== "string" || Number.isNaN(Date.parse(rawDue))) return reply.status(400).send({ error: "dueAt must be an ISO 8601 date-time." });
      dueAt = new Date(rawDue);
      if (dueAt.getTime() <= Date.now()) return reply.status(400).send({ error: "dueAt must be in the future." });
    }
    const started = await startMission(deps, objective.trim(), dueAt);
    if ("status" in started) return reply.status(started.status).send(started.body);
    return reply.status(202).send({ ...started, status: "planning" });
  });

  app.get("/manager/missions", async (_request, reply) => {
    const refs = await deps.db.transaction((tx) => findManagerRefs(tx), { accessMode: "read only" });
    if (!refs) return reply.send({ missions: [], manager: null });
    const rows = await deps.db.select().from(goals).where(and(eq(goals.projectId, refs.projectId), isNull(goals.archivedAt))).orderBy(desc(goals.createdAt)).limit(30);
    const missions = [];
    for (const g of rows) {
      const m = await readMission(deps.db, g.id);
      if (m) missions.push({ goal: m.goal, status: m.status, blockers: m.blockers.length });
    }
    return reply.send({ missions, manager: refs.agent });
  });

  app.get<{ Params: { goalId: string } }>("/manager/missions/:goalId", async (request, reply) => {
    if (!isUuid(request.params.goalId)) return reply.status(400).send({ error: "goal id must be a UUID" });
    const refs = await deps.db.transaction((tx) => findManagerRefs(tx), { accessMode: "read only" });
    const goal = await deps.db.query.goals.findFirst({ where: eq(goals.id, request.params.goalId) });
    if (!goal || !refs || goal.projectId !== refs.projectId) return reply.status(404).send({ error: "No mission found for that id." });
    return reply.send(await readMission(deps.db, goal.id));
  });
}

