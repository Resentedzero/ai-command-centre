/**
 * `POST /goals` — creates a Goal (attached to the seed's own fixture Project
 * — see `../../definitions/lookupSeed.ts`'s header; this MVP has no
 * project-management routes of its own), starts a Workflow Run against the
 * seeded "Research-and-Publish" Workflow Definition, then immediately calls
 * `advanceWorkflowRun` once (Ruling 3 — see `../server.ts`'s header) to kick
 * off Task A.
 *
 * Thin pass-through, per the brief's route-structure requirement: the only
 * orchestration functions this handler calls are Unit 7's `startWorkflowRun`
 * and (via `../../workflow/advanceWorkflowRunUntilBlocked.ts` — Ruling 3 fix
 * round 1) `advanceWorkflowRun`, dispatched through
 * `../../workflow/buildInvocationSpecsForTaskDefinition.ts` (Ruling 2) — no
 * policy/budget/workflow logic is written inline here.
 *
 * Ruling 3 fix round 1: this route drives the run as far as automatically
 * possible (bounded by its own step count), not just Task A — see
 * `advanceWorkflowRunUntilBlocked.ts`'s header for why looping is safe and
 * bounded, and task-10-report.md's "Fix round 1" section for why the
 * original "call advanceWorkflowRun once" ruling left the run permanently
 * stuck after Task A with no route able to progress it.
 */
import type { FastifyInstance } from "fastify";
import { goals } from "../../db/schema.js";
import type { ApiDeps } from "../server.js";
import { startWorkflowRun } from "../../workflow/interpreter.js";
import { advanceWorkflowRunUntilBlocked } from "../../workflow/advanceWorkflowRunUntilBlocked.js";
import { buildInvocationSpecsForTaskDefinition } from "../../workflow/buildInvocationSpecsForTaskDefinition.js";
import { findSeededPublishWorkflow } from "../../definitions/lookupSeed.js";
import { runWorkflowMutationAndRelay } from "../liveEventRelay.js";

type CreateGoalBody = { title?: string; description?: string };

export function registerGoalsRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.post<{ Body: CreateGoalBody }>("/goals", async (request, reply) => {
    const { title, description } = request.body ?? {};
    if (!title || typeof title !== "string") {
      return reply.status(400).send({ error: "title is required" });
    }

    const result = await runWorkflowMutationAndRelay(deps.db, null, async (tx) => {
      const seed = await findSeededPublishWorkflow(tx);
      if (!seed) {
        throw new Error('No seeded Workflow Definition found — run "npm run seed" before creating Goals.');
      }

      const [goalRow] = await tx
        .insert(goals)
        .values({ projectId: seed.projectId, title, description: description ?? null, status: "active" })
        .returning();
      const goalId = goalRow!.id;

      const { workflowRunId } = await startWorkflowRun(tx, seed.workflowDefinitionId, goalId);

      const builder = buildInvocationSpecsForTaskDefinition(tx, seed);
      const advanceResult = await advanceWorkflowRunUntilBlocked(tx, workflowRunId, builder);

      return { goalId, workflowRunId, status: advanceResult.status };
    });

    return reply.status(201).send(result);
  });
}
