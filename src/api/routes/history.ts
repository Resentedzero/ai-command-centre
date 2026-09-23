/**
 * Work history and archive (plan §13).
 *
 *   GET  /history?lifecycle=&archived=&from=&to=&agent=&workflow=&q=  — Goals with their work, filtered, newest first
 *   POST /goals/:id/archive                                           — move a finished Goal out of current work
 *   POST /goals/:id/unarchive                                         — bring it back
 *   GET  /history/workflow-runs?status=&archived=&from=&to=&workflow=&q=  — Workflow Runs, flat, newest first
 *   POST /history/archive  { finishedBeforeHours, dryRun, expectedCount } — archive every finished Goal idle that long
 *
 * CURRENT VS HISTORY. `GET /goals` and `GET /workflow-runs` take `?within=<hours>`: current work is
 * what is unfinished, or finished within that window; everything older is history without anyone
 * archiving it. Nothing is hidden or changed by the window — it is a read filter, and History shows all.
 *
 * BULK ARCHIVE. One operator action archives every finished (completed or failed), unarchived Goal
 * whose last activity is older than the cutoff, each with its own `goal_archived` event. A dry run
 * returns the count; the real call must repeat that count (`expectedCount`) or it is refused (409),
 * so it never archives more than the operator saw. Nothing is archived automatically.
 *
 * ARCHIVE IS NOT DELETION. Archiving sets `goals.archived_at` and records one `goal_archived` event
 * (unarchive: `goal_unarchived`). The Goal, its Workflow Runs, Task Instances, Runs, Invocations,
 * Events, Artifacts, approvals, costs and progression stay exactly as recorded and reachable by
 * their links; `GET /goals` and `GET /workflow-runs` only leave archived work out of the current
 * lists unless asked (`?archived=include`). Only a finished Goal (completed or failed) can be
 * archived: work in progress stays current.
 *
 * LIFECYCLE, AS RECORDED. The runtime's Goal statuses are active, completed and failed. Shown with
 * what the records add: `awaiting_approval` (a Run waits on an approval), `paused` (its latest Workflow
 * Run is paused), `stopped` (failed because an emergency stop halted a Run), and archived. There is no
 * draft (a Goal starts its work when created) and no cancellation in the runtime; neither is invented.
 */
import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, sql, type SQL } from "drizzle-orm";
import type { ApiDeps } from "../server.js";
import { isUuid } from "../requestGuards.js";
import { agentDefinitions, events, goals, projects, runs, taskInstances, workflowDefinitions, workflowRuns } from "../../db/schema.js";
import { emitLifecycleEvent, NO_CORRELATION } from "../../events/lifecycle.js";
import { relayCommittedEvent } from "../liveEventRelay.js";
import { V1_RESOLUTION_ACTOR } from "./approvals.js";

const HISTORY_LIMIT = 200;
/** With a lifecycle filter (derived in memory) this many newest goals are examined; beyond it the response says it is capped. */
const SCAN_LIMIT = HISTORY_LIMIT * 5;
export const LIFECYCLES = ["active", "awaiting_approval", "paused", "completed", "failed", "stopped"] as const;
/** The longest current-work window accepted (one year), in hours. */
export const MAX_WINDOW_HOURS = 24 * 365;

/** Parses `within` / `finishedBeforeHours`: a whole number of hours, 0 to a year. Undefined when absent. */
export function parseHours(value: unknown): number | undefined | "invalid" {
  if (value === undefined || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n >= 0 && n <= MAX_WINDOW_HOURS ? n : "invalid";
}

type GoalColumns = { id: typeof goals.id; status: typeof goals.status; createdAt: typeof goals.createdAt };

/** A Goal's last activity: the latest its Workflow Runs finished or started, else when it was created. */
const goalLastActivity = (g: GoalColumns) =>
  sql`GREATEST(${g.createdAt}, COALESCE((SELECT MAX(COALESCE(wr.completed_at, wr.created_at)) FROM workflow_runs wr WHERE wr.goal_id = ${g.id}), ${g.createdAt}))`;

/** Current work for `GET /goals`: unfinished, or active within the window. Pass the query's own columns. */
export function currentGoalSql(hours: number, g: GoalColumns = goals): SQL {
  const cutoff = new Date(Date.now() - hours * 3_600_000);
  return sql`(${g.status} = 'active' OR ${goalLastActivity(g)} >= ${cutoff})`;
}

/** "Stopped" only when the goal's last failed Run was the one an emergency stop halted, not merely any Run ever halted. */
function lastFailedWasHalted(stepRuns: { id: string; status: string; outcome: Record<string, unknown> | null; completedAt: Date | null }[], halted: Set<string | null>): boolean {
  const failed = stepRuns.filter((r) => r.status === "failed").sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0));
  const last = failed[0];
  return last !== undefined && (halted.has(last.id) || last.outcome?.reason === "execution_stopped");
}

export function registerHistoryRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get<{ Querystring: Record<string, string | undefined> }>("/history", async (request, reply) => {
    const { lifecycle, archived = "include", from, to, agent, workflow, q } = request.query;
    if (lifecycle !== undefined && !(LIFECYCLES as readonly string[]).includes(lifecycle)) return reply.status(400).send({ error: `lifecycle must be one of ${LIFECYCLES.join(", ")}` });
    if (!["include", "only", "exclude"].includes(archived)) return reply.status(400).send({ error: "archived must be include, only or exclude" });
    const date = (v: string | undefined, name: string) => {
      if (v === undefined || v === "") return null;
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) throw new Error(`${name} must be a date`);
      return d;
    };
    let fromDate: Date | null;
    let toDate: Date | null;
    try {
      fromDate = date(from, "from");
      toDate = date(to, "to");
    } catch (e) {
      return reply.status(400).send({ error: (e as Error).message });
    }
    if (q !== undefined && q.length > 200) return reply.status(400).send({ error: "q must be at most 200 characters" });

    const where: SQL[] = [];
    if (archived === "only") where.push(isNotNull(goals.archivedAt));
    if (archived === "exclude") where.push(isNull(goals.archivedAt));
    if (fromDate) where.push(gte(goals.createdAt, fromDate));
    if (toDate) where.push(lte(goals.createdAt, toDate));
    if (q?.trim()) where.push(ilike(goals.title, `%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`));
    if (agent?.trim()) {
      where.push(sql`EXISTS (SELECT 1 FROM ${workflowRuns} wr JOIN ${taskInstances} ti ON ti.workflow_run_id = wr.id JOIN ${runs} r ON r.task_instance_id = ti.id
        JOIN ${agentDefinitions} ad ON ad.id = r.agent_definition_id WHERE wr.goal_id = ${goals.id} AND ad.name = ${agent.trim()})`);
    }
    if (workflow?.trim()) {
      where.push(sql`EXISTS (SELECT 1 FROM ${workflowRuns} wr JOIN ${workflowDefinitions} wd ON wd.id = wr.workflow_definition_id WHERE wr.goal_id = ${goals.id} AND wd.name = ${workflow.trim()})`);
    }

    const goalRows = await deps.db
      .select({ goal: goals, project: projects.name })
      .from(goals)
      .innerJoin(projects, eq(projects.id, goals.projectId))
      .where(where.length > 0 ? and(...where) : undefined)
      .orderBy(desc(goals.createdAt))
      .limit(lifecycle ? SCAN_LIMIT + 1 : HISTORY_LIMIT + 1);

    const ids = goalRows.map((g) => g.goal.id);
    const wrRows = ids.length
      ? await deps.db
          .select({ wr: workflowRuns, name: workflowDefinitions.name, version: workflowDefinitions.version })
          .from(workflowRuns)
          .leftJoin(workflowDefinitions, eq(workflowDefinitions.id, workflowRuns.workflowDefinitionId))
          .where(inArray(workflowRuns.goalId, ids))
          .orderBy(desc(workflowRuns.createdAt))
      : [];
    const wrIds = wrRows.map((r) => r.wr.id);
    const runRows = wrIds.length
      ? await deps.db
          .select({ id: runs.id, status: runs.status, outcome: runs.outcome, completedAt: runs.completedAt, wr: taskInstances.workflowRunId, agent: agentDefinitions.name })
          .from(runs)
          .innerJoin(taskInstances, eq(taskInstances.id, runs.taskInstanceId))
          .leftJoin(agentDefinitions, eq(agentDefinitions.id, runs.agentDefinitionId))
          .where(inArray(taskInstances.workflowRunId, wrIds))
      : [];
    const halted = new Set(
      runRows.length
        ? (await deps.db.select({ runId: events.runId }).from(events).where(and(eq(events.eventType, "run_halted"), inArray(events.runId, runRows.map((r) => r.id))))).map((e) => e.runId)
        : []
    );

    const items = goalRows.map(({ goal, project }) => {
      const workRuns = wrRows.filter((r) => r.wr.goalId === goal.id);
      const stepRuns = runRows.filter((r) => workRuns.some((w) => w.wr.id === r.wr));
      const derived =
        goal.status === "active"
          ? stepRuns.some((r) => r.status === "awaiting_approval")
            ? "awaiting_approval"
            : workRuns[0]?.wr.status === "paused"
              ? "paused"
              : "active"
          : goal.status === "failed" && lastFailedWasHalted(stepRuns, halted)
            ? "stopped"
            : goal.status;
      return {
        id: goal.id,
        title: goal.title,
        project,
        status: goal.status,
        lifecycle: derived,
        createdAt: goal.createdAt,
        archivedAt: goal.archivedAt,
        archivedBy: goal.archivedBy,
        agents: [...new Set(stepRuns.map((r) => r.agent).filter((a): a is string => a !== null))].sort(),
        workflowRuns: workRuns.map((w) => ({ id: w.wr.id, status: w.wr.status, createdAt: w.wr.createdAt, completedAt: w.wr.completedAt, workflow: w.name ? `${w.name} v${w.version}` : null })),
      };
    });
    const matching = lifecycle ? items.filter((i) => i.lifecycle === lifecycle) : items;
    const filtered = matching.slice(0, HISTORY_LIMIT);

    const [agentNames, workflowNames] = await Promise.all([
      deps.db.selectDistinct({ name: agentDefinitions.name }).from(agentDefinitions).orderBy(agentDefinitions.name),
      deps.db.selectDistinct({ name: workflowDefinitions.name }).from(workflowDefinitions).orderBy(workflowDefinitions.name),
    ]);
    return reply.send({
      goals: filtered,
      capped: matching.length > HISTORY_LIMIT || (lifecycle !== undefined && goalRows.length > SCAN_LIMIT),
      limit: HISTORY_LIMIT,
      filters: { lifecycles: LIFECYCLES, agents: agentNames.map((a) => a.name), workflows: workflowNames.map((w) => w.name) },
    });
  });

  app.get<{ Querystring: Record<string, string | undefined> }>("/history/workflow-runs", async (request, reply) => {
    const { status, archived = "include", from, to, workflow, q } = request.query;
    const STATUSES = ["in_progress", "paused", "completed", "failed"];
    if (status !== undefined && !STATUSES.includes(status)) return reply.status(400).send({ error: `status must be one of ${STATUSES.join(", ")}` });
    if (!["include", "only", "exclude"].includes(archived)) return reply.status(400).send({ error: "archived must be include, only or exclude" });
    const fromDate = from ? new Date(from) : null;
    const toDate = to ? new Date(to) : null;
    if ((fromDate && Number.isNaN(fromDate.getTime())) || (toDate && Number.isNaN(toDate.getTime()))) return reply.status(400).send({ error: "from and to must be dates" });
    if (q !== undefined && q.length > 200) return reply.status(400).send({ error: "q must be at most 200 characters" });
    const where: SQL[] = [];
    if (status) where.push(eq(workflowRuns.status, status));
    if (archived === "only") where.push(isNotNull(goals.archivedAt));
    if (archived === "exclude") where.push(isNull(goals.archivedAt));
    if (fromDate) where.push(gte(workflowRuns.createdAt, fromDate));
    if (toDate) where.push(lte(workflowRuns.createdAt, toDate));
    if (workflow?.trim()) where.push(eq(workflowDefinitions.name, workflow.trim()));
    if (q?.trim()) where.push(ilike(goals.title, `%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`));
    const rows = await deps.db
      .select({ wr: workflowRuns, goalTitle: goals.title, goalArchivedAt: goals.archivedAt, name: workflowDefinitions.name, version: workflowDefinitions.version })
      .from(workflowRuns)
      .innerJoin(goals, eq(goals.id, workflowRuns.goalId))
      .leftJoin(workflowDefinitions, and(eq(workflowDefinitions.id, workflowRuns.workflowDefinitionId), eq(workflowDefinitions.version, workflowRuns.workflowDefinitionVersion)))
      .where(where.length > 0 ? and(...where) : undefined)
      .orderBy(desc(workflowRuns.createdAt))
      .limit(HISTORY_LIMIT + 1);
    return reply.send({
      workflowRuns: rows.slice(0, HISTORY_LIMIT).map((r) => ({
        id: r.wr.id,
        status: r.wr.status,
        createdAt: r.wr.createdAt,
        completedAt: r.wr.completedAt,
        goal: { id: r.wr.goalId, title: r.goalTitle, archivedAt: r.goalArchivedAt },
        workflow: r.name ? `${r.name} v${r.version}` : null,
      })),
      capped: rows.length > HISTORY_LIMIT,
      limit: HISTORY_LIMIT,
    });
  });

  app.post<{ Body: { finishedBeforeHours?: unknown; dryRun?: unknown; expectedCount?: unknown } }>("/history/archive", async (request, reply) => {
    const body = request.body ?? {};
    const hours = parseHours(body.finishedBeforeHours);
    if (hours === undefined || hours === "invalid") return reply.status(400).send({ error: `finishedBeforeHours must be a whole number of hours from 0 to ${MAX_WINDOW_HOURS}` });
    const dryRun = body.dryRun !== false;
    if (!dryRun && !(Number.isInteger(body.expectedCount) && (body.expectedCount as number) >= 0)) return reply.status(400).send({ error: "expectedCount (from the dry run) is required to archive" });
    const cutoff = new Date(Date.now() - hours * 3_600_000);
    const result = await deps.db.transaction(async (tx) => {
      const eligible = await tx
        .select({ id: goals.id, title: goals.title, status: goals.status })
        .from(goals)
        .where(and(isNull(goals.archivedAt), inArray(goals.status, ["completed", "failed"]), sql`${goalLastActivity(goals)} < ${cutoff}`))
        .for("update");
      if (dryRun) return { status: 200 as const, count: eligible.length, keys: [] as string[] };
      if (eligible.length !== body.expectedCount) return { status: 409 as const, count: eligible.length, keys: [] as string[] };
      const now = new Date();
      const keys: string[] = [];
      if (eligible.length > 0) {
        await tx.update(goals).set({ archivedAt: now, archivedBy: V1_RESOLUTION_ACTOR }).where(inArray(goals.id, eligible.map((g) => g.id)));
      }
      for (const goal of eligible) {
        const key = `goal_archived:${goal.id}:${now.getTime()}`;
        await emitLifecycleEvent(tx, {
          eventType: "goal_archived",
          subjectId: goal.id,
          idempotencyKey: key,
          correlation: { ...NO_CORRELATION, goalId: goal.id },
          producer: "api",
          actor: V1_RESOLUTION_ACTOR,
          payload: { title: goal.title, status: goal.status, bulk: true, finishedBeforeHours: hours },
        });
        keys.push(key);
      }
      return { status: 200 as const, count: eligible.length, keys };
    });
    if (result.status === 409) return reply.status(409).send({ error: `The number of goals to archive changed to ${result.count}; check again before archiving.`, count: result.count });
    for (const key of result.keys) await relayCommittedEvent(deps.db, key);
    return reply.send({ dryRun, count: result.count, finishedBeforeHours: hours });
  });

  for (const action of ["archive", "unarchive"] as const) {
    app.post<{ Params: { id: string } }>(`/goals/:id/${action}`, async (request, reply) => {
      const id = request.params.id;
      if (!isUuid(id)) return reply.status(400).send({ error: "goal id must be a UUID" });
      const eventType = action === "archive" ? "goal_archived" : "goal_unarchived";
      const result = await deps.db.transaction(async (tx) => {
        const goal = await tx.query.goals.findFirst({ where: eq(goals.id, id) });
        if (!goal) return { status: 404 as const, error: `No goal found for id "${id}"` };
        if (action === "archive" && goal.status === "active") return { status: 409 as const, error: "Work in progress cannot be archived; archive it once it has completed or failed." };
        if (action === "archive" ? goal.archivedAt !== null : goal.archivedAt === null) return { status: 409 as const, error: action === "archive" ? "This goal is already archived." : "This goal is not archived." };
        const now = new Date();
        const [row] = await tx
          .update(goals)
          .set(action === "archive" ? { archivedAt: now, archivedBy: V1_RESOLUTION_ACTOR } : { archivedAt: null, archivedBy: null })
          .where(eq(goals.id, id))
          .returning();
        const key = `${eventType}:${id}:${now.getTime()}`;
        await emitLifecycleEvent(tx, {
          eventType,
          subjectId: id,
          idempotencyKey: key,
          correlation: { ...NO_CORRELATION, goalId: id },
          producer: "api",
          actor: V1_RESOLUTION_ACTOR,
          payload: { title: goal.title, status: goal.status },
        });
        return { status: 200 as const, goal: row!, key };
      });
      if ("error" in result) return reply.status(result.status).send({ error: result.error });
      await relayCommittedEvent(deps.db, result.key);
      return reply.send({ id: result.goal.id, archivedAt: result.goal.archivedAt, archivedBy: result.goal.archivedBy });
    });
  }
}
