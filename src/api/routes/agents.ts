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
import { desc, eq, notInArray } from "drizzle-orm";
import { agentDefinitions, events, runs, taskInstances } from "../../db/schema.js";
import type { ApiDeps } from "../server.js";
import { rowToEventEnvelope } from "../eventEnvelopeRow.js";

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
