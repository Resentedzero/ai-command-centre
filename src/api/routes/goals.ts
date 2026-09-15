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
import { MAX_TEXT_LENGTH } from "../../definitions/registryWrites.js";

type CreateGoalBody = { title?: string; description?: string; workflowDefinitionId?: string; projectId?: string; async?: boolean };

/**
 * Creates a Goal and starts its Workflow Run, committed as one unit in the transaction
 * that confirms the Workflow Definition and Project exist (either defaults to the
 * seed's). The driver then advances in its own short transactions (Phase 9). Shared by
 * `POST /goals` and Keeper Think (`./keeper.ts`), so both start work the same way.
 */
export async function createGoalWithWorkflowRun(
  deps: ApiDeps,
  input: { title: string; description: string | null; workflowDefinitionId?: string; projectId?: string }
): Promise<{ error: string } | { goalId: string; workflowRunId: string }> {
  return deps.db.transaction(async (tx) => {
    const seed = input.workflowDefinitionId && input.projectId ? null : await requireSeededPublishWorkflow(tx);
    const workflowDefinitionId = input.workflowDefinitionId ?? seed!.workflowDefinitionId;
    const projectId = input.projectId ?? seed!.projectId;
    if (!(await tx.query.workflowDefinitions.findFirst({ where: eq(workflowDefinitions.id, workflowDefinitionId) }))) {
      return { error: "workflowDefinitionId does not name a Workflow Definition" };
    }
    if (!(await tx.query.projects.findFirst({ where: eq(projects.id, projectId) }))) {
      return { error: "projectId does not name a Project" };
    }
    const [goalRow] = await tx.insert(goals).values({ projectId, title: input.title, description: input.description, status: "active" }).returning();
    const goalId = goalRow!.id;
    // Spec §8.2 `goal_created`, same transaction as the row. The V1 operator identity.
    await emitLifecycleEvent(tx, {
      eventType: "goal_created",
      subjectId: goalId,
      correlation: { ...NO_CORRELATION, goalId },
      producer: "api",
      actor: "human:operator",
      payload: { title: input.title },
    });
    const { workflowRunId } = await startWorkflowRun(tx, workflowDefinitionId, goalId);
    return { goalId, workflowRunId };
  });
}

/**
 * R2 (V1.1): the Goal and Workflow Run are committed; the same driver continues in this
 * process after the response. Postgres stays authoritative: the run's state is in its
 * rows and events, the UI follows the event stream, and if the process dies the startup
 * re-drive (`../start.ts`) picks the run up. No queue, no broker.
 */
export function driveInBackground(relay: ReturnType<typeof createWorkflowRelay>, workflowRunId: string): void {
  void advanceWorkflowRunUntilBlocked(relay.runInTx, workflowRunId, buildInvocationSpecsFromDefinitions).catch((error) => {
    // eslint-disable-next-line no-console
    console.error(`Driving workflow run ${workflowRunId} in the background failed; POST /workflow-runs/${workflowRunId}/advance retries:`, error);
  });
}

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
    const { title, description, workflowDefinitionId: requestedWorkflowDefinitionId, projectId: requestedProjectId, async: runAsync } =
      request.body ?? {};
    if (runAsync !== undefined && typeof runAsync !== "boolean") {
      return reply.status(400).send({ error: "async must be a boolean" });
    }
    if (!title || typeof title !== "string") {
      return reply.status(400).send({ error: "title is required" });
    }
    if (title.length > MAX_TEXT_LENGTH) {
      return reply.status(400).send({ error: `title must be at most ${MAX_TEXT_LENGTH} characters` });
    }
    if (description !== undefined && description !== null && (typeof description !== "string" || description.length > MAX_TEXT_LENGTH)) {
      return reply.status(400).send({ error: `description must be a string of at most ${MAX_TEXT_LENGTH} characters` });
    }
    for (const [field, value] of [
      ["workflowDefinitionId", requestedWorkflowDefinitionId],
      ["projectId", requestedProjectId],
    ] as const) {
      if (value !== undefined && !isUuid(value)) return reply.status(400).send({ error: `${field} must be a UUID` });
    }

    const relay = createWorkflowRelay(deps.db);
    const created = await createGoalWithWorkflowRun(deps, { title, description: description ?? null, workflowDefinitionId: requestedWorkflowDefinitionId, projectId: requestedProjectId });
    if ("error" in created) return reply.status(400).send({ error: created.error });

    await relay.track(created.workflowRunId, { fresh: true });
    await relay.flush();

    if (runAsync) {
      driveInBackground(relay, created.workflowRunId);
      return reply.status(202).send({ goalId: created.goalId, workflowRunId: created.workflowRunId, status: "in_progress" });
    }

    const advanceResult = await advanceWorkflowRunUntilBlocked(relay.runInTx, created.workflowRunId, buildInvocationSpecsFromDefinitions);

    return reply.status(201).send({ goalId: created.goalId, workflowRunId: created.workflowRunId, status: advanceResult.status });
  });
}
