/**
 * Agent appearance (R2): how a persistent agent LOOKS, and nothing else.
 *
 * THREE THINGS, KEPT APART.
 * - Persistent identity: the agent's `name`, shared by every Agent Definition version.
 * - Versioned definition: `agent_definitions`, written only by the Registry, never updated.
 * - Appearance: one `agent_appearances` row per name, holding catalogue keys only. Changing it mints no
 *   Definition version; a new version keeps it.
 *
 * PRESENTATION ONLY. Nothing that decides what an agent may do, what it costs, which model serves it,
 * what enters its context or how it is scored reads this module or its table — enforced by
 * `tests/execution/structuralInvariants.test.ts`. Writing an appearance emits no event: it is not a
 * runtime fact, and must never read as work.
 *
 * FAILS SAFE. A write naming a part or option the catalogue lacks is refused. A stored option the
 * catalogue no longer has resolves to that part's default on read, so a trimmed catalogue can never
 * break a screen.
 */
import { readFileSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { agentAppearances, agentDefinitions } from "../db/schema.js";
import type * as schema from "../db/schema.js";
import type { DrizzleTransaction } from "../events/emit.js";

type Part = { label: string; default: string; options: string[] };
export type AppearanceCatalogue = {
  version: number;
  poses: string[];
  facings: string[];
  frameSize: number;
  frames: Record<string, number>;
  frameMs: Record<string, number>;
  parts: Record<string, Part>;
  presets: { id: string; name: string; appearance: Record<string, string> }[];
};

/** The one catalogue: the art generator draws it, this module validates against it, the builder offers it. */
export const APPEARANCE_CATALOGUE: AppearanceCatalogue = JSON.parse(readFileSync(new URL("./appearanceCatalogue.json", import.meta.url), "utf8")) as AppearanceCatalogue;

export type Appearance = Record<string, string>;

/** The catalogue as the builder needs it: parts, labels, options and defaults — no colours or file layout. */
export function appearanceBuilderOptions() {
  const { version, poses, facings, frameSize, frames, frameMs, parts, presets } = APPEARANCE_CATALOGUE;
  return { version, poses, facings, frameSize, frames, frameMs, parts, presets };
}

/**
 * The look an agent with no chosen appearance is drawn with (D28): every part picked from a hash of
 * its persistent NAME, so every version and every screen agrees. Derived on read, never stored — it
 * is not a choice the operator made, and choosing a look replaces it.
 */
export function derivedAppearance(name: string): Appearance {
  let h = 2166136261;
  for (const c of name) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return Object.fromEntries(
    Object.entries(APPEARANCE_CATALOGUE.parts).map(([key, part]) => {
      h = Math.imul(h ^ key.length, 2654435761) >>> 0;
      h = (h ^ (h >>> 13)) >>> 0;
      return [key, part.options[h % part.options.length]!];
    })
  );
}

export function defaultAppearance(): Appearance {
  return Object.fromEntries(Object.entries(APPEARANCE_CATALOGUE.parts).map(([key, part]) => [key, part.default]));
}

/** Validates a write. Every catalogue part must be present with one of its options; nothing else is accepted. */
export function parseAppearance(value: unknown): { ok: true; appearance: Appearance } | { ok: false; reason: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "appearance must be an object." };
  const given = value as Record<string, unknown>;
  const unknown = Object.keys(given).filter((key) => !(key in APPEARANCE_CATALOGUE.parts));
  if (unknown.length > 0) return { ok: false, reason: `unknown appearance part(s): ${unknown.join(", ")}.` };
  const appearance: Appearance = {};
  for (const [key, part] of Object.entries(APPEARANCE_CATALOGUE.parts)) {
    const option = given[key];
    if (typeof option !== "string" || !part.options.includes(option)) {
      return { ok: false, reason: `appearance.${key} must be one of ${part.options.join(", ")}.` };
    }
    appearance[key] = option;
  }
  return { ok: true, appearance };
}

/** A stored appearance as the screens use it: every part present, anything the catalogue no longer has replaced by its default. */
export function resolveAppearance(stored: Record<string, unknown>): Appearance {
  return Object.fromEntries(
    Object.entries(APPEARANCE_CATALOGUE.parts).map(([key, part]) => {
      const option = stored[key];
      return [key, typeof option === "string" && part.options.includes(option) ? option : part.default];
    })
  );
}

type Reader = NodePgDatabase<typeof schema> | DrizzleTransaction;

/** Appearances by agent name, for the names that have one. An agent with none keeps its default character. */
export async function readAppearances(db: Reader, names: string[]): Promise<Map<string, Appearance>> {
  const unique = [...new Set(names)];
  if (unique.length === 0) return new Map();
  const rows = await db.select().from(agentAppearances).where(inArray(agentAppearances.agentName, unique));
  return new Map(rows.map((row) => [row.agentName, resolveAppearance(row.appearance)]));
}

export class AppearanceError extends Error {
  constructor(
    readonly statusCode: 400 | 404,
    message: string
  ) {
    super(message);
  }
}

/**
 * Sets a persistent agent's appearance. The name must belong to at least one Agent Definition: an
 * appearance never creates an identity. Touches `agent_appearances` only — no Definition, Grant,
 * counter or event.
 */
export async function setAppearance(tx: DrizzleTransaction, name: string, value: unknown): Promise<{ name: string; appearance: Appearance; updatedAt: Date }> {
  const parsed = parseAppearance(value);
  if (!parsed.ok) throw new AppearanceError(400, parsed.reason);
  const agent = await tx.query.agentDefinitions.findFirst({ where: eq(agentDefinitions.name, name) });
  if (!agent) throw new AppearanceError(404, `no agent named "${name}" exists; recruit it before giving it an appearance.`);
  const now = new Date();
  const [row] = await tx
    .insert(agentAppearances)
    .values({ agentName: name, appearance: parsed.appearance, updatedAt: now })
    .onConflictDoUpdate({ target: agentAppearances.agentName, set: { appearance: parsed.appearance, updatedAt: now } })
    .returning();
  return { name, appearance: resolveAppearance(row!.appearance), updatedAt: row!.updatedAt };
}
