/**
 * `POST /goals` — creates a Goal (attached to the seed's own fixture Project
 * — see `../../definitions/lookupSeed.ts`'s header; this MVP has no
 * project-management routes of its own), starts a Workflow Run against the
 * seeded "Research-and-Publish" Workflow Definition, then drives it as far as
 * automatically possible (bounded by its own step count) through
 * `../../workflow/advanceWorkflowRunUntilBlocked.ts` — see `../server.ts`'s
 * header.
 *
 * Thin pass-through: the only orchestration functions this handler calls are
 * `startWorkflowRun` and the driver, with specs from
 * `../../workflow/buildInvocationSpecsForTaskDefinition.ts` — no
 * policy/budget/workflow logic is written inline here. The Goal and Workflow
 * Run commit first, so a request that fails later has still created them.
 */
import type { FastifyInstance } from "fastify";
import { inArray } from "drizzle-orm";
import { goals, workflowRuns } from "../../db/schema.js";
import type { ApiDeps } from "../server.js";
import { startWorkflowRun } from "../../workflow/interpreter.js";
import { advanceWorkflowRunUntilBlocked } from "../../workflow/advanceWorkflowRunUntilBlocked.js";
import { buildInvocationSpecsForTaskDefinition } from "../../workflow/buildInvocationSpecsForTaskDefinition.js";
import { requireSeededPublishWorkflow } from "../../definitions/lookupSeed.js";
import { createWorkflowRelay } from "../liveEventRelay.js";
import { emitLifecycleEvent, NO_CORRELATION } from "../../events/lifecycle.js";

type CreateGoalBody = { title?: string; description?: string };

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
    const { title, description } = request.body ?? {};
    if (!title || typeof title !== "string") {
      return reply.status(400).send({ error: "title is required" });
    }

    const relay = createWorkflowRelay(deps.db);
    const result = await (async () => {
      // Goal + Workflow Run commit first, as one unit; the driver then advances
      // in its own short transactions (Phase 9 — see the driver's header),
      // each relayed to live subscribers as it commits.
      const { seed, goalId, workflowRunId } = await deps.db.transaction(async (tx) => {
        const seed = await requireSeededPublishWorkflow(tx);

        const [goalRow] = await tx
          .insert(goals)
          .values({ projectId: seed.projectId, title, description: description ?? null, status: "active" })
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

        const { workflowRunId } = await startWorkflowRun(tx, seed.workflowDefinitionId, goalId);
        return { seed, goalId, workflowRunId };
      });
      await relay.track(workflowRunId, { fresh: true });
      await relay.flush();

      const advanceResult = await advanceWorkflowRunUntilBlocked(relay.runInTx, workflowRunId, (tx) =>
        buildInvocationSpecsForTaskDefinition(tx, seed)
      );

      return { goalId, workflowRunId, status: advanceResult.status };
    })();

    return reply.status(201).send(result);
  });
}
