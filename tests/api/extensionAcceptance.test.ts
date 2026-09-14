/**
 * Spec §18.3, the V1 success criterion: "adding a third Task Definition, a third
 * Capability, or a third Agent Definition afterward requires no changes to core
 * execution semantics, authorization semantics, the event schema, or the UI
 * architecture — only the new Definition, its Tool Binding(s), its Workflow
 * composition (if any), and its tests."
 *
 * Everything new here is data plus what a capability module would contain (one
 * registered internal function and one registered task plan). It runs through the
 * real HTTP API, Interpreter, Executor, Policy and budget, with real commits, and
 * no seed. The structural half of the criterion is in
 * `tests/execution/structuralInvariants.test.ts` ("core names no capability").
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeTestDb, resetTestSchema, testDb } from "../testDb.js";
import * as schema from "../../src/db/schema.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { buildServer } from "../../src/api/server.js";
import { registerInternalToolFunction, resolveToolInvocation } from "../../src/capabilities/toolAdapters.js";
import { registerTaskPlanBuilder } from "../../src/capabilities/taskPlans.js";
import { validateCapabilityGrant } from "../../src/governance/policy.js";

// --- What a new capability module would contribute --------------------------
const WORD_COUNT = "text.word_count";
registerInternalToolFunction("text.word_count.local", {
  capabilityName: WORD_COUNT,
  prepare: async (_tx, { proposedActionSnapshot }) => {
    if (typeof proposedActionSnapshot.text !== "string") throw new Error("text.word_count.local: no text");
    return { inputs: { text: proposedActionSnapshot.text }, costClass: "local_retrieval", estimatedCost: 0 };
  },
  execute: async ({ inputs }) => ({ words: (inputs.text as string).split(/\s+/).filter(Boolean).length }),
});
registerTaskPlanBuilder("count_words", async (tx, ctx) => [
  await resolveToolInvocation(tx, { capabilityName: WORD_COUNT, permission: "READ", proposedActionSnapshot: { text: ctx.parameters.text } }),
]);

let app: FastifyInstance;
let ids: { projectId: string; workflowDefinitionId: string; agentDefinitionId: string };

beforeAll(async () => {
  await resetTestSchema();
  // --- The new Definitions, as data (no seed exists in this database) --------
  ids = await testDb.transaction(async (tx) => {
    const [project] = await tx.insert(schema.projects).values({ name: "Writing" }).returning();
    const [capability] = await tx.insert(schema.capabilities).values({ name: WORD_COUNT, description: "Count words in a text", staticRiskTag: "low" }).returning();
    await tx.insert(schema.toolBindings).values({ capabilityId: capability!.id, kind: "internal", config: { function: "text.word_count.local" }, trustLevel: 2, version: 1 });
    const [agent] = await tx.insert(schema.agentDefinitions).values({ name: "Editor", version: 1, role: "Editor", objective: "Measure drafts", instructions: "Count words." }).returning();
    const grant = {
      agentDefinitionId: agent!.id,
      agentDefinitionVersion: 1,
      capabilityId: capability!.id,
      permissions: ["READ" as const],
      maxTrustLevelRequired: 1,
      autonomyState: "AUTONOMOUS" as const,
    };
    expect(validateCapabilityGrant(grant).valid).toBe(true);
    await tx.insert(schema.capabilityGrants).values(grant);
    const [taskDefinition] = await tx.insert(schema.taskDefinitions).values({ name: "Count-Words", kind: "count_words", version: 1 }).returning();
    const [workflowDefinition] = await tx
      .insert(schema.workflowDefinitions)
      .values({
        name: "Measure-Draft",
        version: 1,
        graphDefinition: {
          kind: "linear",
          steps: [
            {
              taskDefinitionId: taskDefinition!.id,
              taskDefinitionVersion: 1,
              agentDefinitionId: agent!.id,
              agentDefinitionVersion: 1,
              parameters: { text: "the quick brown fox" },
            },
          ],
        },
      })
      .returning();
    return { projectId: project!.id, workflowDefinitionId: workflowDefinition!.id, agentDefinitionId: agent!.id };
  });
  app = buildServer({ db: testDb });
  await app.ready();
}, 30000);

afterAll(async () => {
  await app.close();
  await closeTestDb();
});

describe("spec 18.3: a new Capability, Tool Binding, Agent, Task Definition and Workflow need no core change", () => {
  it("POST /goals runs the new workflow end to end through the real governance chain", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/goals",
      payload: { title: "Measure my draft", workflowDefinitionId: ids.workflowDefinitionId, projectId: ids.projectId },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { workflowRunId: string; status: string };
    expect(body.status).toBe("completed");

    const taskInstance = await testDb.query.taskInstances.findFirst({ where: eq(schema.taskInstances.workflowRunId, body.workflowRunId) });
    const run = await testDb.query.runs.findFirst({ where: eq(schema.runs.taskInstanceId, taskInstance!.id) });
    expect(run).toMatchObject({ status: "completed", agentDefinitionId: ids.agentDefinitionId });
    const [invocation] = await testDb.query.invocations.findMany({ where: eq(schema.invocations.runId, run!.id) });
    expect(invocation).toMatchObject({ kind: "tool", status: "completed", permission: "READ" });
    const artifact = await testDb.query.artifacts.findFirst({ where: eq(schema.artifacts.producingInvocationId, invocation!.id) });
    expect(JSON.parse(artifact!.inlineContent!)).toEqual({ words: 4 });
  });

  it("rejects an unknown workflowDefinitionId or projectId before creating anything", async () => {
    const unknown = "00000000-0000-4000-8000-000000000000";
    for (const payload of [
      { title: "x", workflowDefinitionId: unknown, projectId: ids.projectId },
      { title: "x", workflowDefinitionId: ids.workflowDefinitionId, projectId: unknown },
      { title: "x", workflowDefinitionId: "not-a-uuid", projectId: ids.projectId },
    ]) {
      const res = await app.inject({ method: "POST", url: "/goals", payload });
      expect(res.statusCode).toBe(400);
    }
    expect(await testDb.query.goals.findMany({ where: eq(schema.goals.title, "x") })).toEqual([]);
  });
});
