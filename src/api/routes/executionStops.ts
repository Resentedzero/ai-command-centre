/**
 * Emergency-stop control plane (frozen spec Phase 9.7).
 *
 *   GET  /execution-stops                    — list ACTIVE stops
 *   POST /execution-stops                    — engage { scope, scopeRefId?, reason? }
 *   POST /execution-stops/lift               — lift   { scope, scopeRefId? }
 *
 * TWO TRANSACTIONS PER MUTATION, deliberately. The state flip commits first, on
 * its own, and only then is the audit event written. A single transaction would
 * let the event's advisory lock hold the stop row uncommitted for as long as a
 * running Run holds that lock — i.e. a stop on a live Run could not take effect
 * until the Run had finished. See `../../governance/executionStop.ts`.
 *
 * If the event write fails after the flip committed, the stop is STILL ACTIVE
 * and the request reports the failure. That is the safe direction: enforcement
 * reads the stop table, never the event log.
 *
 * Deliberately does NOT drive workflow advancement — stopping should never
 * itself cause more work to happen, mirroring `POST /workflow-runs/:id/pause`.
 * Lifting a stop likewise resumes nothing: it only stops refusing.
 *
 * The actor is the server-side constant `V1_STOP_ACTOR`, never read from the
 * request body — see that constant's doc for why.
 */
import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "../server.js";
import {
  engageStop,
  liftStop,
  listActiveStops,
  normalizeStopTarget,
  recordStopEvent,
  type ExecutionStopScope,
} from "../../governance/executionStop.js";

const SCOPES: readonly ExecutionStopScope[] = [
  "global",
  "agent_definition",
  "capability_grant",
  "goal",
  "workflow_run",
  "run",
];

function isScope(value: unknown): value is ExecutionStopScope {
  return typeof value === "string" && (SCOPES as readonly string[]).includes(value);
}

type StopBody = { scope?: unknown; scopeRefId?: unknown; reason?: unknown };

/** Validates the request body. Returns an error message, or null when valid. */
function validate(body: StopBody): string | null {
  if (!isScope(body.scope)) {
    return `"scope" must be one of: ${SCOPES.join(", ")}`;
  }
  if (body.scopeRefId !== undefined && body.scopeRefId !== null && typeof body.scopeRefId !== "string") {
    return `"scopeRefId" must be a string when provided`;
  }
  if (body.reason !== undefined && body.reason !== null && typeof body.reason !== "string") {
    return `"reason" must be a string when provided`;
  }
  try {
    // The same validation the governance module enforces, run first so a bad
    // target is a clean 400 rather than a 500 from deeper in the stack.
    normalizeStopTarget(body.scope, typeof body.scopeRefId === "string" ? body.scopeRefId : null);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return null;
}

export function registerExecutionStopsRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get("/execution-stops", async (_request, reply) => {
    const stops = await deps.db.transaction((tx) => listActiveStops(tx));
    return reply.send({ stops });
  });

  app.post<{ Body: StopBody }>("/execution-stops", async (request, reply) => {
    const body = request.body ?? {};
    const error = validate(body);
    if (error) return reply.status(400).send({ error });

    // 1. The state flip — committed on its own, effective immediately.
    const stop = await deps.db.transaction((tx) =>
      engageStop(tx, {
        scope: body.scope as ExecutionStopScope,
        scopeRefId: typeof body.scopeRefId === "string" ? body.scopeRefId : null,
        reason: typeof body.reason === "string" ? body.reason : null,
      })
    );

    // 2. The audit event, afterwards. Idempotent on the stop id.
    await deps.db.transaction((tx) => recordStopEvent(tx, stop, "engaged"));

    return reply.status(201).send({ stop });
  });

  app.post<{ Body: StopBody }>("/execution-stops/lift", async (request, reply) => {
    const body = request.body ?? {};
    const error = validate(body);
    if (error) return reply.status(400).send({ error });

    const lifted = await deps.db.transaction((tx) =>
      liftStop(tx, {
        scope: body.scope as ExecutionStopScope,
        scopeRefId: typeof body.scopeRefId === "string" ? body.scopeRefId : null,
      })
    );
    if (!lifted) {
      return reply.status(404).send({ error: "No active stop matches that scope" });
    }

    await deps.db.transaction((tx) => recordStopEvent(tx, lifted, "lifted"));
    return reply.send({ stop: lifted });
  });
}
