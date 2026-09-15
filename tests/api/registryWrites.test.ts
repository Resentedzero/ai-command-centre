/**
 * Registry writes through the HTTP API (`src/definitions/registryWrites.ts`, roadmap
 * V1.1): Definitions are created and versioned as data, never updated; every write
 * is validated fail-closed and audited; and a whole new workflow built only through
 * these routes runs end to end, with no SQL and no seed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeTestDb, resetTestSchema, testDb, testPool } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import { seedPublishWorkflow, type SeedPublishWorkflowResult, DEFAULT_RESEARCH_REPORT_CONTEXT_BUDGET } from "../../src/definitions/seed.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { buildServer } from "../../src/api/server.js";
import { registerInternalToolFunction, resolveToolInvocation } from "../../src/capabilities/toolAdapters.js";
import { registerTaskPlanBuilder } from "../../src/capabilities/taskPlans.js";

// What a new capability module would contribute (code); everything else is created over HTTP.
const CHAR_COUNT = "text.char_count";
registerInternalToolFunction("text.char_count.local", {
  capabilityName: CHAR_COUNT,
  prepare: async (_tx, { proposedActionSnapshot }) => ({
    inputs: { text: String(proposedActionSnapshot.text) },
    costClass: "local_retrieval",
    estimatedCost: 0,
  }),
  execute: async ({ inputs }) => ({ chars: (inputs.text as string).length }),
});
registerTaskPlanBuilder("count_chars", async (tx, ctx) => [
  await resolveToolInvocation(tx, { capabilityName: CHAR_COUNT, permission: "READ", proposedActionSnapshot: { text: ctx.parameters.text } }),
]);

let app: FastifyInstance;
let seed: SeedPublishWorkflowResult;

async function post(url: string, payload: unknown) {
  const res = await app.inject({ method: "POST", url, payload: payload as Record<string, unknown> });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

async function eventFor(key: string) {
  return testDb.query.events.findFirst({ where: eq(schema.events.idempotencyKey, key) });
}

beforeAll(async () => {
  await resetTestSchema();
  seed = await testDb.transaction((tx) => seedPublishWorkflow(tx));
  app = buildServer({ db: testDb });
  await app.ready();
}, 30000);

afterAll(async () => {
  await app.close();
  await closeTestDb();
});

const AGENT = { role: "Analyst", objective: "Analyse", instructions: "Be precise." };

describe("versioning: editing creates a new version, never mutates history", () => {
  it("creates version 1, refuses an implicit or stale re-create, and versions only when previousVersion names the latest", async () => {
    const v1 = await post("/agent-definitions", { name: "Analyst", ...AGENT });
    expect(v1).toMatchObject({ status: 201, body: { name: "Analyst", version: 1 } });

    expect((await post("/agent-definitions", { name: "Analyst", ...AGENT })).status).toBe(409);
    expect((await post("/agent-definitions", { name: "Analyst", ...AGENT, previousVersion: 0 })).status).toBe(409);
    expect((await post("/agent-definitions", { name: "Brand-New", ...AGENT, previousVersion: 1 })).status).toBe(409);

    const v2 = await post("/agent-definitions", { name: "Analyst", ...AGENT, instructions: "Be concise.", previousVersion: 1 });
    expect(v2).toMatchObject({ status: 201, body: { name: "Analyst", version: 2 } });
    expect(v2.body.id).not.toBe(v1.body.id);

    const original = await testDb.query.agentDefinitions.findFirst({ where: eq(schema.agentDefinitions.id, v1.body.id as string) });
    expect(original).toMatchObject({ version: 1, instructions: "Be precise." });

    const event = await eventFor(`definition_version_created:${v2.body.id}`);
    expect(event).toMatchObject({ eventType: "definition_version_created", actor: "human:operator", producer: "registry" });
    expect(event!.payload).toEqual({ definitionType: "agent_definition", id: v2.body.id, name: "Analyst", version: 2 });
  });

  it("allocates a version only while holding the per-name registry lock", async () => {
    const holder = await testPool.connect();
    try {
      await holder.query("select pg_advisory_lock(20260914, hashtext('registry:agent_definitions:Locked'))");
      let settled = false;
      const pending = post("/agent-definitions", { name: "Locked", ...AGENT }).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      await holder.query("select pg_advisory_unlock(20260914, hashtext('registry:agent_definitions:Locked'))");
      expect((await pending).status).toBe(201);
    } finally {
      holder.release();
    }
  });

  it("serializes concurrent creates of the same name: exactly one wins", async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => post("/agent-definitions", { name: "Racer", ...AGENT })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
    expect(await testDb.query.agentDefinitions.findMany({ where: eq(schema.agentDefinitions.name, "Racer") })).toHaveLength(1);
  });

  it("versioning a seeded Definition keeps the default POST /goals working, on the latest seeded workflow version", async () => {
    expect((await post("/agent-definitions", { name: "Researcher", ...AGENT, previousVersion: 1 })).status).toBe(201);
    const workflow = await testDb.query.workflowDefinitions.findFirst({ where: eq(schema.workflowDefinitions.id, seed.workflowDefinitionId) });
    const v2 = await post("/workflow-definitions", { name: "Research-and-Publish", graphDefinition: workflow!.graphDefinition, previousVersion: 1 });
    expect(v2.status).toBe(201);

    const { findSeededPublishWorkflow } = await import("../../src/definitions/lookupSeed.js");
    const refs = await testDb.transaction((tx) => findSeededPublishWorkflow(tx));
    expect(refs).toMatchObject({ workflowDefinitionId: v2.body.id, agentDefinitionVersion: 2 });
  });

  it("rejects malformed bodies and out-of-range integers", async () => {
    expect((await post("/agent-definitions", { name: " Padded", ...AGENT })).status).toBe(400);
    const step = { taskDefinitionId: seed.taskDefinitionId, taskDefinitionVersion: 1e12, agentDefinitionId: seed.agentDefinitionId, agentDefinitionVersion: 1 };
    expect((await post("/workflow-definitions", { name: "Big", graphDefinition: { kind: "linear", steps: [step] } })).status).toBe(400);
    expect((await post("/workflow-definitions", { name: "Big", graphDefinition: { kind: "linear", steps: [{ ...step, taskDefinitionVersion: 1.5 }] } })).status).toBe(400);
    expect(
      (await post("/capability-grants", { agentDefinitionId: seed.agentDefinitionId, agentDefinitionVersion: 1e12, capabilityId: seed.capabilityId, permissions: ["WRITE"], maxTrustLevelRequired: 1 })).status
    ).toBe(400);
    expect((await post("/agent-definitions", { name: "", ...AGENT })).status).toBe(400);
    expect((await post("/agent-definitions", { name: "X", ...AGENT, memoryPolicy: [] })).status).toBe(400);
    expect((await post("/agent-definitions", { name: "X", ...AGENT, previousVersion: "1" })).status).toBe(400);
    const res = await app.inject({ method: "POST", url: "/agent-definitions", payload: "[1]", headers: { "content-type": "application/json" } });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /capabilities and /tool-bindings", () => {
  it("refuses a duplicate capability name and an unknown risk tag", async () => {
    expect((await post("/capabilities", { name: "research.retrieve", staticRiskTag: "low" })).status).toBe(409);
    expect((await post("/capabilities", { name: "x.y", staticRiskTag: "trivial" })).status).toBe(400);
  });

  it("refuses bindings resolution could not execute, and creates the next version otherwise, without echoing config", async () => {
    const base = { capabilityId: seed.capabilityId, trustLevel: 2, previousVersion: 1 };
    const refusals = [
      { ...base, kind: "direct_api", config: { function: "research.retrieve.local_corpus" } },
      { ...base, kind: "internal", config: { function: "not.registered" } },
      { ...base, kind: "internal", config: { function: "publish.report.filesystem" } }, // another capability's function
      { ...base, kind: "internal", config: { function: "research.retrieve.local_corpus" }, trustLevel: 3 },
      { ...base, kind: "internal", config: { function: "research.retrieve.local_corpus" }, capabilityId: "nope" },
    ];
    for (const payload of refusals) expect((await post("/tool-bindings", payload)).status).toBe(400);
    expect((await post("/tool-bindings", { ...base, kind: "internal", config: { function: "research.retrieve.local_corpus" }, previousVersion: undefined })).status).toBe(409);

    const created = await app.inject({
      method: "POST",
      url: "/tool-bindings",
      payload: { ...base, kind: "internal", config: { function: "research.retrieve.local_corpus", maxResults: 3 } },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: "research.retrieve", version: 2 });
    expect(created.body).not.toContain("maxResults");
    const event = await eventFor(`definition_version_created:${created.json().id}`);
    expect(JSON.stringify(event!.payload)).not.toContain("maxResults");
    expect(event!.payload).toMatchObject({ capabilityId: seed.capabilityId, kind: "internal", function: "research.retrieve.local_corpus", trustLevel: 2 });
  });
});

describe("POST /task-definitions and /workflow-definitions", () => {
  it("refuses an unregistered kind and an incomplete context budget", async () => {
    expect((await post("/task-definitions", { name: "T", kind: "no_such_kind" })).status).toBe(400);
    const { expectedOutputTokens: _dropped, ...incomplete } = DEFAULT_RESEARCH_REPORT_CONTEXT_BUDGET;
    expect((await post("/task-definitions", { name: "T", kind: "research_report", defaultContextBudget: incomplete })).status).toBe(400);
    expect((await post("/task-definitions", { name: "T", kind: "research_report", defaultContextBudget: DEFAULT_RESEARCH_REPORT_CONTEXT_BUDGET })).status).toBe(201);
  });

  it("refuses graphs with an unbound step or a missing Task/Agent version", async () => {
    const step = {
      taskDefinitionId: seed.taskDefinitionId,
      taskDefinitionVersion: 1,
      agentDefinitionId: seed.agentDefinitionId,
      agentDefinitionVersion: 1,
    };
    const graph = (s: Record<string, unknown>) => ({ name: "W", graphDefinition: { kind: "linear", steps: [s] } });
    expect((await post("/workflow-definitions", graph({ taskDefinitionId: step.taskDefinitionId, taskDefinitionVersion: 1 }))).status).toBe(400);
    expect((await post("/workflow-definitions", graph({ ...step, taskDefinitionVersion: 9 }))).status).toBe(400);
    expect((await post("/workflow-definitions", graph({ ...step, agentDefinitionVersion: 9 }))).status).toBe(400);
    expect((await post("/workflow-definitions", graph({ ...step, agentDefinitionId: "nope" }))).status).toBe(400);
    expect((await post("/workflow-definitions", { name: "W", graphDefinition: { kind: "linear", steps: [] } })).status).toBe(400);
    expect((await post("/workflow-definitions", graph(step))).status).toBe(201);
  });
});

describe("POST /capability-grants", () => {
  it("refuses a Grant on an Agent version already in use: changing authorization is a new Agent version (spec 9.2)", async () => {
    const onSeeded = await post("/capability-grants", {
      agentDefinitionId: seed.publisherAgentDefinitionId,
      agentDefinitionVersion: 1,
      capabilityId: seed.capabilityId,
      permissions: ["READ"],
      autonomyState: "AUTONOMOUS",
      maxTrustLevelRequired: 1,
    });
    expect(onSeeded.status).toBe(409);
    expect(String(onSeeded.body.error)).toContain("already in use");
    expect(await testDb.query.capabilityGrants.findMany({ where: eq(schema.capabilityGrants.agentDefinitionId, seed.publisherAgentDefinitionId) })).toHaveLength(1);
  });

  it("enforces the autonomy ceiling, refuses scope, unknown references and overlap, defaults to ALWAYS_APPROVE, and records capability_granted", async () => {
    const publisherV2 = await post("/agent-definitions", { name: "Publisher", ...AGENT, previousVersion: 1 });
    expect(publisherV2.status).toBe(201);
    const base = {
      agentDefinitionId: publisherV2.body.id,
      agentDefinitionVersion: 2,
      capabilityId: seed.publishCapabilityId,
      maxTrustLevelRequired: 1,
    };
    expect((await post("/capability-grants", { ...base, permissions: ["PUBLISH"], autonomyState: "AUTONOMOUS" })).status).toBe(400);
    expect((await post("/capability-grants", { ...base, permissions: ["READ"], autonomyState: "AUTONOMOUS", scope: { path: "x" } })).status).toBe(400);
    expect((await post("/capability-grants", { ...base, permissions: ["READ", "READ"], autonomyState: "AUTONOMOUS" })).status).toBe(400);
    expect((await post("/capability-grants", { ...base, permissions: ["FLY"], autonomyState: "AUTONOMOUS" })).status).toBe(400);
    expect((await post("/capability-grants", { ...base, permissions: ["READ"], autonomyState: "SOMETIMES" })).status).toBe(400);
    expect((await post("/capability-grants", { ...base, agentDefinitionVersion: 3, permissions: ["READ"], autonomyState: "AUTONOMOUS" })).status).toBe(400);

    const publish = await post("/capability-grants", { ...base, permissions: ["PUBLISH"] });
    expect(publish.status).toBe(201);
    const stored = await testDb.query.capabilityGrants.findFirst({ where: eq(schema.capabilityGrants.id, publish.body.id as string) });
    expect(stored?.autonomyState).toBe("ALWAYS_APPROVE"); // spec 9.4 default when omitted
    const event = await eventFor(`capability_granted:${publish.body.id}`);
    expect(event).toMatchObject({ eventType: "capability_granted", actor: "human:operator" });
    expect(event!.payload).toMatchObject({ grantId: publish.body.id, permissions: ["PUBLISH"], autonomyState: "ALWAYS_APPROVE" });

    // A second Grant covering PUBLISH with different autonomy would make resolution arbitrary.
    const overlap = await post("/capability-grants", { ...base, permissions: ["PUBLISH", "READ"], autonomyState: "CONDITIONAL" });
    expect(overlap.status).toBe(409);
    expect(String(overlap.body.error)).toContain(publish.body.id);
    expect((await post("/capability-grants", { ...base, permissions: ["READ"], autonomyState: "AUTONOMOUS" })).status).toBe(201);

    // Before the version is in use, a Grant is replaced by revoking it and creating another.
    expect((await app.inject({ method: "POST", url: `/capability-grants/${publish.body.id}/revoke` })).statusCode).toBe(200);
    expect((await post("/capability-grants", { ...base, permissions: ["PUBLISH"], autonomyState: "CONDITIONAL" })).status).toBe(201);

    // Once a Workflow names the version, its authorization is fixed.
    // V1.1 (R3): a publish step must name an earlier step's report, so the graph is saved valid.
    const research = { taskDefinitionId: seed.taskDefinitionId, taskDefinitionVersion: 1, agentDefinitionId: seed.agentDefinitionId, agentDefinitionVersion: 1 };
    const step = {
      taskDefinitionId: seed.reviewAndPublishTaskDefinitionId,
      taskDefinitionVersion: 1,
      agentDefinitionId: publisherV2.body.id,
      agentDefinitionVersion: 2,
      parameters: { sourceTaskDefinitionId: seed.taskDefinitionId },
    };
    expect((await post("/workflow-definitions", { name: "Publish-Only", graphDefinition: { kind: "linear", steps: [research, step] } })).status).toBe(201);
    expect((await post("/capability-grants", { ...base, capabilityId: seed.capabilityId, permissions: ["READ"], autonomyState: "AUTONOMOUS" })).status).toBe(409);
  });
});

describe("a new workflow built only through the Registry API", () => {
  it("runs end to end through POST /goals", async () => {
    const capability = await post("/capabilities", { name: CHAR_COUNT, staticRiskTag: "low" });
    expect(capability.status).toBe(201);
    expect((await post("/tool-bindings", { capabilityId: capability.body.id, kind: "internal", config: { function: "text.char_count.local" }, trustLevel: 2 })).status).toBe(201);
    const agent = await post("/agent-definitions", { name: "Counter", ...AGENT });
    const grant = await post("/capability-grants", {
      agentDefinitionId: agent.body.id,
      agentDefinitionVersion: 1,
      capabilityId: capability.body.id,
      permissions: ["READ"],
      autonomyState: "AUTONOMOUS",
      maxTrustLevelRequired: 1,
    });
    expect(grant.status).toBe(201);
    const task = await post("/task-definitions", { name: "Count-Chars", kind: "count_chars" });
    const workflow = await post("/workflow-definitions", {
      name: "Measure",
      graphDefinition: {
        kind: "linear",
        steps: [
          {
            taskDefinitionId: task.body.id,
            taskDefinitionVersion: 1,
            agentDefinitionId: agent.body.id,
            agentDefinitionVersion: 1,
            parameters: { text: "hello" },
          },
        ],
      },
    });
    expect(workflow.status).toBe(201);

    const goal = await post("/goals", { title: "Count", workflowDefinitionId: workflow.body.id });
    expect(goal).toMatchObject({ status: 201, body: { status: "completed" } });

    const registry = (await app.inject({ method: "GET", url: "/registry" })).json() as {
      taskDefinitions: { name: string; planRegistered: boolean; defaultContextBudget: unknown }[];
    };
    expect(registry.taskDefinitions.find((t) => t.name === "Count-Chars")).toMatchObject({ planRegistered: true, defaultContextBudget: {} });
  });
});
