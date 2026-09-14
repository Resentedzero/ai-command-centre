/**
 * `GET /artifacts/:id` — one Artifact with its provenance (spec §15.1 screen 2
 * "outputs (linked Artifacts)", screen 8 "Artifacts … with provenance chains
 * visible", §5.13 lineage). Read-only.
 *
 * - `artifact`: metadata, a bounded `preview` of inline content (the same bound
 *   the Approval queue uses) with `truncated`, and `contentHashMatches` — whether
 *   the stored content still hashes to the stored hash (null when there is no
 *   inline content; nothing is read from the filesystem here). The preview is
 *   model or tool output: clients render it as text, never HTML.
 * - `producedBy`: producing Invocation → Run (Agent version) → Task Instance
 *   (Task Definition) → Workflow Run → Goal. Null for an Artifact with no
 *   producing Invocation.
 * - `referencedBy`: every compiled context that included this Artifact, from the
 *   `context_compiled` events' `included` provenance (version and hash as they went
 *   in), newest first, at most REFERENCE_LIMIT, with `referencedByTruncated`.
 */
import type { FastifyInstance } from "fastify";
import { and, desc, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { agentDefinitions, artifacts, events, goals, invocations, runs, taskDefinitions, taskInstances, workflowRuns } from "../../db/schema.js";
import type { ApiDeps } from "../server.js";
import { isUuid } from "../requestGuards.js";
import { APPROVAL_PREVIEW_CHARS } from "./approvals.js";

const REFERENCE_LIMIT = 100;

export function registerArtifactsRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get<{ Params: { id: string } }>("/artifacts/:id", async (request, reply) => {
    const artifactId = request.params.id;
    if (!isUuid(artifactId)) return reply.status(400).send({ error: "artifact id must be a UUID" });
    const row = await deps.db.query.artifacts.findFirst({ where: eq(artifacts.id, artifactId) });
    if (!row) return reply.status(404).send({ error: `No artifact found for id "${artifactId}"` });

    const [producer] = row.producingInvocationId
      ? await deps.db
          .select({
            invocationId: invocations.id,
            invocationKind: invocations.kind,
            seqNo: invocations.seqNo,
            runId: runs.id,
            taskInstanceId: taskInstances.id,
            taskDefinitionId: taskDefinitions.id,
            taskDefinitionName: taskDefinitions.name,
            taskDefinitionVersion: taskInstances.taskDefinitionVersion,
            agentDefinitionId: runs.agentDefinitionId,
            agentName: agentDefinitions.name,
            agentVersion: runs.agentDefinitionVersion,
            workflowRunId: taskInstances.workflowRunId,
            goalId: goals.id,
            goalTitle: goals.title,
          })
          .from(invocations)
          .innerJoin(runs, eq(runs.id, invocations.runId))
          .innerJoin(taskInstances, eq(taskInstances.id, runs.taskInstanceId))
          .innerJoin(taskDefinitions, eq(taskDefinitions.id, taskInstances.taskDefinitionId))
          .leftJoin(agentDefinitions, eq(agentDefinitions.id, runs.agentDefinitionId))
          .leftJoin(workflowRuns, eq(workflowRuns.id, taskInstances.workflowRunId))
          .leftJoin(goals, eq(goals.id, workflowRuns.goalId))
          .where(eq(invocations.id, row.producingInvocationId))
      : [];

    // `included` entries are `{ id, tier, kind, trusted, estimatedTokens, version?, hash? }` (context/types.ts).
    // ponytail: jsonb containment with no index scans context_compiled events on each request;
    // add a partial index on event_type = 'context_compiled' (or GIN on payload->'included') when it shows.
    const referenceRows = await deps.db
      .select({ invocationId: events.invocationId, runId: events.runId, occurredAt: events.occurredAt, payload: events.payload })
      .from(events)
      .where(
        and(
          eq(events.eventType, "context_compiled"),
          sql`${events.payload}->'included' @> ${JSON.stringify([{ id: artifactId }])}::jsonb`
        )
      )
      .orderBy(desc(events.globalSeq))
      .limit(REFERENCE_LIMIT + 1);

    const content = row.inlineContent;
    return reply.send({
      artifact: {
        id: row.id,
        type: row.type,
        version: row.version,
        size: row.size,
        hash: row.hash,
        summary: row.summary,
        createdAt: row.createdAt,
        storedInline: content !== null,
        preview: content === null ? null : content.slice(0, APPROVAL_PREVIEW_CHARS),
        truncated: content !== null && content.length > APPROVAL_PREVIEW_CHARS,
        contentHashMatches: content === null ? null : createHash("sha256").update(content).digest("hex") === row.hash,
      },
      producedBy: producer
        ? {
            invocation: { id: producer.invocationId, kind: producer.invocationKind, seqNo: producer.seqNo },
            runId: producer.runId,
            agent:
              producer.agentDefinitionId === null
                ? null
                : { id: producer.agentDefinitionId, name: producer.agentName, version: producer.agentVersion },
            taskInstanceId: producer.taskInstanceId,
            taskDefinition: { id: producer.taskDefinitionId, name: producer.taskDefinitionName, version: producer.taskDefinitionVersion },
            workflowRunId: producer.workflowRunId,
            goal: producer.goalId === null ? null : { id: producer.goalId, title: producer.goalTitle },
          }
        : null,
      referencedBy: referenceRows.slice(0, REFERENCE_LIMIT).map((r) => {
        const included = ((r.payload as { included?: Record<string, unknown>[] }).included ?? []).find((i) => i.id === artifactId) ?? {};
        return {
          invocationId: r.invocationId,
          runId: r.runId,
          occurredAt: r.occurredAt,
          kind: included.kind ?? null,
          tier: included.tier ?? null,
          version: included.version ?? null,
          hash: included.hash ?? null,
        };
      }),
      referencedByTruncated: referenceRows.length > REFERENCE_LIMIT,
    });
  });
}
