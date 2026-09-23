/**
 * Role icons: identity beside a name, never authority. Every seeded agent gets a catalogue icon from its
 * own first version's words; a new version never changes it; an operator may choose one; nothing outside
 * the catalogue is accepted; and choosing an icon changes no Grant, Policy decision, budget or progression.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeTestDb, resetTestSchema, testDb } from "../testDb.js";
import * as schema from "../../src/db/schema.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { seedPublishWorkflow, seedV11Definitions } from "../../src/definitions/seed.js";
import { buildServer } from "../../src/api/server.js";
import { createAgentDefinition } from "../../src/definitions/registryWrites.js";
import { ROLE_ICON_CATALOGUE, derivedRoleIcon, readRoleIcons } from "../../src/definitions/roleIcon.js";

let app: FastifyInstance;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
  const res = await app.inject({ method, url, payload: payload as Json });
  return { status: res.statusCode, body: res.json() as Json };
};
const authority = async () =>
  JSON.stringify(await Promise.all([schema.capabilities, schema.capabilityGrants, schema.toolBindings, schema.agentDefinitions, schema.executionStops, schema.agentXpAwards].map((t) => testDb.select().from(t))));

beforeAll(async () => {
  await resetTestSchema();
  await testDb.transaction((tx) => seedPublishWorkflow(tx));
  await testDb.transaction((tx) => seedV11Definitions(tx));
  app = buildServer({ db: testDb });
  await app.ready();
}, 30_000);

afterAll(async () => {
  await app.close();
  await closeTestDb();
});

describe("the catalogue", () => {
  it("every icon has a distinct id, symbol and identity colour, and no identity colour is a runtime state colour", () => {
    const icons = ROLE_ICON_CATALOGUE.icons;
    expect(icons.length).toBeGreaterThanOrEqual(6);
    expect(new Set(icons.map((i) => i.id)).size).toBe(icons.length);
    expect(new Set(icons.map((i) => i.pixels.join("|"))).size).toBe(icons.length);
    expect(new Set(icons.map((i) => i.colorToken)).size).toBe(icons.length);
    for (const i of icons) {
      expect(i.colorToken).toMatch(/^--role-[a-z]+$/);
      expect(i.pixels).toHaveLength(ROLE_ICON_CATALOGUE.size);
      for (const row of i.pixels) expect(row).toMatch(new RegExp(`^[.#+]{${ROLE_ICON_CATALOGUE.size}}$`));
      // A symbol, not an empty square: shape alone tells the roles apart.
      expect(i.pixels.join("").replace(/\./g, "").length).toBeGreaterThan(8);
      expect(i.name.length).toBeGreaterThan(2);
      expect(i.description.length).toBeGreaterThan(10);
    }
  });

  it("an agent's own words earn its icon, and unknown words earn the plain one", () => {
    expect(derivedRoleIcon("Researcher Research Analyst Retrieve information for a query")).toBe("research");
    expect(derivedRoleIcon("Field Researcher gathers evidence from public sources")).toBe("field");
    expect(derivedRoleIcon("Manager Workforce coordinator delegates bounded work")).toBe("command");
    expect(derivedRoleIcon("Keeper The Command Keep's guide explains the records")).toBe("keeper");
    expect(derivedRoleIcon("Publisher publishes the report")).toBe("publishing");
    expect(derivedRoleIcon("Reviewer approval gate checkpoint")).toBe("review");
    expect(derivedRoleIcon("Evidence Analyst analyses reports")).toBe("analysis");
    expect(derivedRoleIcon("Idea Architect brainstorms options")).toBe("idea");
    expect(derivedRoleIcon("Strategist plans the season")).toBe("strategy");
    expect(derivedRoleIcon("Blorb does an unnameable thing")).toBe("generic");
  });
});

describe("every agent has an icon, and it is theirs to keep", () => {
  it("the seeded agents each get a catalogue icon from their first version", async () => {
    const icons = await readRoleIcons(testDb);
    const ids = ROLE_ICON_CATALOGUE.icons.map((i) => i.id);
    expect([...icons.keys()].sort()).toEqual(["Field Researcher", "Keeper", "Manager", "Publisher", "Researcher", "Reviewer"]);
    for (const [, v] of icons) {
      expect(ids).toContain(v.iconId);
      expect(v.chosen).toBe(false);
    }
    expect(icons.get("Manager")!.iconId).toBe("command");
    expect(icons.get("Keeper")!.iconId).toBe("keeper");
    expect(icons.get("Researcher")!.iconId).toBe("research");
    expect(icons.get("Field Researcher")!.iconId).toBe("field");
    const listed = (await call("GET", "/role-icons")).body;
    expect(listed.catalogue.icons.length).toBe(ROLE_ICON_CATALOGUE.icons.length);
    expect(listed.agents.find((a: Json) => a.name === "Publisher")).toEqual({ name: "Publisher", iconId: "publishing", chosen: false });
  });

  it("a new Agent Definition version never changes the icon, whatever its new words say", async () => {
    const before = (await readRoleIcons(testDb)).get("Researcher")!.iconId;
    await testDb.transaction(async (tx) => {
      const versions = await tx.select().from(schema.agentDefinitions).where(eq(schema.agentDefinitions.name, "Researcher"));
      const latest = versions.sort((a, b) => b.version - a.version)[0]!;
      await createAgentDefinition(
        tx,
        { name: "Researcher", previousVersion: latest.version, role: "Publishing Reviewer", objective: "Publish and review everything.", instructions: latest.instructions, executionProfile: latest.executionProfile, grants: [] },
        "human:operator"
      );
    });
    expect((await readRoleIcons(testDb)).get("Researcher")!.iconId).toBe(before);
    expect(before).toBe("research");
  });

  it("the operator may choose one; only catalogue ids are accepted; an appearance change leaves it alone", async () => {
    const authorityBefore = await authority();
    expect((await call("POST", "/agent-role-icons/Publisher", { iconId: "idea" })).body).toEqual({ agentName: "Publisher", iconId: "idea" });
    const icons = (await call("GET", "/role-icons")).body.agents as Json[];
    expect(icons.find((a) => a.name === "Publisher")).toEqual({ name: "Publisher", iconId: "idea", chosen: true });
    expect(icons.find((a) => a.name === "Keeper")).toMatchObject({ chosen: false });

    for (const bad of [{ iconId: "wizard" }, { iconId: "" }, { iconId: 3 }, {}]) expect((await call("POST", "/agent-role-icons/Publisher", bad)).status).toBe(400);
    expect((await call("POST", "/agent-role-icons/Nobody", { iconId: "idea" })).status).toBe(404);
    expect((await call("POST", "/agent-role-icons/Publisher", { iconId: "idea" })).status).toBe(200);

    // Changing how an agent looks does not touch its role icon, and the icon does not touch its look.
    const look = (await call("GET", "/registry")).body.builder.appearance.presets[0].appearance;
    expect((await call("POST", "/agent-appearances/Publisher", { appearance: look })).status).toBe(200);
    expect(((await call("GET", "/role-icons")).body.agents as Json[]).find((a) => a.name === "Publisher")!.iconId).toBe("idea");

    // Nothing an icon touches is authority: Grants, Definitions, stops and XP are unchanged (the appearance
    // above is this test's own doing, and lives in its own table).
    expect(await authority()).toEqual(authorityBefore);
    const rows = await testDb.execute(sql`SELECT count(*)::int AS n FROM agent_role_icons`);
    expect((rows.rows[0] as { n: number }).n).toBe(1);
  });

  it("an icon says nothing about what an agent may do: the Registry still decides", async () => {
    await call("POST", "/agent-role-icons/Keeper", { iconId: "command" });
    const registry = (await call("GET", "/registry")).body;
    const keeper = registry.agentDefinitions.filter((a: Json) => a.name === "Keeper").sort((a: Json, b: Json) => b.version - a.version)[0];
    const grants = registry.capabilityGrants.filter((g: Json) => g.agentDefinitionId === keeper.id && !g.revokedAt).map((g: Json) => registry.capabilities.find((c: Json) => c.id === g.capabilityId).name);
    // It now wears the Manager's symbol and holds not one of the Manager's Grants.
    expect(grants).not.toContain("manager.delegate");
    expect(grants).not.toContain("manager.inspect_workforce");
    expect(grants.sort()).toEqual(["docs.retrieve", "system.inspect", "system.keep_stats"]);
    await call("POST", "/agent-role-icons/Keeper", { iconId: "keeper" });
  });
});
