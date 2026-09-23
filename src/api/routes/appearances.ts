/**
 * Agent appearance (R2): `POST /agent-appearances/:name` — set how a persistent agent looks.
 *
 * Body: `{ appearance: { skin, hair, hairColor, top, topColor, bottom, bottomColor, accessory, mark } }`,
 * every part one of `src/definitions/appearanceCatalogue.json`'s options. Unknown part or option → 400;
 * a name no Agent Definition carries → 404. An upsert of one `agent_appearances` row and nothing else:
 * no Definition version, Grant, counter or event (see `../../definitions/appearance.ts`). POST, like
 * every other write here, so the CORS surface is unchanged.
 */
import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "../server.js";
import { AppearanceError, setAppearance } from "../../definitions/appearance.js";

export function registerAppearanceRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.post<{ Params: { name: string } }>("/agent-appearances/:name", async (request, reply) => {
    const body = request.body;
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return reply.status(400).send({ error: "The request body must be a JSON object." });
    }
    try {
      const saved = await deps.db.transaction((tx) => setAppearance(tx, request.params.name, (body as { appearance?: unknown }).appearance));
      return reply.send(saved);
    } catch (error) {
      if (error instanceof AppearanceError) return reply.status(error.statusCode).send({ error: error.message });
      throw error;
    }
  });
}
