/**
 * `buildServer` — builds (but does not start) the Fastify app: Unit 10's API
 * layer, the ONLY boundary the UI (Unit 11, next) is meant to use. Nothing
 * downstream of this layer — Postgres, model providers, tool adapters — is
 * ever meant to be reached directly by a UI client; every capability the UI
 * needs is exposed as a route here.
 *
 * ---------------------------------------------------------------------------
 * Ruling 3 (task-10-brief.md, corrected in fix round 1) — synchronous,
 * bounded-loop advancement, documented once here for the whole API layer
 * ---------------------------------------------------------------------------
 * This MVP has NO background poller/worker process — the API server is the
 * only process. Every mutating route that changes a Workflow Run's state
 * therefore drives advancement SYNCHRONOUSLY, inline in the request/response
 * cycle, immediately after its own state change.
 *
 * FIX ROUND 1: the original ruling called `advanceWorkflowRun`
 * (`../workflow/interpreter.ts`) exactly ONCE per route. Because a single
 * call only ever advances one step (interpreter.ts's own documented
 * algorithm never creates the next step's Task Instance within the same
 * call), that left a Workflow Run permanently stuck after Task A completed
 * — no route in this unit's surface could ever trigger the second call
 * needed to create Task B (see task-10-report.md's original "Concerns" /
 * "Fix round 1" sections for the full writeup). The corrected design routes
 * every advancing call through `advanceWorkflowRunUntilBlocked`
 * (`../workflow/advanceWorkflowRunUntilBlocked.ts`), which loops
 * `advanceWorkflowRun` up to the run's OWN step count (derived from its
 * Workflow Definition's graph, never hardcoded) and stops early on a
 * terminal status — see that module's header for the bound/termination
 * argument (why this can never under- or over-advance):
 *   - `POST /goals` (`routes/goals.ts`): create Goal -> `startWorkflowRun`
 *     -> `advanceWorkflowRunUntilBlocked` (drives as far as automatically
 *     possible, e.g. Task A completing AND Task B reaching
 *     `awaiting_approval`, within this MVP's 2-step seed).
 *   - `POST /approvals/:id/approve|reject` (`routes/approvals.ts`):
 *     `resolveApproval` -> (if the gated Invocation belongs to a
 *     workflow-created Task Instance) `advanceWorkflowRunUntilBlocked`.
 *   - `POST /workflow-runs/:id/resume` (`routes/workflowRuns.ts`):
 *     `resumeWorkflowRun` -> `advanceWorkflowRunUntilBlocked`.
 *   - `POST /workflow-runs/:id/pause` (`routes/workflowRuns.ts`): the ONE
 *     deliberate exception — `pauseWorkflowRun` ONLY, no advancement.
 *     Pausing must never itself cause more work to happen.
 * This is a deliberate MVP simplification that only holds because this is a
 * single-user, local, single-process app with no meaningful concurrency — a
 * real multi-user deployment would need a real background driver instead of
 * piggybacking advancement onto whichever HTTP request happens to touch a
 * Workflow Run next.
 *
 * ---------------------------------------------------------------------------
 * Ruling 4 — no real provider API key is configured
 * ---------------------------------------------------------------------------
 * `.env` has no real `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` (by design — see
 * the repo's own `.env`). `tests/api/routes.integration.test.ts` and
 * `tests/api/sseReplay.test.ts` mock `../router/providers/anthropic.js` /
 * `openai.js` exactly as Units 8/9's own integration tests do, so
 * `POST /goals`'s Task A llm step never makes a real network call under
 * test. Exercising the real LLM step against a live, locally-run server
 * (`start.ts`) requires the operator's OWN real API key in their own `.env`
 * — this is not something this unit configures or can configure.
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

  return app;
}
