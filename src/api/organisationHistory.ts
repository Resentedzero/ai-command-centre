/**
 * What the Keep DID (R2 Stage 9) — bounded, provenance-carrying organisational history.
 *
 * The Keep already knows what is true NOW (`agentState.ts`). This answers the other question: what was
 * true before, and why. It is a READ MODEL, not a store: there is no history table, no projection to
 * rebuild and nothing to fall out of step, because every record here is composed on demand from the
 * authoritative rows and the immutable event log. Deleting this file would lose no fact.
 *
 * FOUR THINGS KEPT APART (the brief's distinction, made structural):
 *   STATE       `agentState.ts`      — what is true now.
 *   HISTORY     this module          — what was true, with the ids to prove it.
 *   EXPLANATION `keeper/`            — why the Keep says so, in words, with its sources.
 *   ACTION      governed capabilities — what may actually be done about it.
 *
 * FACT, CALCULATION, UNKNOWN. Every record carries `basis`:
 *   "recorded"   — a row or event says so (a Run failed; a decision was recorded).
 *   "calculated" — code derived it from records and the clock (a goal is overdue; a follow-up is still
 *                  outstanding). Reproducible, never guessed.
 *   Absent evidence is reported as absent. Nothing here fills a gap with a plausible sentence, and no
 *   model is called: this module is pure reading.
 *
 * BOUNDED BY CONSTRUCTION. Every entry point takes an explicit window and limit, both clamped
 * (`WINDOW`). There is no "everything since the beginning" query, and no free-text filter — relevance is
 * a fixed chain of keys (goal, agent, meeting), never a similarity search. Postgres is authoritative; no
 * embedding, no vector store.
 *
 * FACTS, NOT BODIES. History returns ids, hashes, statuses, reason codes and the short texts the runtime
 * itself stamped (a decision, a classified failure). It never returns an artifact's content. A caller who
 * needs a deliverable's body asks for the artifact by id, and it arrives through the Context Compiler
 * fenced as untrusted — which is what keeps model-written prose from quietly becoming a historical fact.
 */
import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import type { Database } from "../db/client.js";
import type { DrizzleTransaction } from "../events/emit.js";
import { agentDefinitions, artifacts, goals, invocations, projects, runs, taskDefinitions, taskInstances, workflowRuns } from "../db/schema.js";
import { decisionBehind, readMissionIn } from "./routes/manager.js";
import { listMeetings } from "../workplace/workplace.js";
import { MISSIONS_PROJECT_NAME } from "../definitions/seed.js";

/** Windows and sizes, all clamped. A caller may ask for less; it may never ask for more. */
export const WINDOW = Object.freeze({ defaultHours: 24 * 7, maxHours: 24 * 30, defaultLimit: 20, maxLimit: 50 });

export const clampHours = (h: unknown): number => {
  const n = typeof h === "number" && Number.isFinite(h) ? Math.floor(h) : WINDOW.defaultHours;
  return Math.min(Math.max(n, 1), WINDOW.maxHours);
};
export const clampLimit = (n: unknown): number => {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : WINDOW.defaultLimit;
  return Math.min(Math.max(v, 1), WINDOW.maxLimit);
};

/** Where a record came from. Never "the model said so". */
export type Basis = "recorded" | "calculated";

export type MissionSummary = {
  goalId: string;
  title: string;
  objective: string | null;
  status: string;
  basis: Basis;
  startedAt: string;
  finishedAt: string | null;
  dueAt: string | null;
  /** Calculated from the clock, exactly as the mission read model does it. */
  overdue: boolean;
  agents: string[];
  /** The classified reason codes this mission recorded, if any. */
  reasons: { code: string; detail: string }[];
  /** Deliverables produced, by id and hash — never their content. */
  deliverables: { artifactId: string; hash: string; agentName: string | null }[];
  /** The meeting decision this mission was started from, when it was. */
  fromDecision: { meetingId: string; text: string } | null;
};

export type MeetingRecord = {
  meetingId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  status: string;
  basis: Basis;
  participants: string[];
  /** Whether the Keep actually HELD it, and who could not attend if it did not. */
  held: boolean;
  notHeldReason: string | null;
  decisions: { index: number; text: string; actor: string; at: string }[];
  followUps: { goalId: string; text: string }[];
};

export type FollowUp = {
  meetingId: string;
  decision: string;
  goalId: string;
  goalTitle: string;
  goalStatus: string;
  /** Calculated: a follow-up is outstanding while its goal is neither completed nor archived. */
  outstanding: boolean;
  basis: Basis;
};

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const since = (hours: number, now: Date) => new Date(now.getTime() - hours * 3_600_000);

/** The Missions project, or null when the Keep has not been seeded. */
async function missionsProjectId(tx: DrizzleTransaction): Promise<string | null> {
  const row = await tx.query.projects.findFirst({ where: eq(projects.name, MISSIONS_PROJECT_NAME) });
  return row?.id ?? null;
}

/**
 * Recent missions, newest first. One summary each, composed from the SAME reader the mission route uses
 * (`readMissionIn`), so history and the live view can never tell different stories.
 */
export async function recentMissions(tx: DrizzleTransaction, opts: { hours?: number; limit?: number } = {}, now = new Date()): Promise<MissionSummary[]> {
  const hours = clampHours(opts.hours);
  const limit = clampLimit(opts.limit);
  const projectId = await missionsProjectId(tx);
  if (!projectId) return [];
  const rows = await tx
    .select({ id: goals.id })
    .from(goals)
    .where(and(eq(goals.projectId, projectId), gte(goals.createdAt, since(hours, now))))
    .orderBy(desc(goals.createdAt))
    .limit(limit);
  const out: MissionSummary[] = [];
  for (const { id } of rows) {
    const summary = await missionSummary(tx, id);
    if (summary) out.push(summary);
  }
  return out;
}

/** One mission's summary: statuses and ids the runtime recorded, plus what code calculated from them. */
export async function missionSummary(tx: DrizzleTransaction, goalId: string): Promise<MissionSummary | null> {
  const mission = await readMissionIn(tx as unknown as Database, goalId);
  if (!mission) return null;
  const finished = mission.workflowRuns.map((w) => w.completedAt).filter((d): d is Date => d instanceof Date);
  const deliverables = await deliverablesOf(tx, goalId);
  return {
    goalId,
    title: mission.goal.title,
    objective: mission.goal.objective ?? null,
    status: mission.status,
    basis: "recorded",
    startedAt: mission.goal.createdAt.toISOString(),
    finishedAt: finished.length > 0 ? iso(new Date(Math.max(...finished.map((d) => d.getTime())))) : null,
    dueAt: iso(mission.goal.dueAt),
    overdue: mission.goal.overdue,
    agents: [...new Set(mission.workflowRuns.flatMap((w) => w.steps.map((s) => s.agentName)).filter((n): n is string => typeof n === "string"))].sort(),
    reasons: mission.reasons.map((r) => ({ code: r.code, detail: r.detail })),
    deliverables,
    fromDecision: await decisionBehind(tx as unknown as Database, goalId),
  };
}

/** Deliverable artifacts of a goal: id, hash and who produced them. Never content. */
async function deliverablesOf(tx: DrizzleTransaction, goalId: string): Promise<{ artifactId: string; hash: string; agentName: string | null }[]> {
  const rows = await tx
    .select({ artifactId: artifacts.id, hash: artifacts.hash, agentName: agentDefinitions.name })
    .from(artifacts)
    .innerJoin(invocations, eq(invocations.id, artifacts.producingInvocationId))
    .innerJoin(runs, eq(runs.id, invocations.runId))
    .innerJoin(taskInstances, eq(taskInstances.id, runs.taskInstanceId))
    .innerJoin(workflowRuns, eq(workflowRuns.id, taskInstances.workflowRunId))
    .leftJoin(agentDefinitions, eq(agentDefinitions.id, runs.agentDefinitionId))
    .where(and(eq(workflowRuns.goalId, goalId), eq(artifacts.type, "deliverable")))
    .orderBy(asc(artifacts.createdAt))
    .limit(WINDOW.maxLimit);
  return rows;
}


/**
 * Recent meetings and what they produced. "Held" is the Stage 4 fact — a past end time is not attendance
 * — and a meeting nobody could attend keeps the reason it was not held.
 */
export async function meetingHistory(tx: DrizzleTransaction, opts: { hours?: number; limit?: number } = {}, now = new Date()): Promise<MeetingRecord[]> {
  const hours = clampHours(opts.hours);
  const limit = clampLimit(opts.limit);
  const meetings = await listMeetings(tx, { from: since(hours, now), to: now, includeCancelled: true }, now);
  return meetings.slice(-limit).reverse().map((m) => ({
    meetingId: m.id,
    title: m.title,
    startsAt: m.startsAt,
    endsAt: m.endsAt,
    status: m.status,
    basis: "recorded" as const,
    participants: m.participants.map((p) => p.agentName),
    held: m.convenedAt !== null,
    notHeldReason: m.notConvenedReason,
    // Decisions have no id of their own: their identity is the meeting plus their position in it.
    decisions: m.decisions.map((d, index) => ({ index, text: d.text, actor: d.actor, at: d.at })),
    followUps: m.actions.map((a) => ({ goalId: a.goalId, text: a.text })),
  }));
}

/**
 * Work started from a meeting decision that has not finished. "Outstanding" is CALCULATED: the decision
 * and the goal are recorded; whether it still counts as open is read off the goal's status now.
 */
export async function outstandingFollowUps(tx: DrizzleTransaction, opts: { hours?: number; limit?: number } = {}, now = new Date()): Promise<FollowUp[]> {
  const meetings = await meetingHistory(tx, { hours: clampHours(opts.hours), limit: WINDOW.maxLimit }, now);
  const pairs = meetings.flatMap((m) => m.followUps.map((f) => ({ meetingId: m.meetingId, decision: f.text, goalId: f.goalId })));
  if (pairs.length === 0) return [];
  const rows = await tx
    .select({ id: goals.id, title: goals.title, status: goals.status, archivedAt: goals.archivedAt })
    .from(goals)
    .where(inArray(goals.id, [...new Set(pairs.map((p) => p.goalId))]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return pairs
    .flatMap((p) => {
      const goal = byId.get(p.goalId);
      if (!goal) return [];
      return [
        {
          ...p,
          goalTitle: goal.title,
          goalStatus: goal.status,
          outstanding: goal.status !== "completed" && goal.archivedAt === null,
          basis: "calculated" as const,
        },
      ];
    })
    .slice(0, clampLimit(opts.limit));
}

export type AgentWork = {
  agentName: string;
  goalId: string | null;
  goalTitle: string | null;
  runId: string;
  taskKind: string | null;
  status: string;
  basis: Basis;
  startedAt: string;
  /** The classified reason, when the run failed. Read from the runtime, never written here. */
  failure: string | null;
};

/**
 * What one agent actually did recently. Scoped to that agent by key — never a scan of everyone's work,
 * which is what keeps one agent's history out of another's context.
 */
export async function agentWork(tx: DrizzleTransaction, agentName: string, opts: { hours?: number; limit?: number } = {}, now = new Date()): Promise<AgentWork[]> {
  const hours = clampHours(opts.hours);
  const limit = clampLimit(opts.limit);
  const ids = (await tx.select({ id: agentDefinitions.id }).from(agentDefinitions).where(eq(agentDefinitions.name, agentName))).map((a) => a.id);
  if (ids.length === 0) return [];
  const rows = await tx
    .select({
      runId: runs.id,
      status: runs.status,
      startedAt: runs.startedAt,
      outcome: runs.outcome,
      taskKind: taskDefinitions.kind,
      goalId: workflowRuns.goalId,
      goalTitle: goals.title,
    })
    .from(runs)
    .innerJoin(taskInstances, eq(taskInstances.id, runs.taskInstanceId))
    .leftJoin(taskDefinitions, eq(taskDefinitions.id, taskInstances.taskDefinitionId))
    .leftJoin(workflowRuns, eq(workflowRuns.id, taskInstances.workflowRunId))
    .leftJoin(goals, eq(goals.id, workflowRuns.goalId))
    .where(and(inArray(runs.agentDefinitionId, ids), gte(runs.startedAt, since(hours, now))))
    .orderBy(desc(runs.startedAt))
    .limit(limit);
  return rows.map((r) => ({
    agentName,
    goalId: r.goalId,
    goalTitle: r.goalTitle,
    runId: r.runId,
    taskKind: r.taskKind,
    status: r.status,
    basis: "recorded" as const,
    startedAt: r.startedAt.toISOString(),
    failure: r.status === "failed" ? String(((r.outcome ?? {}) as { reason?: unknown }).reason ?? "the run failed").slice(0, 200) : null,
  }));
}

/** Everything one bounded history request can answer. Each part is independently bounded. */
export type OrganisationHistory = {
  window: { hours: number; limit: number; now: string };
  missions: MissionSummary[];
  meetings: MeetingRecord[];
  followUps: FollowUp[];
};

/** The whole bounded picture, for the read API and the Manager's history capability. */
export async function organisationHistory(tx: DrizzleTransaction, opts: { hours?: number; limit?: number } = {}, now = new Date()): Promise<OrganisationHistory> {
  const hours = clampHours(opts.hours);
  const limit = clampLimit(opts.limit);
  return {
    window: { hours, limit, now: now.toISOString() },
    missions: await recentMissions(tx, { hours, limit }, now),
    meetings: await meetingHistory(tx, { hours, limit }, now),
    followUps: await outstandingFollowUps(tx, { hours, limit }, now),
  };
}

/** `organisationHistory` in its own read-only snapshot. */
export function readOrganisationHistory(db: Database, opts: { hours?: number; limit?: number } = {}, now = new Date()): Promise<OrganisationHistory> {
  return db.transaction((tx) => organisationHistory(tx as unknown as DrizzleTransaction, opts, now), { isolationLevel: "repeatable read", accessMode: "read only" });
}
