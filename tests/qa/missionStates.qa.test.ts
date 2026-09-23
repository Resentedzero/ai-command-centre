/**
 * Browser QA harness for Manager mission states (not part of the normal suite: skipped unless QA_SERVE=1).
 * Builds real missions in every state against the TEST database with mocked model calls — no dev data is
 * fabricated and no model is called — writes their goal ids to QA_OUT, and serves the API on port 3000 for
 * QA_SECONDS so the web app can be inspected in a browser.
 */
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { writeFileSync } from "node:fs";
import { closeTestDb, resetTestSchema, testDb } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import { seedPublishWorkflow, seedV11Definitions } from "../../src/definitions/seed.js";
import { createAgentDefinition } from "../../src/definitions/registryWrites.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { callClaudeSubscriptionModel } from "../../src/router/providers/claudeSubscription.js";
import { buildServer } from "../../src/api/server.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const QA = process.env.QA_SERVE === "1";

describe.skipIf(!QA)("mission states for browser QA", () => {
  it(
    "builds and serves missions in every state",
    async () => {
      await resetTestSchema();
      await testDb.transaction((tx) => seedPublishWorkflow(tx));
      await testDb.transaction((tx) => seedV11Definitions(tx));
      const USAGE = { tokensIn: 300, tokensOut: 100, costAmount: 400, costUnit: "subscription_tokens" as const };
      const noFollow = { needed: false, agentName: "", brief: "", expectedOutput: "", completionCriteria: "", intents: [] };
      const task = (over: Json = {}) => ({ stepId: "ideas", agentName: "Researcher", brief: "Brainstorm three ideas for organising the Command Centre.", expectedOutput: "Three ideas.", completionCriteria: "Three distinct ideas.", intents: ["brainstorm"], tools: [], dependsOn: [], ...over });
      const finish = { assessment: "done", done: true, action: { type: "finish", intent: "", capability: "", input: { query: "" }, instruction: "", useArtifacts: [] }, ledgerNote: "done" };
      const think = { assessment: "more", done: false, action: { type: "think", intent: "brainstorm", capability: "", input: { query: "" }, instruction: "think", useArtifacts: [] }, ledgerNote: "think" };
      const s: { plan: () => Json; review: (n: number) => Json; decide: (n: number) => Json | Error; onDecide?: () => Promise<void>; reviews: number; decides: number } = {
        plan: () => ({ summary: "One task.", assumptions: [], tasks: [task()], escalation: { needed: false, reason: "" } }),
        review: () => ({ summary: "Three ideas: role-based views, alert triage, modular layout.", assessments: [{ stepId: "ideas", sufficient: true, reason: "ok" }], followUp: noFollow }),
        decide: () => finish,
        reviews: 0,
        decides: 0,
      };
      vi.mocked(callClaudeSubscriptionModel).mockImplementation(async (_m, _c, shape) => {
        const p = (shape as { properties?: Record<string, unknown> }).properties ?? {};
        if ("escalation" in p) return { result: s.plan(), usage: USAGE };
        if ("assessments" in p) return { result: s.review(++s.reviews), usage: USAGE };
        if ("action" in p) {
          await s.onDecide?.();
          const d = s.decide(++s.decides);
          if (d instanceof Error) throw d;
          return { result: d, usage: USAGE };
        }
        if ("content" in p) return { result: { summary: "worked", content: "## Worked", keyPoints: ["k"] }, usage: USAGE };
        return { result: { title: "Ideas", summary: "Three ideas.", body: "1. Role-based views\n2. Alert triage\n3. Modular layout", findings: [], recommendations: [], sources: [] }, usage: USAGE };
      });
      const app = buildServer({ db: testDb });
      await app.ready();
      const post = async (url: string, payload: Json) => (await app.inject({ method: "POST", url, payload })).json() as Json;
      const settle = async (goalId: string, want: string[]) => {
        for (let i = 0; i < 400; i++) {
          const m = (await app.inject({ method: "GET", url: `/manager/missions/${goalId}` })).json() as Json;
          if (want.includes(m.status)) return m;
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error(`mission ${goalId} did not reach ${want}`);
      };
      const start = async (objective: string) => (await post("/manager/missions", { objective })).goalId as string;
      const agentId = async (name: string) => (await testDb.select().from(schema.agentDefinitions).where(eq(schema.agentDefinitions.name, name)))[0]!.id;
      const reset = () => {
        s.plan = () => ({ summary: "One task.", assumptions: [], tasks: [task()], escalation: { needed: false, reason: "" } });
        s.review = () => ({ summary: "Three ideas: role-based views, alert triage, modular layout.", assessments: [{ stepId: "ideas", sufficient: true, reason: "ok" }], followUp: noFollow });
        s.decide = () => finish;
        s.onDecide = undefined;
        s.reviews = 0;
        s.decides = 0;
      };
      const out: Record<string, string> = {};

      out.completed = await start("Brainstorm three ideas for organising the Command Centre and summarise them.");
      await settle(out.completed, ["completed"]);

      reset();
      s.decide = (n) => (n <= 3 ? think : finish);
      s.review = (n) =>
        n === 1
          ? { summary: "The first pass ran out of iterations.", assessments: [{ stepId: "ideas", sufficient: true, reason: "looks fine" }], followUp: { needed: true, agentName: "Keeper", brief: "Add the missing ideas.", expectedOutput: "Ideas.", completionCriteria: "Three ideas.", intents: ["brainstorm"] } }
          : { summary: "Complete after the follow-up.", assessments: [{ stepId: "follow_up_2", sufficient: true, reason: "ok" }], followUp: noFollow };
      out.followUp = await start("Brainstorm ideas; follow up if the first pass is incomplete.");
      await settle(out.followUp, ["completed", "escalated"]);

      reset();
      s.plan = () => ({ summary: "", assumptions: [], tasks: [task({ agentName: "Admin" })], escalation: { needed: false, reason: "" } });
      out.escalated = await start("Have the admin agent reorganise everything.");
      await settle(out.escalated, ["escalated"]);

      reset();
      s.decide = () => Object.assign(new Error("provider timed out"), { code: "timeout", consumption: "unknown" });
      out.failed = await start("Brainstorm ideas (the worker's model call times out).");
      await settle(out.failed, ["failed"]);

      reset();
      s.decide = () => think;
      s.onDecide = async () => {
        await post("/execution-stops", { scope: "agent_definition", scopeRefId: await agentId("Researcher"), reason: "QA: operator stop" });
      };
      out.stopped = await start("Brainstorm ideas (stopped by the operator mid-work).");
      await settle(out.stopped, ["stopped"]);

      reset();
      const [cap] = await testDb.select().from(schema.capabilities).where(eq(schema.capabilities.name, "research.retrieve"));
      await testDb.transaction((tx) =>
        createAgentDefinition(tx, { name: "Careful Researcher", role: "Research analyst who asks first", objective: "Retrieve evidence, with approval.", instructions: "Ask before retrieving.", grants: [{ capabilityId: cap!.id, permissions: ["READ"], autonomyState: "ALWAYS_APPROVE", maxTrustLevelRequired: 1 }] }, "human:operator")
      );
      s.plan = () => ({ summary: "", assumptions: [], tasks: [task({ agentName: "Careful Researcher", intents: [], tools: ["research.retrieve"] })], escalation: { needed: false, reason: "" } });
      s.decide = () => ({ assessment: "need", done: false, action: { type: "tool", intent: "", capability: "research.retrieve", input: { query: "organisation" }, instruction: "", useArtifacts: [] }, ledgerNote: "retrieve" });
      out.awaitingApproval = await start("Retrieve evidence about organising the Command Centre (needs approval).");
      await settle(out.awaitingApproval, ["awaiting_approval"]);

      writeFileSync(process.env.QA_OUT ?? "qa-missions.json", JSON.stringify(out, null, 2));
      await app.listen({ port: Number(process.env.QA_PORT ?? 3000), host: "127.0.0.1" });
      await new Promise((r) => setTimeout(r, Number(process.env.QA_SECONDS ?? 600) * 1000));
      await app.close();
      await closeTestDb();
      expect(Object.keys(out)).toHaveLength(6);
    },
    60 * 60 * 1000
  );
});
