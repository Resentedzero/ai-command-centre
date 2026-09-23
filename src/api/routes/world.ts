/**
 * Workspace configuration (plan §13): the operator's world — buildings, areas, workstations.
 *
 *   GET  /world                               — the configured world (empty when none was created) and the allowed values
 *   POST /world                               — create the world from the default template (only when none exists)
 *   POST /world/templates/:id                 — make a new current world from a template; the previous one is retired, not deleted
 *   POST /world/workspace                     — { name }: rename the workspace
 *   POST /world/buildings                     — create a building
 *   POST /world/buildings/:id                 — update or (active: false) deactivate a building
 *   POST /world/areas, /world/areas/:id       — the same for areas
 *   POST /world/workstations, /world/workstations/:id — the same for workstations
 *
 * Space only, never authority: validation lives in `../../world/worldConfig.ts`, nothing here
 * touches a Definition, Grant, Policy, budget, run or event, and no governance, routing, execution,
 * workflow, context or projection code reads these tables (structural invariant). POST for every
 * write, so the CORS surface is unchanged.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ApiDeps } from "../server.js";
import { WORLD_TEMPLATES, defaultWorldPreview } from "../../world/defaultWorld.js";
import { isUuid } from "../requestGuards.js";
import { ensureDefaultRooms } from "../../workplace/workplace.js";
import {
  AREA_PURPOSES,
  activeAreaNames,
  FACINGS,
  WORKSTATION_ACTIVITIES,
  WorldConfigError,
  applyTemplate,
  createDefaultWorld,
  readWorld,
  renameWorkspace,
  saveArea,
  saveBuilding,
  saveWorkstation,
} from "../../world/worldConfig.js";

async function write(reply: FastifyReply, deps: ApiDeps, body: unknown, run: (tx: Parameters<Parameters<ApiDeps["db"]["transaction"]>[0]>[0], body: Record<string, unknown>) => Promise<unknown>) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return reply.status(400).send({ error: "The request body must be a JSON object." });
  try {
    const saved = await deps.db.transaction((tx) => run(tx, body as Record<string, unknown>));
    return reply.send({ saved, world: await readWorld(deps.db) });
  } catch (error) {
    if (error instanceof WorldConfigError) return reply.status(error.statusCode).send({ error: error.message });
    throw error;
  }
}

export function registerWorldRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get("/world", async (_request, reply) => {
    const world = await deps.db.transaction((tx) => readWorld(tx), { accessMode: "read only" });
    // Before the operator creates a world, the current keep is offered as an unsaved preview, so the map still has its rooms.
    const templates = WORLD_TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description }));
    return reply.send({ ...world, purposes: AREA_PURPOSES, activities: WORKSTATION_ACTIVITIES, facings: FACINGS, templates, ...(world.workspace ? {} : { preview: defaultWorldPreview() }) });
  });

  // Creating or replacing the world moves the drawn rooms, so the meeting rooms are re-placed on it:
  // a meeting room always names an area this world actually has, or says plainly that it is not on the map.
  const placeRooms = async (tx: Parameters<Parameters<ApiDeps["db"]["transaction"]>[0]>[0]) => {
    await ensureDefaultRooms(tx as never, "human:operator", await activeAreaNames(tx as never));
  };

  app.post("/world", async (_request, reply) => {
    try {
      await deps.db.transaction(async (tx) => {
        await createDefaultWorld(tx);
        await placeRooms(tx);
      });
      return reply.status(201).send({ world: await readWorld(deps.db) });
    } catch (error) {
      if (error instanceof WorldConfigError) return reply.status(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>("/world/templates/:id", async (request, reply) => {
    try {
      await deps.db.transaction(async (tx) => {
        await applyTemplate(tx, request.params.id);
        await placeRooms(tx);
      });
      return reply.status(201).send({ world: await readWorld(deps.db) });
    } catch (error) {
      if (error instanceof WorldConfigError) return reply.status(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.post("/world/workspace", async (request, reply) => write(reply, deps, request.body, (tx, body) => renameWorkspace(tx, body)));

  const collections = [
    ["buildings", saveBuilding],
    ["areas", saveArea],
    ["workstations", saveWorkstation],
  ] as const;
  for (const [path, save] of collections) {
    app.post(`/world/${path}`, async (request, reply) => write(reply, deps, request.body, (tx, body) => save(tx, null, body)));
    app.post<{ Params: { id: string } }>(`/world/${path}/:id`, async (request, reply) => {
      if (!isUuid(request.params.id)) return reply.status(400).send({ error: "id must be a UUID" });
      return write(reply, deps, request.body, (tx, body) => save(tx, request.params.id, body));
    });
  }
}
