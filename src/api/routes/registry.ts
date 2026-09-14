/**
 * Registry control plane (roadmap V1.1; spec §15.1 screen 6 reads, §9.7 revocation).
 *
 *   GET  /registry                          — every Definition, read-only
 *   POST /capabilities                      — create a Capability
 *   POST /tool-bindings                     — create a Capability's next Tool Binding version
 *   POST /agent-definitions                 — create an Agent Definition or its next version
 *   POST /task-definitions                  — create a Task Definition or its next version
 *   POST /workflow-definitions              — create a Workflow Definition or its next version
 *   POST /capability-grants                 — create one Capability Grant
 *   POST /capability-grants/:id/revoke      — revoke one Capability Grant
 *
 * `GET /registry` returns Agent Definitions, Capabilities with their Tool
 * Bindings, Capability Grants, Task Definitions and Workflow Definitions. A Tool
 * Binding's `config` is NEVER returned: it is adapter configuration and may hold
 * endpoints or credentials (spec §9.6). Only an internal binding's function name
 * is shown.
 *
 * Creates validate and version in `../../definitions/registryWrites.ts`; nothing is
 * ever updated (spec §15.1: editing creates a new version). A refused write is 400
 * or 409, a transient database conflict 503. Each commits its row and event in one
 * transaction, then relays the event. The actor is the server-side operator constant.
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
import { sqlStateOf } from "../../db/databaseErrors.js";
import type { DrizzleTransaction } from "../../events/emit.js";
import {
  RegistryWriteError,
  createAgentDefinition,
  createCapability,
  createCapabilityGrant,
  createTaskDefinition,
  createToolBinding,
  createWorkflowDefinition,
  type Created,
} from "../../definitions/registryWrites.js";

const CREATE_ROUTES: [string, (tx: DrizzleTransaction, body: Record<string, unknown>, actor: string) => Promise<Created>][] = [
  ["/capabilities", createCapability],
  ["/tool-bindings", createToolBinding],
  ["/agent-definitions", createAgentDefinition],
  ["/task-definitions", createTaskDefinition],
  ["/workflow-definitions", createWorkflowDefinition],
  ["/capability-grants", createCapabilityGrant],
];

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
        instructions: a.instructions,
        memoryPolicy: a.memoryPolicy,
        escalationPolicy: a.escalationPolicy,
        createdAt: a.createdAt,
      })),
      capabilities: capabilityRows.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        staticRiskTag: c.staticRiskTag,
        costProfile: c.costProfile,
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
        scope: g.scope,
        createdAt: g.createdAt,
        revokedAt: g.revokedAt,
      })),
      taskDefinitions: taskRows.map((t) => ({
        id: t.id,
        name: t.name,
        kind: t.kind,
        version: t.version,
        planRegistered: hasTaskPlan(t.kind),
        inputSchema: t.inputSchema,
        outputSchema: t.outputSchema,
        defaultContextBudget: t.defaultContextBudget,
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

  for (const [url, create] of CREATE_ROUTES) {
    app.post(url, async (request, reply) => {
      const body = request.body;
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return reply.status(400).send({ error: "The request body must be a JSON object." });
      }
      let created: Created;
      try {
        created = await deps.db.transaction((tx) => create(tx, body as Record<string, unknown>, V1_RESOLUTION_ACTOR));
      } catch (error) {
        if (error instanceof RegistryWriteError) return reply.status(error.status).send({ error: error.message });
        // The unique (capability_id, version) index backs the version lock for Tool Bindings.
        if (sqlStateOf(error) === "23505") return reply.status(409).send({ error: "A concurrent write created this version first; re-read and retry." });
        if (isTransientDatabaseError(error)) {
          return reply.status(503).send({ error: "The write conflicted with concurrent work and was not applied; retry." });
        }
        throw error;
      }
      await relayCommittedEvent(deps.db, created.eventIdempotencyKey);
      return reply.status(201).send({ id: created.id, name: created.name, version: created.version });
    });
  }

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
    if (result.revoked) {
      // In commit (cursor) order: each Approval's expiry was written before the
      // revocation event. Relaying only the latter left the expiries off the live
      // feed, and a client whose cursor then passed them would never replay them.
      for (const approvalId of result.cancelledApprovalIds) {
        await relayCommittedEvent(deps.db, `approval_expired:${approvalId}`);
      }
      await relayCommittedEvent(deps.db, `capability_grant_revoked:${grant.id}`);
    }

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
