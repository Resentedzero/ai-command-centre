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
 */
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { workflowRuns } from "../../db/schema.js";
import type { ApiDeps } from "../server.js";
import { pauseWorkflowRun, resumeWorkflowRun } from "../../workflow/interpreter.js";
import { advanceWorkflowRunUntilBlocked } from "../../workflow/advanceWorkflowRunUntilBlocked.js";
import { buildInvocationSpecsForTaskDefinition } from "../../workflow/buildInvocationSpecsForTaskDefinition.js";
import { findSeededPublishWorkflow } from "../../definitions/lookupSeed.js";
import { runWorkflowMutationAndRelay } from "../liveEventRelay.js";
import { transactionRunner } from "../../db/transactionRunner.js";

export function registerWorkflowRunsRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.post<{ Params: { id: string } }>("/workflow-runs/:id/pause", async (request, reply) => {
    const workflowRunId = request.params.id;

    // No advancement, no events produced by pauseWorkflowRun itself (see
    // module header) — a plain transaction, no live-event relay needed.
    await deps.db.transaction((tx) => pauseWorkflowRun(tx, workflowRunId));

    const row = await deps.db.query.workflowRuns.findFirst({ where: eq(workflowRuns.id, workflowRunId) });
    return reply.send({ workflowRunId, status: row?.status ?? "paused" });
  });

  app.post<{ Params: { id: string } }>("/workflow-runs/:id/resume", async (request, reply) => {
    const workflowRunId = request.params.id;

    const runInTx = transactionRunner(deps.db);
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
  });
}
