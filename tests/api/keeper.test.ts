/**
 * V1.1 Keeper. Deterministic answers (explain, guide) use no model and write nothing:
 * no Run, no Invocation, no event. Think is an explicit, ordinary governed Goal in the
 * Keeper project, run by the ordinary Keeper Agent (READ Grants only, CHEAP tier), whose
 * proposal is data only. Every model call is mocked.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeTestDb, resetTestSchema, testDb } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import { seedPublishWorkflow, seedV11Definitions, type SeedPublishWorkflowResult } from "../../src/definitions/seed.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { callClaudeSubscriptionModel } from "../../src/router/providers/claudeSubscription.js";
import { buildServer } from "../../src/api/server.js";

let app: FastifyInstance;
let seed: SeedPublishWorkflowResult;
const USAGE = { tokensIn: 200, tokensOut: 100, costAmount: 300, costUnit: "subscription_tokens" as const };
let failResearch = false;

async function get(url: string) {
  const res = await app.inject({ method: "GET", url });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

async function counts() {
  const [runs, invocations, events, agents] = await Promise.all([
    testDb.select().from(schema.runs),
    testDb.select().from(schema.invocations),
    testDb.select().from(schema.events),
    testDb.select().from(schema.agentDefinitions),
  ]);
  return { runs: runs.length, invocations: invocations.length, events: events.length, agents: agents.length };
}

async function waitFor<T>(probe: () => Promise<T | null | undefined | false>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await probe();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("waitFor timed out");
}

beforeAll(async () => {
  await resetTestSchema();
  seed = await testDb.transaction((tx) => seedPublishWorkflow(tx));
  await testDb.transaction((tx) => seedV11Definitions(tx));
  vi.mocked(callClaudeSubscriptionModel).mockImplementation(async (_m, _ctx, shape) => {
    const props = (shape as { properties?: Record<string, unknown> }).properties ?? {};
    if ("report" in props) {
      if (failResearch) throw Object.assign(new Error("provider unavailable"), { consumption: "none", code: "cli_unavailable" });
      return { result: { report: "# Evidence" }, usage: USAGE };
    }
    if ("answer" in props) {
      return {
        result: {
          answer: "## Why it waits\n\nThe publish step needs your approval.",
          keyPoints: ["Publisher asks first"],
          proposal: { kind: "agent", name: "Analyst", role: "Analyst", objective: "Analyse reports", instructions: "Be precise.", capabilities: ["research.retrieve"], steps: [] },
        },
        usage: USAGE,
      };
    }
    throw new Error("unexpected shape");
  });
  app = buildServer({ db: testDb });
  await app.ready();
}, 30000);

afterAll(async () => {
  await app.close();
  await closeTestDb();
});

describe("deterministic Keeper answers use no model and write nothing", () => {
  it("explains what the system can do, honestly about research", async () => {
    const before = await counts();
    const res = await get("/keeper/explain?subject=system");
    expect(res.status).toBe(200);
    expect(res.body.headline).toBe("What the Command Keep can do right now.");
    const reasons = (res.body.reasons as string[]).join(" ");
    // R2: external sources exist now, so the honest answer names them — and still says
    // plainly that retrieving what we already hold is not research.
    expect(reasons).toMatch(/read public encyclopedic and scholarly sources/);
    expect(reasons).toMatch(/searches the live web/);
    expect(reasons).toMatch(/research\.retrieve \(fixture\)/);
    expect(await counts()).toEqual(before);
    expect(callClaudeSubscriptionModel).not.toHaveBeenCalled();
  });

  it("answers how-to questions from the guide cards", async () => {
    const before = await counts();
    const agent = await get(`/keeper/guide?q=${encodeURIComponent("How do I create an agent?")}`);
    expect((agent.body.cards as { slug: string }[])[0]!.slug).toBe("create-an-agent");
    const runs = await get(`/keeper/guide?q=${encodeURIComponent("What's the difference between a Run and an Invocation?")}`);
    expect((runs.body.cards as { slug: string }[]).map((c) => c.slug)).toContain("run-vs-invocation");
    const budget = await get(`/keeper/guide?q=${encodeURIComponent("What does this budget mean?")}`);
    expect((budget.body.cards as { slug: string }[])[0]!.slug).toBe("budgets");
    expect((await get("/keeper/guide?q=")).status).toBe(400);
    expect(await counts()).toEqual(before);
    expect(callClaudeSubscriptionModel).not.toHaveBeenCalled();
  });

  it("explains why a workflow is waiting, and what the approval is", async () => {
    const started = await app.inject({ method: "POST", url: "/goals", payload: { title: "Publish a report" } });
    const { workflowRunId } = started.json() as { workflowRunId: string };
    vi.mocked(callClaudeSubscriptionModel).mockClear();

    const before = await counts();
    const run = await get(`/keeper/explain?subject=workflow_run:${workflowRunId}`);
    expect(run.body.headline).toBe("This workflow run is waiting for your approval.");
    const reasons = (run.body.reasons as string[]).join(" ");
    expect(reasons).toMatch(/use publish\.report \(PUBLISH\)/);
    expect(reasons).toMatch(/set to ask you first \(ALWAYS_APPROVE\)/);
    expect(run.body.next).toEqual(expect.arrayContaining([{ label: "Review approvals", href: "/approvals" }]));

    const [pending] = await testDb.select().from(schema.approvals).where(eq(schema.approvals.status, "pending"));
    const approval = await get(`/keeper/explain?subject=approval:${pending!.id}`);
    expect(approval.body.headline).toBe("This approval is waiting for your decision.");
    expect((approval.body.facts as { label: string; value: string }[]).find((f) => f.label === "agent")!.value).toBe("Publisher v1");

    const agent = await get(`/keeper/explain?subject=agent:${seed.agentDefinitionId}`);
    expect((agent.body.reasons as string[])[0]).toBe("May use research.retrieve (READ): acts without asking.");

    expect(await counts()).toEqual(before);
    expect(callClaudeSubscriptionModel).not.toHaveBeenCalled();
  });

  it("explains why a run failed", async () => {
    failResearch = true;
    const started = await app.inject({ method: "POST", url: "/goals", payload: { title: "This will fail" } });
    failResearch = false;
    const { workflowRunId } = started.json() as { workflowRunId: string };
    const res = await get(`/keeper/explain?subject=workflow_run:${workflowRunId}`);
    expect(res.body.headline).toBe("This workflow run failed.");
    expect((res.body.reasons as string[]).join(" ")).toMatch(/The failing action reported: .*provider unavailable/);
  });

  it("refuses malformed subjects and says when something doesn't exist", async () => {
    expect((await get("/keeper/explain?subject=workflow_run:nope")).status).toBe(400);
    expect((await get("/keeper/explain?subject=table:00000000-0000-4000-8000-000000000000")).status).toBe(400);
    expect((await get("/keeper/explain?subject=agent:00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });
});

describe("Keeper Think is an explicit, governed, read-only Goal", () => {
  it("answers through the Keeper agent at CHEAP, with evidence and a proposal that creates nothing", async () => {
    const [waiting] = await testDb.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.status, "in_progress"));
    const before = await counts();
    const res = await app.inject({ method: "POST", url: "/keeper/questions", payload: { question: "Why is Publisher waiting?", subject: `workflow_run:${waiting!.id}` } });
    expect(res.statusCode).toBe(202);
    const { goalId, workflowRunId } = res.json() as { goalId: string; workflowRunId: string };

    const done = await waitFor(async () => {
      const wr = await testDb.query.workflowRuns.findFirst({ where: eq(schema.workflowRuns.id, workflowRunId) });
      return wr && wr.status !== "in_progress" ? wr : null;
    });
    expect(done.status).toBe("completed");

    const goal = await testDb.query.goals.findFirst({ where: eq(schema.goals.id, goalId) });
    const project = await testDb.query.projects.findFirst({ where: eq(schema.projects.id, goal!.projectId) });
    expect(project!.name).toBe("Keeper");

    const [ti] = (done.variables as { stepTaskInstanceIds: string[] }).stepTaskInstanceIds;
    const run = await testDb.query.runs.findFirst({ where: eq(schema.runs.taskInstanceId, ti!) });
    const keeper = await testDb.query.agentDefinitions.findFirst({ where: eq(schema.agentDefinitions.id, run!.agentDefinitionId!) });
    expect(keeper!.name).toBe("Keeper");
    const grants = await testDb.query.capabilityGrants.findMany({ where: eq(schema.capabilityGrants.agentDefinitionId, keeper!.id) });
    expect(grants.every((g) => g.permissions.length === 1 && g.permissions[0] === "READ")).toBe(true);

    const started = await testDb.query.events.findFirst({ where: and(eq(schema.events.runId, run!.id), eq(schema.events.eventType, "invocation_started"), eq(schema.events.invocationId, (await testDb.query.invocations.findFirst({ where: and(eq(schema.invocations.runId, run!.id), eq(schema.invocations.kind, "llm")) }))!.id)) });
    expect((started!.payload as { resultingTier?: string }).resultingTier).toBe("CHEAP");

    const answer = (
      await testDb
        .select({ a: schema.artifacts })
        .from(schema.artifacts)
        .innerJoin(schema.invocations, eq(schema.artifacts.producingInvocationId, schema.invocations.id))
        .where(and(eq(schema.invocations.runId, run!.id), eq(schema.artifacts.type, "keeper_answer")))
    )[0]!.a;
    const content = JSON.parse(answer.inlineContent!);
    expect(content).toMatchObject({
      format: "deliverable/v1",
      title: "Why is Publisher waiting?",
      body: expect.stringContaining("needs your approval"),
      subject: `workflow_run:${waiting!.id}`,
      proposal: { kind: "agent", name: "Analyst", capabilities: ["research.retrieve"] },
    });
    expect(content.basis.evidence).toEqual(
      expect.arrayContaining([
        { capability: "system.inspect", evidenceClass: "system_state", calls: 1 },
        { capability: "docs.retrieve", evidenceClass: "local_corpus", calls: 1 },
      ])
    );
    // The proposal is data: no agent was created, and nothing but this governed run was written.
    const after = await counts();
    expect(after.agents).toBe(before.agents);
    expect(await testDb.query.agentDefinitions.findFirst({ where: eq(schema.agentDefinitions.name, "Analyst") })).toBeUndefined();
  });

  it("an emergency stop applies to the Keeper like any agent", async () => {
    await app.inject({ method: "POST", url: "/execution-stops", payload: { scope: "global", reason: "test" } });
    const res = await app.inject({ method: "POST", url: "/keeper/questions", payload: { question: "Anything?" } });
    expect(res.statusCode).toBe(202);
    const { workflowRunId } = res.json() as { workflowRunId: string };
    const done = await waitFor(async () => {
      const wr = await testDb.query.workflowRuns.findFirst({ where: eq(schema.workflowRuns.id, workflowRunId) });
      return wr && wr.status !== "in_progress" ? wr : null;
    });
    expect(done.status).toBe("failed");
    const [ti] = (done.variables as { stepTaskInstanceIds: string[] }).stepTaskInstanceIds;
    const run = await testDb.query.runs.findFirst({ where: eq(schema.runs.taskInstanceId, ti!) });
    expect(await testDb.query.events.findFirst({ where: and(eq(schema.events.runId, run!.id), eq(schema.events.eventType, "run_halted")) })).toBeTruthy();
    const stops = await app.inject({ method: "GET", url: "/execution-stops" });
    const stop = (stops.json() as { stops: { id: string; scope: string }[] }).stops.find((s) => s.scope === "global")!;
    await app.inject({ method: "POST", url: "/execution-stops/lift", payload: { scope: "global", stopId: stop.id } });
  });

  it("validates the question", async () => {
    expect((await app.inject({ method: "POST", url: "/keeper/questions", payload: { question: "" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/keeper/questions", payload: { question: "x", subject: "bad" } })).statusCode).toBe(400);
  });
});

describe("structural: the Keeper has no write path of its own", () => {
  it("its explain, guide, read capabilities and routes never insert, update or delete", () => {
    const root = path.resolve("src");
    const files = [
      ...readdirSync(path.join(root, "keeper")).map((f) => path.join(root, "keeper", f)),
      path.join(root, "capabilities/systemInspect/adapter.ts"),
      path.join(root, "capabilities/docsRetrieve/adapter.ts"),
      path.join(root, "api/routes/keeper.ts"),
    ];
    // Database writes only (a hash's `.update()` is not one).
    const offenders = files.filter((f) => /(tx|db)\s*\.\s*(insert|update|delete)\(|emitEvent\(|emitLifecycleEvent\(/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
