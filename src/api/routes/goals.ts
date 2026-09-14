/**
 * `POST /goals` — creates a Goal in a Project, starts a Workflow Run of a
 * Workflow Definition, then drives it as far as automatically possible (bounded
 * by its own step count) through `../../workflow/advanceWorkflowRunUntilBlocked.ts`
 * — see `../server.ts`'s header.
 *
 * `workflowDefinitionId` and `projectId` are optional (2026-09-14, additive):
 * each defaults to the seed's Workflow Definition / fixture Project
 * (`../../definitions/lookupSeed.ts`). A request naming both needs no seed.
 *
 * Thin pass-through: the only orchestration functions this handler calls are
 * `startWorkflowRun` and the driver, with specs planned from persisted
 * Definitions (`../../workflow/buildInvocationSpecsFromDefinitions.ts`) — no
 * policy/budget/workflow logic is written inline here. The Goal and Workflow
 * Run commit first, so a request that fails later has still created them.
 */
import type { FastifyInstance } from "fastify";
import { eq, inArray } from "drizzle-orm";
import { goals, projects, workflowDefinitions, workflowRuns } from "../../db/schema.js";
import type { ApiDeps } from "../server.js";
import { startWorkflowRun } from "../../workflow/interpreter.js";
import { advanceWorkflowRunUntilBlocked } from "../../workflow/advanceWorkflowRunUntilBlocked.js";
import { buildInvocationSpecsFromDefinitions } from "../../workflow/buildInvocationSpecsFromDefinitions.js";
import { requireSeededPublishWorkflow } from "../../definitions/lookupSeed.js";
import { createWorkflowRelay } from "../liveEventRelay.js";
import { emitLifecycleEvent, NO_CORRELATION } from "../../events/lifecycle.js";
import { isUuid } from "../requestGuards.js";

type CreateGoalBody = { title?: string; description?: string; workflowDefinitionId?: string; projectId?: string };

/** Most recent Goals returned by `GET /goals`. Ample for a single operator; a paged listing can follow real volume. */
const GOALS_LIST_LIMIT = 500;

export function registerGoalsRoutes(app: FastifyInstance, deps: ApiDeps): void {
  /**
   * `GET /goals` (2026-09-14) — spec §15.1 screen 5 (Goals & Projects): every
   * Project with its Goals (newest first), each with its Workflow Runs.
   * Read-only. Three queries grouped in memory rather than one per row.
   */
  app.get("/goals", async (_request, reply) => {
    const projectRows = await deps.db.query.projects.findMany({ orderBy: (p, { asc }) => asc(p.name) });
    const goalRows = await deps.db.query.goals.findMany({
      orderBy: (g, { desc }) => desc(g.createdAt),
      limit: GOALS_LIST_LIMIT,
    });
    const runRows =
      goalRows.length > 0
        ? await deps.db.query.workflowRuns.findMany({
            where: inArray(
              workflowRuns.goalId,
              goalRows.map((g) => g.id)
            ),
            orderBy: (w, { desc }) => desc(w.createdAt),
          })
        : [];

    const runsByGoal = new Map<string, { id: string; status: string; createdAt: Date; completedAt: Date | null }[]>();
    for (const run of runRows) {
      const list = runsByGoal.get(run.goalId) ?? [];
      list.push({ id: run.id, status: run.status, createdAt: run.createdAt, completedAt: run.completedAt });
      runsByGoal.set(run.goalId, list);
    }

    const goalsByProject = new Map<string, unknown[]>();
    for (const goal of goalRows) {
      const list = goalsByProject.get(goal.projectId) ?? [];
      list.push({
        id: goal.id,
        title: goal.title,
        description: goal.description,
        status: goal.status,
        createdAt: goal.createdAt,
        workflowRuns: runsByGoal.get(goal.id) ?? [],
      });
      goalsByProject.set(goal.projectId, list);
    }

    return reply.send({
      projects: projectRows.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        goals: goalsByProject.get(p.id) ?? [],
      })),
    });
  });

  app.post<{ Body: CreateGoalBody }>("/goals", async (request, reply) => {
    const { title, description, workflowDefinitionId: requestedWorkflowDefinitionId, projectId: requestedProjectId } =
      request.body ?? {};
    if (!title || typeof title !== "string") {
      return reply.status(400).send({ error: "title is required" });
    }
    for (const [field, value] of [
      ["workflowDefinitionId", requestedWorkflowDefinitionId],
      ["projectId", requestedProjectId],
    ] as const) {
      if (value !== undefined && !isUuid(value)) return reply.status(400).send({ error: `${field} must be a UUID` });
    }

    const relay = createWorkflowRelay(deps.db);
    // Goal + Workflow Run commit first, as one unit, in the same transaction that
    // confirms their Workflow Definition and Project exist; the driver then
    // advances in its own short transactions (Phase 9 — see the driver's
    // header), each relayed to live subscribers as it commits.
    const created = await deps.db.transaction(async (tx) => {
      // Either may be omitted; the seeded Workflow Definition and fixture Project
      // are the defaults, so a caller that names both needs no seed at all.
      const seed =
        requestedWorkflowDefinitionId && requestedProjectId ? null : await requireSeededPublishWorkflow(tx);
      const workflowDefinitionId = requestedWorkflowDefinitionId ?? seed!.workflowDefinitionId;
      const projectId = requestedProjectId ?? seed!.projectId;
      if (!(await tx.query.workflowDefinitions.findFirst({ where: eq(workflowDefinitions.id, workflowDefinitionId) }))) {
        return { error: "workflowDefinitionId does not name a Workflow Definition" } as const;
      }
      if (!(await tx.query.projects.findFirst({ where: eq(projects.id, projectId) }))) {
        return { error: "projectId does not name a Project" } as const;
      }

      const [goalRow] = await tx
        .insert(goals)
        .values({ projectId, title, description: description ?? null, status: "active" })
        .returning();
      const goalId = goalRow!.id;
      // Spec §8.2 `goal_created`, same transaction as the row. The V1 operator
      // identity, as for Approval resolutions (routes/approvals.ts).
      await emitLifecycleEvent(tx, {
        eventType: "goal_created",
        subjectId: goalId,
        correlation: { ...NO_CORRELATION, goalId },
        producer: "api",
        actor: "human:operator",
        payload: { title },
      });

      const { workflowRunId } = await startWorkflowRun(tx, workflowDefinitionId, goalId);
      return { goalId, workflowRunId } as const;
    });
    if ("error" in created) return reply.status(400).send({ error: created.error });

    await relay.track(created.workflowRunId, { fresh: true });
    await relay.flush();
    const advanceResult = await advanceWorkflowRunUntilBlocked(relay.runInTx, created.workflowRunId, buildInvocationSpecsFromDefinitions);

    return reply.status(201).send({ goalId: created.goalId, workflowRunId: created.workflowRunId, status: advanceResult.status });
  });
}
