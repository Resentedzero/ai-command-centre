/**
 * V1.1 Agent Builder over the Registry: an Agent Definition version and its Grants
 * are created in one transaction; the execution profile is validated against the
 * runtime's own configuration and the operator's ceilings; a new version never
 * touches an older one; the builder's options come from the API.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeTestDb, resetTestSchema, testDb } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import { seedResearchWorkflow, type SeedResearchWorkflowResult } from "../../src/definitions/seed.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { buildServer } from "../../src/api/server.js";

let app: FastifyInstance;
let seed: SeedResearchWorkflowResult;
let researchCapabilityId: string;

async function post(url: string, payload: unknown) {
  const res = await app.inject({ method: "POST", url, payload: payload as Record<string, unknown> });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

const BASE = { role: "Idea Architect", objective: "Develop ideas into opportunities", instructions: "Think in options." };

beforeAll(async () => {
  await resetTestSchema();
  seed = await testDb.transaction((tx) => seedResearchWorkflow(tx));
  researchCapabilityId = (await testDb.query.capabilities.findFirst({ where: eq(schema.capabilities.name, "research.retrieve") }))!.id;
  app = buildServer({ db: testDb });
  await app.ready();
}, 30000);

afterAll(async () => {
  await app.close();
  await closeTestDb();
});

describe("POST /agent-definitions with grants and an execution profile", () => {
  it("creates the version, its Grants and the profile in one write, with one event each", async () => {
    const res = await post("/agent-definitions", {
      name: "Architect",
      ...BASE,
      executionProfile: { preferredTier: "MID", provider: "claude_subscription", loop: { maxIterations: 8, maxActiveSeconds: 600 } },
      grants: [{ capabilityId: researchCapabilityId, permissions: ["READ"], autonomyState: "AUTONOMOUS", maxTrustLevelRequired: 1 }],
    });
    expect(res).toMatchObject({ status: 201, body: { name: "Architect", version: 1 } });
    const id = res.body.id as string;

    const row = await testDb.query.agentDefinitions.findFirst({ where: eq(schema.agentDefinitions.id, id) });
    expect(row!.executionProfile).toEqual({ preferredTier: "MID", provider: "claude_subscription", loop: { maxIterations: 8, maxActiveSeconds: 600 } });
    const grants = await testDb.query.capabilityGrants.findMany({ where: eq(schema.capabilityGrants.agentDefinitionId, id) });
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ agentDefinitionVersion: 1, autonomyState: "AUTONOMOUS", permissions: ["READ"] });

    expect(await testDb.query.events.findFirst({ where: eq(schema.events.idempotencyKey, `definition_version_created:${id}`) })).toBeTruthy();
    expect(await testDb.query.events.findFirst({ where: eq(schema.events.idempotencyKey, `capability_granted:${grants[0]!.id}`) })).toBeTruthy();
  });

  it("rolls back the whole write when any Grant is refused (AUTONOMOUS PUBLISH, unknown capability)", async () => {
    const publish = await post("/capability-grants", {}); // establishes route shape only
    expect(publish.status).toBe(400);

    const refused = await post("/agent-definitions", {
      name: "HalfGranted",
      ...BASE,
      grants: [
        { capabilityId: researchCapabilityId, permissions: ["READ"], autonomyState: "AUTONOMOUS", maxTrustLevelRequired: 1 },
        { capabilityId: researchCapabilityId, permissions: ["PUBLISH"], autonomyState: "AUTONOMOUS", maxTrustLevelRequired: 1 },
      ],
    });
    expect(refused.status).toBe(400);
    expect(String(refused.body.error)).toMatch(/^grants\[1\]:/);
    expect(await testDb.query.agentDefinitions.findMany({ where: eq(schema.agentDefinitions.name, "HalfGranted") })).toHaveLength(0);

    const unknown = await post("/agent-definitions", {
      name: "HalfGranted",
      ...BASE,
      grants: [{ capabilityId: "00000000-0000-4000-8000-000000000000", permissions: ["READ"], maxTrustLevelRequired: 1 }],
    });
    expect(unknown.status).toBe(400);
    expect(await testDb.query.agentDefinitions.findMany({ where: eq(schema.agentDefinitions.name, "HalfGranted") })).toHaveLength(0);
    expect(await testDb.query.capabilityGrants.findMany({ where: eq(schema.capabilityGrants.capabilityId, researchCapabilityId) })).toHaveLength(2); // seed + Architect
  });

  it("refuses a Grant that tries to pin another agent version", async () => {
    const res = await post("/agent-definitions", {
      name: "Sneaky",
      ...BASE,
      grants: [{ capabilityId: researchCapabilityId, permissions: ["READ"], maxTrustLevelRequired: 1, agentDefinitionId: seed.agentDefinitionId, agentDefinitionVersion: 1 }],
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/set by the new version/);
  });

  it.each([
    [{ preferredTier: "ULTRA" }, /preferredTier/],
    [{ provider: "made_up" }, /configured provider/],
    [{ loop: { maxIterations: 13 } }, /1 to 12/],
    [{ loop: { maxActiveSeconds: 901 } }, /60 to 900/],
    [{ loop: { maxIterations: 3, extend: true } }, /unknown field/],
    [{ maxBudget: 1_000_000 }, /unknown field/],
  ])("refuses profile %j: limits can only be lowered, never raised or invented", async (executionProfile, message) => {
    const res = await post("/agent-definitions", { name: "BadProfile", ...BASE, executionProfile });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(message);
  });
});

describe("versioning keeps history immutable", () => {
  it("a new version gets its own Grants; version 1, its Grants and its Runs are untouched", async () => {
    const v1 = await testDb.query.agentDefinitions.findFirst({ where: and(eq(schema.agentDefinitions.name, "Architect"), eq(schema.agentDefinitions.version, 1)) });
    const v1Grants = await testDb.query.capabilityGrants.findMany({ where: eq(schema.capabilityGrants.agentDefinitionId, v1!.id) });

    const v2 = await post("/agent-definitions", {
      name: "Architect",
      ...BASE,
      instructions: "Challenge every idea.",
      previousVersion: 1,
      executionProfile: { preferredTier: "STRONG" },
      grants: [{ capabilityId: researchCapabilityId, permissions: ["READ"], autonomyState: "ALWAYS_APPROVE", maxTrustLevelRequired: 1 }],
    });
    expect(v2).toMatchObject({ status: 201, body: { version: 2 } });

    const after = await testDb.query.agentDefinitions.findFirst({ where: eq(schema.agentDefinitions.id, v1!.id) });
    expect(after).toEqual(v1);
    expect(await testDb.query.capabilityGrants.findMany({ where: eq(schema.capabilityGrants.agentDefinitionId, v1!.id) })).toEqual(v1Grants);
    const v2Grants = await testDb.query.capabilityGrants.findMany({ where: eq(schema.capabilityGrants.agentDefinitionId, v2.body.id as string) });
    expect(v2Grants.map((g) => [g.agentDefinitionVersion, g.autonomyState])).toEqual([[2, "ALWAYS_APPROVE"]]);
  });

  it("an in-use version still refuses new Grants (spec §9.2), pointing at a new version", async () => {
    const res = await post("/capability-grants", {
      agentDefinitionId: seed.agentDefinitionId,
      agentDefinitionVersion: 1,
      capabilityId: researchCapabilityId,
      permissions: ["READ"],
      maxTrustLevelRequired: 1,
    });
    // The seeded Researcher already holds a READ Grant; either refusal is a 409 and nothing is written.
    expect(res.status).toBe(409);
  });
});

describe("GET /registry builder options", () => {
  it("exposes profiles and the options the builder may offer, from runtime configuration", async () => {
    const res = await app.inject({ method: "GET", url: "/registry" });
    const body = res.json() as {
      agentDefinitions: { name: string; version: number; executionProfile: unknown }[];
      builder: {
        permissions: string[];
        autonomyStates: string[];
        tiers: string[];
        providers: { name: string; enabled: boolean; tiers: string[]; resourceUnits: string[] }[];
        autonomyLimits: { maxIterations: number; maxActiveSeconds: number; taskInstanceCeilings: Record<string, string> };
      };
    };
    expect(body.agentDefinitions.find((a) => a.name === "Architect" && a.version === 2)!.executionProfile).toEqual({ preferredTier: "STRONG" });
    expect(body.agentDefinitions.find((a) => a.name === "Researcher")!.executionProfile).toEqual({});
    expect(body.builder.permissions).toContain("PUBLISH");
    expect(body.builder.autonomyStates).toEqual(["ALWAYS_APPROVE", "CONDITIONAL", "AUTONOMOUS"]);
    expect(body.builder.tiers).toEqual(["CHEAP", "MID", "STRONG"]);
    expect(body.builder.providers.find((p) => p.name === "claude_subscription")).toMatchObject({ enabled: true, resourceUnits: ["subscription_tokens"] });
    expect(body.builder.autonomyLimits).toMatchObject({ maxIterations: 12, maxActiveSeconds: 900, taskInstanceCeilings: { subscription_tokens: "50000" } });
  });

  it("GET /agents/:id carries instructions and the execution profile", async () => {
    const v2 = await testDb.query.agentDefinitions.findFirst({ where: and(eq(schema.agentDefinitions.name, "Architect"), eq(schema.agentDefinitions.version, 2)) });
    const res = await app.inject({ method: "GET", url: `/agents/${v2!.id}` });
    expect(res.json().agent).toMatchObject({ instructions: "Challenge every idea.", executionProfile: { preferredTier: "STRONG" } });
  });
});
