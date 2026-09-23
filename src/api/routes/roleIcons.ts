/**
 * Role icons (workplace identity):
 *
 *   GET  /role-icons                 — the catalogue and every persistent agent's icon (chosen or derived)
 *   POST /agent-role-icons/:name     — `{ iconId }`: the operator chooses one; anything outside the catalogue is 400
 *
 * Identity only. The icon says who an agent is beside its name; it grants nothing, implies no capability
 * and changes no Grant, Policy decision, budget, route or score (`../../definitions/roleIcon.ts`). An
 * agent with no chosen icon keeps the one its FIRST version's own words earn, so new versions never
 * change it silently. POST for the write, like every other write here.
 */
import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "../server.js";
import { RoleIconError, readRoleIcons, roleIconCatalogue, setRoleIcon } from "../../definitions/roleIcon.js";

export function registerRoleIconRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get("/role-icons", async (_request, reply) => {
    const icons = await deps.db.transaction((tx) => readRoleIcons(tx), { accessMode: "read only" });
    return reply.send({
      catalogue: roleIconCatalogue(),
      agents: [...icons].map(([name, v]) => ({ name, iconId: v.iconId, chosen: v.chosen })).sort((a, b) => a.name.localeCompare(b.name)),
    });
  });

  app.post<{ Params: { name: string } }>("/agent-role-icons/:name", async (request, reply) => {
    const body = request.body;
    if (body === null || typeof body !== "object" || Array.isArray(body)) return reply.status(400).send({ error: "The request body must be a JSON object." });
    try {
      const saved = await deps.db.transaction((tx) => setRoleIcon(tx, request.params.name, (body as { iconId?: unknown }).iconId));
      return reply.send(saved);
    } catch (error) {
      if (error instanceof RoleIconError) return reply.status(error.statusCode).send({ error: error.message });
      throw error;
    }
  });
}
