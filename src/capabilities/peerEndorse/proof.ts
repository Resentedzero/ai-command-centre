/**
 * The anti-fabrication rule for `peer.endorse`, decided by code from persisted rows — never by
 * what the model wrote. An endorsement is allowed only if:
 *  1. the artifact exists and is a `deliverable`;
 *  2. the endorsing Run's own `context_compiled` events included that artifact id WITH its stored
 *     hash (the agent actually received exactly this content);
 *  3. a different agent (another persistent name) produced it — no self- or same-lineage endorsement;
 *  4. this agent has not already endorsed it.
 * The proven snapshot carries the hash, the endorsing Run and the endorsed agent from the record,
 * not from the decision. The progression projection proves it again before counting it.
 */
import { and, eq, sql } from "drizzle-orm";
import { agentDefinitions, artifacts, capabilities, events, invocations, runs } from "../../db/schema.js";
import type { DrizzleTransaction } from "../../events/emit.js";
import { PEER_ENDORSE_CAPABILITY } from "./capability.js";

export const MAX_ENDORSEMENT_REASON = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EndorsementSnapshot = { artifactId: string; artifactHash: string; endorserRunId: string; endorsedAgentName: string; reason: string };

async function agentNameOfRun(tx: DrizzleTransaction, runId: string): Promise<string | null> {
  const [row] = await tx
    .select({ name: agentDefinitions.name })
    .from(runs)
    .innerJoin(agentDefinitions, eq(agentDefinitions.id, runs.agentDefinitionId))
    .where(eq(runs.id, runId));
  return row?.name ?? null;
}

export async function proveEndorsement(
  tx: DrizzleTransaction,
  request: { endorserRunId: string; artifactId: string; reason: string }
): Promise<{ ok: true; snapshot: EndorsementSnapshot } | { ok: false; reason: string }> {
  const { endorserRunId, artifactId } = request;
  const reason = request.reason.trim();
  if (!UUID.test(artifactId)) return { ok: false, reason: "an endorsement must name an artifact id" };
  if (reason === "" || reason.length > MAX_ENDORSEMENT_REASON) {
    return { ok: false, reason: `an endorsement needs a reason of 1 to ${MAX_ENDORSEMENT_REASON} characters` };
  }

  const artifact = await tx.query.artifacts.findFirst({ where: eq(artifacts.id, artifactId) });
  if (!artifact) return { ok: false, reason: "that artifact does not exist" };
  if (artifact.type !== "deliverable") return { ok: false, reason: "only a deliverable can be endorsed" };

  const [received] = await tx
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.runId, endorserRunId),
        eq(events.eventType, "context_compiled"),
        sql`${events.payload}->'included' @> ${JSON.stringify([{ id: artifactId, hash: artifact.hash }])}::jsonb`
      )
    )
    .limit(1);
  if (!received) return { ok: false, reason: "this run never received that artifact in its context, so it cannot endorse it" };

  const endorser = await agentNameOfRun(tx, endorserRunId);
  const [producer] = artifact.producingInvocationId
    ? await tx
        .select({ name: agentDefinitions.name })
        .from(invocations)
        .innerJoin(runs, eq(runs.id, invocations.runId))
        .innerJoin(agentDefinitions, eq(agentDefinitions.id, runs.agentDefinitionId))
        .where(eq(invocations.id, artifact.producingInvocationId))
    : [];
  if (!endorser || !producer) return { ok: false, reason: "the endorsing agent or the artifact's producing agent is unknown" };
  if (producer.name === endorser) return { ok: false, reason: "an agent cannot endorse its own lineage's work" };

  const [already] = await tx
    .select({ id: invocations.id })
    .from(invocations)
    .innerJoin(capabilities, and(eq(capabilities.id, invocations.capabilityId), eq(capabilities.name, PEER_ENDORSE_CAPABILITY.id)))
    .innerJoin(runs, eq(runs.id, invocations.runId))
    .innerJoin(agentDefinitions, eq(agentDefinitions.id, runs.agentDefinitionId))
    .where(and(eq(agentDefinitions.name, endorser), eq(invocations.status, "completed"), sql`${invocations.proposedActionSnapshot}->>'artifactId' = ${artifactId}`))
    .limit(1);
  if (already) return { ok: false, reason: "this agent has already endorsed that artifact" };

  return { ok: true, snapshot: { artifactId, artifactHash: artifact.hash, endorserRunId, endorsedAgentName: producer.name, reason } };
}
