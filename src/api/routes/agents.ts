/**
 * `GET /agents/active` — Unit 11 (task-11-brief.md, Ruling 1). A genuine
 * gap in Unit 10's own surface: nothing prior to this unit exposes "which
 * agents are working right now" as a single read. This route is new,
 * unspecified-by-any-prior-unit code -- the shape below is this unit's own
 * call, documented here rather than silently assumed.
 *
 * "Active" = a `runs` row whose status is NOT in the terminal set
 * (`"completed"`, `"failed"` -- see `src/workflow/interpreter.ts`'s
 * `AdvanceResult`/`resolveStepOutcome`, the only place `runs.status` is ever
 * written a final value). Every other value the column holds today
 * (`"active"` at creation -- `src/workflow/interpreter.ts:358` -- and
 * `"awaiting_approval"` -- `src/execution/executor.ts`) represents a Run
 * that still has live work associated with it, by construction, so nothing
 * further needs to be enumerated for the "active" side of this filter.
 *
 * The join is written as three sequential, per-row lookups rather than a
 * single SQL join, matching this codebase's own established convention for
 * read routes over small MVP data volumes (see `routes/approvals.ts`'s
 * `lookupApprovalWorkflowRunId`, which does the same thing for a very
 * similar reason) rather than introducing a different query style just for
 * this route.
 *
 * `runs.agentDefinitionId` is nullable (`src/db/schema.ts`) -- Unit 7's
 * `advanceWorkflowRun` creates a step's `runs` row with NO agent binding;
 * `bindRunAgent` (`../../capabilities/shared/runProvisioning.ts`) only sets
 * it once that step's `InvocationSpecBuilder` runs, which happens BEFORE the
 * Run can reach `"awaiting_approval"`/`"completed"` for the two capabilities
 * this MVP seeds, but is not a schema-level guarantee for every future
 * capability. This route therefore treats a null `agentDefinitionId` as a
 * legitimate ("not yet bound") case rather than assuming it is always
 * present, and reports `agentName: "Unassigned"` for it instead of throwing
 * or silently dropping the row.
 *
 * `latestActivitySummary` is derived from the most recent `events` row for
 * the Run (`sequenceNo` is monotonic per-runId -- `src/events/types.ts`),
 * using ONLY `eventType`. `payload` is explicitly documented as "not a
 * discriminated union for MVP" (`src/events/types.ts`), so no field is
 * guaranteed present across every `eventType` this codebase emits (compare
 * `src/execution/executor.ts`'s `{artifactId}` payloads against
 * `src/router/modelRouter.ts`'s `{tier, modelId}` ones) -- `eventType` is
 * the one thing every row guarantees, making it the only generically safe
 * "what's happening" summary at this layer. A richer, eventType-specific
 * summary is left to the UI (`web/lib/api.ts`'s own `EventDisplayItem`
 * derivation) or a future unit, not invented here.
 */
import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import {
  agentDefinitions,
  artifacts,
  budgetCounters,
  capabilities,
  capabilityGrants,
  events,
  executionStops,
  goals,
  invocations,
  runs,
  taskDefinitions,
  taskInstances,
  workflowRuns,
} from "../../db/schema.js";
import type { ApiDeps } from "../server.js";
import { rowToEventEnvelope } from "../eventEnvelopeRow.js";
import { isUuid } from "../requestGuards.js";

/** Bounds for the Agent Detail read model: recent history, not a full archive. */
const AGENT_RECENT_RUNS = 10;
const AGENT_RECENT_EVENTS = 20;
const AGENT_RECENT_OUTPUTS = 10;

/** See module header: the only two `runs.status` values that mean "no longer active". */
const TERMINAL_RUN_STATUSES = ["completed", "failed"] as const;

export type ActiveAgentData = {
  agentDefinitionId: string | null;
  agentName: string;
  runId: string;
  taskInstanceId: string;
  taskStatus: string;
  latestActivitySummary: string | null;
};

async function latestActivitySummaryForRun(deps: ApiDeps, runId: string): Promise<string | null> {
  const rows = await deps.db
    .select()
    .from(events)
    .where(eq(events.runId, runId))
    .orderBy(desc(events.sequenceNo))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return rowToEventEnvelope(row).eventType;
}

export function registerAgentsRoutes(app: FastifyInstance, deps: ApiDeps): void {
  /**
   * `GET /agents/:id` (2026-09-14) — spec §15.1 screen 2 (Agent Detail) for one
   * Agent Definition version. Read-only:
   *   - `activeStop`: the agent-scope emergency stop, if engaged (the control the
   *     UI offers; spec §9.7). There is no separate per-agent pause mechanism.
   *   - `grants`: its Capability Grants, read-only (permissions, autonomy, trust bar).
   *   - `runs`: its most recent Runs with Task/Goal lineage and latest Invocation.
   *   - `budgetTotals`: consumption summed PER UNIT in SQL (exact numerics as
   *     strings). Units are separate counters and are never combined.
   *   - `recentEvents`, `outputs` (artifacts its Runs produced), and
   *     `contextLineage` (the latest `context_compiled` payload — ids, tiers,
   *     exclusion reasons, token estimate; never content; spec §5.13).
   *   - `performance`: null — the `agent_performance` projection is V2 and not
   *     built; reported as absent rather than approximated.
   */
  app.get<{ Params: { id: string } }>("/agents/:id", async (request, reply) => {
    const agentId = request.params.id;
    if (!isUuid(agentId)) {
      return reply.status(400).send({ error: "agent definition id must be a UUID" });
    }
    const agent = await deps.db.query.agentDefinitions.findFirst({ where: eq(agentDefinitions.id, agentId) });
    if (!agent) {
      return reply.status(404).send({ error: `No agent definition found for id "${agentId}"` });
    }

    const [activeStop] = await deps.db
      .select({
        id: executionStops.id,
        scope: executionStops.scope,
        scopeRefId: executionStops.scopeRefId,
        reason: executionStops.reason,
        engagedAt: executionStops.engagedAt,
      })
      .from(executionStops)
      .where(
        and(
          eq(executionStops.scope, "agent_definition"),
          eq(executionStops.scopeRefId, agent.id.toLowerCase()),
          isNull(executionStops.liftedAt)
        )
      );

    const grantRows = await deps.db
      .select({
        id: capabilityGrants.id,
        capabilityId: capabilityGrants.capabilityId,
        capabilityName: capabilities.name,
        permissions: capabilityGrants.permissions,
        autonomyState: capabilityGrants.autonomyState,
        maxTrustLevelRequired: capabilityGrants.maxTrustLevelRequired,
        revokedAt: capabilityGrants.revokedAt,
      })
      .from(capabilityGrants)
      .innerJoin(capabilities, eq(capabilityGrants.capabilityId, capabilities.id))
      .where(and(eq(capabilityGrants.agentDefinitionId, agent.id), eq(capabilityGrants.agentDefinitionVersion, agent.version)));

    const runRows = await deps.db.query.runs.findMany({
      where: and(eq(runs.agentDefinitionId, agent.id), eq(runs.agentDefinitionVersion, agent.version)),
      orderBy: (r, { desc: descOrder }) => descOrder(r.startedAt),
      limit: AGENT_RECENT_RUNS,
    });
    const runIds = runRows.map((r) => r.id);

    const runSummaries = [];
    for (const run of runRows) {
      const taskInstance = await deps.db.query.taskInstances.findFirst({ where: eq(taskInstances.id, run.taskInstanceId) });
      const taskDefinition = taskInstance
        ? await deps.db.query.taskDefinitions.findFirst({
            where: and(
              eq(taskDefinitions.id, taskInstance.taskDefinitionId),
              eq(taskDefinitions.version, taskInstance.taskDefinitionVersion)
            ),
          })
        : undefined;
      const workflowRun = taskInstance?.workflowRunId
        ? await deps.db.query.workflowRuns.findFirst({ where: eq(workflowRuns.id, taskInstance.workflowRunId) })
        : undefined;
      const goal = workflowRun ? await deps.db.query.goals.findFirst({ where: eq(goals.id, workflowRun.goalId) }) : undefined;
      const [latestInvocation] = await deps.db
        .select({ seqNo: invocations.seqNo, kind: invocations.kind, status: invocations.status })
        .from(invocations)
        .where(eq(invocations.runId, run.id))
        .orderBy(desc(invocations.seqNo))
        .limit(1);
      const outcomeReason = (run.outcome as Record<string, unknown> | null)?.reason;

      runSummaries.push({
        runId: run.id,
        status: run.status,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        outcomeReason: typeof outcomeReason === "string" ? outcomeReason : null,
        taskInstance: taskInstance ? { id: taskInstance.id, status: taskInstance.status } : null,
        taskDefinitionName: taskDefinition?.name ?? null,
        workflowRunId: taskInstance?.workflowRunId ?? null,
        goal: goal ? { id: goal.id, title: goal.title } : null,
        latestInvocation: latestInvocation ?? null,
      });
    }

    const budgetTotals =
      runIds.length > 0
        ? await deps.db
            .select({
              resourceUnit: budgetCounters.resourceUnit,
              consumed: sql<string>`coalesce(sum(${budgetCounters.consumedAmount}), 0)::text`,
              reserved: sql<string>`coalesce(sum(${budgetCounters.reservedAmount}), 0)::text`,
            })
            .from(budgetCounters)
            .where(and(eq(budgetCounters.scope, "run"), inArray(budgetCounters.scopeRefId, runIds)))
            .groupBy(budgetCounters.resourceUnit)
            .orderBy(budgetCounters.resourceUnit)
        : [];

    const recentEvents =
      runIds.length > 0
        ? (
            await deps.db
              .select()
              .from(events)
              .where(inArray(events.runId, runIds))
              .orderBy(desc(events.globalSeq))
              .limit(AGENT_RECENT_EVENTS)
          ).map((row) => {
            const envelope = rowToEventEnvelope(row);
            return {
              eventId: envelope.eventId,
              eventType: envelope.eventType,
              occurredAt: envelope.occurredAt,
              runId: envelope.correlation.runId,
              invocationId: envelope.correlation.invocationId,
              eventCursor: envelope.eventCursor,
            };
          })
        : [];

    const outputs =
      runIds.length > 0
        ? await deps.db
            .select({
              id: artifacts.id,
              type: artifacts.type,
              size: artifacts.size,
              createdAt: artifacts.createdAt,
              invocationId: invocations.id,
              runId: invocations.runId,
            })
            .from(artifacts)
            .innerJoin(invocations, eq(artifacts.producingInvocationId, invocations.id))
            .where(inArray(invocations.runId, runIds))
            .orderBy(desc(artifacts.createdAt))
            .limit(AGENT_RECENT_OUTPUTS)
        : [];

    const [lineageRow] =
      runIds.length > 0
        ? await deps.db
            .select()
            .from(events)
            .where(and(inArray(events.runId, runIds), eq(events.eventType, "context_compiled")))
            .orderBy(desc(events.globalSeq))
            .limit(1)
        : [];
    const lineagePayload = (lineageRow?.payload ?? {}) as Record<string, unknown>;
    const contextLineage = lineageRow
      ? {
          invocationId: lineageRow.invocationId,
          occurredAt: lineageRow.occurredAt,
          intent: typeof lineagePayload.intent === "string" ? lineagePayload.intent : null,
          estimatedInputTokens:
            typeof lineagePayload.estimatedInputTokens === "number" ? lineagePayload.estimatedInputTokens : null,
          maxInputTokens: typeof lineagePayload.maxInputTokens === "number" ? lineagePayload.maxInputTokens : null,
          included: Array.isArray(lineagePayload.included) ? lineagePayload.included : [],
          excluded: Array.isArray(lineagePayload.excluded) ? lineagePayload.excluded : [],
        }
      : null;

    return reply.send({
      agent: { id: agent.id, name: agent.name, version: agent.version, role: agent.role, objective: agent.objective },
      activeStop: activeStop ?? null,
      grants: grantRows.map((g) => ({
        id: g.id,
        capabilityId: g.capabilityId,
        capabilityName: g.capabilityName,
        permissions: g.permissions,
        autonomyState: g.autonomyState,
        maxTrustLevelRequired: g.maxTrustLevelRequired,
        revoked: g.revokedAt !== null,
      })),
      runs: runSummaries,
      budgetTotals,
      recentEvents,
      outputs,
      contextLineage,
      performance: null,
    });
  });

  app.get("/agents/active", async (_request, reply) => {
    const activeRuns = await deps.db.query.runs.findMany({
      where: notInArray(runs.status, [...TERMINAL_RUN_STATUSES]),
      orderBy: (r, { desc: descOrder }) => descOrder(r.startedAt),
    });

    const agents: ActiveAgentData[] = [];
    for (const run of activeRuns) {
      const taskInstance = await deps.db.query.taskInstances.findFirst({
        where: eq(taskInstances.id, run.taskInstanceId),
      });
      const agentDefinition = run.agentDefinitionId
        ? await deps.db.query.agentDefinitions.findFirst({ where: eq(agentDefinitions.id, run.agentDefinitionId) })
        : null;
      const latestActivitySummary = await latestActivitySummaryForRun(deps, run.id);

      agents.push({
        agentDefinitionId: run.agentDefinitionId,
        agentName: agentDefinition?.name ?? "Unassigned",
        runId: run.id,
        taskInstanceId: run.taskInstanceId,
        taskStatus: taskInstance?.status ?? "unknown",
        latestActivitySummary,
      });
    }

    return reply.send({ agents });
  });
}
