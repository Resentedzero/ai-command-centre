/**
 * Unit 10 integration test — Fastify `app.inject()` against the real
 * `TEST_DATABASE_URL`-backed test database (Ruling 5: `buildServer({db:
 * testDb})`), proving every required route behavior end to end.
 *
 * Provider mocking (Ruling 4 / same convention as Units 8/9's own
 * integration tests): only `callAnthropicModel`/`callOpenAiModel` are
 * mocked — every route handler, `startWorkflowRun`/`advanceWorkflowRun`,
 * `resolveApproval`, and the whole governance chain run for real against the
 * real test database.
 *
 * Full-flow design note (fix round 1): `POST /goals` now drives the
 * Workflow Run through `advanceWorkflowRunUntilBlocked`
 * (`../../src/workflow/advanceWorkflowRunUntilBlocked.ts`), which loops
 * Unit 7's `advanceWorkflowRun` up to the run's own step count rather than
 * calling it exactly once. For this MVP's 2-step seeded workflow, a SINGLE
 * `POST /goals` call therefore drives all the way from nothing through Task
 * A's completion AND Task B's creation, halting only at Task B's genuine
 * `awaiting_approval` gate (its `ALWAYS_APPROVE` Grant) — no
 * pause/resume workaround is needed to reach a real pending Approval
 * through the HTTP API. (An earlier version of this ruling called
 * `advanceWorkflowRun` exactly once per route, which left the run
 * permanently stuck after Task A with no route able to progress it further
 * — see task-10-report.md's "Concerns" / "Fix round 1" sections for the
 * full history. `POST /workflow-runs/:id/pause` + `/resume` are still
 * tested below as their own required round-trip, no longer as a setup
 * workaround.)
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
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

import { callAnthropicModel } from "../../src/router/providers/anthropic.js";
import { buildServer } from "../../src/api/server.js";

let app: FastifyInstance;
let seedRefs: SeededWorkflowRefs;
const PUBLISHED_FILES: string[] = [];

beforeAll(async () => {
  await resetTestSchema();
  await testDb.transaction(async (tx) => {
    await seedPublishWorkflow(tx);
  });
  // Fetched once, by well-known name (same lookup the routes themselves
  // use) — used below to identify Task A vs Task B by their actual
  // taskDefinitionId, NOT by createdAt ordering: both Task Instances are
  // now created within the same request/transaction (fix round 1's bounded
  // loop), close enough in time that a `createdAt` tie is a real risk.
  const refs = await testDb.transaction((tx) => findSeededPublishWorkflow(tx));
  if (!refs) throw new Error("beforeAll: seed did not produce a findable Research-and-Publish workflow");
  seedRefs = refs;
  app = buildServer({ db: testDb });
  await app.ready();
}, 30000);

afterAll(async () => {
  await app.close();
  await closeTestDb();
});

afterEach(() => {
  vi.clearAllMocks();
  for (const filePath of PUBLISHED_FILES.splice(0)) {
    try {
      rmSync(filePath, { force: true });
    } catch {
      // best-effort cleanup only
    }
  }
});

function mockLlmOnce(reportText: string): void {
  vi.mocked(callAnthropicModel).mockResolvedValueOnce({
    result: { report: reportText },
    usage: { tokensIn: 100, tokensOut: 50, costAmount: 0.001 },
  });
}

type CreatedGoal = { goalId: string; workflowRunId: string; status: string };

async function createGoal(title: string, reportText: string): Promise<CreatedGoal> {
  mockLlmOnce(reportText);
  const res = await app.inject({ method: "POST", url: "/goals", payload: { title } });
  expect(res.statusCode).toBe(201);
  return res.json() as CreatedGoal;
}

type TaskInstanceRow = typeof schema.taskInstances.$inferSelect;

/**
 * Identifies Task A ("Research-Report") vs Task B ("Review-and-Publish") by
 * their actual `taskDefinitionId` (via `seedRefs`), NOT by `createdAt`
 * ordering — fix round 1's bounded advancement loop now creates both Task
 * Instances within the same request/transaction, close enough in time that
 * a `createdAt` tie is a real, observed risk (two inserts within the same
 * millisecond are indistinguishable by timestamp alone).
 */
async function findTaskInstances(workflowRunId: string): Promise<{ taskA: TaskInstanceRow; taskB: TaskInstanceRow }> {
  const taskInstances = await testDb.query.taskInstances.findMany({
    where: eq(schema.taskInstances.workflowRunId, workflowRunId),
  });
  const taskA = taskInstances.find((t) => t.taskDefinitionId === seedRefs.taskDefinitionId);
  const taskB = taskInstances.find((t) => t.taskDefinitionId === seedRefs.reviewAndPublishTaskDefinitionId);
  if (!taskA || !taskB) {
    throw new Error(`findTaskInstances: expected both Task A and Task B for workflow_run "${workflowRunId}", found ${taskInstances.length} instance(s)`);
  }
  return { taskA, taskB };
}

/** See module header (fix round 1): a single POST /goals now drives the run all the way to Task B's awaiting_approval gate on its own. */
async function driveToTaskBAwaitingApproval(title: string, reportText: string): Promise<CreatedGoal> {
  const created = await createGoal(title, reportText);
  expect(created.status).toBe("in_progress");

  const { taskB } = await findTaskInstances(created.workflowRunId);
  expect(taskB.status).toBe("awaiting_approval");

  return created;
}

async function findPendingApprovalId(workflowRunId: string): Promise<string> {
  const taskInstances = await testDb.query.taskInstances.findMany({
    where: eq(schema.taskInstances.workflowRunId, workflowRunId),
  });
  for (const taskInstance of taskInstances) {
    const run = await testDb.query.runs.findFirst({ where: eq(schema.runs.taskInstanceId, taskInstance.id) });
    if (!run) continue;
    const invocation = await testDb.query.invocations.findFirst({
      where: eq(schema.invocations.runId, run.id),
    });
    if (!invocation) continue;
    const approval = await testDb.query.approvals.findFirst({ where: eq(schema.approvals.invocationId, invocation.id) });
    if (approval?.status === "pending") return approval.id;
  }
  throw new Error(`findPendingApprovalId: no pending approval found for workflow_run "${workflowRunId}"`);
}

function publishedPathFor(taskInstanceId: string): string {
  return path.resolve(process.env.ARTIFACT_ROOT!, "published", "reports", `${taskInstanceId}.json`);
}

// ---------------------------------------------------------------------------
// POST /goals
// ---------------------------------------------------------------------------

describe("POST /goals", () => {
  it("creates a Goal and starts a Workflow Run, driving it (via the bounded advancement loop, fix round 1) through Task A and up to Task B's approval gate", async () => {
    const created = await createGoal("First MVP Goal", "first goal report content");

    expect(created.goalId).toBeDefined();
    expect(created.workflowRunId).toBeDefined();
    // "in_progress" at the Workflow Run level even though Task B's own Run
    // is `awaiting_approval` — see interpreter.ts's documented mapping.
    expect(created.status).toBe("in_progress");

    const goalRow = await testDb.query.goals.findFirst({ where: eq(schema.goals.id, created.goalId) });
    expect(goalRow?.title).toBe("First MVP Goal");

    const workflowRunRow = await testDb.query.workflowRuns.findFirst({ where: eq(schema.workflowRuns.id, created.workflowRunId) });
    expect(workflowRunRow?.status).toBe("in_progress");

    // The bounded loop drove BOTH steps within this one request: Task A
    // completed, and Task B was created and halted at awaiting_approval.
    const { taskA, taskB } = await findTaskInstances(created.workflowRunId);
    expect(taskA.status).toBe("completed");
    expect(taskB.status).toBe("awaiting_approval");

    expect(callAnthropicModel).toHaveBeenCalledTimes(1);
  });

  it("rejects a request with no title", async () => {
    const res = await app.inject({ method: "POST", url: "/goals", payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /workflow-runs/:id/pause + /resume (round-trip)
// ---------------------------------------------------------------------------

describe("POST /workflow-runs/:id/pause and /resume", () => {
  it("round-trips against Unit 7: pause halts the run, resume flips it back to in_progress without disturbing the still-pending Approval", async () => {
    // Already at Task B's awaiting_approval gate after one POST /goals
    // (fix round 1) — pause/resume is exercised here as its own genuine
    // round-trip, not as a setup mechanism.
    const created = await driveToTaskBAwaitingApproval("Pause-resume Goal", "pause resume report");
    const approvalIdBefore = await findPendingApprovalId(created.workflowRunId);

    const pauseRes = await app.inject({ method: "POST", url: `/workflow-runs/${created.workflowRunId}/pause` });
    expect(pauseRes.statusCode).toBe(200);
    expect(pauseRes.json()).toEqual({ workflowRunId: created.workflowRunId, status: "paused" });

    const pausedRow = await testDb.query.workflowRuns.findFirst({ where: eq(schema.workflowRuns.id, created.workflowRunId) });
    expect(pausedRow?.status).toBe("paused");

    const resumeRes = await app.inject({ method: "POST", url: `/workflow-runs/${created.workflowRunId}/resume` });
    expect(resumeRes.statusCode).toBe(200);
    // The bounded advancement loop's own no-op branch (Task B's Approval is
    // still pending) — the run comes back to "in_progress" without erroring
    // and without disturbing the still-pending Approval.
    expect(resumeRes.json()).toEqual({ workflowRunId: created.workflowRunId, status: "in_progress" });

    const resumedRow = await testDb.query.workflowRuns.findFirst({ where: eq(schema.workflowRuns.id, created.workflowRunId) });
    expect(resumedRow?.status).toBe("in_progress");

    const approvalIdAfter = await findPendingApprovalId(created.workflowRunId);
    expect(approvalIdAfter).toBe(approvalIdBefore); // unchanged — still the same pending Approval
  });

  it("pausing an already-paused run fails (fail-closed, Unit 7's own contract) — proves this route does not silently swallow interpreter errors", async () => {
    const created = await createGoal("Double-pause Goal", "double pause report");
    const first = await app.inject({ method: "POST", url: `/workflow-runs/${created.workflowRunId}/pause` });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({ method: "POST", url: `/workflow-runs/${created.workflowRunId}/pause` });
    expect(second.statusCode).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// GET /approvals + POST /approvals/:id/approve + /reject
// ---------------------------------------------------------------------------

describe("GET /approvals", () => {
  it("returns pending approvals with full snapshots", async () => {
    const created = await driveToTaskBAwaitingApproval("Approvals-list Goal", "approvals list report");
    const approvalId = await findPendingApprovalId(created.workflowRunId);

    const res = await app.inject({ method: "GET", url: "/approvals" });
    expect(res.statusCode).toBe(200);
    const { approvals } = res.json() as { approvals: Array<Record<string, unknown>> };

    const found = approvals.find((a) => a.id === approvalId);
    expect(found).toBeDefined();
    expect(found?.status).toBe("pending");
    expect(found?.proposedActionSnapshot).toMatchObject({
      artifactId: expect.any(String),
      destinationRelativePath: expect.any(String),
    });
    expect(found?.riskTier).toBeDefined();
  });
});

describe("POST /approvals/:id/approve", () => {
  it("calls resolveApproval (Unit 3) and the gated Invocation proceeds: workflow completes and the report is actually published", async () => {
    const created = await driveToTaskBAwaitingApproval("Approve-flow Goal", "approve flow report content");
    const approvalId = await findPendingApprovalId(created.workflowRunId);

    const res = await app.inject({ method: "POST", url: `/approvals/${approvalId}/approve`, payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({
      approvalId,
      approvalStatus: "approved",
      workflowRunId: created.workflowRunId,
      workflowStatus: "completed",
    });

    const approvalRow = await testDb.query.approvals.findFirst({ where: eq(schema.approvals.id, approvalId) });
    expect(approvalRow?.status).toBe("approved");

    const workflowRunRow = await testDb.query.workflowRuns.findFirst({ where: eq(schema.workflowRuns.id, created.workflowRunId) });
    expect(workflowRunRow?.status).toBe("completed");

    const { taskB } = await findTaskInstances(created.workflowRunId);
    expect(taskB.status).toBe("completed");

    const publishedPath = publishedPathFor(taskB.id);
    PUBLISHED_FILES.push(publishedPath);
    expect(existsSync(publishedPath)).toBe(true);
  });
});

describe("POST /approvals/:id/reject", () => {
  it("calls resolveApproval (Unit 3) and the gated Invocation fails: workflow fails, nothing is published", async () => {
    const created = await driveToTaskBAwaitingApproval("Reject-flow Goal", "reject flow report content");
    const approvalId = await findPendingApprovalId(created.workflowRunId);

    const res = await app.inject({ method: "POST", url: `/approvals/${approvalId}/reject`, payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({
      approvalId,
      approvalStatus: "rejected",
      workflowRunId: created.workflowRunId,
      workflowStatus: "failed",
    });

    const workflowRunRow = await testDb.query.workflowRuns.findFirst({ where: eq(schema.workflowRuns.id, created.workflowRunId) });
    expect(workflowRunRow?.status).toBe("failed");

    const { taskB } = await findTaskInstances(created.workflowRunId);
    expect(taskB.status).toBe("failed");

    expect(existsSync(publishedPathFor(taskB.id))).toBe(false);
  });

  it("returns 404 for an unknown approval id", async () => {
    const res = await app.inject({ method: "POST", url: "/approvals/00000000-0000-0000-0000-000000000000/reject", payload: {} });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Structural: no inline policy/budget/workflow logic in route handlers
// ---------------------------------------------------------------------------

describe("Structural: route handlers are thin pass-throughs", () => {
  const routeFiles = ["goals.ts", "approvals.ts", "workflowRuns.ts", "events.ts"].map((f) =>
    fileURLToPath(new URL(`../../src/api/routes/${f}`, import.meta.url))
  );

  it("never imports Unit 2-6's internal governance/execution modules directly (only their already-built entry points)", () => {
    const forbiddenImportFragments = [
      "governance/policy.js",
      "governance/budget.js",
      "governance/risk.js",
      "execution/executor.js",
      "execution/invocationLifecycle.js",
      "execution/taskInstance.js",
      "context/compiler.js",
      "router/modelRouter.js",
    ];
    for (const file of routeFiles) {
      const source = readFileSync(file, "utf8");
      for (const fragment of forbiddenImportFragments) {
        expect(source, `${file} must not reference "${fragment}"`).not.toContain(fragment);
      }
    }
  });

  it("never calls raw policy/budget/execution primitives directly (evaluatePolicy, reserveBudget, executeRun, compileContext, authorizeRoute, callModel)", () => {
    const disallowedCalls = ["evaluatePolicy(", "reserveBudget(", "executeRun(", "compileContext(", "authorizeRoute(", "callModel("];
    for (const file of routeFiles) {
      const source = readFileSync(file, "utf8");
      for (const call of disallowedCalls) {
        expect(source, `${file} must not call ${call}`).not.toContain(call);
      }
    }
  });

  it("each mutating route calls only Unit 3/7's own already-built orchestration functions (advancement via the thin, bounded advanceWorkflowRunUntilBlocked wrapper, fix round 1)", () => {
    const allowedOrchestrationCalls = [
      "startWorkflowRun(",
      "advanceWorkflowRunUntilBlocked(",
      "pauseWorkflowRun(",
      "resumeWorkflowRun(",
      "resolveApproval(",
    ];
    const goalsSource = readFileSync(routeFiles[0]!, "utf8");
    expect(allowedOrchestrationCalls.some((c) => goalsSource.includes(c))).toBe(true);
    expect(goalsSource).toContain("startWorkflowRun(");
    expect(goalsSource).toContain("advanceWorkflowRunUntilBlocked(");

    const approvalsSource = readFileSync(routeFiles[1]!, "utf8");
    expect(approvalsSource).toContain("resolveApproval(");
    expect(approvalsSource).toContain("advanceWorkflowRunUntilBlocked(");

    const workflowRunsSource = readFileSync(routeFiles[2]!, "utf8");
    expect(workflowRunsSource).toContain("pauseWorkflowRun(");
    expect(workflowRunsSource).toContain("resumeWorkflowRun(");
    expect(workflowRunsSource).toContain("advanceWorkflowRunUntilBlocked(");
  });
});
