/**
 * `GET /runs/:id/trace` — spec §8.4: "A 'trace' is a query: all events where
 * `run_id = X`, ordered by `sequence_no`, joined with each Invocation's
 * context-lineage stamp. No separate tracing system." Read-only.
 *
 * - `events`: every event of the Run as wire envelopes, in `sequence_no` order
 *   (authoritative within a Run; `global_seq` is not — `../eventEnvelopeRow.ts`).
 *   Payloads are what the SSE stream already delivers: failure text is redacted
 *   where it is written, and binding config never enters an event.
 * - `invocations`: each Invocation in `seq_no` order with its `context_compiled`
 *   lineage (ids, tiers, versions, hashes, exclusions, token estimate — never
 *   content, spec §5.13), or null when it compiled none (tools, deterministic), and
 *   `policyEvaluations`: Policy's record at each checkpoint, in sequence order (tool
 *   Invocations only; `../policyDecisionRecord.ts`), and `budgetOutcome`
 *   (`../budgetOutcome.ts`).
 *
 * Events not tied to a Run (`goal_created`, `workflow_run_started`, stops,
 * revocations) are outside a Run's trace by the spec's definition.
 */
import type { FastifyInstance } from "fastify";
import { asc, eq } from "drizzle-orm";
import { events, invocations, runs } from "../../db/schema.js";
import type { ApiDeps } from "../server.js";
import { isUuid } from "../requestGuards.js";
import { rowToEventEnvelope } from "../eventEnvelopeRow.js";
import { toPolicyDecisionRecord } from "../policyDecisionRecord.js";
import { budgetOutcomeOf } from "../budgetOutcome.js";

export function registerTraceRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get<{ Params: { id: string } }>("/runs/:id/trace", async (request, reply) => {
    const runId = request.params.id;
    if (!isUuid(runId)) return reply.status(400).send({ error: "run id must be a UUID" });
    const run = await deps.db.query.runs.findFirst({ where: eq(runs.id, runId) });
    if (!run) return reply.status(404).send({ error: `No run found for id "${runId}"` });

    const [eventRows, invocationRows] = await Promise.all([
      deps.db.select().from(events).where(eq(events.runId, runId)).orderBy(asc(events.sequenceNo)),
      deps.db.select().from(invocations).where(eq(invocations.runId, runId)).orderBy(asc(invocations.seqNo)),
    ]);
    const lineageByInvocation = new Map(
      eventRows.filter((e) => e.eventType === "context_compiled").map((e) => [e.invocationId, e.payload])
    );

    const payloadOf = (eventType: string, invocationId: string) =>
      eventRows.find((e) => e.eventType === eventType && e.invocationId === invocationId)?.payload;

    return reply.send({
      run: {
        id: run.id,
        taskInstanceId: run.taskInstanceId,
        agentDefinitionId: run.agentDefinitionId,
        agentDefinitionVersion: run.agentDefinitionVersion,
        status: run.status,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
      },
      events: eventRows.map(rowToEventEnvelope),
      invocations: invocationRows.map((i) => ({
        id: i.id,
        seqNo: i.seqNo,
        kind: i.kind,
        status: i.status,
        capabilityId: i.capabilityId,
        permission: i.permission,
        toolBindingId: i.toolBindingId,
        startedAt: i.startedAt,
        completedAt: i.completedAt,
        contextLineage: lineageByInvocation.get(i.id) ?? null,
        policyEvaluations: eventRows
          .filter((e) => e.eventType === "policy_evaluated" && e.invocationId === i.id)
          .map((e) => toPolicyDecisionRecord(e.payload)),
        budgetOutcome: budgetOutcomeOf(i, {
          startedPayload: payloadOf("invocation_started", i.id),
          failedPayload: payloadOf("invocation_failed", i.id),
          preDispatchChecked: eventRows.some(
            (e) => e.eventType === "policy_evaluated" && e.invocationId === i.id && (e.payload as { checkpoint?: unknown }).checkpoint === "pre_dispatch"
          ),
          approvalRequired: eventRows.some((e) => e.eventType === "approval_required" && e.invocationId === i.id),
        }),
      })),
    });
  });
}
