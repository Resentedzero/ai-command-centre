/**
 * `GET /costs` (spec §15.1 screen 7): budget counters by scope with per-unit totals
 * that never cross units, Run counters labelled, and cost-vs-success rows from
 * `agent_performance` with names.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { closeTestDb, resetTestSchema, testDb } from "../testDb.js";
import * as schema from "../../src/db/schema.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { buildServer } from "../../src/api/server.js";

let app: FastifyInstance;
let runId: string;

beforeAll(async () => {
  await resetTestSchema();
  runId = await testDb.transaction(async (tx) => {
    const [project] = await tx.insert(schema.projects).values({ name: "P" }).returning();
    const [task] = await tx.insert(schema.taskDefinitions).values({ name: "Summarise", kind: "k", version: 1 }).returning();
    const [agent] = await tx.insert(schema.agentDefinitions).values({ name: "Writer", version: 2, role: "r", objective: "o", instructions: "i" }).returning();
    const [ti] = await tx.insert(schema.taskInstances).values({ taskDefinitionId: task!.id, taskDefinitionVersion: 1, projectId: project!.id, status: "completed" }).returning();
    const [run] = await tx.insert(schema.runs).values({ taskInstanceId: ti!.id, agentDefinitionId: agent!.id, agentDefinitionVersion: 2, status: "completed" }).returning();
    await tx.insert(schema.budgetCounters).values([
      { scope: "run", scopeRefId: run!.id, resourceUnit: "usd", limitAmount: "1.00", reservedAmount: "0", consumedAmount: "0.25" },
      { scope: "run", scopeRefId: run!.id, resourceUnit: "subscription_tokens", limitAmount: "50000", reservedAmount: "10", consumedAmount: "1200" },
      { scope: "run", scopeRefId: "00000000-0000-4000-8000-000000000000", resourceUnit: "usd", limitAmount: "1.00", reservedAmount: "0.5", consumedAmount: "0.75" },
      { scope: "day", scopeRefId: "2026-09-14", resourceUnit: "usd", limitAmount: "20", reservedAmount: "0", consumedAmount: "1" },
    ]);
    await tx.insert(schema.agentPerformance).values({
      agentDefinitionId: agent!.id,
      agentDefinitionVersion: 2,
      taskDefinitionId: task!.id,
      modelTier: "CHEAP",
      successRate: "0.5",
      avgCost: { usd: "0.25" },
      avgRetries: "0",
      sampleCount: 2,
    });
    return run!.id;
  });
  app = buildServer({ db: testDb });
  await app.ready();
}, 30000);

afterAll(async () => {
  await app.close();
  await closeTestDb();
});

type Body = {
  counters: { scope: string; scopeRefId: string; resourceUnit: string; consumedAmount: string; run: { agent: { name: string; version: number } | null; taskDefinitionName: string | null } | null }[];
  totals: { scope: string; resourceUnit: string; consumed: string; reserved: string; counters: number }[];
  costVsSuccess: { agentName: string; agentVersion: number; taskDefinitionName: string; modelTier: string; sampleCount: number; successRate: string; avgCost: Record<string, string> }[];
};

describe("GET /costs", () => {
  it("returns counters, per-unit totals per scope, and named cost-vs-success rows", async () => {
    const res = await app.inject({ method: "GET", url: "/costs" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Body;

    expect(body.counters).toHaveLength(4);
    const labelled = body.counters.find((c) => c.scopeRefId === runId && c.resourceUnit === "usd");
    expect(labelled?.run).toEqual({ agent: { name: "Writer", version: 2 }, taskDefinitionName: "Summarise" });
    expect(body.counters.find((c) => c.scope === "run" && c.scopeRefId !== runId)?.run).toEqual({ agent: null, taskDefinitionName: null });
    expect(body.counters.find((c) => c.scope === "day")).toMatchObject({ scopeRefId: "2026-09-14", run: null });

    const byKey = (a: { scope: string; resourceUnit: string }, b: { scope: string; resourceUnit: string }) =>
      `${a.scope}:${a.resourceUnit}`.localeCompare(`${b.scope}:${b.resourceUnit}`);
    // Run usd totals 0.25 + 0.75 from two counters; subscription tokens are a separate row, never added to it.
    expect([...body.totals].sort(byKey)).toEqual([
      { scope: "day", resourceUnit: "usd", consumed: "1", reserved: "0", counters: 1 },
      { scope: "run", resourceUnit: "subscription_tokens", consumed: "1200", reserved: "10", counters: 1 },
      { scope: "run", resourceUnit: "usd", consumed: "1.00", reserved: "0.5", counters: 2 },
    ]);

    expect(body.costVsSuccess).toEqual([
      expect.objectContaining({ agentName: "Writer", agentVersion: 2, taskDefinitionName: "Summarise", modelTier: "CHEAP", sampleCount: 2, successRate: "0.5", avgCost: { usd: "0.25" } }),
    ]);
  });

  it("filters by scope, keeps Run labels under the filter, and rejects an unknown or repeated scope", async () => {
    const day = (await app.inject({ method: "GET", url: "/costs?scope=day" })).json() as Body;
    expect(day.counters.map((c) => c.scope)).toEqual(["day"]);
    expect(day.totals.map((t) => t.scope)).toEqual(["day"]);

    const run = (await app.inject({ method: "GET", url: "/costs?scope=run" })).json() as Body & { countersTruncated: boolean };
    expect(run.counters).toHaveLength(3);
    expect(run.countersTruncated).toBe(false);
    expect(run.counters.find((c) => c.scopeRefId === runId)?.run).toEqual({ agent: { name: "Writer", version: 2 }, taskDefinitionName: "Summarise" });

    expect((await app.inject({ method: "GET", url: "/costs?scope=planet" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/costs?scope=run&scope=day" })).statusCode).toBe(400);
  });

  it("caps the counter list at 500 and says so, while totals count every counter", async () => {
    await testDb.insert(schema.budgetCounters).values(
      Array.from({ length: 501 }, (_, i) => ({ scope: "task_instance" as const, scopeRefId: `ti-${i}`, resourceUnit: "usd", limitAmount: "1", consumedAmount: "0.01" }))
    );
    const body = (await app.inject({ method: "GET", url: "/costs?scope=task_instance" })).json() as Body & { countersTruncated: boolean };
    expect(body.counters).toHaveLength(500);
    expect(body.countersTruncated).toBe(true);
    expect(body.totals).toEqual([{ scope: "task_instance", resourceUnit: "usd", consumed: "5.01", reserved: "0", counters: 501 }]);
  });
});
