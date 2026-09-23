/**
 * Role icons: the small symbol beside an agent's name that says who it is at a glance.
 *
 * IDENTITY, NEVER AUTHORITY. An icon grants nothing, implies no capability and restricts nothing;
 * changing one changes no Grant, Policy decision, budget, route, context or score (structural
 * invariant). It is presentation, like an appearance — but governed: only ids in
 * `./roleIconCatalogue.json` exist, and no model chooses one.
 *
 * STABLE ACROSS VERSIONS. The icon follows the persistent agent NAME. Unless an operator chose one,
 * it is derived by code from that agent's FIRST version's role and objective (the earliest row, which
 * never changes), so v1 → v2 → v3 keeps the same icon even when a new version rewords its role.
 */
import { readFileSync } from "node:fs";
import { asc, eq, inArray } from "drizzle-orm";
import { agentDefinitions, agentRoleIcons } from "../db/schema.js";
import type { DrizzleTransaction } from "../events/emit.js";
import type { Database } from "../db/client.js";

export type RoleIcon = { id: string; name: string; colorToken: string; description: string; pixels: string[] };
type Catalogue = { version: number; size: number; note: string; icons: RoleIcon[]; rules: { icon: string; match: string }[] };

export const ROLE_ICON_CATALOGUE = JSON.parse(readFileSync(new URL("./roleIconCatalogue.json", import.meta.url), "utf8")) as Catalogue;
export const FALLBACK_ROLE_ICON = "generic";

export function isRoleIconId(value: unknown): value is string {
  return typeof value === "string" && ROLE_ICON_CATALOGUE.icons.some((i) => i.id === value);
}

/** The icon an agent's own words earn it: the first matching rule, in catalogue order. Pure. */
export function derivedRoleIcon(text: string): string {
  const words = text.toLowerCase();
  return ROLE_ICON_CATALOGUE.rules.find((r) => new RegExp(r.match, "i").test(words))?.icon ?? FALLBACK_ROLE_ICON;
}

export class RoleIconError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

type Reader = DrizzleTransaction | Database;

/** Every persistent agent's icon: the operator's choice if there is one, else the one its first version's words earn. */
export async function readRoleIcons(db: Reader, names?: string[]): Promise<Map<string, { iconId: string; chosen: boolean }>> {
  const defs = await db
    .select({ name: agentDefinitions.name, version: agentDefinitions.version, role: agentDefinitions.role, objective: agentDefinitions.objective })
    .from(agentDefinitions)
    .orderBy(asc(agentDefinitions.name), asc(agentDefinitions.version));
  const chosen = new Map((await db.select().from(agentRoleIcons)).map((r) => [r.agentName, r.iconId]));
  const out = new Map<string, { iconId: string; chosen: boolean }>();
  for (const d of defs) {
    if (out.has(d.name) || (names && !names.includes(d.name))) continue;
    // `defs` is ordered by version, so this is the FIRST version's wording.
    const picked = chosen.get(d.name);
    out.set(d.name, picked ? { iconId: picked, chosen: true } : { iconId: derivedRoleIcon(`${d.name} ${d.role} ${d.objective}`), chosen: false });
  }
  return out;
}

export async function readRoleIcon(db: Reader, name: string): Promise<string> {
  return (await readRoleIcons(db, [name])).get(name)?.iconId ?? FALLBACK_ROLE_ICON;
}

/** The operator chooses an agent's icon. Validated against the catalogue; nothing else changes. */
export async function setRoleIcon(tx: DrizzleTransaction, name: string, value: unknown): Promise<{ agentName: string; iconId: string }> {
  if (!isRoleIconId(value)) throw new RoleIconError(400, `iconId must be one of: ${ROLE_ICON_CATALOGUE.icons.map((i) => i.id).join(", ")}`);
  if (!(await tx.query.agentDefinitions.findFirst({ where: eq(agentDefinitions.name, name) }))) throw new RoleIconError(404, `no agent named "${name.slice(0, 80)}"`);
  const values = { agentName: name, iconId: value, updatedAt: new Date() };
  await tx.insert(agentRoleIcons).values(values).onConflictDoUpdate({ target: agentRoleIcons.agentName, set: values });
  return { agentName: name, iconId: value };
}

/** The catalogue as the web needs it (no rules: they are code's business, not a chooser's). */
export function roleIconCatalogue() {
  return { version: ROLE_ICON_CATALOGUE.version, size: ROLE_ICON_CATALOGUE.size, icons: ROLE_ICON_CATALOGUE.icons };
}

/** Icons for a set of names, as plain ids (for API payloads). */
export async function roleIconMap(db: Reader, names: string[]): Promise<Record<string, string>> {
  const icons = await readRoleIcons(db, names.length > 0 ? names : undefined);
  return Object.fromEntries([...icons].map(([name, v]) => [name, v.iconId]));
}

/** Names that exist, for a bulk read where only some are wanted. */
export async function knownAgentNames(db: Reader, names: string[]): Promise<string[]> {
  if (names.length === 0) return [];
  return (await db.selectDistinct({ name: agentDefinitions.name }).from(agentDefinitions).where(inArray(agentDefinitions.name, names))).map((r) => r.name);
}
