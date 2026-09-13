/**
 * `POST /workflow-runs/:id/pause` / `/resume` — thin pass-throughs over Unit
 * 7's `pauseWorkflowRun`/`resumeWorkflowRun`.
 *
 * Ruling 3 (see `../server.ts`'s header): pause NEVER drives advancement —
 * `pauseWorkflowRun` only, deliberately, since pausing should never itself
 * cause more work to happen. Resume immediately re-drives the run as far as
 * automatically possible (fix round 1 — bounded by its own step count, not
 * just one step; see `../../workflow/advanceWorkflowRunUntilBlocked.ts`'s
 * header), synchronously, via Ruling 2's dispatcher.
 *
 * Errors: a non-UUID id is 400; an unknown Workflow Run is 404; a Workflow Run
 * in the wrong state for the operation (e.g. pausing one already paused or
 * finished) is 409. Anything else is a genuine server error.
 */
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { workflowRuns } from "../../db/schema.js";
import type { ApiDeps } from "../server.js";
import {
  pauseWorkflowRun,
  resumeWorkflowRun,
  WorkflowRunNotFoundError,
  WorkflowRunStateError,
} from "../../workflow/interpreter.js";
import { advanceWorkflowRunUntilBlocked } from "../../workflow/advanceWorkflowRunUntilBlocked.js";
import { buildInvocationSpecsForTaskDefinition } from "../../workflow/buildInvocationSpecsForTaskDefinition.js";
import { findSeededPublishWorkflow } from "../../definitions/lookupSeed.js";
import { runWorkflowMutationAndRelay } from "../liveEventRelay.js";
import { transactionRunner } from "../../db/transactionRunner.js";
import { isUuid } from "../requestGuards.js";

function replyForWorkflowRunError(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof WorkflowRunNotFoundError) return reply.status(404).send({ error: error.message });
  if (error instanceof WorkflowRunStateError) return reply.status(409).send({ error: error.message });
  throw error;
}

export function registerWorkflowRunsRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.post<{ Params: { id: string } }>("/workflow-runs/:id/pause", async (request, reply) => {
    const workflowRunId = request.params.id;
    if (!isUuid(workflowRunId)) {
      return reply.status(400).send({ error: "workflow run id must be a UUID" });
    }

    // No advancement, no events produced by pauseWorkflowRun itself (see
    // module header) — a plain transaction, no live-event relay needed.
    try {
      await deps.db.transaction((tx) => pauseWorkflowRun(tx, workflowRunId));
    } catch (error) {
      return replyForWorkflowRunError(error, reply);
    }

    const row = await deps.db.query.workflowRuns.findFirst({ where: eq(workflowRuns.id, workflowRunId) });
    return reply.send({ workflowRunId, status: row?.status ?? "paused" });
  });

  app.post<{ Params: { id: string } }>("/workflow-runs/:id/resume", async (request, reply) => {
    const workflowRunId = request.params.id;
    if (!isUuid(workflowRunId)) {
      return reply.status(400).send({ error: "workflow run id must be a UUID" });
    }

    const runInTx = transactionRunner(deps.db);
    try {
      const result = await runWorkflowMutationAndRelay(deps.db, workflowRunId, async () => {
        const seed = await runInTx((tx) => findSeededPublishWorkflow(tx));
        if (!seed) {
          throw new Error('No seeded Workflow Definition found — run "npm run seed" first.');
        }

        await runInTx((tx) => resumeWorkflowRun(tx, workflowRunId));

        const advanceResult = await advanceWorkflowRunUntilBlocked(runInTx, workflowRunId, (tx) =>
          buildInvocationSpecsForTaskDefinition(tx, seed)
        );

        return { workflowRunId, status: advanceResult.status };
      });
      return reply.send(result);
    } catch (error) {
      return replyForWorkflowRunError(error, reply);
    }
  });
}
