/**
 * `buildServer` — builds (but does not start) the Fastify app: Unit 10's API
 * layer, the ONLY boundary the UI (Unit 11, `web/`) is meant to use. Nothing
 * downstream of this layer — Postgres, model providers, tool adapters — is
 * ever meant to be reached directly by a UI client; every capability the UI
 * needs is exposed as a route here.
 *
 * ---------------------------------------------------------------------------
 * Advancement
 * ---------------------------------------------------------------------------
 * Routes that change a Workflow Run's state drive it forward in the request
 * through `advanceWorkflowRunUntilBlocked`
 * (`../workflow/advanceWorkflowRunUntilBlocked.ts`), bounded by the run's own
 * step count. Each step commits in its own short transaction and every
 * provider call happens with no transaction open
 * (`docs/architecture/DURABLE_EXECUTION.md`):
 *   - `POST /goals`: create Goal -> `startWorkflowRun` -> advance.
 *   - `POST /approvals/:id/approve|reject`: `resolveApproval` (committed) ->
 *     advance. An advance failure after the decision is reported alongside it.
 *   - `POST /workflow-runs/:id/resume`: resume -> advance.
 *     `POST /workflow-runs/:id/advance`: advance only (recovery).
 *   - `POST /workflow-runs/:id/pause` and `/execution-stops`: no advancement —
 *     stopping must never itself cause more work.
 * Outside requests, `start.ts` settles interrupted Invocations and re-drives
 * `in_progress` Workflow Runs at startup, and runs the Approval TTL sweep
 * every minute. One such process per database (`executorInstanceLock.ts`).
 *
 * ---------------------------------------------------------------------------
 * Providers
 * ---------------------------------------------------------------------------
 * The routed default is the Claude subscription CLI (`claude -p`), which needs
 * no API key. Every API test mocks all three provider adapters (anthropic,
 * openai, claudeSubscription) so no test makes a real call or consumes quota.
 *
 * ---------------------------------------------------------------------------
 * Test injection (Ruling 5)
 * ---------------------------------------------------------------------------
 * `buildServer` takes an OPTIONAL injected `db`, defaulting to the real app
 * client (`../db/client.js`). This exists purely so `tests/api/*.test.ts`
 * can point every route at the isolated `TEST_DATABASE_URL`-backed client
 * (`tests/testDb.ts`) instead of the real database — this project's already
 * established test-database convention (e.g.
 * `tests/capabilities/publishReport.integration.test.ts`). `buildServer`
 * itself never calls `.listen()` — that is `start.ts`'s job (the real-run
 * entrypoint) — so tests can use Fastify's `app.inject()` (or, for the SSE
 * route, a real bound port — see `tests/api/sseReplay.test.ts`'s own header
 * for why) without ever binding a real network port.
 */
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { db as realDb, type Database } from "../db/client.js";
import { registerGoalsRoutes } from "./routes/goals.js";
import { registerApprovalsRoutes } from "./routes/approvals.js";
import { registerWorkflowRunsRoutes } from "./routes/workflowRuns.js";
import { registerEventsRoutes } from "./routes/events.js";
import { registerAgentsRoutes } from "./routes/agents.js";
import { registerExecutionStopsRoutes } from "./routes/executionStops.js";
import { registerRegistryRoutes } from "./routes/registry.js";
import { registerCostsRoutes } from "./routes/costs.js";
import { registerTraceRoutes } from "./routes/trace.js";
import { registerArtifactsRoutes } from "./routes/artifacts.js";
import { registerKeeperRoutes } from "./routes/keeper.js";
import { registerAppearanceRoutes } from "./routes/appearances.js";
import { registerProgressionRoutes } from "./routes/progression.js";
import { registerWorldRoutes } from "./routes/world.js";
import { registerHistoryRoutes } from "./routes/history.js";
import { registerWorkplaceRoutes } from "./routes/workplace.js";
import { registerRoleIconRoutes } from "./routes/roleIcons.js";
import { registerTalkRoutes } from "./routes/talk.js";
import { registerManagerRoutes } from "./routes/manager.js";
import { makeRequestGuard } from "./requestGuards.js";
import { SeedMissingError } from "../definitions/lookupSeed.js";

export type ApiDeps = { db: Database };

/**
 * ---------------------------------------------------------------------------
 * Unit 11 (task-11-brief.md), Ruling 2 — CORS for the local dev UI
 * ---------------------------------------------------------------------------
 * Manual header-setting (the brief's own documented alternative to
 * `@fastify/cors`), chosen to avoid adding a new root dependency for what is
 * pure HTTP transport wiring. Headers are written directly onto
 * `reply.raw` (Node's own `http.ServerResponse`) via `setHeader`, NOT via
 * Fastify's `reply.header()` — `routes/events.ts`'s SSE route calls
 * `reply.hijack()` and then writes its response with `reply.raw.writeHead(...)`
 * directly, which bypasses Fastify's own header-sending machinery
 * (`reply.header()` values are applied by Fastify's `onSend` hook, which
 * never runs for a hijacked reply) entirely. `reply.raw.setHeader(...)`
 * called here, in a global `onRequest` hook that runs before any route
 * handler, survives that: Node's `response.writeHead(status, headers)`
 * merges its own `headers` argument with whatever was already set via
 * `setHeader` (routes/events.ts's own `writeHead` call only sets
 * Content-Type/Cache-Control/Connection, none of which collide with the
 * names below), so this is the one implementation that correctly reaches
 * every route, hijacked or not.
 *
 * The UI's actual dev origin is `http://localhost:3100`, not Next.js's
 * literal default of 3000 — see `web/lib/api.ts`'s header for why (this
 * API's own default port, from `src/api/start.ts`, is ALSO 3000, so the two
 * defaults collide; `web/package.json`'s `dev` script binds Next to 3100
 * instead). Overridable via `UI_ORIGIN` for anyone who deliberately runs the
 * UI dev server on a different port.
 */
const UI_ORIGIN = process.env.UI_ORIGIN ?? "http://localhost:3100";

function setCorsHeaders(reply: FastifyReply): void {
  reply.raw.setHeader("Access-Control-Allow-Origin", UI_ORIGIN);
  reply.raw.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  reply.raw.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export function buildServer(overrides?: Partial<ApiDeps>): FastifyInstance {
  const deps: ApiDeps = { db: overrides?.db ?? realDb };

  // No automatic HEAD routes: a HEAD of `/events/stream` would run the stream
  // handler and hold a capped stream slot (see `./requestGuards.ts`, attack 3).
  const app = Fastify({ logger: false, exposeHeadRoutes: false });

  app.addHook("onRequest", async (_request, reply) => {
    setCorsHeaders(reply);
  });

  // Refuses DNS-rebinding and cross-site state changes BEFORE any route runs —
  // see `./requestGuards.ts`. Registered after the CORS hook so a refusal still
  // carries CORS headers (the UI can read why it was refused).
  app.addHook(
    "onRequest",
    makeRequestGuard({
      uiOrigin: UI_ORIGIN,
      extraAllowedHosts: (process.env.API_ALLOWED_HOSTS ?? "")
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    })
  );

  // 5xx bodies never carry the error's message: drizzle's messages embed the
  // full SQL text and parameters, and other errors can carry host paths. The
  // detail goes to the server log; the client gets a generic message. 4xx
  // errors raised by Fastify itself (e.g. malformed JSON) keep their message.
  app.setErrorHandler(async (error: { statusCode?: number; message?: string }, _request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (error instanceof SeedMissingError) {
      return reply.status(status).send({ error: error.message });
    }
    if (status >= 500) {
      // eslint-disable-next-line no-console
      console.error("Unhandled API error:", error);
      return reply.status(status).send({ error: "Internal server error" });
    }
    return reply.status(status).send({ error: error.message ?? "Bad request" });
  });

  // A real registered route, not just relying on the hook above: a browser
  // CORS preflight (triggered by the UI's JSON POSTs, e.g. approve/reject)
  // sends `OPTIONS` to a path only ever registered for `GET`/`POST` below —
  // Fastify's router must actually match something to respond 2xx to it.
  app.options("*", async (_request, reply) => {
    setCorsHeaders(reply);
    reply.status(204).send();
  });

  registerGoalsRoutes(app, deps);
  registerApprovalsRoutes(app, deps);
  registerWorkflowRunsRoutes(app, deps);
  registerEventsRoutes(app, deps);
  registerAgentsRoutes(app, deps); // Unit 11, Ruling 1 — new, additive.
  registerExecutionStopsRoutes(app, deps); // Phase 8 — emergency stop control plane.
  registerRegistryRoutes(app, deps); // V1.1 — Definitions read model and grant revocation.
  registerCostsRoutes(app, deps); // V2 — budget counters and cost-vs-success, read-only.
  registerTraceRoutes(app, deps); // Spec 8.4 — a Run's trace, read-only.
  registerArtifactsRoutes(app, deps); // Spec 15.1 screens 2/8 — an Artifact with provenance, read-only.
  registerKeeperRoutes(app, deps); // V1.1 Keeper: deterministic explain and guide; Think as a governed Goal.
  registerAppearanceRoutes(app, deps); // R2 — agent appearance, presentation only.
  registerProgressionRoutes(app, deps); // R2 — quality verdicts and the progression read model.
  registerWorldRoutes(app, deps); // Living workplace — workspace configuration, space only.
  registerHistoryRoutes(app, deps); // Living workplace — work history and archive (not deletion).
  registerWorkplaceRoutes(app, deps); // Workplace — calendar, meetings, rooms, internal notifications.
  registerRoleIconRoutes(app, deps); // Role icons — who an agent is beside its name; identity, never authority.
  registerTalkRoutes(app, deps); // R2 character interaction — talk to an agent as governed work.
  registerManagerRoutes(app, deps); // R2 management layer — objectives for the Manager as governed missions.

  return app;
}
