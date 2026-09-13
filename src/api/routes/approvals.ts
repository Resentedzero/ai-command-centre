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
import type { FastifyInstance, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { approvals, invocations, runs, taskInstances } from "../../db/schema.js";
import type { ApiDeps } from "../server.js";
import { resolveApproval, ApprovalAlreadyResolvedError, ApprovalNotFoundError } from "../../governance/approvals.js";
import { advanceWorkflowRunUntilBlocked } from "../../workflow/advanceWorkflowRunUntilBlocked.js";
import { buildInvocationSpecsForTaskDefinition } from "../../workflow/buildInvocationSpecsForTaskDefinition.js";
import { findSeededPublishWorkflow } from "../../definitions/lookupSeed.js";
import { runWorkflowMutationAndRelay } from "../liveEventRelay.js";
import { transactionRunner } from "../../db/transactionRunner.js";
import { isUuid } from "../requestGuards.js";

/**
 * The V1 actor recorded for every Approval resolution made through this API
 * (independent-review Important 2).
 *
 * `resolvedBy` used to be read straight off the request body
 * (`request.body?.resolvedBy ?? "human:api"`) and passed unvalidated into the
 * Event envelope's `actor` — the permanent, immutable audit record (Phase
 * 8.7). A body of `{"resolvedBy":"system"}` therefore wrote `actor: "system"`,
 * falsely attributing a human's governance decision to the system itself, and
 * any other string was accepted just as readily.
 *
 * The fix is that the SERVER decides this value, not the client: there is one
 * fixed identity, defined here, and `resolvedBy` has been removed from the
 * request surface entirely — no sanitization, no defaulting, no body read at
 * all. Sanitizing an attacker-chosen string is not the same as the server
 * choosing the value.
 *
 * One hardcoded constant is the right mechanism for V1 specifically because
 * Phase 9.8 scopes this MVP to a single local operator with no user-to-user
 * permission model ("permissions apply agent-to-action"), so there is exactly
 * one human this could ever denote, and inventing an auth system to discover
 * that would be building a multi-user concept the spec explicitly defers. It
 * is a `human:<id>` value per Phase 8.1's actor vocabulary — the audit trail
 * still records that a HUMAN decided, which is the fact that matters and the
 * reason `resolveApproval` does not simply record `"system"`. When real
 * identities arrive, this constant is the single place they replace.
 */
export const V1_RESOLUTION_ACTOR = "human:operator";

/** Approval -> Invocation -> Run -> Task Instance -> workflowRunId (Ruling 3's own stated lookup path), read-only, BEFORE any mutation. */
async function lookupApprovalWorkflowRunId(
  deps: ApiDeps,
  approvalId: string
): Promise<{ found: true; workflowRunId: string | null } | { found: false }> {
  const approval = await deps.db.query.approvals.findFirst({ where: eq(approvals.id, approvalId) });
  if (!approval) return { found: false };

  const invocation = await deps.db.query.invocations.findFirst({ where: eq(invocations.id, approval.invocationId) });
  if (!invocation) return { found: true, workflowRunId: null };

  const run = await deps.db.query.runs.findFirst({ where: eq(runs.id, invocation.runId) });
  if (!run) return { found: true, workflowRunId: null };

  const taskInstance = await deps.db.query.taskInstances.findFirst({ where: eq(taskInstances.id, run.taskInstanceId) });
  return { found: true, workflowRunId: taskInstance?.workflowRunId ?? null };
}

/**
 * Maps `resolveApproval`'s two throw paths onto this route's existing
 * `{ error: string }` 404/409 contract; anything else is a genuine server
 * error and is rethrown untouched.
 *
 * Independent-review Important 1: this is REPORTING, not enforcement. The
 * guarantee that one Approval produces exactly one state transition lives
 * entirely in `resolveApproval`'s conditional `UPDATE ... WHERE status =
 * 'pending'` and Postgres's row-level locking (see that function's header).
 * The route-level read-only 409 pre-check that used to stand in for it has
 * been REMOVED: it could not be correct, because the read and the write were
 * not atomic with respect to each other, so two concurrent requests could both
 * pass it before either had written anything — and the loser would then go on
 * to overwrite the winner's status and emit a contradictory resolution event
 * into the immutable log. The 404 pre-check survives only because
 * `lookupApprovalWorkflowRunId` has to run anyway (to choose the standalone vs
 * workflow path, and to give the live-event relay its "before" Workflow Run);
 * the `ApprovalNotFoundError` branch below is what actually closes that case.
 */
function replyForResolutionError(error: unknown, reply: FastifyReply, approvalId: string): FastifyReply {
  if (error instanceof ApprovalAlreadyResolvedError) {
    return reply.status(409).send({ error: `Approval "${approvalId}" is already resolved (status: "${error.currentStatus}")` });
  }
  if (error instanceof ApprovalNotFoundError) {
    return reply.status(404).send({ error: `No approval found for id "${approvalId}"` });
  }
  throw error;
}

function registerResolveRoute(app: FastifyInstance, deps: ApiDeps, decision: "approved" | "rejected", path: string): void {
  app.post<{ Params: { id: string } }>(path, async (request, reply) => {
    const approvalId = request.params.id;
    // Validated before any query: a non-UUID otherwise reaches Postgres and
    // surfaces as a 500 instead of a client error.
    if (!isUuid(approvalId)) {
      return reply.status(400).send({ error: "approval id must be a UUID" });
    }

    const lookup = await lookupApprovalWorkflowRunId(deps, approvalId);
    if (!lookup.found) {
      return reply.status(404).send({ error: `No approval found for id "${approvalId}"` });
    }

    if (!lookup.workflowRunId) {
      // Standalone Task Instance (or an Invocation/Run this codebase can no
      // longer resolve) — resolve the Approval only, nothing to advance.
      try {
        const resolved = await deps.db.transaction((tx) => resolveApproval(tx, approvalId, decision, V1_RESOLUTION_ACTOR));
        return reply.send({ approvalId: resolved.id, approvalStatus: resolved.status, workflowRunId: null, workflowStatus: null });
      } catch (error) {
        return replyForResolutionError(error, reply, approvalId);
      }
    }

    const workflowRunId = lookup.workflowRunId;
    try {
      const runInTx = transactionRunner(deps.db);
      const result = await runWorkflowMutationAndRelay(deps.db, workflowRunId, async () => {
        // Checked BEFORE resolving: the resolution commits on its own, so a
        // missing seed must not leave a decided Approval with nothing to act on.
        const seed = await runInTx((tx) => findSeededPublishWorkflow(tx));
        if (!seed) {
          throw new Error('No seeded Workflow Definition found — run "npm run seed" first.');
        }

        // Resolved and COMMITTED before any advancement (Phase 9: the advance
        // runs in its own short transactions). The conditional UPDATE inside
        // `resolveApproval` is still the exactly-once guarantee: a losing
        // concurrent resolution throws here and never reaches the driver.
        const resolved = await runInTx((tx) => resolveApproval(tx, approvalId, decision, V1_RESOLUTION_ACTOR));

        const advanceResult = await advanceWorkflowRunUntilBlocked(runInTx, workflowRunId, (tx) =>
          buildInvocationSpecsForTaskDefinition(tx, seed)
        );

        return {
          approvalId: resolved.id,
          approvalStatus: resolved.status,
          workflowRunId,
          workflowStatus: advanceResult.status,
        };
      });

      return reply.send(result);
    } catch (error) {
      return replyForResolutionError(error, reply, approvalId);
    }
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
