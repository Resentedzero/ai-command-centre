/**
 * `POST /workflow-runs/:id/pause` / `/resume` / `/advance`.
 *
 * Ruling 3 (see `../server.ts`'s header): pause NEVER drives advancement —
 * pausing should never itself cause more work to happen. Resume re-drives the
 * run as far as automatically possible via the driver
 * (`../../workflow/advanceWorkflowRunUntilBlocked.ts`).
 *
 * `advance` (2026-09-14) re-drives an `in_progress` Workflow Run WITHOUT any
 * state change of its own. It exists because a request now commits in several
 * transactions (Phase 9): if one fails part-way — or its process dies — a
 * Workflow Run can be left `in_progress` with nothing driving it (an Approval
 * committed but not acted on; a dispatch recorded but the Run not continued).
 * Approve would answer "already resolved" and resume only accepts `paused`, so
 * without this the only repair was pause-then-resume or a restart. It runs the
 * ordinary driver, so every governance check runs again; for a Run genuinely
 * waiting on a human it is a cheap no-op.
 *
 * Errors: a non-UUID id is 400; an unknown Workflow Run is 404; a Workflow Run
 * in the wrong state for the operation is 409.
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
import { createWorkflowRelay } from "../liveEventRelay.js";
import { isUuid } from "../requestGuards.js";

function replyForWorkflowRunError(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof WorkflowRunNotFoundError) return reply.status(404).send({ error: error.message });
  if (error instanceof WorkflowRunStateError) return reply.status(409).send({ error: error.message });
  throw error;
}

async function driveWithRelay(deps: ApiDeps, workflowRunId: string, beforeAdvance?: () => Promise<void>) {
  const relay = createWorkflowRelay(deps.db);
  await relay.track(workflowRunId);
  const seed = await deps.db.transaction((tx) => findSeededPublishWorkflow(tx));
  if (!seed) {
    throw new Error('No seeded Workflow Definition found — run "npm run seed" first.');
  }
  if (beforeAdvance) await beforeAdvance();
  await relay.flush();
  const result = await advanceWorkflowRunUntilBlocked(relay.runInTx, workflowRunId, (tx) =>
    buildInvocationSpecsForTaskDefinition(tx, seed)
  );
  return { workflowRunId, status: result.status };
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
    try {
      const result = await driveWithRelay(deps, workflowRunId, () =>
        deps.db.transaction((tx) => resumeWorkflowRun(tx, workflowRunId))
      );
      return reply.send(result);
    } catch (error) {
      return replyForWorkflowRunError(error, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/workflow-runs/:id/advance", async (request, reply) => {
    const workflowRunId = request.params.id;
    if (!isUuid(workflowRunId)) {
      return reply.status(400).send({ error: "workflow run id must be a UUID" });
    }
    const row = await deps.db.query.workflowRuns.findFirst({ where: eq(workflowRuns.id, workflowRunId) });
    if (!row) {
      return reply.status(404).send({ error: `No workflow run found for id "${workflowRunId}"` });
    }
    if (row.status !== "in_progress") {
      return reply
        .status(409)
        .send({ error: `Workflow run "${workflowRunId}" is "${row.status}"; only an in_progress run can be advanced` });
    }
    try {
      return reply.send(await driveWithRelay(deps, workflowRunId));
    } catch (error) {
      return replyForWorkflowRunError(error, reply);
    }
  });
}
