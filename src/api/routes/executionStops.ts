/**
 * Emergency-stop control plane (frozen spec Phase 9.7).
 *
 *   GET  /execution-stops                    — list ACTIVE stops
 *   POST /execution-stops                    — engage { scope, scopeRefId?, reason? }
 *   POST /execution-stops/lift               — lift   { scope, scopeRefId?, stopId? }
 *
 * `stopId` (optional, 2026-09-14): the id of the stop the caller SAW. When given
 * and a different stop is now active for that target, the lift is refused (409)
 * instead of silently lifting a stop the operator never reviewed — e.g. a page
 * loaded while stop A was active must not lift a stop B engaged since.
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
  EXECUTION_STOP_ENGAGED,
  EXECUTION_STOP_LIFTED,
  liftStop,
  listActiveStops,
  normalizeStopTarget,
  recordStopEvent,
  type ExecutionStopScope,
} from "../../governance/executionStop.js";
import { relayCommittedEvent } from "../liveEventRelay.js";
import { isUuid } from "../requestGuards.js";

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

type StopBody = { scope?: unknown; scopeRefId?: unknown; reason?: unknown; stopId?: unknown };

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
  if (body.stopId !== undefined && body.stopId !== null && !isUuid(body.stopId)) {
    return `"stopId" must be a UUID when provided`;
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

    // 2. The audit event, afterwards. Idempotent on the stop id. Relayed live
    // once committed: a stop is exactly the event an operator watches for.
    await deps.db.transaction((tx) => recordStopEvent(tx, stop, "engaged"));
    await relayCommittedEvent(deps.db, `${EXECUTION_STOP_ENGAGED}:${stop.id}`);

    return reply.status(201).send({ stop });
  });

  app.post<{ Body: StopBody }>("/execution-stops/lift", async (request, reply) => {
    const body = request.body ?? {};
    const error = validate(body);
    if (error) return reply.status(400).send({ error });

    // Refuse to lift a stop the caller did not see (see module header). A
    // separate read before the lift, not one transaction with it: for a single
    // operator the window between them is not a meaningful race, and a lift
    // that slips through it only lifts the stop that was just confirmed active.
    if (isUuid(body.stopId)) {
      const target = normalizeStopTarget(
        body.scope as ExecutionStopScope,
        typeof body.scopeRefId === "string" ? body.scopeRefId : null
      );
      const active = (await deps.db.transaction((tx) => listActiveStops(tx))).find(
        (s) => s.scope === body.scope && s.scopeRefId === target
      );
      if (active && active.id !== body.stopId.toLowerCase()) {
        return reply.status(409).send({
          error: "A different stop is now active for this target than the one you saw; reload and review it before lifting.",
        });
      }
    }

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
    await relayCommittedEvent(deps.db, `${EXECUTION_STOP_LIFTED}:${lifted.id}`);
    return reply.send({ stop: lifted });
  });
}
