/**
 * Spec §18.2: "the capability boundary must survive replacing that binding
 * entirely." `research.retrieve` is switched from its seeded synthetic stub to
 * the local corpus search by inserting one Tool Binding row. No code, the
 * Capability, its Grant and its spec builder are unchanged, and the full chain
 * (Grant -> Policy -> budget -> tool -> Artifact -> compiled context -> LLM)
 * runs against the new binding.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { closeTestDb, resetTestSchema, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { executeRunToBoundary } from "../helpers/driveToBoundary.js";
import { createStandaloneTaskInstance } from "../../src/execution/taskInstance.js";
import { seedResearchWorkflow, DEFAULT_RESEARCH_REPORT_CONTEXT_BUDGET } from "../../src/definitions/seed.js";
import { buildResearchReportInvocationSpecs } from "../../src/capabilities/researchRetrieve/buildInvocationSpecs.js";
import { RESEARCH_RETRIEVE_LOCAL_CORPUS } from "../../src/capabilities/researchRetrieve/adapter.js";
import { callClaudeSubscriptionModel } from "../../src/router/providers/claudeSubscription.js";

let corpusRoot: string;

beforeAll(async () => {
  await resetTestSchema();
  corpusRoot = mkdtempSync(path.join(tmpdir(), "swap-corpus-"));
  writeFileSync(path.join(corpusRoot, "cells.md"), "# Solid-state cells\n\nSolid-state electrolytes raise energy density.");
}, 30000);

afterAll(async () => {
  rmSync(corpusRoot, { recursive: true, force: true });
  await closeTestDb();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

const QUERY = "solid-state electrolytes";

async function setUp(tx: DrizzleTransaction, corpusTrustLevel = 2) {
  const seed = await seedResearchWorkflow(tx);
  const [corpusBinding] = await tx
    .insert(schema.toolBindings)
    .values({
      capabilityId: seed.capabilityId,
      kind: "internal",
      config: { function: RESEARCH_RETRIEVE_LOCAL_CORPUS, maxResults: 3 },
      trustLevel: corpusTrustLevel,
      version: 2,
    })
    .returning();
  const { taskInstanceId } = await createStandaloneTaskInstance(tx, seed.taskDefinitionId, seed.goalId, { query: QUERY });
  const [run] = await tx.insert(schema.runs).values({ taskInstanceId, status: "active" }).returning();
  const specs = await buildResearchReportInvocationSpecs(
    tx,
    {
      agentDefinitionId: seed.agentDefinitionId,
      agentDefinitionVersion: seed.agentDefinitionVersion,
      query: QUERY,
      contextBudget: DEFAULT_RESEARCH_REPORT_CONTEXT_BUDGET,
    },
    { taskDefinitionId: seed.taskDefinitionId, taskDefinitionVersion: 1, taskInstanceId, input: {} }
  );
  return { seed, corpusBinding: corpusBinding!, runId: run!.id, specs };
}

describe("research.retrieve binding replaced by data alone", () => {
  it("runs the whole chain against the local corpus binding, which declares a free local read", async () => {
    vi.stubEnv("RESEARCH_CORPUS_ROOT", corpusRoot);
    vi.mocked(callClaudeSubscriptionModel).mockResolvedValueOnce({
      result: { report: "Solid-state electrolytes raise energy density." },
      usage: { tokensIn: 50, tokensOut: 20, costAmount: 70, costUnit: "subscription_tokens" },
    });

    await withRollback(async (tx) => {
      const { corpusBinding, runId, specs } = await setUp(tx);
      const outcome = await executeRunToBoundary(tx, runId, specs);
      expect(outcome.status).toBe("completed");

      const tool = await tx.query.invocations.findFirst({ where: and(eq(schema.invocations.runId, runId), eq(schema.invocations.seqNo, 1)) });
      expect(tool).toMatchObject({ status: "completed", toolBindingId: corpusBinding.id, costClass: "local_retrieval" });

      const toolArtifact = await tx.query.artifacts.findFirst({ where: eq(schema.artifacts.producingInvocationId, tool!.id) });
      const content = JSON.parse(toolArtifact!.inlineContent!);
      expect(content.results).toEqual([
        expect.objectContaining({ title: "Solid-state cells", sourcePath: "cells.md", snippet: expect.stringContaining("electrolytes") }),
      ]);
      expect(toolArtifact!.inlineContent).not.toContain(corpusRoot);

      // Corpus content is external data: the LLM saw it fenced as untrusted (spec 5.15).
      const llm = await tx.query.invocations.findFirst({ where: and(eq(schema.invocations.runId, runId), eq(schema.invocations.seqNo, 2)) });
      const compiled = await tx.query.events.findFirst({ where: eq(schema.events.idempotencyKey, `context_compiled:${llm!.id}`) });
      expect(compiled!.payload).toMatchObject({ untrustedDataFenced: true });

      // A free local read reserved and consumed nothing in USD.
      const usd = await tx.query.budgetCounters.findFirst({
        where: and(eq(schema.budgetCounters.scopeRefId, runId), eq(schema.budgetCounters.resourceUnit, "usd")),
      });
      expect(Number(usd!.consumedAmount)).toBe(0);
      expect(Number(usd!.reservedAmount)).toBe(0);
    });
  });

  it("selection is not Policy: a newest binding below the Grant's trust bar is selected, then denied, never skipped", async () => {
    vi.stubEnv("RESEARCH_CORPUS_ROOT", corpusRoot);
    await withRollback(async (tx) => {
      const { corpusBinding, runId, specs } = await setUp(tx, 0);
      const outcome = await executeRunToBoundary(tx, runId, specs);
      expect(outcome.status).toBe("failed");
      const tool = await tx.query.invocations.findFirst({ where: and(eq(schema.invocations.runId, runId), eq(schema.invocations.seqNo, 1)) });
      expect(tool).toMatchObject({ status: "failed", toolBindingId: corpusBinding.id });
      expect(callClaudeSubscriptionModel).not.toHaveBeenCalled();
    });
  });
});
