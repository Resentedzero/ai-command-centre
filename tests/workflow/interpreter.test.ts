import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { resetTestSchema, closeTestDb, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";
import type { CapabilityPermission } from "../../src/governance/policy.js";
import { resolveApproval } from "../../src/governance/approvals.js";

// ---------------------------------------------------------------------------
// PROVIDER MOCKS — defence in depth, not decoration.
//
// `advanceWorkflowRun` reaches `executeRun` -> `callModel` -> a real provider
// adapter. Today every spec this file's builders produce is "deterministic" or
// "tool", so no dispatch happens — but `advanceWorkflowRun` takes a
// CALLER-SUPPLIED spec builder, so the only thing standing between this file
// and a real `claude` CLI subprocess is that nobody has yet written an "llm"
// spec in it. That is a convention, not a barrier.
//
// Since Claude Max became the routed default, an accidental llm spec here would
// spawn the real CLI and spend subscription entitlement during `npm test`.
// Mocking all three adapters makes that impossible rather than unlikely.
// ---------------------------------------------------------------------------
vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({
  callClaudeSubscriptionModel: vi.fn(),
}));

import {
  startWorkflowRun,
  pauseWorkflowRun,
  resumeWorkflowRun,
  deriveGoalStatus,
  type InvocationSpecBuilder,
} from "../../src/workflow/interpreter.js";
// Tool Invocations yield `dispatch_required` (DURABLE_EXECUTION §2.1); this drives
// each call to its next real boundary exactly as the production driver does.
import { advanceWorkflowRunToBoundary as advanceWorkflowRun } from "../helpers/driveToBoundary.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function seedProjectAndGoal(tx: DrizzleTransaction) {
  const [project] = await tx.insert(schema.projects).values({ name: "p-" + randomUUID() }).returning();
  const [goal] = await tx
    .insert(schema.goals)
    .values({ projectId: project!.id, title: "g-" + randomUUID(), status: "active" })
    .returning();
  return { project: project!, goal: goal! };
}

async function seedTaskDefinition(tx: DrizzleTransaction, version = 1) {
  const [taskDefinition] = await tx
    .insert(schema.taskDefinitions)
    .values({ name: "t-" + randomUUID(), kind: "workflow-step", version })
    .returning();
  return taskDefinition!;
}

async function seedLinearWorkflow(
  tx: DrizzleTransaction,
  steps: { taskDefinitionId: string; taskDefinitionVersion: number }[]
) {
  const [workflowDefinition] = await tx
    .insert(schema.workflowDefinitions)
    .values({ name: "wf-" + randomUUID(), version: 1, graphDefinition: { kind: "linear", steps } })
    .returning();
  return workflowDefinition!;
}

/** A 2-step linear workflow with fresh, distinct Task Definitions for step 0 and step 1. */
async function seedTwoStepWorkflowFixture(tx: DrizzleTransaction) {
  const { goal } = await seedProjectAndGoal(tx);
  const stepOneDef = await seedTaskDefinition(tx, 1);
  const stepTwoDef = await seedTaskDefinition(tx, 2);
  const workflowDefinition = await seedLinearWorkflow(tx, [
    { taskDefinitionId: stepOneDef.id, taskDefinitionVersion: stepOneDef.version },
    { taskDefinitionId: stepTwoDef.id, taskDefinitionVersion: stepTwoDef.version },
  ]);
  return { goal, stepOneDef, stepTwoDef, workflowDefinition };
}

/** Capability/Grant fixture with autonomyState "ALWAYS_APPROVE" — the only way a "tool" spec ever reaches REQUIRE_APPROVAL. */
async function seedApprovalGatedGrant(tx: DrizzleTransaction) {
  const [capability] = await tx.insert(schema.capabilities).values({ name: "cap-" + randomUUID(), staticRiskTag: "low" }).returning();
  const [toolBinding] = await tx
    .insert(schema.toolBindings)
    .values({ capabilityId: capability!.id, kind: "internal", config: {}, trustLevel: 2, version: 1 })
    .returning();
  const [agentDefinition] = await tx
    .insert(schema.agentDefinitions)
    .values({ name: "agent-" + randomUUID(), version: 1, role: "tester", objective: "test", instructions: "n/a" })
    .returning();
  await tx.insert(schema.capabilityGrants).values({
    agentDefinitionId: agentDefinition!.id,
    agentDefinitionVersion: agentDefinition!.version,
    capabilityId: capability!.id,
    permissions: ["WRITE"],
    maxTrustLevelRequired: 1,
    autonomyState: "ALWAYS_APPROVE",
  });
  return {
    capabilityId: capability!.id,
    toolBindingId: toolBinding!.id,
    agentDefinitionId: agentDefinition!.id,
    agentDefinitionVersion: agentDefinition!.version,
    permission: "WRITE" as CapabilityPermission,
  };
}

/** Builder that always returns a single trivial deterministic spec — used for steps with no special behavior. */
function alwaysDeterministicBuilder(execute?: () => Promise<Record<string, unknown>>): InvocationSpecBuilder {
  return async () => [{ kind: "deterministic", costClass: "deterministic", execute: execute ?? (async () => ({})) }];
}

/**
 * Builder that, for ONE specific Task Definition id, returns an
 * approval-gated "tool" spec (REQUIRE_APPROVAL via the ALWAYS_APPROVE grant
 * above) — and, per interpreter.ts's module header, binds the just-created
 * `runs` row to the gated grant's agent BEFORE returning the spec, since
 * `InvocationSpecBuilder`'s frozen signature carries no `tx`/agent-binding
 * channel of its own. `costClass: "deterministic"` is used deliberately so
 * this fixture needs no `budget_counters` row — REQUIRE_APPROVAL is driven
 * entirely by the Grant's autonomyState, not by cost class. Every other
 * Task Definition id gets a plain deterministic spec.
 *
 * When `calls` is supplied, every invocation's `taskDefinitionId` is
 * recorded into it — used to prove exactly which step advanceWorkflowRun
 * asked the builder to build specs for on each call (the assertion that
 * actually pins interpreter.ts's "last non-null step" correction against a
 * regression to a literal "first null index" reading; a bare Task Instance
 * count doesn't distinguish the two).
 */
function makeApprovalGatedBuilder(
  tx: DrizzleTransaction,
  gatedTaskDefinitionId: string,
  gated: Awaited<ReturnType<typeof seedApprovalGatedGrant>>,
  opts: { execute?: () => Promise<Record<string, unknown>>; calls?: string[] } = {}
): InvocationSpecBuilder {
  return async ({ taskDefinitionId, taskInstanceId }) => {
    opts.calls?.push(taskDefinitionId);
    if (taskDefinitionId !== gatedTaskDefinitionId) {
      return [{ kind: "deterministic", costClass: "deterministic", execute: async () => ({}) }];
    }
    await tx
      .update(schema.runs)
      .set({ agentDefinitionId: gated.agentDefinitionId, agentDefinitionVersion: gated.agentDefinitionVersion })
      .where(eq(schema.runs.taskInstanceId, taskInstanceId));
    return [
      {
        kind: "tool",
        costClass: "deterministic",
        capabilityId: gated.capabilityId,
        permission: gated.permission,
        proposedActionSnapshot: { action: "do-thing" },
        toolBindingId: gated.toolBindingId,
        estimatedCost: 1,
        execute: opts.execute ?? (async () => ({ done: true })),
      },
    ];
  };
}

function failingDeterministicBuilder(): InvocationSpecBuilder {
  return async () => [
    {
      kind: "deterministic",
      costClass: "deterministic",
      execute: async () => {
        throw new Error("step blew up");
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// 1. startWorkflowRun + first advanceWorkflowRun
// ---------------------------------------------------------------------------

describe("startWorkflowRun + advanceWorkflowRun (first step)", () => {
  it("creates a Task Instance with workflow_run_id set to this run — never null", async () => {
    await withRollback(async (tx) => {
      const { goal, stepOneDef, workflowDefinition } = await seedTwoStepWorkflowFixture(tx);

      const { workflowRunId } = await startWorkflowRun(tx, workflowDefinition.id, goal.id);
      expect(workflowRunId).toBeTruthy();

      const outcome = await advanceWorkflowRun(tx, workflowRunId, alwaysDeterministicBuilder());
      expect(outcome).toEqual({ status: "in_progress" });

      const taskInstances = await tx.query.taskInstances.findMany({ where: eq(schema.taskInstances.workflowRunId, workflowRunId) });
      expect(taskInstances).toHaveLength(1);
      expect(taskInstances[0]!.workflowRunId).toBe(workflowRunId);
      expect(taskInstances[0]!.workflowRunId).not.toBeNull();
      expect(taskInstances[0]!.taskDefinitionId).toBe(stepOneDef.id);
      expect(taskInstances[0]!.status).toBe("completed");
    });
  });

  it("startWorkflowRun does not create any Task Instance by itself", async () => {
    await withRollback(async (tx) => {
      const { goal, workflowDefinition } = await seedTwoStepWorkflowFixture(tx);
      const { workflowRunId } = await startWorkflowRun(tx, workflowDefinition.id, goal.id);

      const run = await tx.query.workflowRuns.findFirst({ where: eq(schema.workflowRuns.id, workflowRunId) });
      expect(run?.status).toBe("in_progress");
      expect(run?.variables).toEqual({ stepTaskInstanceIds: [null, null], stepRunIds: [null, null] });

      const taskInstances = await tx.query.taskInstances.findMany({ where: eq(schema.taskInstances.workflowRunId, workflowRunId) });
      expect(taskInstances).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Step gating: step 2 is never created before step 1 reaches "completed"
// ---------------------------------------------------------------------------

describe("advanceWorkflowRun step gating", () => {
  it("does not create step 2's Task Instance until step 1 reaches completed, and not within the same call that completes step 1", async () => {
    await withRollback(async (tx) => {
      const { goal, stepOneDef, stepTwoDef, workflowDefinition } = await seedTwoStepWorkflowFixture(tx);
      const gated = await seedApprovalGatedGrant(tx);
      const calls: string[] = [];
      const builder = makeApprovalGatedBuilder(tx, stepOneDef.id, gated, { calls });

      const { workflowRunId } = await startWorkflowRun(tx, workflowDefinition.id, goal.id);

      // Call 1: creates step 1's Task Instance; halts at awaiting_approval.
      const first = await advanceWorkflowRun(tx, workflowRunId, builder);
      expect(first).toEqual({ status: "in_progress" });
      let taskInstances = await tx.query.taskInstances.findMany({ where: eq(schema.taskInstances.workflowRunId, workflowRunId) });
      expect(taskInstances).toHaveLength(1);
      expect(taskInstances[0]!.status).toBe("awaiting_approval");

      // Call 2: still pending approval — no-op, still exactly 1 Task Instance.
      const second = await advanceWorkflowRun(tx, workflowRunId, builder);
      expect(second).toEqual({ status: "in_progress" });
      taskInstances = await tx.query.taskInstances.findMany({ where: eq(schema.taskInstances.workflowRunId, workflowRunId) });
      expect(taskInstances).toHaveLength(1);
      expect(taskInstances[0]!.status).toBe("awaiting_approval");

      // Approve it.
      const runForStep1 = await tx.query.runs.findFirst({ where: eq(schema.runs.taskInstanceId, taskInstances[0]!.id) });
      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, runForStep1!.id) });
      const approval = await tx.query.approvals.findFirst({ where: eq(schema.approvals.invocationId, invocation!.id) });
      await resolveApproval(tx, approval!.id, "approved", "reviewer");

      // Call 3: resumes step 1 to completion — but step 2 is STILL not created
      // within this same call (the brief's explicit requirement).
      const third = await advanceWorkflowRun(tx, workflowRunId, builder);
      expect(third).toEqual({ status: "in_progress" });
      taskInstances = await tx.query.taskInstances.findMany({ where: eq(schema.taskInstances.workflowRunId, workflowRunId) });
      expect(taskInstances).toHaveLength(1);
      expect(taskInstances[0]!.status).toBe("completed");

      // Call 4: NOW step 2 gets created (a fresh call, per algorithm step 9).
      const fourth = await advanceWorkflowRun(tx, workflowRunId, builder);
      expect(fourth).toEqual({ status: "completed" });
      taskInstances = await tx.query.taskInstances.findMany({ where: eq(schema.taskInstances.workflowRunId, workflowRunId) });
      expect(taskInstances).toHaveLength(2);
      const step2Instance = taskInstances.find((t) => t.taskDefinitionId === stepTwoDef.id);
      expect(step2Instance).toBeDefined();
      expect(step2Instance?.status).toBe("completed");

      const finalRun = await tx.query.workflowRuns.findFirst({ where: eq(schema.workflowRuns.id, workflowRunId) });
      expect(finalRun?.status).toBe("completed");
      expect(finalRun?.completedAt).not.toBeNull();

      // The assertion that actually pins the corrected step-4 semantics: the
      // builder was asked to (re)build step 1's specs on calls 1-3 (creation,
      // still-pending no-op, the approved resume, and once more after that
      // resume's tool dispatch was recorded) and ONLY switched to step 2 on
      // call 4. A regression to a literal "first null index" reading would have
      // asked for step 2 on call 2 already.
      expect(calls).toEqual([stepOneDef.id, stepOneDef.id, stepOneDef.id, stepOneDef.id, stepTwoDef.id]);
    });
  });
});

// ---------------------------------------------------------------------------
// 3a. Pause/resume scenario A — between steps
// ---------------------------------------------------------------------------

describe("pause/resume scenario A (between steps)", () => {
  it("pausing after step 1 completes prevents step 2 from being created until resumed", async () => {
    await withRollback(async (tx) => {
      const { goal, stepTwoDef, workflowDefinition } = await seedTwoStepWorkflowFixture(tx);
      const builder = alwaysDeterministicBuilder();
      const { workflowRunId } = await startWorkflowRun(tx, workflowDefinition.id, goal.id);

      const first = await advanceWorkflowRun(tx, workflowRunId, builder);
      expect(first).toEqual({ status: "in_progress" });
      let taskInstances = await tx.query.taskInstances.findMany({ where: eq(schema.taskInstances.workflowRunId, workflowRunId) });
      expect(taskInstances).toHaveLength(1);
      expect(taskInstances[0]!.status).toBe("completed");

      await pauseWorkflowRun(tx, workflowRunId);
      const pausedRun = await tx.query.workflowRuns.findFirst({ where: eq(schema.workflowRuns.id, workflowRunId) });
      expect(pausedRun?.status).toBe("paused");

      // advanceWorkflowRun on a paused run: immediate no-op, step 2 NOT created.
      const whilePaused = await advanceWorkflowRun(tx, workflowRunId, builder);
      expect(whilePaused).toEqual({ status: "paused" });
      taskInstances = await tx.query.taskInstances.findMany({ where: eq(schema.taskInstances.workflowRunId, workflowRunId) });
      expect(taskInstances).toHaveLength(1);

      await resumeWorkflowRun(tx, workflowRunId);
      const resumedRun = await tx.query.workflowRuns.findFirst({ where: eq(schema.workflowRuns.id, workflowRunId) });
      expect(resumedRun?.status).toBe("in_progress");

      const afterResume = await advanceWorkflowRun(tx, workflowRunId, builder);
      expect(afterResume).toEqual({ status: "completed" });
      taskInstances = await tx.query.taskInstances.findMany({ where: eq(schema.taskInstances.workflowRunId, workflowRunId) });
      expect(taskInstances).toHaveLength(2);
      expect(taskInstances.find((t) => t.taskDefinitionId === stepTwoDef.id)?.status).toBe("completed");
    });
  });
});

// ---------------------------------------------------------------------------
// 3b. Pause/resume scenario B — during a step's awaiting_approval
// ---------------------------------------------------------------------------

describe("pause/resume scenario B (during a step's awaiting_approval)", () => {
  it("pausing while step 1 is awaiting_approval halts advancement; resuming continues the resume exactly where it left off", async () => {
    await withRollback(async (tx) => {
      const { goal, stepOneDef, stepTwoDef, workflowDefinition } = await seedTwoStepWorkflowFixture(tx);
      const gated = await seedApprovalGatedGrant(tx);
      const builder = makeApprovalGatedBuilder(tx, stepOneDef.id, gated);
      const { workflowRunId } = await startWorkflowRun(tx, workflowDefinition.id, goal.id);

      const first = await advanceWorkflowRun(tx, workflowRunId, builder);
      expect(first).toEqual({ status: "in_progress" });
      let taskInstances = await tx.query.taskInstances.findMany({ where: eq(schema.taskInstances.workflowRunId, workflowRunId) });
      expect(taskInstances[0]!.status).toBe("awaiting_approval");

      // The Workflow Run itself is still "in_progress" here (only its current
      // step's Run is waiting) — pause is valid from "in_progress".
      await pauseWorkflowRun(tx, workflowRunId);

      const whilePaused = await advanceWorkflowRun(tx, workflowRunId, builder);
      expect(whilePaused).toEqual({ status: "paused" });
      // Untouched: still exactly 1 Task Instance, still awaiting_approval.
      taskInstances = await tx.query.taskInstances.findMany({ where: eq(schema.taskInstances.workflowRunId, workflowRunId) });
      expect(taskInstances).toHaveLength(1);
      expect(taskInstances[0]!.status).toBe("awaiting_approval");

      // Approvals are independent of workflow_run status — resolve while paused.
      const runForStep1 = await tx.query.runs.findFirst({ where: eq(schema.runs.taskInstanceId, taskInstances[0]!.id) });
      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, runForStep1!.id) });
      const approval = await tx.query.approvals.findFirst({ where: eq(schema.approvals.invocationId, invocation!.id) });
      await resolveApproval(tx, approval!.id, "approved", "reviewer");

      await resumeWorkflowRun(tx, workflowRunId);

      const afterResume = await advanceWorkflowRun(tx, workflowRunId, builder);
      expect(afterResume).toEqual({ status: "in_progress" });
      taskInstances = await tx.query.taskInstances.findMany({ where: eq(schema.taskInstances.workflowRunId, workflowRunId) });
      expect(taskInstances).toHaveLength(1);
      expect(taskInstances[0]!.status).toBe("completed");

      const finalAdvance = await advanceWorkflowRun(tx, workflowRunId, builder);
      expect(finalAdvance).toEqual({ status: "completed" });
      taskInstances = await tx.query.taskInstances.findMany({ where: eq(schema.taskInstances.workflowRunId, workflowRunId) });
      expect(taskInstances).toHaveLength(2);
      expect(taskInstances.find((t) => t.taskDefinitionId === stepTwoDef.id)?.status).toBe("completed");
    });
  });
});

// ---------------------------------------------------------------------------
// 4. A failed Task Instance halts advanceWorkflowRun at "failed"
// ---------------------------------------------------------------------------

describe("failure halts the Workflow Run", () => {
  it("a failed step 1 Task Instance marks the Workflow Run failed and step 2 is never created", async () => {
    await withRollback(async (tx) => {
      const { goal, workflowDefinition, stepTwoDef } = await seedTwoStepWorkflowFixture(tx);
      const { workflowRunId } = await startWorkflowRun(tx, workflowDefinition.id, goal.id);

      const outcome = await advanceWorkflowRun(tx, workflowRunId, failingDeterministicBuilder());
      expect(outcome).toEqual({ status: "failed" });

      const taskInstances = await tx.query.taskInstances.findMany({ where: eq(schema.taskInstances.workflowRunId, workflowRunId) });
      expect(taskInstances).toHaveLength(1);
      expect(taskInstances[0]!.status).toBe("failed");
      expect(taskInstances.some((t) => t.taskDefinitionId === stepTwoDef.id)).toBe(false);

      const run = await tx.query.workflowRuns.findFirst({ where: eq(schema.workflowRuns.id, workflowRunId) });
      expect(run?.status).toBe("failed");

      // Idempotent on repeated calls after terminal state — no further processing.
      const again = await advanceWorkflowRun(tx, workflowRunId, failingDeterministicBuilder());
      expect(again).toEqual({ status: "failed" });
      const taskInstancesAfter = await tx.query.taskInstances.findMany({ where: eq(schema.taskInstances.workflowRunId, workflowRunId) });
      expect(taskInstancesAfter).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Malformed graph_definition — fail closed
// ---------------------------------------------------------------------------

describe("malformed graph_definition handling (fail closed)", () => {
  it("startWorkflowRun throws when graph_definition is not a valid LinearGraphDefinition", async () => {
    await withRollback(async (tx) => {
      const { goal } = await seedProjectAndGoal(tx);
      const [badDefinition] = await tx
        .insert(schema.workflowDefinitions)
        .values({ name: "bad-" + randomUUID(), version: 1, graphDefinition: { kind: "branching", nodes: [] } })
        .returning();

      await expect(startWorkflowRun(tx, badDefinition!.id, goal.id)).rejects.toThrow(/LinearGraphDefinition/);
    });
  });

  it("startWorkflowRun throws when graph_definition has zero steps", async () => {
    await withRollback(async (tx) => {
      const { goal } = await seedProjectAndGoal(tx);
      const [badDefinition] = await tx
        .insert(schema.workflowDefinitions)
        .values({ name: "empty-" + randomUUID(), version: 1, graphDefinition: { kind: "linear", steps: [] } })
        .returning();

      await expect(startWorkflowRun(tx, badDefinition!.id, goal.id)).rejects.toThrow(/LinearGraphDefinition/);
    });
  });

  it("startWorkflowRun throws when the goal does not exist", async () => {
    await withRollback(async (tx) => {
      const stepDef = await seedTaskDefinition(tx);
      const workflowDefinition = await seedLinearWorkflow(tx, [
        { taskDefinitionId: stepDef.id, taskDefinitionVersion: stepDef.version },
      ]);
      await expect(startWorkflowRun(tx, workflowDefinition.id, randomUUID())).rejects.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// 6. pauseWorkflowRun / resumeWorkflowRun state validation
// ---------------------------------------------------------------------------

describe("pauseWorkflowRun / resumeWorkflowRun state validation", () => {
  it("pauseWorkflowRun throws when called on a run that is not in_progress", async () => {
    await withRollback(async (tx) => {
      const { goal, workflowDefinition } = await seedTwoStepWorkflowFixture(tx);
      const { workflowRunId } = await startWorkflowRun(tx, workflowDefinition.id, goal.id);
      await pauseWorkflowRun(tx, workflowRunId);
      await expect(pauseWorkflowRun(tx, workflowRunId)).rejects.toThrow(/is not "in_progress"/);
    });
  });

  it("resumeWorkflowRun throws when called on a run that is not paused", async () => {
    await withRollback(async (tx) => {
      const { goal, workflowDefinition } = await seedTwoStepWorkflowFixture(tx);
      const { workflowRunId } = await startWorkflowRun(tx, workflowDefinition.id, goal.id);
      await expect(resumeWorkflowRun(tx, workflowRunId)).rejects.toThrow(/is not "paused"/);
    });
  });
});

// ---------------------------------------------------------------------------
// 6a. Pause and resume are recorded as events (operator decision R-EV1)
// ---------------------------------------------------------------------------

describe("workflow_run_paused / workflow_run_resumed", () => {
  it("every pause and resume records its own event, correlated to the Workflow Run and Goal, by the operator", async () => {
    await withRollback(async (tx) => {
      const { goal, workflowDefinition } = await seedTwoStepWorkflowFixture(tx);
      const { workflowRunId } = await startWorkflowRun(tx, workflowDefinition.id, goal.id);

      for (let cycle = 0; cycle < 2; cycle++) {
        await pauseWorkflowRun(tx, workflowRunId);
        await resumeWorkflowRun(tx, workflowRunId);
      }
      // A refused pause or resume records nothing.
      await expect(resumeWorkflowRun(tx, workflowRunId)).rejects.toThrow(/is not "paused"/);

      const recorded = await tx.query.events.findMany({
        where: eq(schema.events.workflowRunId, workflowRunId),
        orderBy: (e, { asc }) => asc(e.globalSeq),
      });
      const pauses = recorded.filter((e) => e.eventType === "workflow_run_paused" || e.eventType === "workflow_run_resumed");
      expect(pauses.map((e) => e.eventType)).toEqual(["workflow_run_paused", "workflow_run_resumed", "workflow_run_paused", "workflow_run_resumed"]);
      for (const event of pauses) {
        expect(event).toMatchObject({ goalId: goal.id, workflowRunId, runId: null, actor: "human:operator", producer: "workflow-interpreter" });
      }
      expect(pauses[0]!.payload).toEqual({ from: "in_progress", to: "paused" });
      expect(pauses[1]!.payload).toEqual({ from: "paused", to: "in_progress" });
    });
  });
});

// ---------------------------------------------------------------------------
// 6b. A Goal's status is derived from its Workflow Runs (operator decision R-GOAL1)
// ---------------------------------------------------------------------------

describe("Goal status derived from its Workflow Runs", () => {
  it("derives active, completed and failed from the Workflow Runs' statuses", () => {
    expect(deriveGoalStatus([])).toBe("active");
    expect(deriveGoalStatus(["in_progress"])).toBe("active");
    expect(deriveGoalStatus(["paused"])).toBe("active");
    expect(deriveGoalStatus(["completed", "in_progress"])).toBe("active");
    expect(deriveGoalStatus(["completed"])).toBe("completed");
    expect(deriveGoalStatus(["completed", "completed"])).toBe("completed");
    expect(deriveGoalStatus(["failed"])).toBe("failed");
    expect(deriveGoalStatus(["completed", "failed"])).toBe("failed");
  });

  it("records goal_completed when its only Workflow Run completes, and stays active while paused", async () => {
    await withRollback(async (tx) => {
      const { goal, workflowDefinition } = await seedTwoStepWorkflowFixture(tx);
      const builder = alwaysDeterministicBuilder();
      const { workflowRunId } = await startWorkflowRun(tx, workflowDefinition.id, goal.id);

      await advanceWorkflowRun(tx, workflowRunId, builder);
      await pauseWorkflowRun(tx, workflowRunId);
      expect((await tx.query.goals.findFirst({ where: eq(schema.goals.id, goal.id) }))!.status).toBe("active");
      await resumeWorkflowRun(tx, workflowRunId);
      expect(await advanceWorkflowRun(tx, workflowRunId, builder)).toEqual({ status: "completed" });

      expect((await tx.query.goals.findFirst({ where: eq(schema.goals.id, goal.id) }))!.status).toBe("completed");
      const goalEvents = await tx.query.events.findMany({ where: eq(schema.events.goalId, goal.id) });
      const transitions = goalEvents.filter((e) => e.eventType.startsWith("goal_") && e.eventType !== "goal_created");
      expect(transitions.map((e) => e.eventType)).toEqual(["goal_completed"]);
      expect(transitions[0]!.payload).toEqual({ from: "active", to: "completed", workflowRunId });
      expect(transitions[0]!.workflowRunId).toBe(workflowRunId);

      // Re-advancing a finished Workflow Run records no further Goal event.
      await advanceWorkflowRun(tx, workflowRunId, builder);
      expect((await tx.query.events.findMany({ where: eq(schema.events.goalId, goal.id) })).length).toBe(goalEvents.length);
    });
  });

  it("records goal_failed, returns to active when a new Workflow Run starts, and fails again unless every run completed", async () => {
    await withRollback(async (tx) => {
      const { goal, workflowDefinition } = await seedTwoStepWorkflowFixture(tx);
      const first = await startWorkflowRun(tx, workflowDefinition.id, goal.id);
      expect(await advanceWorkflowRun(tx, first.workflowRunId, failingDeterministicBuilder())).toEqual({ status: "failed" });
      expect((await tx.query.goals.findFirst({ where: eq(schema.goals.id, goal.id) }))!.status).toBe("failed");

      const second = await startWorkflowRun(tx, workflowDefinition.id, goal.id);
      expect((await tx.query.goals.findFirst({ where: eq(schema.goals.id, goal.id) }))!.status).toBe("active");
      expect(await advanceWorkflowRun(tx, second.workflowRunId, alwaysDeterministicBuilder())).toEqual({ status: "in_progress" });
      expect(await advanceWorkflowRun(tx, second.workflowRunId, alwaysDeterministicBuilder())).toEqual({ status: "completed" });

      // One completed and one failed Workflow Run: the Goal is failed.
      expect((await tx.query.goals.findFirst({ where: eq(schema.goals.id, goal.id) }))!.status).toBe("failed");
      const transitions = (await tx.query.events.findMany({ where: eq(schema.events.goalId, goal.id), orderBy: (e, { asc }) => asc(e.globalSeq) }))
        .filter((e) => ["goal_completed", "goal_failed", "goal_transitioned"].includes(e.eventType))
        .map((e) => [e.eventType, (e.payload as { to: string }).to]);
      expect(transitions).toEqual([
        ["goal_failed", "failed"],
        ["goal_transitioned", "active"],
        ["goal_failed", "failed"],
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// 7. Structural test: interpreter.ts never imports createStandaloneTaskInstance
// ---------------------------------------------------------------------------

describe("structural separation from the standalone Task Instance path", () => {
  it("src/workflow/interpreter.ts never imports createStandaloneTaskInstance", () => {
    const interpreterPath = fileURLToPath(new URL("../../src/workflow/interpreter.ts", import.meta.url));
    const source = readFileSync(interpreterPath, "utf8");
    expect(source).not.toMatch(/createStandaloneTaskInstance/);
  });

  it("src/workflow/interpreter.ts DOES import createWorkflowTaskInstance (sanity check on the positive half)", () => {
    const interpreterPath = fileURLToPath(new URL("../../src/workflow/interpreter.ts", import.meta.url));
    const source = readFileSync(interpreterPath, "utf8");
    expect(source).toMatch(/createWorkflowTaskInstance/);
  });
});
