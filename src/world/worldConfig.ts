/**
 * Workspace configuration (plan §13): the physical Command Centre — buildings, the areas inside
 * them and the workstations inside those — read, validated and written for the operator.
 *
 * SPACE, NEVER AUTHORITY. A workstation's `activity` only says where a kind of real work is drawn.
 * Nothing that authorizes, routes, budgets, executes, compiles context or scores reads this module
 * or its tables (`tests/execution/structuralInvariants.test.ts`); placing an agent anywhere grants
 * it nothing. Edits emit no event: configuration is not a runtime fact.
 *
 * SAFE EDITS. Rectangles are whole world pixels inside the workspace; an area lies inside its
 * building and a workstation inside its area. Nothing is deleted: a row is deactivated, and a
 * deactivation that would leave the world with no active common area or no active workstation is
 * refused. An unknown purpose or activity is refused.
 */
import { and, asc, desc, eq } from "drizzle-orm";
import { worldAreas, worldBuildings, worldWorkspaces, worldWorkstations } from "../db/schema.js";
import type { DrizzleTransaction } from "../events/emit.js";
import { WORLD_TEMPLATES, type WorldTemplate } from "./defaultWorld.js";

export const AREA_PURPOSES = ["work", "common", "rest", "social", "waiting", "corridor", "other"] as const;
export const WORKSTATION_ACTIVITIES = ["think", "research", "analysis", "writing", "publishing", "generic"] as const;
export const FACINGS = ["up", "down", "left", "right"] as const;
export type Facing = (typeof FACINGS)[number];
export type AreaPurpose = (typeof AREA_PURPOSES)[number];
export type WorkstationActivity = (typeof WORKSTATION_ACTIVITIES)[number];

const MAX_NAME = 60;

export class WorldConfigError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 409,
    message: string
  ) {
    super(message);
  }
}

type Reader = Pick<DrizzleTransaction, "select" | "query">;
type Rect = { x: number; y: number; w: number; h: number };

export type WorldSnapshot = {
  workspace: { id: string; name: string; width: number; height: number; template: string | null } | null;
  buildings: (typeof worldBuildings.$inferSelect)[];
  areas: (typeof worldAreas.$inferSelect)[];
  workstations: (typeof worldWorkstations.$inferSelect)[];
};

/** The current workspace's whole world (active and inactive rows), or an empty world when none was created. */
export async function readWorld(db: Reader): Promise<WorldSnapshot> {
  const [workspace] = await db.select().from(worldWorkspaces).where(eq(worldWorkspaces.active, true)).orderBy(desc(worldWorkspaces.createdAt)).limit(1);
  if (!workspace) return { workspace: null, buildings: [], areas: [], workstations: [] };
  const buildings = await db.select().from(worldBuildings).where(eq(worldBuildings.workspaceId, workspace.id)).orderBy(asc(worldBuildings.createdAt), asc(worldBuildings.name));
  const ids = new Set(buildings.map((b) => b.id));
  const areas = (await db.select().from(worldAreas).orderBy(asc(worldAreas.createdAt), asc(worldAreas.name))).filter((a) => ids.has(a.buildingId));
  const areaIds = new Set(areas.map((a) => a.id));
  const workstations = (await db.select().from(worldWorkstations).orderBy(asc(worldWorkstations.createdAt), asc(worldWorkstations.name))).filter((w) => areaIds.has(w.areaId));
  return { workspace: { id: workspace.id, name: workspace.name, width: workspace.width, height: workspace.height, template: workspace.template }, buildings, areas, workstations };
}

/**
 * The names of the areas an agent can actually stand in today: the current workspace's active areas in
 * its active buildings. Meeting rooms name the area they occupy, so this is what makes a room "on the map".
 */
export async function activeAreaNames(db: Reader): Promise<string[]> {
  const world = await readWorld(db);
  const buildings = new Set(world.buildings.filter((b) => b.active).map((b) => b.id));
  return [...new Set(world.areas.filter((a) => a.active && buildings.has(a.buildingId)).map((a) => a.name))].sort();
}

/** Creates the world from the default template (The Keep). Refused when a world already exists. */
export async function createDefaultWorld(tx: DrizzleTransaction): Promise<void> {
  const [existing] = await tx.select({ id: worldWorkspaces.id }).from(worldWorkspaces).where(eq(worldWorkspaces.active, true)).limit(1);
  if (existing) throw new WorldConfigError(409, "A world already exists.");
  await applyTemplate(tx, WORLD_TEMPLATES[0]!.id);
}

/**
 * Makes a new current workspace from a template. The previous workspace, with every building, area
 * and desk in it, is retired (marked inactive) — kept, never deleted — so switching back is a matter
 * of applying a template again or editing.
 */
export async function applyTemplate(tx: DrizzleTransaction, templateId: string): Promise<void> {
  const template: WorldTemplate | undefined = WORLD_TEMPLATES.find((t) => t.id === templateId);
  if (!template) throw new WorldConfigError(404, `No world template "${templateId}".`);
  // Serialise template switches and edits on the current workspace.
  await tx.select({ id: worldWorkspaces.id }).from(worldWorkspaces).where(eq(worldWorkspaces.active, true)).for("update");
  await tx.update(worldWorkspaces).set({ active: false, updatedAt: new Date() }).where(eq(worldWorkspaces.active, true));
  const [workspace] = await tx.insert(worldWorkspaces).values({ name: template.name, width: template.width, height: template.height, template: template.id }).returning();
  for (const b of template.buildings) {
    const [building] = await tx.insert(worldBuildings).values({ workspaceId: workspace!.id, name: b.name, ...b.rect }).returning();
    for (const a of b.areas) {
      const [area] = await tx.insert(worldAreas).values({ buildingId: building!.id, name: a.name, purpose: a.purpose, ...a.rect }).returning();
      for (const s of a.workstations ?? []) await tx.insert(worldWorkstations).values({ areaId: area!.id, name: s.name, activity: s.activity, x: s.x, y: s.y, facing: s.facing ?? "up" });
    }
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

type Body = Record<string, unknown>;

function name(body: Body, required: boolean): string | undefined {
  const v = body.name;
  if (v === undefined && !required) return undefined;
  if (typeof v !== "string" || v.trim() === "" || v.trim().length > MAX_NAME) throw new WorldConfigError(400, `name must be 1 to ${MAX_NAME} characters.`);
  return v.trim();
}

function int(body: Body, key: string, required: boolean): number | undefined {
  const v = body[key];
  if (v === undefined && !required) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v)) throw new WorldConfigError(400, `${key} must be a whole number of world pixels.`);
  return v;
}

function oneOf<T extends string>(body: Body, key: string, allowed: readonly T[], required: boolean): T | undefined {
  const v = body[key];
  if (v === undefined && !required) return undefined;
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw new WorldConfigError(400, `${key} must be one of ${allowed.join(", ")}.`);
  return v as T;
}

function onlyKnownKeys(body: Body, keys: string[]) {
  const unknown = Object.keys(body).filter((k) => !keys.includes(k));
  if (unknown.length > 0) throw new WorldConfigError(400, `unknown field(s): ${unknown.join(", ")}.`);
}

const inside = (inner: Rect, outer: Rect) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
const pointInside = (x: number, y: number, r: Rect) => x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h;

function checkRect(rect: Rect, within: Rect, what: string, container: string) {
  if (rect.w < 16 || rect.h < 16) throw new WorldConfigError(400, `${what} must be at least 16 × 16 pixels.`);
  if (!inside(rect, within)) throw new WorldConfigError(400, `${what} must lie inside its ${container}.`);
}

/** Locks the workspace row for the edit, so two concurrent edits cannot both pass the livability check. */
async function requireWorkspace(tx: DrizzleTransaction) {
  const [workspace] = await tx.select().from(worldWorkspaces).where(eq(worldWorkspaces.active, true)).orderBy(desc(worldWorkspaces.createdAt)).limit(1).for("update");
  if (!workspace) throw new WorldConfigError(404, "No world exists yet: create it from the current keep first.");
  return workspace;
}

const bounds = (ws: { width: number; height: number }): Rect => ({ x: 0, y: 0, w: ws.width, h: ws.height });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const parentId = (v: unknown, key: string): string | null => {
  if (v === undefined) return null;
  if (typeof v !== "string" || !UUID.test(v)) throw new WorldConfigError(400, `${key} must name an existing ${key === "buildingId" ? "building" : "area"}.`);
  return v;
};

/** Refuses a change that would leave the world with no active common area or no active workstation. */
async function assertLivable(tx: DrizzleTransaction) {
  const world = await readWorld(tx);
  const activeBuildings = new Set(world.buildings.filter((b) => b.active).map((b) => b.id));
  const activeAreas = world.areas.filter((a) => a.active && activeBuildings.has(a.buildingId));
  const activeAreaIds = new Set(activeAreas.map((a) => a.id));
  if (!activeAreas.some((a) => a.purpose === "common")) throw new WorldConfigError(409, "The world needs at least one active common area for idle agents to live in.");
  if (!world.workstations.some((w) => w.active && activeAreaIds.has(w.areaId))) throw new WorldConfigError(409, "The world needs at least one active workstation for real work to be drawn at.");
}

// ---------------------------------------------------------------------------
// Writes. Each runs in the caller's transaction; a refused edit rolls back whole.
// ---------------------------------------------------------------------------

export async function saveBuilding(tx: DrizzleTransaction, id: string | null, body: Body) {
  onlyKnownKeys(body, ["name", "x", "y", "w", "h", "active"]);
  const ws = await requireWorkspace(tx);
  const current = id ? await tx.query.worldBuildings.findFirst({ where: and(eq(worldBuildings.id, id), eq(worldBuildings.workspaceId, ws.id)) }) : undefined;
  if (id && !current) throw new WorldConfigError(404, "No such building in the current world.");
  const next = {
    name: name(body, !current) ?? current!.name,
    x: int(body, "x", !current) ?? current!.x,
    y: int(body, "y", !current) ?? current!.y,
    w: int(body, "w", !current) ?? current!.w,
    h: int(body, "h", !current) ?? current!.h,
    active: typeof body.active === "boolean" ? body.active : (current?.active ?? true),
  };
  checkRect(next, bounds(ws), "A building", "workspace");
  if (current) {
    // Its active areas must still fit inside it, and it cannot be deactivated while they are active.
    const areas = await tx.select().from(worldAreas).where(and(eq(worldAreas.buildingId, current.id), eq(worldAreas.active, true)));
    if (!next.active && areas.length > 0) throw new WorldConfigError(409, `Deactivate this building's ${areas.length} active area(s) first.`);
    const misfit = areas.find((a) => !inside(a, next));
    if (misfit) throw new WorldConfigError(400, `Area "${misfit.name}" would no longer lie inside this building; move or deactivate it first.`);
  }
  const [row] = current
    ? await tx.update(worldBuildings).set({ ...next, updatedAt: new Date() }).where(eq(worldBuildings.id, current.id)).returning()
    : await tx.insert(worldBuildings).values({ ...next, workspaceId: ws.id }).returning();
  await assertLivable(tx);
  return row!;
}

export async function saveArea(tx: DrizzleTransaction, id: string | null, body: Body) {
  onlyKnownKeys(body, ["buildingId", "name", "purpose", "x", "y", "w", "h", "active"]);
  const ws = await requireWorkspace(tx);
  const current = id ? await tx.query.worldAreas.findFirst({ where: eq(worldAreas.id, id) }) : undefined;
  if (id && !current) throw new WorldConfigError(404, "No such area.");
  if (current && body.buildingId !== undefined && body.buildingId !== current.buildingId) throw new WorldConfigError(400, "An area cannot move to another building; create it there instead.");
  const buildingId = current ? current.buildingId : parentId(body.buildingId, "buildingId");
  const building = buildingId ? await tx.query.worldBuildings.findFirst({ where: eq(worldBuildings.id, buildingId) }) : undefined;
  if (!building || building.workspaceId !== ws.id) throw new WorldConfigError(current ? 404 : 400, "buildingId must name a building in the current world.");
  const next = {
    name: name(body, !current) ?? current!.name,
    purpose: oneOf(body, "purpose", AREA_PURPOSES, !current) ?? (current!.purpose as AreaPurpose),
    x: int(body, "x", !current) ?? current!.x,
    y: int(body, "y", !current) ?? current!.y,
    w: int(body, "w", !current) ?? current!.w,
    h: int(body, "h", !current) ?? current!.h,
    active: typeof body.active === "boolean" ? body.active : (current?.active ?? true),
  };
  checkRect(next, building, "An area", "building");
  if (next.active && !building.active) throw new WorldConfigError(409, "Its building is inactive; reactivate the building first.");
  if (current) {
    const stations = await tx.select().from(worldWorkstations).where(and(eq(worldWorkstations.areaId, current.id), eq(worldWorkstations.active, true)));
    if (!next.active && stations.length > 0) throw new WorldConfigError(409, `Deactivate this area's ${stations.length} active workstation(s) first.`);
    if (next.purpose !== "work" && stations.length > 0) throw new WorldConfigError(409, "Only a work area holds workstations; move or deactivate them before changing its purpose.");
    const misfit = stations.find((s) => !pointInside(s.x, s.y, next));
    if (misfit) throw new WorldConfigError(400, `Workstation "${misfit.name}" would no longer lie inside this area; move or deactivate it first.`);
  }
  const [row] = current
    ? await tx.update(worldAreas).set({ ...next, updatedAt: new Date() }).where(eq(worldAreas.id, current.id)).returning()
    : await tx.insert(worldAreas).values({ ...next, buildingId: building.id }).returning();
  await assertLivable(tx);
  return row!;
}

export async function saveWorkstation(tx: DrizzleTransaction, id: string | null, body: Body) {
  onlyKnownKeys(body, ["areaId", "name", "activity", "x", "y", "facing", "active"]);
  const ws = await requireWorkspace(tx);
  const current = id ? await tx.query.worldWorkstations.findFirst({ where: eq(worldWorkstations.id, id) }) : undefined;
  if (id && !current) throw new WorldConfigError(404, "No such workstation.");
  const areaId = parentId(body.areaId, "areaId") ?? current?.areaId ?? null;
  const area = areaId ? await tx.query.worldAreas.findFirst({ where: eq(worldAreas.id, areaId) }) : undefined;
  const areaBuilding = area ? await tx.query.worldBuildings.findFirst({ where: eq(worldBuildings.id, area.buildingId) }) : undefined;
  if (!area || areaBuilding?.workspaceId !== ws.id) throw new WorldConfigError(current ? 404 : 400, "areaId must name an area in the current world.");
  if (area.purpose !== "work") throw new WorldConfigError(400, "A workstation belongs in a work area.");
  const next = {
    name: name(body, !current) ?? current!.name,
    activity: oneOf(body, "activity", WORKSTATION_ACTIVITIES, !current) ?? (current!.activity as WorkstationActivity),
    facing: oneOf(body, "facing", FACINGS, false) ?? ((current?.facing as Facing | undefined) ?? "up"),
    x: int(body, "x", !current) ?? current!.x,
    y: int(body, "y", !current) ?? current!.y,
    active: typeof body.active === "boolean" ? body.active : (current?.active ?? true),
  };
  if (!pointInside(next.x, next.y, area)) throw new WorldConfigError(400, "A workstation must lie inside its area.");
  if (next.active) {
    const building = await tx.query.worldBuildings.findFirst({ where: eq(worldBuildings.id, area.buildingId) });
    if (!area.active || !building?.active) throw new WorldConfigError(409, "Its area or building is inactive; reactivate it first.");
  }
  const [row] = current
    ? await tx.update(worldWorkstations).set({ ...next, areaId: area.id, updatedAt: new Date() }).where(eq(worldWorkstations.id, current.id)).returning()
    : await tx.insert(worldWorkstations).values({ ...next, areaId: area.id }).returning();
  await assertLivable(tx);
  return row!;
}

export async function renameWorkspace(tx: DrizzleTransaction, body: Body) {
  onlyKnownKeys(body, ["name"]);
  const ws = await requireWorkspace(tx);
  const [row] = await tx.update(worldWorkspaces).set({ name: name(body, true)!, updatedAt: new Date() }).where(eq(worldWorkspaces.id, ws.id)).returning();
  return row!;
}
