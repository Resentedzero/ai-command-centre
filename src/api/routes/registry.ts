/**
 * Registry control plane (roadmap V1.1; spec §15.1 screen 6 reads, §9.7 revocation).
 *
 *   GET  /registry                          — every Definition, read-only
 *   POST /capability-grants/:id/revoke      — revoke one Capability Grant
 *
 * `GET /registry` returns Agent Definitions, Capabilities with their Tool
 * Bindings, Capability Grants, Task Definitions and Workflow Definitions. A Tool
 * Binding's `config` is NEVER returned: it is adapter configuration and may hold
 * endpoints or credentials (spec §9.6). Only an internal binding's function name
 * is shown. Writes that create or edit Definitions are not built yet: editing
 * creates a new version (spec §15.1), and binding rows are immutable
 * (`docs/architecture/CAPABILITY_PLATFORM.md`).
 *
 * Revocation commits first, on its own, and only then re-drives each affected
 * Workflow Run, exactly as `revokeCapabilityGrant`'s contract requires: driving
 * inside the revocation transaction would invert the lock order
 * (DURABLE_EXECUTION §6). A re-drive failure is reported per Workflow Run beside
 * the committed revocation; the Approval TTL sweep would settle them anyway. A
 * transient database conflict on the revocation itself is reported as 503 and
 * not retried here. The actor is the server-side operator constant.
 */
import type { FastifyInstance } from "fastify";
import { asc, eq, inArray } from "drizzle-orm";
import {
  agentDefinitions,
  capabilities,
  capabilityGrants,
  runs,
  taskDefinitions,
  taskInstances,
  toolBindings,
  workflowDefinitions,
} from "../../db/schema.js";
import type { ApiDeps } from "../server.js";
import { isUuid } from "../requestGuards.js";
import { revokeCapabilityGrant } from "../../governance/approvals.js";
import { isTransientDatabaseError } from "../../db/databaseErrors.js";
import { hasTaskPlan } from "../../capabilities/taskPlans.js";
import { advanceWorkflowRunUntilBlocked } from "../../workflow/advanceWorkflowRunUntilBlocked.js";
import { buildInvocationSpecsFromDefinitions } from "../../workflow/buildInvocationSpecsFromDefinitions.js";
import { createWorkflowRelay, relayCommittedEvent } from "../liveEventRelay.js";
import { V1_RESOLUTION_ACTOR } from "./approvals.js";

export function registerRegistryRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get("/registry", async (_request, reply) => {
    const [agentRows, capabilityRows, bindingRows, grantRows, taskRows, workflowRows] = await Promise.all([
      deps.db.select().from(agentDefinitions).orderBy(asc(agentDefinitions.name), asc(agentDefinitions.version)),
      deps.db.select().from(capabilities).orderBy(asc(capabilities.name)),
      deps.db.select().from(toolBindings).orderBy(asc(toolBindings.version), asc(toolBindings.id)),
      deps.db.select().from(capabilityGrants).orderBy(asc(capabilityGrants.createdAt), asc(capabilityGrants.id)),
      deps.db.select().from(taskDefinitions).orderBy(asc(taskDefinitions.name), asc(taskDefinitions.version)),
      deps.db.select().from(workflowDefinitions).orderBy(asc(workflowDefinitions.name), asc(workflowDefinitions.version)),
    ]);

    return reply.send({
      agentDefinitions: agentRows.map((a) => ({
        id: a.id,
        name: a.name,
        version: a.version,
        role: a.role,
        objective: a.objective,
        createdAt: a.createdAt,
      })),
      capabilities: capabilityRows.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        staticRiskTag: c.staticRiskTag,
        toolBindings: bindingRows
          .filter((b) => b.capabilityId === c.id)
          .map((b) => ({
            id: b.id,
            kind: b.kind,
            version: b.version,
            trustLevel: b.trustLevel,
            internalFunction: b.kind === "internal" && typeof b.config?.function === "string" ? b.config.function : null,
          })),
      })),
      capabilityGrants: grantRows.map((g) => ({
        id: g.id,
        agentDefinitionId: g.agentDefinitionId,
        agentDefinitionVersion: g.agentDefinitionVersion,
        capabilityId: g.capabilityId,
        permissions: g.permissions,
        autonomyState: g.autonomyState,
        maxTrustLevelRequired: g.maxTrustLevelRequired,
        createdAt: g.createdAt,
        revokedAt: g.revokedAt,
      })),
      taskDefinitions: taskRows.map((t) => ({
        id: t.id,
        name: t.name,
        kind: t.kind,
        version: t.version,
        planRegistered: hasTaskPlan(t.kind),
      })),
      workflowDefinitions: workflowRows.map((w) => ({
        id: w.id,
        name: w.name,
        version: w.version,
        graphDefinition: w.graphDefinition,
        createdAt: w.createdAt,
      })),
    });
  });

  app.post<{ Params: { id: string } }>("/capability-grants/:id/revoke", async (request, reply) => {
    const grantId = request.params.id;
    if (!isUuid(grantId)) return reply.status(400).send({ error: "capability grant id must be a UUID" });
    const grant = await deps.db.query.capabilityGrants.findFirst({ where: eq(capabilityGrants.id, grantId) });
    if (!grant) return reply.status(404).send({ error: `No capability grant found for id "${grantId}"` });

    let result: Awaited<ReturnType<typeof revokeCapabilityGrant>>;
    try {
      result = await deps.db.transaction((tx) => revokeCapabilityGrant(tx, grant.id, V1_RESOLUTION_ACTOR));
    } catch (error) {
      if (isTransientDatabaseError(error)) {
        return reply.status(503).send({ error: "The revocation conflicted with concurrent work and was not applied; retry." });
      }
      throw error;
    }
    if (result.revoked) await relayCommittedEvent(deps.db, `capability_grant_revoked:${grant.id}`);

    const affected =
      result.affectedRunIds.length > 0
        ? await deps.db
            .selectDistinct({ workflowRunId: taskInstances.workflowRunId })
            .from(runs)
            .innerJoin(taskInstances, eq(runs.taskInstanceId, taskInstances.id))
            .where(inArray(runs.id, result.affectedRunIds))
        : [];
    const workflowRunIds = affected
      .map((r) => r.workflowRunId)
      .filter((id): id is string => id !== null)
      .sort();

    const workflowRuns: ({ workflowRunId: string; status: string } | { workflowRunId: string; error: string })[] = [];
    for (const workflowRunId of workflowRunIds) {
      try {
        const relay = createWorkflowRelay(deps.db);
        await relay.track(workflowRunId);
        const advanced = await advanceWorkflowRunUntilBlocked(relay.runInTx, workflowRunId, buildInvocationSpecsFromDefinitions);
        workflowRuns.push({ workflowRunId, status: advanced.status });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`Re-driving workflow run ${workflowRunId} after a grant revocation failed:`, error);
        workflowRuns.push({
          workflowRunId,
          error: `The revocation was recorded, but advancing this workflow run failed. Retry with POST /workflow-runs/${workflowRunId}/advance.`,
        });
      }
    }

    return reply.send({
      grantId: grant.id,
      revoked: result.revoked,
      cancelledApprovalIds: result.cancelledApprovalIds,
      workflowRuns,
    });
  });
}
