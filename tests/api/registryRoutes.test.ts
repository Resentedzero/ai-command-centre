/**
 * Registry control plane (`src/api/routes/registry.ts`): the Definitions read model
 * never exposes Tool Binding config, and revoking a Grant through the API cancels
 * the Approvals it alone covered and settles their Workflow Runs, with real commits.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeTestDb, resetTestSchema, testDb } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import { seedPublishWorkflow, type SeedPublishWorkflowResult } from "../../src/definitions/seed.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { callClaudeSubscriptionModel } from "../../src/router/providers/claudeSubscription.js";
import { buildServer } from "../../src/api/server.js";

let app: FastifyInstance;
let seed: SeedPublishWorkflowResult;
const CANARY = "REGISTRY_CONFIG_SECRET_CANARY";

beforeAll(async () => {
  await resetTestSchema();
  seed = await testDb.transaction((tx) => seedPublishWorkflow(tx));
  // A second research.retrieve binding carrying a secret in its config, older than the seeded one.
  await testDb.insert(schema.toolBindings).values({
    capabilityId: seed.capabilityId,
    kind: "direct_api",
    config: { apiKey: CANARY, function: "ignored" },
    trustLevel: 1,
    version: 0,
  });
  app = buildServer({ db: testDb });
  await app.ready();
}, 30000);

afterAll(async () => {
  await app.close();
  await closeTestDb();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /registry", () => {
  it("lists every Definition, with bindings but never their config", async () => {
    const res = await app.inject({ method: "GET", url: "/registry" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(CANARY);
    expect(res.body).not.toContain('"config"');

    const body = res.json() as {
      capabilities: { name: string; toolBindings: { kind: string; version: number; internalFunction: string | null }[] }[];
      taskDefinitions: { name: string; kind: string; planRegistered: boolean }[];
      agentDefinitions: { name: string }[];
      capabilityGrants: { id: string; revokedAt: string | null }[];
      workflowDefinitions: { name: string }[];
    };
    expect(body.capabilities.find((c) => c.name === "research.retrieve")?.toolBindings).toEqual([
      { id: expect.any(String), kind: "direct_api", version: 0, trustLevel: 1, internalFunction: null },
      { id: seed.toolBindingId, kind: "internal", version: 1, trustLevel: 2, internalFunction: "research.retrieve.synthetic" },
    ]);
    expect(body.taskDefinitions.map((t) => [t.kind, t.planRegistered])).toEqual(
      expect.arrayContaining([
        ["research_report", true],
        ["publish_report", true],
      ])
    );
    expect(body.agentDefinitions.map((a) => a.name)).toEqual(["Publisher", "Researcher"]);
    expect(body.capabilityGrants.map((g) => g.id)).toEqual(expect.arrayContaining([seed.capabilityGrantId, seed.publishCapabilityGrantId]));
    expect(body.workflowDefinitions.map((w) => w.name)).toEqual(["Research-and-Publish"]);
  });
});

describe("POST /capability-grants/:id/revoke", () => {
  it("rejects a malformed id and reports an unknown one", async () => {
    expect((await app.inject({ method: "POST", url: "/capability-grants/nope/revoke" })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/capability-grants/00000000-0000-4000-8000-000000000000/revoke" })).statusCode).toBe(404);
  });

  it("revokes the publish Grant: its pending Approval is cancelled, the hold released, the Workflow Run failed; a repeat revokes nothing", async () => {
    vi.mocked(callClaudeSubscriptionModel).mockResolvedValueOnce({
      result: { report: "a report" },
      usage: { tokensIn: 10, tokensOut: 5, costAmount: 15, costUnit: "subscription_tokens" },
    });
    const created = await app.inject({ method: "POST", url: "/goals", payload: { title: "Revocation" } });
    expect(created.statusCode).toBe(201);
    const { workflowRunId } = created.json() as { workflowRunId: string };

    const [pending] = await testDb
      .select({ approvalId: schema.approvals.id, runId: schema.invocations.runId })
      .from(schema.approvals)
      .innerJoin(schema.invocations, eq(schema.approvals.invocationId, schema.invocations.id))
      .where(eq(schema.approvals.status, "pending"));
    expect(pending).toBeDefined();

    const res = await app.inject({ method: "POST", url: `/capability-grants/${seed.publishCapabilityGrantId}/revoke` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      grantId: seed.publishCapabilityGrantId,
      revoked: true,
      cancelledApprovalIds: [pending!.approvalId],
      workflowRuns: [{ workflowRunId, status: "failed" }],
    });

    const approval = await testDb.query.approvals.findFirst({ where: eq(schema.approvals.id, pending!.approvalId) });
    expect(approval).toMatchObject({ status: "expired" });
    const grant = await testDb.query.capabilityGrants.findFirst({ where: eq(schema.capabilityGrants.id, seed.publishCapabilityGrantId) });
    expect(grant?.revokedAt).not.toBeNull();
    const usd = await testDb.query.budgetCounters.findFirst({
      where: and(eq(schema.budgetCounters.scopeRefId, pending!.runId), eq(schema.budgetCounters.resourceUnit, "usd")),
    });
    expect(Number(usd!.reservedAmount)).toBe(0);
    const revokedEvent = await testDb.query.events.findFirst({
      where: eq(schema.events.idempotencyKey, `capability_grant_revoked:${seed.publishCapabilityGrantId}`),
    });
    expect(revokedEvent?.actor).toBe("human:operator");

    const again = await app.inject({ method: "POST", url: `/capability-grants/${seed.publishCapabilityGrantId}/revoke` });
    expect(again.json()).toEqual({ grantId: seed.publishCapabilityGrantId, revoked: false, cancelledApprovalIds: [], workflowRuns: [] });
  });
});
