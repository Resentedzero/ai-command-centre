/**
 * Request guards for a LOCALHOST API that governs real side effects.
 *
 * The API binds 127.0.0.1 and has no authentication (spec §9.8: one local
 * operator). Binding to loopback does NOT keep other websites out: the
 * operator's own browser is on loopback, and a page it visits can send
 * requests to `http://127.0.0.1:3000`. CORS does not prevent that — it only
 * decides whether the page may READ the response; the request itself still
 * executes. Two concrete attacks follow, both closed here:
 *
 *   1. DNS rebinding. `attacker.example` first resolves to the attacker, then
 *      to 127.0.0.1. The attacker's page is now same-origin with this API: it
 *      can read `GET /approvals` for ids, then `POST /approvals/:id/approve`,
 *      lift the global emergency stop, or start Goals that spend quota. The
 *      browser still sends `Host: attacker.example:3000` — so the API refuses
 *      any Host that is not a loopback name (or one the operator configured).
 *
 *   2. Cross-site request forgery. A page on any origin can fire a no-body
 *      `POST /approvals/:id/approve` without a CORS preflight. Browsers attach
 *      `Origin` to every cross-origin POST, so a state-changing request whose
 *      Origin is present and is not the UI's origin is refused. A request with
 *      no Origin at all (curl, tests, server-to-server) is not a browser
 *      cross-site request and is allowed.
 *
 *   3. Cross-site resource holding. A page can also open long-lived GETs —
 *      notably `GET /events/stream`, which replays the event log and holds one
 *      of a capped number of stream slots — with no Origin header at all (a
 *      no-cors fetch sends none). Browsers do send `Sec-Fetch-Site`; a
 *      `cross-site` request is refused unless it comes from the UI's own
 *      origin. The UI and API on localhost ports are `same-site`, so the real
 *      UI is unaffected. HEAD routes are not exposed (`server.ts`) so a HEAD
 *      cannot hold a stream either.
 */
import type { FastifyReply, FastifyRequest } from "fastify";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/** `Host` header -> bare hostname, lowercased; handles `[::1]:3000` and `name:port`. */
export function hostnameOf(hostHeader: string): string {
  const trimmed = hostHeader.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end === -1 ? trimmed : trimmed.slice(1, end);
  }
  const colon = trimmed.lastIndexOf(":");
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

export type RequestGuardConfig = {
  /** The UI's origin, the only browser origin allowed to change state. */
  uiOrigin: string;
  /** Extra hostnames the API may be addressed by, beyond loopback (operator-configured). */
  extraAllowedHosts?: string[];
};

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Returns a refusal reason, or null when the request may proceed. Pure, so it
 * is tested directly as well as through the server.
 */
export function refuseRequest(
  req: { method: string; host: string | undefined; origin: string | undefined; secFetchSite?: string | undefined },
  config: RequestGuardConfig
): string | null {
  if (!req.host) return "missing Host header";
  const hostname = hostnameOf(req.host);
  const allowed = LOOPBACK_HOSTNAMES.has(hostname) || (config.extraAllowedHosts ?? []).includes(hostname);
  if (!allowed) return `Host "${hostname}" is not an allowed name for this API`;

  if (req.secFetchSite?.toLowerCase() === "cross-site" && req.origin !== config.uiOrigin) {
    return "cross-site requests are not accepted by this API";
  }

  if (STATE_CHANGING.has(req.method.toUpperCase()) && req.origin !== undefined && req.origin !== config.uiOrigin) {
    return `Origin "${req.origin}" may not change state through this API`;
  }
  return null;
}

export function makeRequestGuard(config: RequestGuardConfig) {
  return async function requestGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const refusal = refuseRequest(
      {
        method: request.method,
        host: request.headers.host,
        origin: request.headers.origin,
        secFetchSite: request.headers["sec-fetch-site"] as string | undefined,
      },
      config
    );
    if (refusal) {
      await reply.status(403).send({ error: `Forbidden: ${refusal}` });
    }
  };
}
