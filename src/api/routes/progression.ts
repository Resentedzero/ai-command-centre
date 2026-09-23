/**
 * Agent progression (R2): the operator's quality verdicts, and the read model of a persistent
 * agent's progression.
 *
 *   POST /quality-verdicts                    — { artifactId, verdict, rationale? }: the operator judges an artifact
 *   GET  /artifacts/:id/quality-verdicts      — that artifact's verdict history, newest first
 *   GET  /agent-progression/:name             — XP, level, awards, achievements, specialisation, reputation signals
 *
 * A QUALITY VERDICT IS THE OPERATOR'S, AND ONLY THE OPERATOR'S. This route is the one writer of
 * `quality_verdict_recorded` (structural invariant): no capability, loop action or model output can
 * emit it, so an agent can never grade its own work. It is not approval — approving an action says
 * the agent may do it, a verdict says how good the result was — and neither implies the other.
 * The event records the verdict, the actor, the artifact and its hash, the agent and Run that
 * produced it (resolved here, and re-derived by the projection rather than trusted) and the verdict
 * it replaces. Only the latest verdict on an artifact counts for XP. A verdict grants nothing.
 *
 * The verdict event carries no Run correlation on purpose: it is a later judgement about a Run's
 * output, not a step of that Run, so it never enters the Run's own event sequence.
 */
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { ApiDeps } from "../server.js";
import { isUuid } from "../requestGuards.js";
import {
  agentAchievements,
  agentDefinitions,
  agentDomainWork,
  agentEndorsements,
  agentXpAwards,
  artifacts,
  events,
  invocations,
  runs,
} from "../../db/schema.js";
import { emitLifecycleEvent, NO_CORRELATION } from "../../events/lifecycle.js";
import { relayCommittedEvent } from "../liveEventRelay.js";
import { V1_RESOLUTION_ACTOR } from "./approvals.js";
import { refreshAgentProgression } from "../../projections/agentProgression.js";
import {
  ACHIEVEMENTS,
  QUALITY_VERDICTS,
  REPUTATION_MIN_VERDICTS,
  SPECIALISATION_MIN_RUNS,
  VERDICT_XP,
  levelFor,
  type QualityVerdict,
} from "../../projections/progressionRules.js";

export const QUALITY_VERDICT_RECORDED = "quality_verdict_recorded";
const MAX_RATIONALE = 1_000;

export function registerProgressionRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.post("/quality-verdicts", async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;
    if (body === null || typeof body !== "object" || Array.isArray(body)) return reply.status(400).send({ error: "The request body must be a JSON object." });
    const { artifactId, verdict, rationale } = body;
    if (typeof artifactId !== "string" || !isUuid(artifactId)) return reply.status(400).send({ error: "artifactId must be a UUID" });
    if (typeof verdict !== "string" || !(QUALITY_VERDICTS as readonly string[]).includes(verdict)) {
      return reply.status(400).send({ error: `verdict must be one of ${QUALITY_VERDICTS.join(", ")}` });
    }
    if (rationale !== undefined && rationale !== null && (typeof rationale !== "string" || rationale.length > MAX_RATIONALE)) {
      return reply.status(400).send({ error: `rationale must be text of at most ${MAX_RATIONALE} characters` });
    }

    const verdictId = randomUUID();
    const result = await deps.db.transaction(async (tx) => {
      const artifact = await tx.query.artifacts.findFirst({ where: eq(artifacts.id, artifactId) });
      if (!artifact) return null;
      const [producer] = artifact.producingInvocationId
        ? await tx
            .select({ runId: runs.id, agentName: agentDefinitions.name, agentVersion: agentDefinitions.version })
            .from(invocations)
            .innerJoin(runs, eq(runs.id, invocations.runId))
            .leftJoin(agentDefinitions, eq(agentDefinitions.id, runs.agentDefinitionId))
            .where(eq(invocations.id, artifact.producingInvocationId))
        : [];
      const [previous] = await tx
        .select({ payload: events.payload })
        .from(events)
        .where(and(eq(events.eventType, QUALITY_VERDICT_RECORDED), sql`${events.payload}->>'artifactId' = ${artifactId}`))
        .orderBy(desc(events.globalSeq))
        .limit(1);
      const payload = {
        verdictId,
        verdict,
        rationale: typeof rationale === "string" && rationale.trim() !== "" ? rationale.trim() : null,
        artifactId,
        artifactHash: artifact.hash,
        artifactType: artifact.type,
        runId: producer?.runId ?? null,
        agentName: producer?.agentName ?? null,
        agentVersion: producer?.agentVersion ?? null,
        previousVerdict: typeof previous?.payload.verdict === "string" ? previous.payload.verdict : null,
      };
      await emitLifecycleEvent(tx, {
        eventType: QUALITY_VERDICT_RECORDED,
        subjectId: verdictId,
        correlation: NO_CORRELATION,
        producer: "api",
        actor: V1_RESOLUTION_ACTOR,
        payload,
      });
      return payload;
    });
    if (!result) return reply.status(404).send({ error: `No artifact found for id "${artifactId}"` });

    await relayCommittedEvent(deps.db, `${QUALITY_VERDICT_RECORDED}:${verdictId}`);
    // Committed first; the XP it is worth follows on the next rebuild, here or on the projection loop.
    await deps.db.transaction((tx) => refreshAgentProgression(tx)).catch(() => undefined);
    return reply.status(201).send({
      ...result,
      actor: V1_RESOLUTION_ACTOR,
      xp: result.agentName ? VERDICT_XP[verdict as QualityVerdict] : 0,
      note: result.agentName ? null : "No agent produced this artifact, so the verdict is recorded and awards no XP.",
    });
  });

  app.get<{ Params: { id: string } }>("/artifacts/:id/quality-verdicts", async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.status(400).send({ error: "artifact id must be a UUID" });
    const rows = await deps.db
      .select({ id: events.id, actor: events.actor, occurredAt: events.occurredAt, payload: events.payload })
      .from(events)
      .where(and(eq(events.eventType, QUALITY_VERDICT_RECORDED), sql`${events.payload}->>'artifactId' = ${request.params.id}`))
      .orderBy(desc(events.globalSeq));
    return reply.send({
      verdicts: rows.map((r) => ({
        eventId: r.id,
        actor: r.actor,
        occurredAt: r.occurredAt,
        verdict: r.payload.verdict,
        rationale: r.payload.rationale ?? null,
        agentName: r.payload.agentName ?? null,
        previousVerdict: r.payload.previousVerdict ?? null,
      })),
    });
  });

  app.get<{ Params: { name: string } }>("/agent-progression/:name", async (request, reply) => {
    const name = request.params.name;
    if (!(await deps.db.query.agentDefinitions.findFirst({ where: eq(agentDefinitions.name, name) }))) {
      return reply.status(404).send({ error: `No agent named "${name}"` });
    }
    const [awards, achievements, domainWork, received, given, verdicts] = await Promise.all([
      deps.db.select().from(agentXpAwards).where(eq(agentXpAwards.agentName, name)).orderBy(desc(agentXpAwards.earnedAt), agentXpAwards.awardKey),
      deps.db.select().from(agentAchievements).where(eq(agentAchievements.agentName, name)).orderBy(agentAchievements.earnedAt),
      deps.db.select().from(agentDomainWork).where(eq(agentDomainWork.agentName, name)),
      deps.db.select().from(agentEndorsements).where(eq(agentEndorsements.endorsedName, name)),
      deps.db.select().from(agentEndorsements).where(eq(agentEndorsements.endorserName, name)),
      deps.db.select().from(agentXpAwards).where(and(eq(agentXpAwards.agentName, name), eq(agentXpAwards.rule, "quality_verdict"))),
    ]);

    const xp = awards.reduce((sum, a) => sum + a.xp, 0);
    const domains: Record<string, number> = {};
    for (const w of domainWork) domains[w.domain] = (domains[w.domain] ?? 0) + 1;
    const domainTotal = Object.values(domains).reduce((a, b) => a + b, 0);
    const [topDomain, topRuns] = Object.entries(domains).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [null, 0];
    const specialisation = topDomain && topRuns >= SPECIALISATION_MIN_RUNS && topRuns * 2 >= domainTotal ? { domain: topDomain, runs: topRuns } : null;

    const verdictCounts: Record<string, number> = Object.fromEntries(QUALITY_VERDICTS.map((v) => [v, 0]));
    for (const v of verdicts) verdictCounts[String(v.evidence.verdict)] = (verdictCounts[String(v.evidence.verdict)] ?? 0) + 1;
    const independent = received.filter((e) => e.verified && !e.mutual);

    return reply.send({
      name,
      ...levelFor(xp),
      awards: awards.map((a) => ({
        rule: a.rule,
        xp: a.xp,
        awardKey: a.awardKey,
        runId: a.runId,
        workflowRunId: a.workflowRunId,
        goalId: a.goalId,
        artifactId: a.artifactId,
        evidence: a.evidence,
        earnedAt: a.earnedAt,
      })),
      achievements: achievements.map((a) => {
        const [key, domain] = a.achievement.split(":");
        return { achievement: a.achievement, label: ACHIEVEMENTS[key as keyof typeof ACHIEVEMENTS] ?? a.achievement, domain: domain ?? null, earnedAt: a.earnedAt, evidence: a.evidence };
      }),
      specialisation,
      domains,
      specialisationMinRuns: SPECIALISATION_MIN_RUNS,
      reputation: {
        // Signals with their counts, never one score (plan §11).
        verdicts: verdictCounts,
        verdictCount: verdicts.length,
        enoughVerdicts: verdicts.length >= REPUTATION_MIN_VERDICTS,
        minVerdicts: REPUTATION_MIN_VERDICTS,
        independentEndorsers: [...new Set(independent.map((e) => e.endorserName))].sort(),
        mutualEndorsements: received.filter((e) => e.verified && e.mutual).length,
        unverifiedEndorsements: received.filter((e) => !e.verified).length,
      },
      endorsementsGiven: given.filter((e) => e.verified).length,
    });
  });
}
