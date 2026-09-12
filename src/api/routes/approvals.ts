/**
 * `GET /approvals`, `POST /approvals/:id/approve`, `POST /approvals/:id/reject`
 * — thin pass-throughs over Unit 3's `resolveApproval` and Unit 7's
 * `advanceWorkflowRun` (via Ruling 2's dispatcher).
 *
 * Ruling 3 (see `../server.ts`'s header; fix round 1 — see
 * `../../workflow/advanceWorkflowRunUntilBlocked.ts`'s header): resolving an
 * Approval whose Invocation belongs to a workflow-created Task Instance
 * (non-null `task_instances.workflow_run_id`) immediately re-drives the run
 * as far as automatically possible (bounded by its own step count), not
 * just one step, synchronously, to resume the gated step and progress past
 * it if nothing further blocks it. An Approval for a STANDALONE Task
 * Instance (`workflow_run_id: null`) is resolved only — there is no
 * Workflow Run to advance.
 */
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { approvals, invocations, runs, taskInstances } from "../../db/schema.js";
import type { ApiDeps } from "../server.js";
import { resolveApproval } from "../../governance/approvals.js";
import { advanceWorkflowRunUntilBlocked } from "../../workflow/advanceWorkflowRunUntilBlocked.js";
import { buildInvocationSpecsForTaskDefinition } from "../../workflow/buildInvocationSpecsForTaskDefinition.js";
import { findSeededPublishWorkflow } from "../../definitions/lookupSeed.js";
import { runWorkflowMutationAndRelay } from "../liveEventRelay.js";

type ResolveBody = { resolvedBy?: string };

/** Approval -> Invocation -> Run -> Task Instance -> workflowRunId (Ruling 3's own stated lookup path), read-only, BEFORE any mutation. */
async function lookupApprovalWorkflowRunId(deps: ApiDeps, approvalId: string): Promise<{ found: true; workflowRunId: string | null } | { found: false }> {
  const approval = await deps.db.query.approvals.findFirst({ where: eq(approvals.id, approvalId) });
  if (!approval) return { found: false };

  const invocation = await deps.db.query.invocations.findFirst({ where: eq(invocations.id, approval.invocationId) });
  if (!invocation) return { found: true, workflowRunId: null };

  const run = await deps.db.query.runs.findFirst({ where: eq(runs.id, invocation.runId) });
  if (!run) return { found: true, workflowRunId: null };

  const taskInstance = await deps.db.query.taskInstances.findFirst({ where: eq(taskInstances.id, run.taskInstanceId) });
  return { found: true, workflowRunId: taskInstance?.workflowRunId ?? null };
}

function registerResolveRoute(app: FastifyInstance, deps: ApiDeps, decision: "approved" | "rejected", path: string): void {
  app.post<{ Params: { id: string }; Body: ResolveBody }>(path, async (request, reply) => {
    const approvalId = request.params.id;
    const resolvedBy = request.body?.resolvedBy ?? "human:api";

    const lookup = await lookupApprovalWorkflowRunId(deps, approvalId);
    if (!lookup.found) {
      return reply.status(404).send({ error: `No approval found for id "${approvalId}"` });
    }

    if (!lookup.workflowRunId) {
      // Standalone Task Instance (or an Invocation/Run this codebase can no
      // longer resolve) — resolve the Approval only, nothing to advance.
      const resolved = await deps.db.transaction((tx) => resolveApproval(tx, approvalId, decision, resolvedBy));
      return reply.send({ approvalId: resolved.id, approvalStatus: resolved.status, workflowRunId: null, workflowStatus: null });
    }

    const workflowRunId = lookup.workflowRunId;
    const result = await runWorkflowMutationAndRelay(deps.db, workflowRunId, async (tx) => {
      const resolved = await resolveApproval(tx, approvalId, decision, resolvedBy);

      const seed = await findSeededPublishWorkflow(tx);
      if (!seed) {
        throw new Error('No seeded Workflow Definition found — run "npm run seed" first.');
      }
      const builder = buildInvocationSpecsForTaskDefinition(tx, seed);
      const advanceResult = await advanceWorkflowRunUntilBlocked(tx, workflowRunId, builder);

      return {
        approvalId: resolved.id,
        approvalStatus: resolved.status,
        workflowRunId,
        workflowStatus: advanceResult.status,
      };
    });

    return reply.send(result);
  });
}

export function registerApprovalsRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get("/approvals", async (_request, reply) => {
    const pending = await deps.db.query.approvals.findMany({
      where: eq(approvals.status, "pending"),
      orderBy: (a, { asc }) => asc(a.createdAt),
    });
    return reply.send({ approvals: pending });
  });

  registerResolveRoute(app, deps, "approved", "/approvals/:id/approve");
  registerResolveRoute(app, deps, "rejected", "/approvals/:id/reject");
}
