/**
 * Manager reliability hardening. Proves, against the real runtime with mocked model calls:
 * - delegated and follow-up Workflow Runs are driven by every driver (async start, approval decision,
 *   startup re-drive), and re-driving a mission never duplicates runs, artifacts, events or XP;
 * - a worker whose own loop ended incomplete can never be completed by the model's word;
 * - the bounded follow-up happens only for recoverable findings, within limits, and is re-validated;
 * - a plan that became stale (grant revoked, agent stopped or busy, budget spent) is refused at the last
 *   boundary with a deterministic reason, and leaves nothing half-written;
 * - every blocked, failed or stopped mission carries a reason code taken from runtime facts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, like, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { closeTestDb, resetTestSchema, testDb } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import { seedPublishWorkflow, seedV11Definitions } from "../../src/definitions/seed.js";
import { dayScopeRef } from "../../src/governance/dailyBudgetPolicy.js";
import { createAgentDefinition } from "../../src/definitions/registryWrites.js";
import { transactionRunner } from "../../src/db/transactionRunner.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { callClaudeSubscriptionModel } from "../../src/router/providers/claudeSubscription.js";
import { buildServer } from "../../src/api/server.js";
import { managerDelegateRecord } from "../../src/capabilities/manager/adapters.js";
import { redriveInProgressWorkflowRuns } from "../../src/workflow/recoverInterruptedInvocations.js";
import { buildInvocationSpecsFromDefinitions } from "../../src/workflow/buildInvocationSpecsFromDefinitions.js";
import { findManagerRefs } from "../../src/definitions/lookupSeed.js";
import { insertGoalWithWorkflowRun } from "../../src/api/routes/goals.js";
import { sweepMissionRecoveries } from "../../src/api/routes/manager.js";
import { refreshAgentProgression } from "../../src/projections/agentProgression.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
type Kind = "plan" | "review" | "recover" | "decide" | "work" | "deliverable";

let app: FastifyInstance;
const USAGE = { tokensIn: 300, tokensOut: 100, costAmount: 400, costUnit: "subscription_tokens" as const };
const calls: Record<Kind, number> = { plan: 0, review: 0, recover: 0, decide: 0, work: 0, deliverable: 0 };
const noFollowUp = { needed: false, agentName: "", brief: "", expectedOutput: "", completionCriteria: "", intents: [] };
const task = (over: Json = {}) => ({ stepId: "ideas", agentName: "Researcher", brief: "Brainstorm three ideas.", expectedOutput: "Three ideas.", completionCriteria: "Three distinct ideas.", intents: ["brainstorm"], tools: [], dependsOn: [], ...over });
/** A recovery proposal: the same task, a different agent. */
const reassignTo = (agentName: string, over: Json = {}) => ({
  diagnosis: "The Researcher's model call timed out; the task itself is sound.",
  action: "reassign",
  stepId: "ideas",
  agentName,
  brief: "Brainstorm three ideas.",
  expectedOutput: "Three ideas.",
  completionCriteria: "Three distinct ideas.",
  reason: "Another agent can do the same work.",
  ...over,
});
const finish = () => ({ assessment: "done", done: true, action: { type: "finish", intent: "", capability: "", input: { query: "" }, instruction: "", useArtifacts: [] }, ledgerNote: "done" });
const think = () => ({ assessment: "more", done: false, action: { type: "think", intent: "brainstorm", capability: "", input: { query: "" }, instruction: "think", useArtifacts: [] }, ledgerNote: "think" });

let plan: () => Json;
let review: (n: number) => Json;
let recover: (n: number) => Json;
let decide: (n: number) => Json;
let hooks: Partial<Record<Kind, (n: number) => Promise<void>>>;
let failDecide: ((n: number) => Json | null) | null;
/** Holds a Talk's model call open (so its agent stays busy) until released. */
let talkGate: Promise<void> | null = null;

function reset() {
  for (const k of Object.keys(calls) as Kind[]) calls[k] = 0;
  plan = () => ({ summary: "One task.", assumptions: [], tasks: [task()], escalation: { needed: false, reason: "" } });
  review = () => ({ summary: "Here are three ideas.", assessments: [{ stepId: "ideas", sufficient: true, reason: "ok" }], followUp: noFollowUp });
  recover = () => reassignTo("Keeper");
  decide = () => finish();
  hooks = {};
  failDecide = null;
}

async function call(method: "GET" | "POST", url: string, payload?: unknown) {
  const res = await app.inject({ method, url, payload: payload as Json });
  return { status: res.statusCode, body: res.json() as Json };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TRIGGER = "artifacts_immutable";
async function until(goalId: string, statuses: string[], ms = 30_000): Promise<Json> {
  const deadline = Date.now() + ms;
  let m: Json = {};
  while (Date.now() < deadline) {
    m = (await call("GET", `/manager/missions/${goalId}`)).body;
    if (statuses.includes(m.status)) return m;
    await sleep(50);
  }
  throw new Error(`mission ${goalId} stayed ${m.status}`);
}
const settled = (goalId: string) => until(goalId, ["completed", "escalated", "failed", "stopped", "awaiting_approval", "paused", "finished_without_report"]);
/**
 * A mission that has stopped moving. A settled status is not the last word: between a delegated Workflow
 * Run failing and the runtime starting its recovery the mission truthfully reads "failed", so a test that
 * cares about the recovery waits until two reads in a row agree.
 */
async function stable(goalId: string, ms = 10_000): Promise<Json> {
  const deadline = Date.now() + ms;
  let previous = JSON.stringify(await settled(goalId));
  while (Date.now() < deadline) {
    await sleep(250);
    const now = JSON.stringify(await settled(goalId));
    if (now === previous) return JSON.parse(now) as Json;
    previous = now;
  }
  return JSON.parse(previous) as Json;
}

async function mission(objective = "Brainstorm three ideas.") {
  const res = await call("POST", "/manager/missions", { objective });
  expect(res.status).toBe(202);
  return stable(res.body.goalId);
}
const agentId = async (name: string) => (await testDb.select().from(schema.agentDefinitions).where(eq(schema.agentDefinitions.name, name)))[0]!.id;
const countRows = async (goalId: string) => {
  const wrs = await testDb.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.goalId, goalId));
  const events = await testDb.select().from(schema.events).where(eq(schema.events.goalId, goalId));
  const arts = await testDb.execute(sql`SELECT count(*)::int AS n FROM artifacts a JOIN invocations i ON i.id = a.producing_invocation_id JOIN runs r ON r.id = i.run_id JOIN task_instances ti ON ti.id = r.task_instance_id JOIN workflow_runs wr ON wr.id = ti.workflow_run_id WHERE wr.goal_id = ${goalId}`);
  const runs = await testDb.execute(sql`SELECT count(*)::int AS n FROM runs r JOIN task_instances ti ON ti.id = r.task_instance_id JOIN workflow_runs wr ON wr.id = ti.workflow_run_id WHERE wr.goal_id = ${goalId}`);
  return { workflowRuns: wrs.length, events: events.length, artifacts: (arts.rows[0] as { n: number }).n, runs: (runs.rows[0] as { n: number }).n };
};
async function liftAllStops() {
  const stops = (await call("GET", "/execution-stops")).body.stops as Json[];
  for (const s of stops) await call("POST", "/execution-stops/lift", { scope: s.scope, scopeRefId: s.scopeRefId, stopId: s.id });
}

beforeAll(async () => {
  await resetTestSchema();
  await testDb.transaction((tx) => seedPublishWorkflow(tx));
  await testDb.transaction((tx) => seedV11Definitions(tx));
  vi.mocked(callClaudeSubscriptionModel).mockImplementation(async (_m, _ctx, shape) => {
    const props = (shape as { properties?: Record<string, unknown> }).properties ?? {};
    if ("reply" in props) {
      await talkGate;
      return { result: { reply: "ok", keyPoints: [] }, usage: USAGE };
    }
    const kind: Kind = "escalation" in props ? "plan" : "assessments" in props ? "review" : "diagnosis" in props ? "recover" : "action" in props ? "decide" : "content" in props ? "work" : "deliverable";
    const n = ++calls[kind];
    await hooks[kind]?.(n);
    if (kind === "decide" && failDecide) {
      const failure = failDecide(n);
      if (failure) throw Object.assign(new Error(String(failure.message)), failure);
    }
    if (kind === "plan") return { result: plan(), usage: USAGE };
    if (kind === "review") return { result: review(n), usage: USAGE };
    if (kind === "recover") return { result: recover(n), usage: USAGE };
    if (kind === "decide") return { result: decide(n), usage: USAGE };
    if (kind === "work") return { result: { summary: "worked", content: "## Worked", keyPoints: ["k"] }, usage: USAGE };
    return { result: { title: "Ideas", summary: "Three ideas.", body: "1. A 2. B 3. C", findings: [], recommendations: [], sources: [] }, usage: USAGE };
  });
  app = buildServer({ db: testDb });
  await app.ready();
}, 30_000);

beforeEach(async () => {
  reset();
  await liftAllStops();
});

afterAll(async () => {
  await app.close();
  await closeTestDb();
});

describe("an incomplete worker can never be completed by the model's word", () => {
  it("a worker that ran out of iterations, judged 'sufficient', escalates with deliverable_invalid", async () => {
    decide = () => think();
    const m = await mission();
    expect(m.status).toBe("escalated");
    expect(m.reason).toBe("deliverable_invalid");
    expect(m.report).toMatchObject({ status: "escalated" });
    expect(m.reasons.map((r: Json) => r.detail).join(" ")).toMatch(/loop ended incomplete \(max_iterations\)/);
  });

  it("insufficient → bounded follow-up → verified again → completes only when every check passes", async () => {
    // The first worker never finishes; the Manager proposes one follow-up, which finishes and is judged sufficient.
    decide = (n) => (n <= 3 ? think() : finish());
    review = (n) =>
      n === 1
        ? { summary: "Incomplete.", assessments: [{ stepId: "ideas", sufficient: true, reason: "looks fine" }], followUp: { needed: true, agentName: "Keeper", brief: "Add the missing ideas.", expectedOutput: "Ideas.", completionCriteria: "Three ideas.", intents: ["brainstorm"] } }
        : { summary: "Now complete.", assessments: [{ stepId: "follow_up_2", sufficient: true, reason: "ok" }], followUp: noFollowUp };
    const m = await mission();
    expect(m.workflowRuns).toHaveLength(3);
    expect(m.workflowRuns[2].steps.map((s: Json) => [s.kind, s.agentName, s.runStatus])).toEqual([
      ["agent_objective", "Keeper", "completed"],
      ["manager_review", "Manager", "completed"],
    ]);
    expect(m.status).toBe("completed");
    expect(m.reason).toBeNull();
  });
});

describe("the bounded follow-up is refused unless it is recoverable, within limits and valid", () => {
  const insufficientWithFollowUp = (over: Json = {}) => () => ({
    summary: "Thin.",
    assessments: [{ stepId: "ideas", sufficient: false, reason: "only two" }],
    followUp: { needed: true, agentName: "Keeper", brief: "Add one idea.", expectedOutput: "One idea.", completionCriteria: "A distinct idea.", intents: ["brainstorm"], ...over },
  });

  it("refuses an invalid follow-up plan (unknown agent)", async () => {
    review = insufficientWithFollowUp({ agentName: "Admin" });
    const m = await mission();
    expect(m.status).toBe("escalated");
    expect(m.workflowRuns).toHaveLength(2);
    expect(m.reasons.map((r: Json) => r.code)).toEqual(expect.arrayContaining(["evidence_invalid", "validation_rejected"]));
  });

  it("refuses a follow-up outside the time window", async () => {
    hooks.review = async () => {
      const [g] = await testDb.select().from(schema.goals).where(like(schema.goals.title, "Mission: Late%"));
      await testDb.update(schema.goals).set({ createdAt: new Date(Date.now() - 31 * 60_000) }).where(eq(schema.goals.id, g!.id));
    };
    review = insufficientWithFollowUp();
    const m = await mission("Late brainstorm.");
    expect(m.status).toBe("escalated");
    expect(m.reasons.map((r: Json) => r.code)).toContain("mission_limit_reached");
    expect(m.workflowRuns).toHaveLength(2);
  });

  it("refuses a busy replacement worker and a stopped one", async () => {
    // The Publisher is busy: its publish workflow waits at an approval.
    await call("POST", "/goals", { title: "Publish something" });
    await sleep(500);
    review = insufficientWithFollowUp({ agentName: "Publisher" });
    let m = await mission();
    expect(m.reasons.map((r: Json) => r.code)).toContain("worker_unavailable");
    expect(m.workflowRuns).toHaveLength(2);

    hooks.review = async () => {
      await call("POST", "/execution-stops", { scope: "agent_definition", scopeRefId: await agentId("Keeper"), reason: "hold" });
    };
    review = insufficientWithFollowUp();
    m = await mission();
    expect(m.reasons.map((r: Json) => r.code)).toContain("emergency_stopped");
    expect(m.workflowRuns).toHaveLength(2);
  });

  it("a worker is never handed a corrupted deliverable: its step fails closed, and no follow-up is planned", async () => {
    // Same corruption, but this time the second worker DEPENDS on the first's deliverable. Provenance still
    // holds — the artifact hangs off the right completed run — so only the hash check can catch it.
    plan = () => ({ summary: "", assumptions: [], tasks: [task(), task({ stepId: "pick", agentName: "Keeper", brief: "Pick one.", intents: ["compare"], dependsOn: ["ideas"] })], escalation: { needed: false, reason: "" } });
    hooks.deliverable = async (n) => {
      if (n !== 2) return;
      const [doc] = await testDb.execute(sql`SELECT a.id FROM artifacts a JOIN invocations i ON i.id = a.producing_invocation_id JOIN runs r ON r.id = i.run_id JOIN agent_definitions ad ON ad.id = r.agent_definition_id WHERE a.type = 'deliverable' AND ad.name = 'Researcher' ORDER BY a.created_at DESC LIMIT 1`).then((r) => r.rows as { id: string }[]);
      await testDb.execute(sql.raw(`ALTER TABLE artifacts DISABLE TRIGGER ${TRIGGER}`));
      try {
        await testDb.update(schema.artifacts).set({ inlineContent: '{"format":"deliverable/v1","body":"tampered"}' }).where(eq(schema.artifacts.id, doc!.id));
      } finally {
        await testDb.execute(sql.raw(`ALTER TABLE artifacts ENABLE TRIGGER ${TRIGGER}`));
      }
    };
    const m = await mission("Two dependent steps.");
    expect(m.status).toBe("failed");
    expect(m.reason).toBe("worker_failed");
    expect(m.workflowRuns[1].steps.map((s: Json) => [s.agentName, s.runStatus])).toEqual([
      ["Researcher", "completed"],
      ["Keeper", "failed"],
    ]);
  });

  it("never follows up after a verification failure, even when the model proposes one", async () => {
    // Two INDEPENDENT tasks: no worker consumes the other's deliverable, so the REVIEW is the only thing
    // that reads the corrupted one and its verification is what must catch it. (A corrupted artifact handed
    // to a worker is caught earlier still, by `resolveStepInputArtifacts`' hash check, and fails that step
    // closed; the review resolves without that check precisely so it can report rather than crash.)
    plan = () => ({ summary: "", assumptions: [], tasks: [task(), task({ stepId: "pick", agentName: "Keeper", brief: "Pick one.", intents: ["compare"] })], escalation: { needed: false, reason: "" } });
    hooks.deliverable = async (n) => {
      if (n !== 2) return;
      const [doc] = await testDb.execute(sql`SELECT a.id FROM artifacts a JOIN invocations i ON i.id = a.producing_invocation_id JOIN runs r ON r.id = i.run_id JOIN agent_definitions ad ON ad.id = r.agent_definition_id WHERE a.type = 'deliverable' AND ad.name = 'Researcher' ORDER BY a.created_at DESC LIMIT 1`).then((r) => r.rows as { id: string }[]);
      // Artifacts are immutable (a database trigger refuses UPDATE): prove it, then simulate storage corruption past it.
      await expect(testDb.update(schema.artifacts).set({ inlineContent: "{}" }).where(eq(schema.artifacts.id, doc!.id))).rejects.toThrow();
      await testDb.execute(sql.raw(`ALTER TABLE artifacts DISABLE TRIGGER ${TRIGGER}`));
      try {
        await testDb.update(schema.artifacts).set({ inlineContent: '{"format":"deliverable/v1","body":"tampered"}' }).where(eq(schema.artifacts.id, doc!.id));
      } finally {
        await testDb.execute(sql.raw(`ALTER TABLE artifacts ENABLE TRIGGER ${TRIGGER}`));
      }
    };
    review = () => ({ summary: "x", assessments: [{ stepId: "ideas", sufficient: true, reason: "ok" }, { stepId: "pick", sufficient: true, reason: "ok" }], followUp: { needed: true, agentName: "Keeper", brief: "Redo.", expectedOutput: "x", completionCriteria: "x", intents: ["brainstorm"] } });
    const m = await mission("Two steps.");
    expect(m.status).toBe("escalated");
    expect(m.reason).toBe("verification_failed");
    expect(m.workflowRuns).toHaveLength(2);
  });

  it("a follow-up that would need approval cannot exist: follow-ups carry no tools, so they cannot ask for one", async () => {
    review = insufficientWithFollowUp();
    const m = await mission();
    const def = await testDb.query.workflowDefinitions.findFirst({ where: eq(schema.workflowDefinitions.id, (await testDb.query.workflowRuns.findFirst({ where: eq(schema.workflowRuns.id, m.workflowRuns[2].id) }))!.workflowDefinitionId) });
    expect((def!.graphDefinition as Json).steps[0].parameters.tools).toEqual([]);
  });
});

describe("a stale plan never becomes authority", () => {
  const staleAtDelegation = (effect: () => Promise<void>) => {
    const original = managerDelegateRecord.execute;
    vi.spyOn(managerDelegateRecord, "execute").mockImplementationOnce(async (...args) => {
      await effect();
      return original(...args);
    });
  };

  it("a worker stopped after validation: refused at the start step, nothing written, emergency_stopped", async () => {
    const defsBefore = (await testDb.select().from(schema.workflowDefinitions)).length;
    staleAtDelegation(async () => {
      await call("POST", "/execution-stops", { scope: "agent_definition", scopeRefId: await agentId("Researcher"), reason: "stale" });
    });
    const m = await mission("Stale stop.");
    expect(m.status).toBe("stopped");
    expect(m.reason).toBe("emergency_stopped");
    expect(m.workflowRuns).toHaveLength(1);
    expect((await testDb.select().from(schema.workflowDefinitions)).length).toBe(defsBefore);
  });

  it("a worker's grant revoked after validation: refused with capability_unavailable", async () => {
    const [cap] = await testDb.select().from(schema.capabilities).where(eq(schema.capabilities.name, "research.retrieve"));
    await testDb.transaction((tx) =>
      createAgentDefinition(tx, { name: "Retriever", role: "r", objective: "o", instructions: "i", grants: [{ capabilityId: cap!.id, permissions: ["READ"], autonomyState: "AUTONOMOUS", maxTrustLevelRequired: 1 }] }, "human:operator")
    );
    plan = () => ({ summary: "", assumptions: [], tasks: [task({ agentName: "Retriever", intents: [], tools: ["research.retrieve"] })], escalation: { needed: false, reason: "" } });
    staleAtDelegation(async () => {
      const [grant] = await testDb.select().from(schema.capabilityGrants).where(eq(schema.capabilityGrants.agentDefinitionId, await agentId("Retriever")));
      expect((await call("POST", `/capability-grants/${grant!.id}/revoke`)).status).toBe(200);
    });
    const m = await mission("Stale grant.");
    expect(m.status).toBe("failed");
    expect(m.reason).toBe("capability_unavailable");
    expect(m.workflowRuns).toHaveLength(1);
  });

  it("a worker that became busy after validation: refused with worker_unavailable", async () => {
    let release = () => {};
    talkGate = new Promise((r) => (release = r));
    staleAtDelegation(async () => {
      const talk = await call("POST", `/agents/${await agentId("Researcher")}/talk`, { message: "busy now" });
      expect(talk.status).toBe(202);
    });
    const m = await mission("Stale busy.");
    expect(m.status).toBe("failed");
    expect(m.reason).toBe("worker_unavailable");
    expect(m.workflowRuns).toHaveLength(1);
    release();
    talkGate = null;
    await sleep(500);
  });

  it("budget spent after delegation: the worker's own call is denied and the mission fails with budget_denied", async () => {
    const day = dayScopeRef(new Date());
    const find = () => testDb.query.budgetCounters.findFirst({ where: (c, { and: all, eq: is }) => all(is(c.scope, "day"), is(c.scopeRefId, day), is(c.resourceUnit, "subscription_tokens")) });
    let saved: { limitAmount: string; consumedAmount: string } | null = null;
    staleAtDelegation(async () => {
      const row = await find();
      saved = row ? { limitAmount: row.limitAmount, consumedAmount: row.consumedAmount } : null;
      if (row) await testDb.update(schema.budgetCounters).set({ limitAmount: "1", consumedAmount: "1" }).where(eq(schema.budgetCounters.id, row.id));
      else await testDb.insert(schema.budgetCounters).values({ scope: "day", scopeRefId: day, resourceUnit: "subscription_tokens", limitAmount: "1", reservedAmount: "0", consumedAmount: "1" });
    });
    const m = await mission("Stale budget.");
    const after = (await find())!;
    if (saved) await testDb.update(schema.budgetCounters).set(saved).where(eq(schema.budgetCounters.id, after.id));
    else await testDb.delete(schema.budgetCounters).where(eq(schema.budgetCounters.id, after.id));
    expect(m.status).toBe("failed");
    expect(m.reason).toBe("budget_denied");
    expect(m.workflowRuns).toHaveLength(2);
  });

  it("a failure while writing the delegation leaves no Workflow Definition behind (one savepoint)", async () => {
    await testDb.execute(sql`CREATE OR REPLACE FUNCTION refuse_mission_run() RETURNS trigger AS $$ BEGIN IF (SELECT name FROM workflow_definitions WHERE id = NEW.workflow_definition_id) LIKE 'Mission · %' THEN RAISE EXCEPTION 'refused by test'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await testDb.execute(sql`CREATE TRIGGER refuse_mission_run BEFORE INSERT ON workflow_runs FOR EACH ROW EXECUTE FUNCTION refuse_mission_run()`);
    plan = () => ({ summary: "", assumptions: [], tasks: [task({ stepId: "unique_shape" })], escalation: { needed: false, reason: "" } });
    try {
      const defsBefore = (await testDb.select().from(schema.workflowDefinitions)).length;
      const m = await mission("Savepoint.");
      expect(m.status).toBe("failed");
      expect(m.reason).toBe("manager_planning_failed");
      expect(m.workflowRuns).toHaveLength(1);
      expect((await testDb.select().from(schema.workflowDefinitions)).length).toBe(defsBefore);
      expect((await testDb.select().from(schema.events).where(and(eq(schema.events.goalId, m.goal.id), eq(schema.events.eventType, "manager_work_delegated"))))).toHaveLength(0);
    } finally {
      await testDb.execute(sql`DROP TRIGGER IF EXISTS refuse_mission_run ON workflow_runs`);
      await testDb.execute(sql`DROP FUNCTION IF EXISTS refuse_mission_run()`);
    }
  });
});

describe("failures carry deterministic reasons", () => {
  it("worker provider timeout → worker_timed_out; no automatic retry, no follow-up", async () => {
    failDecide = () => ({ message: "provider timed out", code: "timeout", consumption: "unknown" });
    const m = await mission();
    expect(m.status).toBe("failed");
    expect(m.reason).toBe("worker_timed_out");
    const worker = m.workflowRuns[1].steps[0];
    expect((await testDb.select().from(schema.runs).where(eq(schema.runs.taskInstanceId, worker.taskInstanceId)))).toHaveLength(1);
  });

  it("an emergency stop during the worker → stopped, emergency_stopped", async () => {
    hooks.decide = async () => {
      await call("POST", "/execution-stops", { scope: "global", reason: "all stop" });
    };
    decide = () => think();
    const m = await mission();
    expect(m.status).toBe("stopped");
    expect(m.reason).toBe("emergency_stopped");
  });

  it("an approval the operator rejects → failed, approval_rejected; while waiting → awaiting_approval, approval_required", async () => {
    const [cap] = await testDb.select().from(schema.capabilities).where(eq(schema.capabilities.name, "research.retrieve"));
    await testDb.transaction((tx) =>
      createAgentDefinition(tx, { name: "Careful One", role: "r", objective: "o", instructions: "i", grants: [{ capabilityId: cap!.id, permissions: ["READ"], autonomyState: "ALWAYS_APPROVE", maxTrustLevelRequired: 1 }] }, "human:operator")
    );
    plan = () => ({ summary: "", assumptions: [], tasks: [task({ agentName: "Careful One", intents: [], tools: ["research.retrieve"] })], escalation: { needed: false, reason: "" } });
    decide = () => ({ assessment: "need", done: false, action: { type: "tool", intent: "", capability: "research.retrieve", input: { query: "q" }, instruction: "", useArtifacts: [] }, ledgerNote: "r" });
    const res = await call("POST", "/manager/missions", { objective: "Careful." });
    const waiting = await until(res.body.goalId, ["awaiting_approval"]);
    expect(waiting.reason).toBe("approval_required");
    await call("POST", `/approvals/${waiting.pendingApprovals[0]}/reject`, { reason: "no" });
    const m = await settled(res.body.goalId);
    expect(m.status).toBe("failed");
    expect(m.reason).toBe("approval_rejected");
  });

  it("the trace lists the Manager's decisions and the governance facts in order", async () => {
    const m = await mission();
    const types = m.trace.map((e: Json) => e.type);
    for (const t of ["goal_created", "manager_plan_validated", "policy_evaluated", "manager_work_delegated", "manager_review_decided", "goal_completed"]) expect(types).toContain(t);
    expect(types.indexOf("manager_plan_validated")).toBeLessThan(types.indexOf("manager_work_delegated"));
    expect(m.trace.find((e: Json) => e.type === "manager_review_decided").summary).toMatch(/^complete · 1\/1 verified/);
  });
});

describe("driving, re-driving and restarts are idempotent", () => {
  it("an approval decision's re-drive carries the mission through its review to completion", async () => {
    const [cap] = await testDb.select().from(schema.capabilities).where(eq(schema.capabilities.name, "research.retrieve"));
    await testDb.transaction((tx) =>
      createAgentDefinition(tx, { name: "Asks First", role: "r", objective: "o", instructions: "i", grants: [{ capabilityId: cap!.id, permissions: ["READ"], autonomyState: "ALWAYS_APPROVE", maxTrustLevelRequired: 1 }] }, "human:operator")
    );
    plan = () => ({ summary: "", assumptions: [], tasks: [task({ agentName: "Asks First", intents: [], tools: ["research.retrieve"] })], escalation: { needed: false, reason: "" } });
    decide = (n) => (n === 1 ? { assessment: "need", done: false, action: { type: "tool", intent: "", capability: "research.retrieve", input: { query: "q" }, instruction: "", useArtifacts: [] }, ledgerNote: "r" } : finish());
    const res = await call("POST", "/manager/missions", { objective: "Approve then finish." });
    const waiting = await until(res.body.goalId, ["awaiting_approval"]);
    expect((await call("POST", `/approvals/${waiting.pendingApprovals[0]}/approve`)).status).toBe(200);
    // No manual advance: the approval route's driver continues the review on the same Workflow Run.
    const m = await until(res.body.goalId, ["completed", "escalated", "failed"]);
    expect(m.status).toBe("completed");
  });

  it("a mission whose process died before anything was driven completes once on startup re-drive, and re-driving again changes nothing", async () => {
    const refs = (await testDb.transaction((tx) => findManagerRefs(tx)))!;
    const started = await testDb.transaction((tx) => insertGoalWithWorkflowRun(tx, { title: "Mission: restart", description: "Brainstorm after a restart.", workflowDefinitionId: refs.planWorkflowDefinitionId, projectId: refs.projectId }));
    if ("error" in started) throw new Error(started.error);
    const runInTx = transactionRunner(testDb);
    await redriveInProgressWorkflowRuns(runInTx, buildInvocationSpecsFromDefinitions);
    const m = (await call("GET", `/manager/missions/${started.goalId}`)).body;
    expect(m.status).toBe("completed");
    expect(m.workflowRuns).toHaveLength(2);
    const before = await countRows(started.goalId);
    await redriveInProgressWorkflowRuns(runInTx, buildInvocationSpecsFromDefinitions);
    for (const wr of m.workflowRuns) expect([200, 409]).toContain((await call("POST", `/workflow-runs/${wr.id}/advance`)).status);
    expect(await countRows(started.goalId)).toEqual(before);
  });

  it("two identical objectives at once start one mission; the other is refused busy", async () => {
    const [a, b] = await Promise.all([call("POST", "/manager/missions", { objective: "Twice." }), call("POST", "/manager/missions", { objective: "Twice." })]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    await settled((a.status === 202 ? a : b).body.goalId);
  });

  it("XP is derived, not accumulated: rebuilding progression twice after all of this gives identical awards", async () => {
    await testDb.transaction((tx) => refreshAgentProgression(tx));
    const first = await testDb.select().from(schema.agentXpAwards).orderBy(schema.agentXpAwards.agentName, schema.agentXpAwards.awardKey);
    await redriveInProgressWorkflowRuns(transactionRunner(testDb), buildInvocationSpecsFromDefinitions);
    await testDb.transaction((tx) => refreshAgentProgression(tx));
    const second = await testDb.select().from(schema.agentXpAwards).orderBy(schema.agentXpAwards.agentName, schema.agentXpAwards.awardKey);
    expect(second.map((a) => `${a.agentName}:${a.awardKey}:${a.xp}`)).toEqual(first.map((a) => `${a.agentName}:${a.awardKey}:${a.xp}`));
    const keys = second.map((a) => `${a.agentName}:${a.awardKey}`);
    expect(new Set(keys).size).toBe(keys.length);
    // Failed runs earn no task award: every task award's Task Instance has a completed run.
    for (const a of second.filter((x) => x.awardKey.startsWith("task:"))) {
      const ti = a.awardKey.slice("task:".length);
      const done = await testDb.select().from(schema.runs).where(and(eq(schema.runs.taskInstanceId, ti), eq(schema.runs.status, "completed")));
      expect(done.length).toBeGreaterThan(0);
    }
  });
});

describe("delegated work that failed gets ONE governed recovery round", () => {
  const eventsOfType = async (goalId: string, type: string) =>
    testDb.select().from(schema.events).where(and(eq(schema.events.goalId, goalId), eq(schema.events.eventType, type)));
  // The recovered task carries a new step id (`recovery_<runs>_<original>`), and the review must judge the
  // task that actually ran — so the reviewer here judges the original step and any recovery of it.
  beforeEach(() => {
    review = () => ({
      summary: "Here are three ideas.",
      assessments: ["ideas", "recovery_2_ideas", "recovery_3_ideas", "recovery_4_ideas"].map((stepId) => ({ stepId, sufficient: true, reason: "ok" })),
      followUp: noFollowUp,
    });
  });

  /** Fails the first worker's model call; later workers (the recovery's) succeed. */
  const firstWorkerTimesOut = () => {
    failDecide = (n) => (n === 1 ? { message: "provider timed out", code: "timeout", consumption: "unknown" } : null);
  };

  it("the runtime starts the recovery, the Manager reassigns, and the replacement work runs", async () => {
    firstWorkerTimesOut();
    const m = await mission();
    const started = await eventsOfType(m.goal.id, "manager_recovery_started");
    expect(started).toHaveLength(1);
    expect((started[0]!.payload as Json).failures.map((f: Json) => f.code)).toEqual(["worker_timed_out"]);
    const decided = await eventsOfType(m.goal.id, "manager_recovery_decided");
    expect((decided[0]!.payload as Json).action).toBe("reassign");
    expect(m.recovery).toMatchObject({ round: 1, action: "reassign", failures: ["worker_timed_out"] });
    // The recovery's own Workflow Run, then the work it delegated to a different agent.
    expect(m.workflowRuns.map((w: Json) => w.workflow?.split(" v")[0])).toEqual(["Manager Plan", "Mission · Researcher", "Manager Recovery", "Mission · Keeper"]);
    expect(m.workflowRuns[3].steps.map((s: Json) => [s.kind, s.agentName, s.runStatus])).toEqual([
      ["agent_objective", "Keeper", "completed"],
      ["manager_review", "Manager", "completed"],
    ]);
    // What the operator actually reads: a mission that recovered, not one that failed.
    expect(m.status).toBe("completed");
    expect(m.reason).toBeNull();
  });

  it("only one round: a second failure is the operator's to answer", async () => {
    failDecide = () => ({ message: "provider timed out", code: "timeout", consumption: "unknown" });
    const m = await mission();
    expect(await eventsOfType(m.goal.id, "manager_recovery_started")).toHaveLength(1);
    expect(m.status).toBe("failed");
    expect(m.recovery).toMatchObject({ round: 1 });
  });

  it("a recovery never reassigns to the agent that just failed", async () => {
    firstWorkerTimesOut();
    recover = () => reassignTo("Researcher");
    const m = await mission();
    const decided = await eventsOfType(m.goal.id, "manager_recovery_decided");
    expect((decided[0]!.payload as Json).action).toBe("escalate");
    expect(m.recovery).toMatchObject({ action: "escalate" });
    expect(m.workflowRuns).toHaveLength(3);
  });

  it("a recovery cannot hand the task to an agent that does not exist", async () => {
    firstWorkerTimesOut();
    recover = () => reassignTo("Admin");
    const m = await mission();
    expect((await eventsOfType(m.goal.id, "manager_recovery_decided"))[0]!.payload).toMatchObject({ action: "escalate" });
    expect(m.workflowRuns).toHaveLength(3);
  });

  it("no recovery when an emergency stop failed the work: stops are the operator's, not the Manager's", async () => {
    hooks.decide = async () => {
      await call("POST", "/execution-stops", { scope: "global", reason: "halt" });
    };
    const m = await mission();
    expect(m.status).toBe("stopped");
    expect(await eventsOfType(m.goal.id, "manager_recovery_started")).toHaveLength(0);
    await liftAllStops();
  });

  it("no recovery when the Manager's own planning failed", async () => {
    plan = () => ({ summary: "Nothing to do.", assumptions: [], tasks: [], escalation: { needed: true, reason: "the objective is unclear" } });
    const m = await mission();
    expect(await eventsOfType(m.goal.id, "manager_recovery_started")).toHaveLength(0);
    expect(m.recovery ?? null).toBeNull();
  });

  it("a mission that failed on a path knowing nothing about missions is recovered by the sweep", async () => {
    // The generic re-drive (a restart, an approval decision) never starts a recovery: only the mission's own
    // driver and this sweep do. Proven here by driving the mission entirely through the generic path.
    firstWorkerTimesOut();
    const refs = (await testDb.transaction((tx) => findManagerRefs(tx)))!;
    const started = await testDb.transaction((tx) => insertGoalWithWorkflowRun(tx, { title: "Mission: swept", description: "Brainstorm after a restart.", workflowDefinitionId: refs.planWorkflowDefinitionId, projectId: refs.projectId }));
    if ("error" in started) throw new Error(started.error);
    await redriveInProgressWorkflowRuns(transactionRunner(testDb), buildInvocationSpecsFromDefinitions);
    // Not "failed": the runtime owes this mission a recovery round, so the mission still reads as working.
    const owed = (await call("GET", `/manager/missions/${started.goalId}`)).body;
    expect(owed.status).toBe("working");
    expect(await eventsOfType(started.goalId, "manager_recovery_started")).toHaveLength(0);

    expect(await sweepMissionRecoveries(testDb)).toHaveLength(1);
    const m = await stable(started.goalId);
    expect(m.recovery).toMatchObject({ round: 1, action: "reassign" });
    expect(m.status).toBe("completed");
    expect(m.workflowRuns).toHaveLength(4);
    // The sweep is idempotent: the round is spent.
    expect(await sweepMissionRecoveries(testDb)).toEqual([]);
  });

  it("no recovery after a mission that never failed", async () => {
    const m = await mission();
    expect(m.status).toBe("completed");
    expect(await eventsOfType(m.goal.id, "manager_recovery_started")).toHaveLength(0);
  });
});
