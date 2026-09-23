/**
 * `GET /agents/active` — Unit 11 (task-11-brief.md, Ruling 1). A genuine
 * gap in Unit 10's own surface: nothing prior to this unit exposes "which
 * agents are working right now" as a single read. This route is new,
 * unspecified-by-any-prior-unit code -- the shape below is this unit's own
 * call, documented here rather than silently assumed.
 *
 * "Active" = a `runs` row whose status is NOT in the terminal set
 * (`"completed"`, `"failed"` -- written by the Executor, `src/execution/executor.ts`).
 * Every other value the column holds today (`"active"` at creation, by the
 * Workflow Interpreter, and `"awaiting_approval"`) represents a Run
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
import { AGENT_STATES, readAgentStates } from "../agentState.js";
import { readOrganisationHistory } from "../organisationHistory.js";
import type { FastifyInstance } from "fastify";
import { derivedAppearance, readAppearances } from "../../definitions/appearance.js";
import { and, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import {
  agentPerformance,
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
import { eligibilityFields } from "../performanceEligibilityFields.js";

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
  /** Spec §15.1 screen 1 "current Task Instance's mission": the Task Definition's name and the Goal's title. */
  taskDefinitionName: string | null;
  /** Null for a standalone Task Instance, which has no Workflow Run to reach a Goal through. */
  goalTitle: string | null;
  latestActivitySummary: string | null;
  /**
   * Living workplace (plan §13): what the Run is doing right now, read from its latest Invocation that
   * is not a bookkeeping step — its kind, status, the Capability it exercises and the intent its
   * context was compiled for. Null before the Run's first such Invocation. Presentation reads it to
   * choose where the agent is drawn working; it decides nothing.
   */
  activity: { invocationKind: string; invocationStatus: string; capability: string | null; intent: string | null; taskKind: string | null } | null;
  /** The Run's Workflow Run and Goal (null for a standalone Task Instance), so a stop at those scopes can be matched. */
  workflowRunId: string | null;
  /** The Workflow Run's own status: `paused` holds the step even while its Task Instance still reads active. */
  workflowRunStatus: string | null;
  goalId: string | null;
};

async function activityForRun(deps: ApiDeps, runId: string): Promise<ActiveAgentData["activity"]> {
  const [latest] = await deps.db
    .select({ id: invocations.id, kind: invocations.kind, status: invocations.status, capability: capabilities.name })
    .from(invocations)
    .leftJoin(capabilities, eq(capabilities.id, invocations.capabilityId))
    .where(and(eq(invocations.runId, runId), sql`${invocations.kind} <> 'deterministic'`))
    .orderBy(desc(invocations.seqNo))
    .limit(1);
  if (!latest) return null;
  const [compiled] = await deps.db
    .select({ payload: events.payload })
    .from(events)
    .where(and(eq(events.runId, runId), eq(events.invocationId, latest.id), eq(events.eventType, "context_compiled")))
    .limit(1);
  const intent = compiled?.payload.intent;
  // The step's Task Definition kind (e.g. keeper_answer): what the work is, recorded when the task was created.
  const [task] = await deps.db
    .select({ kind: taskDefinitions.kind })
    .from(runs)
    .innerJoin(taskInstances, eq(taskInstances.id, runs.taskInstanceId))
    .innerJoin(taskDefinitions, and(eq(taskDefinitions.id, taskInstances.taskDefinitionId), eq(taskDefinitions.version, taskInstances.taskDefinitionVersion)))
    .where(eq(runs.id, runId))
    .limit(1);
  return { invocationKind: latest.kind, invocationStatus: latest.status, capability: latest.capability, intent: typeof intent === "string" ? intent : null, taskKind: task?.kind ?? null };
}

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
   *   - `runs`: every unfinished Run plus its most recent finished ones, with
   *     Task/Goal lineage and latest Invocation.
   *   - `budgetTotals`: consumption over those Runs, summed PER UNIT in SQL
   *     (exact numerics as strings). Units are separate counters, never combined.
   *   - The stop, like every stop scoped to an agent definition, applies to THIS
   *     version only: each version is its own row with its own id.
   *   - `recentEvents`, `outputs` (artifacts its Runs produced), and
   *     `contextLineage` (the latest `context_compiled` payload — ids, tiers,
   *     exclusion reasons, token estimate; never content; spec §5.13).
   *   - `performance`: this version's `agent_performance` rows (per Task Definition
   *     and model tier; avg cost per unit, exact strings). Refreshed asynchronously
   *     (`../../projections/agentPerformance.ts`), so it lags recent Runs, and shown
   *     whatever the sample count. Each row carries `eligible` from the runtime's own
   *     gate (`performanceEligibility`, N = 10): whether the Model Router's tier
   *     preference may use it. Displayed only; this route decides nothing.
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

    // Every UNFINISHED Run, always (spec §15.1 screen 2: the current Task
    // Instance), plus the most recent finished ones. A limit on "newest" alone
    // let a Run parked at an approval gate fall off the page as newer Runs
    // accumulated.
    const agentRuns = and(eq(runs.agentDefinitionId, agent.id), eq(runs.agentDefinitionVersion, agent.version));
    const unfinishedRuns = await deps.db.query.runs.findMany({
      where: and(agentRuns, notInArray(runs.status, [...TERMINAL_RUN_STATUSES])),
      orderBy: (r, { desc: descOrder }) => descOrder(r.startedAt),
    });
    const recentRuns = await deps.db.query.runs.findMany({
      where: agentRuns,
      orderBy: (r, { desc: descOrder }) => descOrder(r.startedAt),
      limit: AGENT_RECENT_RUNS,
    });
    const runRows = [...new Map([...unfinishedRuns, ...recentRuns].map((r) => [r.id, r])).values()].sort(
      (a, b) => b.startedAt.getTime() - a.startedAt.getTime()
    );
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
          // The ceiling the Compiler packed to (the budget capped at the model's window).
          effectiveMaxInputTokens: typeof lineagePayload.effectiveMaxInputTokens === "number" ? lineagePayload.effectiveMaxInputTokens : null,
          // Set only when the Budget Governor tightened the Task's Context Budget for this call.
          budgetOutcome: typeof lineagePayload.budgetOutcome === "string" ? lineagePayload.budgetOutcome : null,
          taskMaxInputTokens: typeof lineagePayload.taskMaxInputTokens === "number" ? lineagePayload.taskMaxInputTokens : null,
          included: Array.isArray(lineagePayload.included) ? lineagePayload.included : [],
          excluded: Array.isArray(lineagePayload.excluded) ? lineagePayload.excluded : [],
        }
      : null;

    const performanceRows = await deps.db
      .select()
      .from(agentPerformance)
      .where(and(eq(agentPerformance.agentDefinitionId, agent.id), eq(agentPerformance.agentDefinitionVersion, agent.version)))
      .orderBy(agentPerformance.taskDefinitionId, agentPerformance.modelTier);

    // R2 progression: the same measured outcomes summed over every version of this agent's name, so
    // a new version keeps its history. Display only; nothing decides on it (decisions stay per version).
    const [acrossVersions] = await deps.db
      .select({
        samples: sql<number>`COALESCE(SUM(${agentPerformance.sampleCount}), 0)::int`,
        successes: sql<number>`COALESCE(ROUND(SUM(${agentPerformance.successRate} * ${agentPerformance.sampleCount})), 0)::int`,
        versions: sql<number>`COUNT(DISTINCT ${agentPerformance.agentDefinitionVersion})::int`,
      })
      .from(agentPerformance)
      .innerJoin(agentDefinitions, eq(agentDefinitions.id, agentPerformance.agentDefinitionId))
      .where(eq(agentDefinitions.name, agent.name));

    return reply.send({
      agent: {
        id: agent.id,
        name: agent.name,
        version: agent.version,
        role: agent.role,
        objective: agent.objective,
        // Instructions stay in the Registry read (`GET /registry`); this read model never carries them.
        executionProfile: agent.executionProfile,
        // Presentation only, keyed on the persistent name so every version looks the same; null = none chosen.
        appearance: (await readAppearances(deps.db, [agent.name])).get(agent.name) ?? null,
        // How it is drawn: the chosen appearance, else the look derived from its name (D28, never stored).
        look: (await readAppearances(deps.db, [agent.name])).get(agent.name) ?? derivedAppearance(agent.name),
      },
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
      performanceAcrossVersions: acrossVersions ?? { samples: 0, successes: 0, versions: 0 },
      performance: performanceRows.map((p) => ({
        taskDefinitionId: p.taskDefinitionId,
        modelTier: p.modelTier,
        sampleCount: p.sampleCount,
        successRate: p.successRate,
        avgRetries: p.avgRetries,
        avgCost: p.avgCost,
        updatedAt: p.updatedAt,
        ...eligibilityFields(p.sampleCount),
      })),
    });
  });

  /**
   * `GET /agents/state` — what every agent is doing now, one deterministic answer (`../agentState.ts`).
   * Read-only, no model, no writes. The living world, the agent views and the Keeper all render THIS,
   * rather than each deriving a state vocabulary of their own.
   */
  app.get("/agents/state", async (_request, reply) => {
    return reply.send({ agents: await readAgentStates(deps.db), states: AGENT_STATES });
  });

  /**
   * `GET /organisation/history` — what the Keep DID, bounded (`../organisationHistory.ts`).
   * Read-only, no model, no writes. `hours` and `limit` are clamped; there is no free-text filter and no
   * "everything" query. Every record carries the ids that prove it and whether it was recorded or
   * calculated. Artifact CONTENT is never returned — only ids and hashes.
   */
  app.get<{ Querystring: { hours?: string; limit?: string } }>("/organisation/history", async (request, reply) => {
    const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
    const hours = num(request.query.hours);
    const limit = num(request.query.limit);
    if ((hours !== undefined && !Number.isFinite(hours)) || (limit !== undefined && !Number.isFinite(limit))) {
      return reply.status(400).send({ error: "hours and limit must be numbers." });
    }
    return reply.send(await readOrganisationHistory(deps.db, { ...(hours === undefined ? {} : { hours }), ...(limit === undefined ? {} : { limit }) }));
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
      const taskDefinition = taskInstance
        ? await deps.db.query.taskDefinitions.findFirst({ where: eq(taskDefinitions.id, taskInstance.taskDefinitionId) })
        : undefined;
      const workflowRun = taskInstance?.workflowRunId
        ? await deps.db.query.workflowRuns.findFirst({ where: eq(workflowRuns.id, taskInstance.workflowRunId) })
        : undefined;
      const goal = workflowRun ? await deps.db.query.goals.findFirst({ where: eq(goals.id, workflowRun.goalId) }) : undefined;
      const latestActivitySummary = await latestActivitySummaryForRun(deps, run.id);

      agents.push({
        agentDefinitionId: run.agentDefinitionId,
        agentName: agentDefinition?.name ?? "Unassigned",
        runId: run.id,
        taskInstanceId: run.taskInstanceId,
        taskStatus: taskInstance?.status ?? "unknown",
        taskDefinitionName: taskDefinition?.name ?? null,
        goalTitle: goal?.title ?? null,
        latestActivitySummary,
        activity: await activityForRun(deps, run.id),
        workflowRunId: workflowRun?.id ?? null,
        workflowRunStatus: workflowRun?.status ?? null,
        goalId: goal?.id ?? null,
      });
    }

    return reply.send({ agents });
  });
}
