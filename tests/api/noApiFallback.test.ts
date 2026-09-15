/**
 * V1.1 acceptance: Claude Max (the subscription CLI adapter) is the default runtime for
 * autonomous agents, and when it is unavailable nothing silently falls back to a billed
 * API provider. The run fails as a governed, visible failure; no API adapter is called;
 * no `usd` is consumed by a model; the Keeper can explain why. Every provider is mocked.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeTestDb, resetTestSchema, testDb } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import { seedPublishWorkflow, seedV11Definitions, type SeedPublishWorkflowResult } from "../../src/definitions/seed.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { callClaudeSubscriptionModel } from "../../src/router/providers/claudeSubscription.js";
import { callAnthropicModel } from "../../src/router/providers/anthropic.js";
import { callOpenAiModel } from "../../src/router/providers/openai.js";
import { buildServer } from "../../src/api/server.js";

let app: FastifyInstance;
let seed: SeedPublishWorkflowResult;

async function post(url: string, payload: unknown) {
  const res = await app.inject({ method: "POST", url, payload: payload as Record<string, unknown> });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

beforeAll(async () => {
  await resetTestSchema();
  seed = await testDb.transaction((tx) => seedPublishWorkflow(tx));
  await testDb.transaction((tx) => seedV11Definitions(tx));
  app = buildServer({ db: testDb });
  await app.ready();
}, 30000);

afterAll(async () => {
  await app.close();
  await closeTestDb();
});

async function objectiveWorkflow(name: string, profile?: Record<string, unknown>) {
  const research = await testDb.query.capabilities.findFirst({ where: eq(schema.capabilities.name, "research.retrieve") });
  const task = await testDb.query.taskDefinitions.findFirst({ where: eq(schema.taskDefinitions.name, "Autonomous Objective") });
  const agent = await post("/agent-definitions", {
    name,
    role: "Idea Architect",
    objective: "Develop opportunities",
    instructions: "Explore.",
    ...(profile ? { executionProfile: profile } : {}),
    grants: [{ capabilityId: research!.id, permissions: ["READ"], autonomyState: "AUTONOMOUS", maxTrustLevelRequired: 1 }],
  });
  const workflow = await post("/workflow-definitions", {
    name: `${name} objective`,
    graphDefinition: {
      kind: "linear",
      steps: [{ stepId: "objective", taskDefinitionId: task!.id, taskDefinitionVersion: 1, agentDefinitionId: agent.body.id, agentDefinitionVersion: 1, parameters: { intents: ["brainstorm"] } }],
    },
  });
  return workflow.body.id as string;
}

async function lastRunOf(workflowRunId: string) {
  const wr = await testDb.query.workflowRuns.findFirst({ where: eq(schema.workflowRuns.id, workflowRunId) });
  const [ti] = (wr!.variables as { stepTaskInstanceIds: string[] }).stepTaskInstanceIds;
  return { wr: wr!, runs: await testDb.query.runs.findMany({ where: eq(schema.runs.taskInstanceId, ti!) }) };
}

describe("no silent API fallback", () => {
  it("routes an autonomous agent's model calls to the Claude subscription candidate by default", async () => {
    vi.mocked(callClaudeSubscriptionModel).mockResolvedValueOnce({
      result: { assessment: "done", done: true, action: { type: "finish", intent: "", capability: "", input: { query: "" }, instruction: "", useArtifacts: [] }, ledgerNote: "" },
      usage: { tokensIn: 100, tokensOut: 50, costAmount: 150, costUnit: "subscription_tokens" },
    }).mockResolvedValueOnce({
      result: { title: "t", summary: "s", body: "b", findings: [], recommendations: [], sources: [] },
      usage: { tokensIn: 100, tokensOut: 50, costAmount: 150, costUnit: "subscription_tokens" },
    });
    const started = await post("/goals", { title: "Default runtime", workflowDefinitionId: await objectiveWorkflow("DefaultRuntime"), projectId: seed.projectId });
    expect(started.body.status).toBe("completed");
    const { runs } = await lastRunOf(started.body.workflowRunId as string);
    const routes = await testDb.query.events.findMany({ where: and(eq(schema.events.runId, runs[0]!.id), eq(schema.events.eventType, "invocation_started")) });
    const providers = routes.map((e) => (e.payload as { budgetAuthorization?: { provider?: string } }).budgetAuthorization?.provider).filter(Boolean);
    expect(providers.length).toBeGreaterThanOrEqual(2);
    expect(new Set(providers)).toEqual(new Set(["claude_subscription"]));
    expect(callAnthropicModel).not.toHaveBeenCalled();
    expect(callOpenAiModel).not.toHaveBeenCalled();
  });

  it("when the Claude runtime is unavailable, the run fails visibly and no API provider is tried or billed", async () => {
    vi.mocked(callClaudeSubscriptionModel).mockReset();
    vi.mocked(callClaudeSubscriptionModel).mockRejectedValue(Object.assign(new Error("claude CLI not found"), { code: "cli_unavailable", consumption: "none" }));
    const started = await post("/goals", { title: "Runtime down", workflowDefinitionId: await objectiveWorkflow("RuntimeDown"), projectId: seed.projectId });
    expect(started.body.status).toBe("failed");

    const { runs } = await lastRunOf(started.body.workflowRunId as string);
    expect(runs).toHaveLength(1); // autonomous runs are never retried automatically
    const failed = await testDb.query.events.findFirst({ where: and(eq(schema.events.runId, runs[0]!.id), eq(schema.events.eventType, "invocation_failed")) });
    expect(JSON.stringify(failed!.payload)).toMatch(/cli_unavailable|claude CLI not found/);
    expect(callAnthropicModel).not.toHaveBeenCalled();
    expect(callOpenAiModel).not.toHaveBeenCalled();
    const usd = await testDb.query.events.findMany({ where: and(eq(schema.events.runId, runs[0]!.id), eq(schema.events.eventType, "budget_consumed")) });
    expect(usd.filter((e) => e.costUnit === "usd" && Number(e.costAmount) > 0)).toEqual([]);

    const explained = await app.inject({ method: "GET", url: `/keeper/explain?subject=workflow_run:${started.body.workflowRunId}` });
    expect(explained.json().headline).toBe("This workflow run failed.");
    expect((explained.json().reasons as string[]).join(" ")).toMatch(/claude CLI not found/);
  });

  it("an Agent restricted to one provider is never served by another", async () => {
    vi.mocked(callClaudeSubscriptionModel).mockReset();
    // Restricted to the API provider, which has no MID candidate: the route is refused.
    // It is not served by the Claude subscription candidate that does serve MID, and nothing is called.
    const workflowDefinitionId = await objectiveWorkflow("AnthropicOnly", { provider: "anthropic", preferredTier: "MID" });
    expect(workflowDefinitionId).toEqual(expect.any(String));
    const started = await post("/goals", { title: "Wrong provider", workflowDefinitionId, projectId: seed.projectId });
    expect(started.body.status).toBe("failed");
    const { runs } = await lastRunOf(started.body.workflowRunId as string);
    const failed = await testDb.query.events.findFirst({ where: and(eq(schema.events.runId, runs[0]!.id), eq(schema.events.eventType, "invocation_failed")) });
    expect(JSON.stringify(failed!.payload)).toMatch(/provider_mismatch|no_eligible_candidate/);
    expect(callClaudeSubscriptionModel).not.toHaveBeenCalled();
    expect(callAnthropicModel).not.toHaveBeenCalled();
    expect(callOpenAiModel).not.toHaveBeenCalled();
  });
});
