/**
 * `GET /runs/:id/trace` (spec §8.4): a real Run driven through `POST /goals`, read
 * back as all of its events in sequence order, with each LLM Invocation's
 * context lineage and nothing from another Run.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeTestDb, resetTestSchema, testDb } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import { seedPublishWorkflow } from "../../src/definitions/seed.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { callClaudeSubscriptionModel } from "../../src/router/providers/claudeSubscription.js";
import { buildServer } from "../../src/api/server.js";

let app: FastifyInstance;
let researchRunId: string;

type Trace = {
  run: { id: string; status: string };
  events: { eventType: string; sequenceNo: number; correlation: { runId: string | null } }[];
  invocations: {
    id: string;
    kind: string;
    seqNo: number;
    contextLineage: { included: { kind: string }[] } | null;
    policyEvaluations: { checkpoint: string; decision: string; basis: string | null }[];
    budgetOutcome: string | null;
    route: { tierSource: string | null; resultingTier: string | null } | null;
  }[];
};

beforeAll(async () => {
  await resetTestSchema();
  await testDb.transaction((tx) => seedPublishWorkflow(tx));
  app = buildServer({ db: testDb });
  await app.ready();

  vi.mocked(callClaudeSubscriptionModel).mockResolvedValueOnce({
    result: { report: "a report" },
    usage: { tokensIn: 10, tokensOut: 5, costAmount: 15, costUnit: "subscription_tokens" },
  });
  const created = await app.inject({ method: "POST", url: "/goals", payload: { title: "Trace me" } });
  const { workflowRunId } = created.json() as { workflowRunId: string };
  const [row] = await testDb
    .select({ runId: schema.runs.id })
    .from(schema.runs)
    .innerJoin(schema.taskInstances, eq(schema.runs.taskInstanceId, schema.taskInstances.id))
    .innerJoin(schema.invocations, eq(schema.invocations.runId, schema.runs.id))
    .where(eq(schema.taskInstances.workflowRunId, workflowRunId))
    .orderBy(schema.invocations.seqNo)
    .limit(1);
  researchRunId = row!.runId;
}, 60000);

afterAll(async () => {
  await app.close();
  await closeTestDb();
});

describe("GET /runs/:id/trace", () => {
  it("returns the Run's events in sequence order and each Invocation's context lineage", async () => {
    const res = await app.inject({ method: "GET", url: `/runs/${researchRunId}/trace` });
    expect(res.statusCode).toBe(200);
    const trace = res.json() as Trace;

    expect(trace.run.id).toBe(researchRunId);
    expect(trace.events.length).toBeGreaterThan(0);
    expect(trace.events.map((e) => e.sequenceNo)).toEqual(trace.events.map((_, i) => i + 1));
    expect(trace.events.every((e) => e.correlation.runId === researchRunId)).toBe(true);
    // A step's lifecycle events carry its Run's id, so they are part of its trace.
    expect(trace.events.map((e) => e.eventType)).toEqual(
      expect.arrayContaining(["task_instance_created", "run_started", "context_compiled", "policy_evaluated", "run_completed"])
    );
    expect(trace.events.map((e) => e.eventType).indexOf("run_started")).toBeLessThan(trace.events.map((e) => e.eventType).indexOf("run_completed"));

    expect(trace.invocations.map((i) => i.kind)).toEqual(["tool", "llm", "deterministic"]);
    const [tool, llm, deterministic] = trace.invocations;
    expect(tool!.contextLineage).toBeNull();
    expect(deterministic!.contextLineage).toBeNull();
    expect(llm!.contextLineage!.included.some((i) => i.kind.startsWith("artifact"))).toBe(true);

    // Every Policy evaluation of the tool Invocation, in sequence order; none for kinds Policy does not govern.
    expect(tool!.policyEvaluations.map((e) => [e.checkpoint, e.decision, e.basis])).toEqual([
      ["propose", "ALLOW", "autonomy_autonomous"],
      ["pre_dispatch", "ALLOW", "autonomy_autonomous"],
    ]);
    expect(llm!.policyEvaluations).toEqual([]);
    expect(deterministic!.policyEvaluations).toEqual([]);
    expect(trace.invocations.map((i) => i.budgetOutcome)).toEqual(["authorized", "authorized", null]);
    expect(tool!.route).toBeNull();
    expect(deterministic!.route).toBeNull();
    expect(llm!.route).toMatchObject({ tierSource: "default", resultingTier: expect.any(String) });
  });

  it("rejects a malformed id and reports an unknown Run", async () => {
    expect((await app.inject({ method: "GET", url: "/runs/nope/trace" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/runs/00000000-0000-4000-8000-000000000000/trace" })).statusCode).toBe(404);
  });
});
