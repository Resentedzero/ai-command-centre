/**
 * Cost and Budget views (spec §15.1 screen 7, §8.5, §10.5; roadmap V2). Read-only.
 *
 *   GET /costs?scope=<budget_counter_scope>
 *
 * - `counters`: `budget_counters` rows, most recently updated first, optionally one
 *   scope. At most COUNTER_LIMIT; `countersTruncated` says when more exist, and
 *   `totals[].counters` is the true count. Amounts are the exact stored decimal
 *   strings; each row is one unit. A `run` counter carries its Agent and Task
 *   Definition names. A `day` key is echoed verbatim: its timezone is an open
 *   decision (ROADMAP_STATUS §6), so it is not interpreted here. `limitAmount` is
 *   the limit stored when the counter was created: enforced for a run counter, and
 *   for a day counter only while a ceiling for its unit is configured.
 * - `totals`: consumed and reserved per (scope, unit), summed in SQL over every
 *   counter, never across units. Limits are not summed: a sum of per-Run limits is
 *   not a limit. Do not add totals across scopes: the same spend is held at a run
 *   and a day counter once day ceilings exist. `reserved` can include a hold an
 *   interrupted Invocation never released (budget.ts has no reservation ledger).
 * - `costVsSuccess`: `agent_performance` rows with Agent and Task Definition names
 *   (§10.5). Shown whatever the sample count. It is a measurement, not a
 *   recommendation: no minimum sample criterion exists yet (NEXT_PHASE_PLAN §7),
 *   so nothing here ranks tiers or suggests a change.
 */
import type { FastifyInstance } from "fastify";
import { desc, eq, inArray, sql } from "drizzle-orm";
import {
  agentDefinitions,
  agentPerformance,
  budgetCounters,
  budgetCounterScope,
  runs,
  taskDefinitions,
  taskInstances,
} from "../../db/schema.js";
import type { ApiDeps } from "../server.js";

const COUNTER_LIMIT = 500;

type Scope = (typeof budgetCounterScope.enumValues)[number];

export function registerCostsRoutes(app: FastifyInstance, deps: ApiDeps): void {
  // A repeated ?scope= arrives as an array and is refused like any other non-scope value.
  app.get<{ Querystring: { scope?: string | string[] } }>("/costs", async (request, reply) => {
    const scope = request.query.scope;
    if (scope !== undefined && (typeof scope !== "string" || !budgetCounterScope.enumValues.includes(scope as Scope))) {
      return reply.status(400).send({ error: `scope must be one of ${budgetCounterScope.enumValues.join(", ")}` });
    }
    const scopeFilter = scope === undefined ? undefined : eq(budgetCounters.scope, scope as Scope);

    const [counterRows, totals, performanceRows] = await Promise.all([
      deps.db
        .select()
        .from(budgetCounters)
        .where(scopeFilter)
        .orderBy(desc(budgetCounters.updatedAt), budgetCounters.scopeRefId, budgetCounters.resourceUnit)
        .limit(COUNTER_LIMIT + 1),
      deps.db
        .select({
          scope: budgetCounters.scope,
          resourceUnit: budgetCounters.resourceUnit,
          consumed: sql<string>`sum(${budgetCounters.consumedAmount})::text`,
          reserved: sql<string>`sum(${budgetCounters.reservedAmount})::text`,
          counters: sql<number>`count(*)::int`,
        })
        .from(budgetCounters)
        .where(scopeFilter)
        .groupBy(budgetCounters.scope, budgetCounters.resourceUnit)
        .orderBy(budgetCounters.scope, budgetCounters.resourceUnit),
      deps.db
        .select({
          agentDefinitionId: agentPerformance.agentDefinitionId,
          agentName: agentDefinitions.name,
          agentVersion: agentPerformance.agentDefinitionVersion,
          taskDefinitionId: agentPerformance.taskDefinitionId,
          taskDefinitionName: taskDefinitions.name,
          modelTier: agentPerformance.modelTier,
          sampleCount: agentPerformance.sampleCount,
          successRate: agentPerformance.successRate,
          avgRetries: agentPerformance.avgRetries,
          avgCost: agentPerformance.avgCost,
          updatedAt: agentPerformance.updatedAt,
        })
        .from(agentPerformance)
        .innerJoin(agentDefinitions, eq(agentDefinitions.id, agentPerformance.agentDefinitionId))
        .innerJoin(taskDefinitions, eq(taskDefinitions.id, agentPerformance.taskDefinitionId))
        .orderBy(taskDefinitions.name, agentDefinitions.name, agentPerformance.agentDefinitionVersion, agentPerformance.modelTier),
    ]);

    const shown = counterRows.slice(0, COUNTER_LIMIT);
    // Labels for the shown Run counters only, by primary key. A run counter's key is a Run id.
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const runIds = [...new Set(shown.filter((c) => c.scope === "run" && UUID.test(c.scopeRefId)).map((c) => c.scopeRefId))];
    const labels =
      runIds.length === 0
        ? []
        : await deps.db
            .select({ runId: runs.id, agentName: agentDefinitions.name, agentVersion: agentDefinitions.version, taskDefinitionName: taskDefinitions.name })
            .from(runs)
            .leftJoin(agentDefinitions, eq(agentDefinitions.id, runs.agentDefinitionId))
            .innerJoin(taskInstances, eq(taskInstances.id, runs.taskInstanceId))
            .innerJoin(taskDefinitions, eq(taskDefinitions.id, taskInstances.taskDefinitionId))
            .where(inArray(runs.id, runIds));
    const labelByRun = new Map(labels.map((l) => [l.runId, l]));

    return reply.send({
      counters: shown.map((c) => {
        const label = c.scope === "run" ? labelByRun.get(c.scopeRefId) : undefined;
        return {
          scope: c.scope,
          scopeRefId: c.scopeRefId,
          resourceUnit: c.resourceUnit,
          limitAmount: c.limitAmount,
          reservedAmount: c.reservedAmount,
          consumedAmount: c.consumedAmount,
          updatedAt: c.updatedAt,
          run:
            c.scope === "run"
              ? {
                  agent: label?.agentName ? { name: label.agentName, version: label.agentVersion } : null,
                  taskDefinitionName: label?.taskDefinitionName ?? null,
                }
              : null,
        };
      }),
      countersTruncated: counterRows.length > COUNTER_LIMIT,
      totals,
      costVsSuccess: performanceRows,
    });
  });
}
