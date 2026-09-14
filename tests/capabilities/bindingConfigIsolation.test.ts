/**
 * A Tool Binding's `config` reaches only its adapter (spec §9.6: credentials and
 * adapter configuration are resolved inside the Tool Adapter). It is never
 * written to an event, an Invocation row, an Approval or an Artifact, and never
 * placed in model context (the Context Compiler's own tests cover context).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { closeTestDb, resetTestSchema, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { advanceWorkflowRunToBoundary } from "../helpers/driveToBoundary.js";
import { startWorkflowRun } from "../../src/workflow/interpreter.js";
import { buildInvocationSpecsFromDefinitions } from "../../src/workflow/buildInvocationSpecsFromDefinitions.js";
import { registerInternalToolFunction, resolveToolInvocation } from "../../src/capabilities/toolAdapters.js";
import { registerTaskPlanBuilder } from "../../src/capabilities/taskPlans.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

const SECRET = "BINDING_CONFIG_SECRET_CANARY";
const ENDPOINT = "https://binding-config-endpoint-canary.invalid";
const CAPABILITY = "test.config.isolation";
const seenConfigs: unknown[] = [];

registerInternalToolFunction(CAPABILITY, {
  capabilityName: CAPABILITY,
  prepare: async (_tx, { config }) => {
    seenConfigs.push(config);
    return { inputs: { note: "ok" }, costClass: "local_retrieval", estimatedCost: 0 };
  },
  execute: async ({ config, inputs }) => {
    seenConfigs.push(config);
    return { ...inputs, used: typeof config.apiKey === "string" };
  },
});
registerTaskPlanBuilder("test_config_isolation", async (tx) => [
  await resolveToolInvocation(tx, { capabilityName: CAPABILITY, permission: "READ", proposedActionSnapshot: { note: "ok" } }),
]);

describe("Tool Binding config isolation", () => {
  it("the adapter receives its config; no event, Invocation, Artifact or Run record contains it", async () => {
    await withRollback(async (tx) => {
      const [project] = await tx.insert(schema.projects).values({ name: "p-" + randomUUID() }).returning();
      const [goal] = await tx.insert(schema.goals).values({ projectId: project!.id, title: "isolate", status: "active" }).returning();
      const [capability] = await tx.insert(schema.capabilities).values({ name: CAPABILITY, description: "d", staticRiskTag: "low" }).returning();
      await tx.insert(schema.toolBindings).values({
        capabilityId: capability!.id,
        kind: "internal",
        config: { function: CAPABILITY, apiKey: SECRET, endpoint: ENDPOINT },
        trustLevel: 2,
        version: 1,
      });
      const [agent] = await tx.insert(schema.agentDefinitions).values({ name: "a-" + randomUUID(), version: 1, role: "r", objective: "o", instructions: "i" }).returning();
      await tx.insert(schema.capabilityGrants).values({
        agentDefinitionId: agent!.id,
        agentDefinitionVersion: 1,
        capabilityId: capability!.id,
        permissions: ["READ"],
        maxTrustLevelRequired: 1,
        autonomyState: "AUTONOMOUS",
      });
      const [taskDefinition] = await tx.insert(schema.taskDefinitions).values({ name: "t-" + randomUUID(), kind: "test_config_isolation", version: 1 }).returning();
      const [workflow] = await tx
        .insert(schema.workflowDefinitions)
        .values({
          name: "wf-" + randomUUID(),
          version: 1,
          graphDefinition: { kind: "linear", steps: [{ taskDefinitionId: taskDefinition!.id, taskDefinitionVersion: 1, agentDefinitionId: agent!.id, agentDefinitionVersion: 1 }] },
        })
        .returning();
      const { workflowRunId } = await startWorkflowRun(tx, workflow!.id, goal!.id);

      expect((await advanceWorkflowRunToBoundary(tx, workflowRunId, buildInvocationSpecsFromDefinitions(tx))).status).toBe("completed");
      expect(seenConfigs).toContainEqual(expect.objectContaining({ apiKey: SECRET, endpoint: ENDPOINT }));

      const taskInstances = await tx.query.taskInstances.findMany({ where: eq(schema.taskInstances.workflowRunId, workflowRunId) });
      const runs = await tx.query.runs.findMany({ where: inArray(schema.runs.taskInstanceId, taskInstances.map((t) => t.id)) });
      const invocations = await tx.query.invocations.findMany({ where: inArray(schema.invocations.runId, runs.map((r) => r.id)) });
      const artifacts = await tx.query.artifacts.findMany({ where: inArray(schema.artifacts.producingInvocationId, invocations.map((i) => i.id)) });
      const events = await tx.query.events.findMany({ where: eq(schema.events.workflowRunId, workflowRunId) });
      expect(invocations).toHaveLength(1);
      expect(events.length).toBeGreaterThan(0);
      expect(JSON.parse(artifacts[0]!.inlineContent!)).toEqual({ note: "ok", used: true });

      const persisted = JSON.stringify({ events, invocations, artifacts, runs, taskInstances });
      expect(persisted).not.toContain(SECRET);
      expect(persisted).not.toContain(ENDPOINT);
    });
  });
});
