/**
 * `GET /artifacts/:id`: an Artifact produced by a real Workflow Run through
 * `POST /goals`, with its provenance chain, the compiled contexts that included it,
 * a bounded preview, and a content hash check that notices tampering.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
let researchRun: { runId: string; toolArtifactId: string; toolInvocationId: string; llmInvocationId: string; reportArtifactId: string };

type Body = {
  artifact: { id: string; type: string; preview: string | null; truncated: boolean; contentHashMatches: boolean | null; storedInline: boolean };
  producedBy: {
    invocation: { id: string; kind: string };
    runId: string;
    agent: { name: string; version: number } | null;
    taskDefinition: { id: string; name: string };
    workflowRunId: string | null;
    goal: { title: string } | null;
  } | null;
  referencedBy: { invocationId: string; runId: string; kind: string; version: number | null; hash: string | null }[];
  referencedByTruncated: boolean;
};

beforeAll(async () => {
  await resetTestSchema();
  seed = await testDb.transaction((tx) => seedPublishWorkflow(tx));
  app = buildServer({ db: testDb });
  await app.ready();

  vi.mocked(callClaudeSubscriptionModel).mockResolvedValueOnce({
    result: { report: "a report about batteries" },
    usage: { tokensIn: 10, tokensOut: 5, costAmount: 15, costUnit: "subscription_tokens" },
  });
  const created = await app.inject({ method: "POST", url: "/goals", payload: { title: "Artifacts please" } });
  expect(created.statusCode).toBe(201);

  const researchInstance = await testDb.query.taskInstances.findFirst({ where: eq(schema.taskInstances.taskDefinitionId, seed.taskDefinitionId) });
  const run = await testDb.query.runs.findFirst({ where: eq(schema.runs.taskInstanceId, researchInstance!.id) });
  const invocationRows = await testDb.query.invocations.findMany({ where: eq(schema.invocations.runId, run!.id), orderBy: (i, { asc }) => asc(i.seqNo) });
  const tool = invocationRows.find((i) => i.kind === "tool")!;
  const llm = invocationRows.find((i) => i.kind === "llm")!;
  const toolArtifact = await testDb.query.artifacts.findFirst({ where: eq(schema.artifacts.producingInvocationId, tool.id) });
  const [report] = await testDb
    .select({ id: schema.artifacts.id })
    .from(schema.artifacts)
    .innerJoin(schema.invocations, eq(schema.artifacts.producingInvocationId, schema.invocations.id))
    .where(and(eq(schema.invocations.runId, run!.id), eq(schema.artifacts.type, "report")));
  researchRun = { runId: run!.id, toolArtifactId: toolArtifact!.id, toolInvocationId: tool.id, llmInvocationId: llm.id, reportArtifactId: report!.id };
}, 60000);

afterAll(async () => {
  await app.close();
  await closeTestDb();
});

async function get(id: string) {
  const res = await app.inject({ method: "GET", url: `/artifacts/${id}` });
  return { status: res.statusCode, body: res.json() as Body };
}

describe("GET /artifacts/:id", () => {
  it("returns the report with a preview, a matching hash, and its full provenance chain", async () => {
    const { status, body } = await get(researchRun.reportArtifactId);
    expect(status).toBe(200);
    expect(body.artifact).toMatchObject({ type: "report", storedInline: true, truncated: false, contentHashMatches: true });
    expect(body.artifact.preview).toContain("a report about batteries");
    expect(body.producedBy).toMatchObject({
      runId: researchRun.runId,
      agent: { name: "Researcher", version: 1 },
      taskDefinition: { id: seed.taskDefinitionId, name: "Research-Report" },
      goal: { title: "Artifacts please" },
    });
    expect(body.producedBy!.workflowRunId).toEqual(expect.any(String));
  });

  it("lists the compiled context that included the tool result, with the version and hash that went in", async () => {
    const { body } = await get(researchRun.toolArtifactId);
    expect(body.producedBy!.invocation).toMatchObject({ id: researchRun.toolInvocationId, kind: "tool" });
    expect(body.referencedBy).toEqual([
      expect.objectContaining({ invocationId: researchRun.llmInvocationId, runId: researchRun.runId, version: 1, hash: expect.any(String) }),
    ]);
    expect(body.referencedBy[0]!.kind).toMatch(/^artifact_/);
    expect(body.referencedByTruncated).toBe(false);
    // The report itself was not fed to any compiled context.
    expect((await get(researchRun.reportArtifactId)).body.referencedBy).toEqual([]);
  });

  it("reports content that no longer matches its hash", async () => {
    const original = await testDb.query.artifacts.findFirst({ where: eq(schema.artifacts.id, researchRun.reportArtifactId) });
    await testDb.update(schema.artifacts).set({ inlineContent: "tampered" }).where(eq(schema.artifacts.id, researchRun.reportArtifactId));
    try {
      expect((await get(researchRun.reportArtifactId)).body.artifact.contentHashMatches).toBe(false);
    } finally {
      await testDb.update(schema.artifacts).set({ inlineContent: original!.inlineContent }).where(eq(schema.artifacts.id, researchRun.reportArtifactId));
    }
  });

  it("rejects a malformed id and reports an unknown Artifact", async () => {
    expect((await app.inject({ method: "GET", url: "/artifacts/nope" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/artifacts/00000000-0000-4000-8000-000000000000" })).statusCode).toBe(404);
  });
});
