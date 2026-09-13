/**
 * Unit 11 (task-11-brief.md, Ruling 1) integration test — `GET /agents/active`
 * against the real `TEST_DATABASE_URL`-backed test database, proving the
 * join correctly:
 *   - includes a Run still in flight (Task B's "awaiting_approval" gate
 *     after one `POST /goals`, per Unit 10's own bounded-advancement design
 *     — see `tests/api/routes.integration.test.ts`'s
 *     `driveToTaskBAwaitingApproval` for the identical setup pattern this
 *     test reuses), and
 *   - excludes a Run that has already reached a terminal status (Task A's
 *     "completed").
 *
 * Also asserts Unit 11's Ruling 2 CORS header is present on a plain GET
 * response AND on the SSE route (`GET /events/stream`) specifically —
 * `routes/events.ts` calls `reply.hijack()` then writes its own response
 * headers directly on `reply.raw`, bypassing Fastify's normal
 * `reply.header()`/`onSend` header-sending path entirely. A CORS
 * implementation that only works via `reply.header()` would silently never
 * reach that response — this test catches exactly that failure mode.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { closeTestDb, resetTestSchema, testDb } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import { seedPublishWorkflow } from "../../src/definitions/seed.js";
import { findSeededPublishWorkflow, type SeededWorkflowRefs } from "../../src/definitions/lookupSeed.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({
  callAnthropicModel: vi.fn(),
}));
vi.mock("../../src/router/providers/openai.js", () => ({
  callOpenAiModel: vi.fn(),
}));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({
  // MANDATORY since Phase 7F made Claude Max the routed default: without this
  // mock these tests would dispatch to the REAL adapter, spawn the Claude CLI,
  // and consume subscription entitlement on every `npm test`.
  callClaudeSubscriptionModel: vi.fn(),
}));

import { callClaudeSubscriptionModel } from "../../src/router/providers/claudeSubscription.js";
import { buildServer } from "../../src/api/server.js";

let app: FastifyInstance;
let seedRefs: SeededWorkflowRefs;
// A real bound port, alongside app.inject() for the non-streaming routes
// below -- `GET /events/stream` never ends its response on its own (SSE
// keeps the connection open indefinitely), so `app.inject()` would hang
// forever on it (same reasoning as `tests/api/sseReplay.test.ts`'s own
// header). Reading just the headers via the platform `fetch` API and then
// aborting sidesteps that without needing to consume/parse the stream body.
let baseUrl: string;

beforeAll(async () => {
  await resetTestSchema();
  await testDb.transaction(async (tx) => {
    await seedPublishWorkflow(tx);
  });
  const refs = await testDb.transaction((tx) => findSeededPublishWorkflow(tx));
  if (!refs) throw new Error("beforeAll: seed did not produce a findable Research-and-Publish workflow");
  seedRefs = refs;
  app = buildServer({ db: testDb });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 30000);

afterAll(async () => {
  await app.close();
  await closeTestDb();
});

type CreatedGoal = { goalId: string; workflowRunId: string; status: string };

async function createGoalUpToTaskBGate(title: string, reportText: string): Promise<CreatedGoal> {
  vi.mocked(callClaudeSubscriptionModel).mockResolvedValueOnce({
    result: { report: reportText },
    usage: { tokensIn: 100, tokensOut: 50, costAmount: 150, costUnit: "subscription_tokens" },
  });
  const res = await app.inject({ method: "POST", url: "/goals", payload: { title } });
  expect(res.statusCode).toBe(201);
  return res.json() as CreatedGoal;
}

type ActiveAgentRow = {
  agentDefinitionId: string | null;
  agentName: string;
  runId: string;
  taskInstanceId: string;
  taskStatus: string;
  latestActivitySummary: string | null;
};

describe("GET /agents/active", () => {
  it("includes the still-in-flight Run (Task B, awaiting_approval) and excludes the terminal one (Task A, completed)", async () => {
    const created = await createGoalUpToTaskBGate("Active Agents Goal", "active agents report content");

    const taskInstances = await testDb.query.taskInstances.findMany({
      where: eq(schema.taskInstances.workflowRunId, created.workflowRunId),
    });
    const taskA = taskInstances.find((t) => t.taskDefinitionId === seedRefs.taskDefinitionId);
    const taskB = taskInstances.find((t) => t.taskDefinitionId === seedRefs.reviewAndPublishTaskDefinitionId);
    if (!taskA || !taskB) throw new Error("setup: expected both Task A and Task B to exist");

    const runA = await testDb.query.runs.findFirst({ where: eq(schema.runs.taskInstanceId, taskA.id) });
    const runB = await testDb.query.runs.findFirst({ where: eq(schema.runs.taskInstanceId, taskB.id) });
    if (!runA || !runB) throw new Error("setup: expected both Task A and Task B to have a Run");

    // Sanity-check the fixture actually exercises the terminal/non-terminal
    // split this route is supposed to implement, before trusting the route's
    // own response to prove anything about it.
    expect(runA.status).toBe("completed");
    expect(runB.status).toBe("awaiting_approval");

    const res = await app.inject({ method: "GET", url: "/agents/active" });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { agents: ActiveAgentRow[] };
    const runIds = body.agents.map((a) => a.runId);
    expect(runIds).toContain(runB.id);
    expect(runIds).not.toContain(runA.id);

    const entryB = body.agents.find((a) => a.runId === runB.id);
    if (!entryB) throw new Error("expected an /agents/active entry for Task B's run");
    expect(entryB.taskInstanceId).toBe(taskB.id);
    expect(entryB.taskStatus).toBe("awaiting_approval");
    // bindRunAgent (src/capabilities/shared/runProvisioning.ts) binds the
    // Run's agentDefinitionId as part of building its invocation specs,
    // which happens before the Run can reach "awaiting_approval" -- so by
    // this point Task B's run is bound to the Publisher agent.
    expect(entryB.agentDefinitionId).toBe(seedRefs.publisherAgentDefinitionId);
    expect(entryB.agentName).toBe("Publisher");
    expect(entryB.latestActivitySummary === null || typeof entryB.latestActivitySummary === "string").toBe(true);
  });

  it("sets the CORS allow-origin header on the response", async () => {
    const res = await app.inject({ method: "GET", url: "/agents/active" });
    expect(res.headers["access-control-allow-origin"]).toBeDefined();
  });
});

describe("CORS on the hijacked SSE route (Ruling 2 vs. routes/events.ts's reply.hijack())", () => {
  it("still carries the Access-Control-Allow-Origin header despite the route bypassing Fastify's normal header-sending path", async () => {
    const controller = new AbortController();
    try {
      const res = await fetch(`${baseUrl}/events/stream`, { signal: controller.signal });
      expect(res.headers.get("access-control-allow-origin")).not.toBeNull();
    } finally {
      controller.abort();
    }
  });
});
