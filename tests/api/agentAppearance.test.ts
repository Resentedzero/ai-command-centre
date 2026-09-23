/**
 * R2 agent visual identity: an appearance belongs to the persistent agent (its name), survives
 * new Definition versions, changes only when the operator sets it, and touches nothing else —
 * no Definition version, Grant, budget, execution profile, event or runtime row.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeTestDb, resetTestSchema, testDb } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import { seedResearchWorkflow } from "../../src/definitions/seed.js";
import { APPEARANCE_CATALOGUE, defaultAppearance, derivedAppearance, parseAppearance, resolveAppearance } from "../../src/definitions/appearance.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { buildServer } from "../../src/api/server.js";

let app: FastifyInstance;
let researchCapabilityId: string;

const SCHOLAR = { skin: "deep", hair: "bun", hairColor: "grey", top: "robe", topColor: "violet", bottom: "skirt", bottomColor: "umber", accessory: "glasses", mark: "book" };
const RUNNER = { skin: "fair", hair: "hood", hairColor: "black", top: "vest", topColor: "teal", bottom: "shorts", bottomColor: "slate", accessory: "scarf", mark: "gear" };
const BASE = { role: "Researcher", objective: "Find sources", instructions: "Cite everything." };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

async function call(method: "GET" | "POST", url: string, payload?: unknown) {
  const res = await app.inject({ method, url, payload: payload as Record<string, unknown> | undefined });
  return { status: res.statusCode, body: res.json() as Json };
}

/** Everything an appearance write must leave alone. */
async function runtimeSnapshot() {
  const [definitions, grants, counters, events, runs, invocations, taskInstances, workflowRuns] = await Promise.all([
    testDb.select().from(schema.agentDefinitions),
    testDb.select().from(schema.capabilityGrants),
    testDb.select().from(schema.budgetCounters),
    testDb.select().from(schema.events),
    testDb.select().from(schema.runs),
    testDb.select().from(schema.invocations),
    testDb.select().from(schema.taskInstances),
    testDb.select().from(schema.workflowRuns),
  ]);
  return JSON.stringify({ definitions, grants, counters, events, runs, invocations, taskInstances, workflowRuns });
}

beforeAll(async () => {
  await resetTestSchema();
  await testDb.transaction((tx) => seedResearchWorkflow(tx));
  researchCapabilityId = (await testDb.query.capabilities.findFirst({ where: eq(schema.capabilities.name, "research.retrieve") }))!.id;
  app = buildServer({ db: testDb });
  await app.ready();
}, 30000);

afterAll(async () => {
  await app.close();
  await closeTestDb();
});

describe("catalogue validation", () => {
  it("accepts a complete appearance and refuses unknown parts, unknown options and missing parts", () => {
    expect(parseAppearance(SCHOLAR)).toEqual({ ok: true, appearance: SCHOLAR });
    expect(parseAppearance({ ...SCHOLAR, wings: "yes" })).toMatchObject({ ok: false, reason: expect.stringMatching(/wings/) });
    expect(parseAppearance({ ...SCHOLAR, hair: "mohawk" })).toMatchObject({ ok: false, reason: expect.stringMatching(/hair/) });
    const { mark: _mark, ...missing } = SCHOLAR;
    expect(parseAppearance(missing)).toMatchObject({ ok: false });
    expect(parseAppearance("knight")).toMatchObject({ ok: false });
  });

  it("resolves a stored option the catalogue no longer has to that part's default, never an error", () => {
    expect(resolveAppearance({ ...SCHOLAR, top: "retired-armour", legacyField: "x" })).toEqual({ ...SCHOLAR, top: defaultAppearance().top });
    expect(resolveAppearance({})).toEqual(defaultAppearance());
  });

  it("offers only presets the catalogue accepts, and derives a valid, stable, name-keyed look for agents without one", () => {
    expect(APPEARANCE_CATALOGUE.presets.length).toBeGreaterThanOrEqual(4);
    for (const preset of APPEARANCE_CATALOGUE.presets) expect(parseAppearance(preset.appearance)).toMatchObject({ ok: true });
    const names = ["Researcher", "Analyst", "Publisher", "Keeper", "Strategist", "Field Researcher"];
    for (const name of names) {
      expect(parseAppearance(derivedAppearance(name))).toMatchObject({ ok: true });
      expect(derivedAppearance(name)).toEqual(derivedAppearance(name));
    }
    expect(new Set(names.map((n) => JSON.stringify(derivedAppearance(n)))).size).toBe(names.length);
  });
});

describe("POST /agent-appearances/:name", () => {
  it("sets an appearance without creating a version, Grant, counter, event or runtime row", async () => {
    const created = await call("POST", "/agent-definitions", {
      name: "Scholar",
      ...BASE,
      executionProfile: { preferredTier: "MID", provider: "claude_subscription" },
      grants: [{ capabilityId: researchCapabilityId, permissions: ["READ"], autonomyState: "AUTONOMOUS", maxTrustLevelRequired: 1 }],
    });
    expect(created.status).toBe(201);
    const before = await runtimeSnapshot();

    const saved = await call("POST", "/agent-appearances/Scholar", { appearance: SCHOLAR });
    expect(saved).toMatchObject({ status: 200, body: { name: "Scholar", appearance: SCHOLAR } });
    expect(await runtimeSnapshot()).toBe(before);

    const detail = await call("GET", `/agents/${created.body.id}`);
    expect(detail.body.agent).toMatchObject({ name: "Scholar", version: 1, appearance: SCHOLAR, executionProfile: { preferredTier: "MID" } });
  });

  it("keeps the appearance across a new Definition version, and a new version never changes it", async () => {
    const v2 = await call("POST", "/agent-definitions", { name: "Scholar", previousVersion: 1, ...BASE, objective: "Find better sources" });
    expect(v2).toMatchObject({ status: 201, body: { version: 2 } });
    expect((await call("GET", `/agents/${v2.body.id}`)).body.agent.appearance).toEqual(SCHOLAR);

    const registry = await call("GET", "/registry");
    const scholars = (registry.body.agentDefinitions as Json[]).filter((a) => a.name === "Scholar");
    expect(scholars.map((a) => [a.version, a.appearance])).toEqual([
      [1, SCHOLAR],
      [2, SCHOLAR],
    ]);
  });

  it("persists an explicit change, and two agents keep distinct appearances", async () => {
    expect((await call("POST", "/agent-definitions", { name: "Runner", ...BASE })).status).toBe(201);
    expect((await call("POST", "/agent-appearances/Runner", { appearance: RUNNER })).status).toBe(200);
    const changed = { ...SCHOLAR, hairColor: "white", mark: "quill" };
    expect((await call("POST", "/agent-appearances/Scholar", { appearance: changed })).status).toBe(200);

    const rows = await testDb.select().from(schema.agentAppearances);
    expect(Object.fromEntries(rows.map((r) => [r.agentName, r.appearance]))).toEqual({ Scholar: changed, Runner: RUNNER });
    expect(await testDb.query.agentDefinitions.findMany({ where: eq(schema.agentDefinitions.name, "Scholar") })).toHaveLength(2);
  });

  it("refuses an invalid appearance (400) and a name no agent carries (404), writing nothing", async () => {
    const before = await testDb.select().from(schema.agentAppearances);
    expect((await call("POST", "/agent-appearances/Runner", { appearance: { ...RUNNER, top: "cape" } })).status).toBe(400);
    expect((await call("POST", "/agent-appearances/Runner", {})).status).toBe(400);
    expect((await call("POST", "/agent-appearances/Nobody", { appearance: RUNNER })).status).toBe(404);
    expect(await testDb.select().from(schema.agentAppearances)).toEqual(before);
  });

  it("gives an existing agent with no appearance null (default character), and offers the catalogue to the builder", async () => {
    const registry = await call("GET", "/registry");
    const seeded = (registry.body.agentDefinitions as Json[]).filter((a) => a.name !== "Scholar" && a.name !== "Runner");
    expect(seeded.length).toBeGreaterThan(0);
    expect(seeded.every((a) => a.appearance === null)).toBe(true);
    // Drawn with the look derived from the name, which is never stored.
    expect(seeded.every((a) => JSON.stringify(a.look) === JSON.stringify(derivedAppearance(a.name as string)))).toBe(true);
    expect(registry.body.builder.appearance.parts.hair).toMatchObject({ default: "short", options: expect.arrayContaining(["bun"]) });
    expect(registry.body.builder.appearance.frames).toEqual({ idle: 4, walk: 6, work: 6 });
    expect(registry.body.builder.appearance.facings).toEqual(["down", "side", "up"]);
  });

  it("falls back to defaults for a stored option the catalogue has since dropped", async () => {
    await testDb.update(schema.agentAppearances).set({ appearance: { ...RUNNER, accessory: "monocle" } }).where(eq(schema.agentAppearances.agentName, "Runner"));
    const registry = await call("GET", "/registry");
    const runner = (registry.body.agentDefinitions as Json[]).find((a) => a.name === "Runner");
    expect(runner!.appearance).toEqual({ ...RUNNER, accessory: "none" });
  });
});
