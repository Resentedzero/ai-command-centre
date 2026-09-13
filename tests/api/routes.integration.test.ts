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
import { closeTestDb, resetTestSchema, testDb, testPool } from "../testDb.js";
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
import { V1_RESOLUTION_ACTOR } from "../../src/api/routes/approvals.js";

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

type EventRow = typeof schema.events.$inferSelect;

/** Every Event correlated to `invocationId`, which is where both resolution events and the gated Invocation's own lifecycle events land. */
async function eventsForInvocation(invocationId: string): Promise<EventRow[]> {
  return testDb.query.events.findMany({ where: eq(schema.events.invocationId, invocationId) });
}

function resolutionEvents(rows: EventRow[]): EventRow[] {
  return rows.filter((e) => e.eventType === "approval_granted" || e.eventType === "approval_rejected");
}

/**
 * Polls `pg_stat_activity` until `expected` backends are simultaneously
 * BLOCKED on a lock while running a statement against `approvals`, and returns
 * the highest count actually observed.
 *
 * Deliberately returns the observed count instead of throwing on timeout: the
 * caller must always be able to release its gate transaction in a `finally`
 * (otherwise a failed poll would leave a row locked and poison `testPool` for
 * every later test in this file), and must then assert the returned count
 * itself. A poll that "timed out but carried on" would silently degrade the
 * race test below into two SEQUENTIAL resolutions — which pass all of its
 * other assertions while proving nothing about concurrency. The count is the
 * evidence; asserting it is not optional.
 *
 * Why `wait_event_type = 'Lock'` catches BOTH waiters: the first blocked
 * UPDATE waits on the gate transaction's `transactionid`; the second queues
 * behind the first on the row's `tuple` lock. Those are different
 * `wait_event`s but the same `wait_event_type`.
 */
async function countBackendsBlockedOnApprovalsLock(expected: number, timeoutMs = 10_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let observed = 0;
  while (Date.now() < deadline) {
    const { rows } = await testPool.query<{ blocked: string }>(
      `SELECT count(*)::text AS blocked
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query ILIKE '%approvals%'`
    );
    observed = Math.max(observed, Number(rows[0]!.blocked));
    if (observed >= expected) return observed;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return observed;
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

  it("returns 409 (not a second resolution) when rejecting an approval already resolved by a prior approve (final-review Minor 1)", async () => {
    const created = await driveToTaskBAwaitingApproval("Double-resolve Goal", "double resolve report content");
    const approvalId = await findPendingApprovalId(created.workflowRunId);

    const first = await app.inject({ method: "POST", url: `/approvals/${approvalId}/approve`, payload: {} });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({ method: "POST", url: `/approvals/${approvalId}/reject`, payload: {} });
    expect(second.statusCode).toBe(409);

    // The approval must still read as "approved" — the rejected 409 call must not have overwritten it.
    const approvalRow = await testDb.query.approvals.findFirst({ where: eq(schema.approvals.id, approvalId) });
    expect(approvalRow?.status).toBe("approved");

    // Exactly one resolution event exists for this approval — no approval_rejected was ever emitted.
    const events = await eventsForInvocation(approvalRow!.invocationId);
    expect(resolutionEvents(events).map((e) => e.eventType)).toEqual(["approval_granted"]);
  });
});

// ---------------------------------------------------------------------------
// Independent-review Important 1 — concurrent approve/reject of ONE Approval
// ---------------------------------------------------------------------------

describe("POST /approvals/:id/approve + /reject concurrently (independent-review Important 1)", () => {
  /**
   * Reproduces the exact race the review found, DETERMINISTICALLY rather than
   * probabilistically.
   *
   * Why plain `Promise.all([inject(approve), inject(reject)])` is NOT enough
   * on its own: both requests do several real async DB round-trips
   * (`lookupApprovalWorkflowRunId`, then `captureRunSequenceWatermarks`)
   * BEFORE `db.transaction()` even opens, and the winner's transaction then
   * does a large amount of work (reauthorize, budget, the real file publish)
   * before committing. Whether the loser's UPDATE is issued while the winner
   * still holds the row lock is therefore a matter of event-loop and I/O
   * timing — usually yes, but nothing guarantees it. A test that merely
   * "usually" overlaps is exactly the false sense of safety this fix is meant
   * to remove: if the two happen to serialize, every assertion below still
   * passes while proving nothing.
   *
   * The technique that makes it deterministic: a THIRD connection (`gate`)
   * opens its own transaction and takes the Approval row's lock with
   * `SELECT ... FOR UPDATE` BEFORE either request is fired. Both requests then
   * run for real, and both necessarily park on that row lock inside their own
   * `resolveApproval` UPDATE — which is the FIRST statement each transaction
   * issues, so neither can slip past it. We then POLL `pg_stat_activity` until
   * we have positively OBSERVED two backends simultaneously blocked on a lock
   * while running a statement against `approvals`, and assert that observation
   * (`expect(blocked).toBe(2)`) — so the interleaving is proven, not hoped
   * for. Only then is the gate rolled back (it wrote nothing; the row is still
   * `pending`), releasing both waiters into the genuine race at the row lock.
   *
   * From there Postgres itself decides the outcome: whichever waiter acquires
   * the lock first matches `status = 'pending'`, updates, and commits; the
   * other re-evaluates its WHERE clause against the now-committed row version,
   * matches ZERO rows, and its whole transaction is rolled back. Which of the
   * two wins is genuinely nondeterministic (it is Postgres's lock-queue
   * order), so the assertions below check INTERNAL CONSISTENCY — one 200, one
   * 409, and a final state plus event log that agree with whichever the
   * database actually chose — rather than a hardcoded winner.
   */
  it("resolves exactly once: one 200, one 409 'already resolved', one resolution event, and no contradictory event", async () => {
    const created = await driveToTaskBAwaitingApproval("Concurrent-resolve Goal", "concurrent resolve report content");
    const approvalId = await findPendingApprovalId(created.workflowRunId);
    const { taskB } = await findTaskInstances(created.workflowRunId);
    // Registered unconditionally: the approve side publishes a real file if it
    // wins, and `afterEach`'s cleanup is a no-op if it did not.
    PUBLISHED_FILES.push(publishedPathFor(taskB.id));

    const gate = await testPool.connect();
    let inFlight: Promise<[Awaited<ReturnType<typeof app.inject>>, Awaited<ReturnType<typeof app.inject>>]> | null = null;
    let blocked = -1;
    try {
      await gate.query("BEGIN");
      await gate.query("SELECT id FROM approvals WHERE id = $1 FOR UPDATE", [approvalId]);

      inFlight = Promise.all([
        app.inject({ method: "POST", url: `/approvals/${approvalId}/approve`, payload: {} }),
        app.inject({ method: "POST", url: `/approvals/${approvalId}/reject`, payload: {} }),
      ]);

      blocked = await countBackendsBlockedOnApprovalsLock(2);
    } finally {
      // Always released, even if the poll above never saw both waiters —
      // otherwise this row stays locked and every later test in this file
      // starves. The failure is reported by the assertion, not by a hang.
      await gate.query("ROLLBACK").catch(() => undefined);
      gate.release();
    }

    const [approveRes, rejectRes] = await inFlight!;

    // THE deterministic checkpoint: both requests were simultaneously inside
    // their own conditional UPDATE, queued on this Approval's row lock. Without
    // this assertion the rest of the test would also pass for two sequential
    // resolutions.
    expect(blocked).toBe(2);

    // Exactly one winner. Which one is Postgres's choice, not ours.
    expect([approveRes.statusCode, rejectRes.statusCode].sort()).toEqual([200, 409]);

    const approveWon = approveRes.statusCode === 200;
    const winningRes = approveWon ? approveRes : rejectRes;
    const losingRes = approveWon ? rejectRes : approveRes;
    const winningStatus = approveWon ? "approved" : "rejected";

    // The loser changed nothing and is told so clearly, in the same
    // `{ error: string }` shape the existing 404/409 contract uses.
    const losingBody = losingRes.json() as { error?: string };
    expect(Object.keys(losingBody)).toEqual(["error"]);
    expect(losingBody.error).toContain("already resolved");
    expect(losingBody.error).toContain(approvalId);
    expect(losingBody.error).toContain(winningStatus);

    // The winner's own response, in the unchanged response contract.
    expect(winningRes.json()).toMatchObject({
      approvalId,
      approvalStatus: winningStatus,
      workflowRunId: created.workflowRunId,
      workflowStatus: approveWon ? "completed" : "failed",
    });

    // Final persisted state agrees with whichever decision actually won.
    const approvalRow = await testDb.query.approvals.findFirst({ where: eq(schema.approvals.id, approvalId) });
    expect(approvalRow?.status).toBe(winningStatus);

    // The immutable audit log carries EXACTLY ONE resolution fact for this
    // Approval — never both, never zero, and never the contradictory one.
    const events = await eventsForInvocation(approvalRow!.invocationId);
    const resolutions = resolutionEvents(events);
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]!.eventType).toBe(approveWon ? "approval_granted" : "approval_rejected");
    expect(events.filter((e) => e.eventType === (approveWon ? "approval_rejected" : "approval_granted"))).toHaveLength(0);

    // The pre-existing double-execution guard (`src/execution/executor.ts`'s
    // terminal-`runs.status` short-circuit and its completed-invocation
    // `continue`) is untouched by this fix: the gated Invocation reached
    // exactly ONE terminal outcome despite two resolution attempts.
    const terminal = events.filter((e) => e.eventType === "invocation_completed" || e.eventType === "invocation_failed");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.eventType).toBe(approveWon ? "invocation_completed" : "invocation_failed");

    // And the real side effect happened exactly as many times as it should
    // have: once if approve won, never if reject won.
    expect(existsSync(publishedPathFor(taskB.id))).toBe(approveWon);
  });

  it("a third resolution attempt after the race is still refused — repeated attempts never re-run the gated action", async () => {
    const created = await driveToTaskBAwaitingApproval("Post-race-retry Goal", "post race retry report content");
    const approvalId = await findPendingApprovalId(created.workflowRunId);
    const { taskB } = await findTaskInstances(created.workflowRunId);
    PUBLISHED_FILES.push(publishedPathFor(taskB.id));

    const first = await app.inject({ method: "POST", url: `/approvals/${approvalId}/approve`, payload: {} });
    expect(first.statusCode).toBe(200);

    for (const decision of ["approve", "reject", "approve"]) {
      const repeat = await app.inject({ method: "POST", url: `/approvals/${approvalId}/${decision}`, payload: {} });
      expect(repeat.statusCode).toBe(409);
    }

    const approvalRow = await testDb.query.approvals.findFirst({ where: eq(schema.approvals.id, approvalId) });
    expect(approvalRow?.status).toBe("approved");

    const events = await eventsForInvocation(approvalRow!.invocationId);
    expect(resolutionEvents(events).map((e) => e.eventType)).toEqual(["approval_granted"]);
    // The gated Invocation still completed exactly once — the executor's
    // completed-invocation re-entry guard is unaffected by this fix.
    expect(events.filter((e) => e.eventType === "invocation_completed")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Independent-review Important 2 — the audit actor is server-controlled
// ---------------------------------------------------------------------------

describe("POST /approvals/:id/approve|reject records a SERVER-controlled actor (independent-review Important 2)", () => {
  it('ignores a request body\'s "resolvedBy": {"resolvedBy":"system"} cannot manufacture actor "system" on approval_granted', async () => {
    const created = await driveToTaskBAwaitingApproval("Actor-spoof-approve Goal", "actor spoof approve report content");
    const approvalId = await findPendingApprovalId(created.workflowRunId);
    const { taskB } = await findTaskInstances(created.workflowRunId);
    PUBLISHED_FILES.push(publishedPathFor(taskB.id));

    const res = await app.inject({
      method: "POST",
      url: `/approvals/${approvalId}/approve`,
      payload: { resolvedBy: "system" },
    });

    // The response contract is unchanged by this fix.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      approvalId,
      approvalStatus: "approved",
      workflowRunId: created.workflowRunId,
      workflowStatus: "completed",
    });

    const approvalRow = await testDb.query.approvals.findFirst({ where: eq(schema.approvals.id, approvalId) });
    expect(approvalRow?.resolvedBy).toBe(V1_RESOLUTION_ACTOR);

    const granted = (await eventsForInvocation(approvalRow!.invocationId)).filter((e) => e.eventType === "approval_granted");
    expect(granted).toHaveLength(1);
    expect(granted[0]!.actor).toBe(V1_RESOLUTION_ACTOR);
    expect(granted[0]!.actor).not.toBe("system");
    expect(granted[0]!.payload).toEqual({
      approvalId,
      riskTier: expect.any(String),
      resolvedBy: V1_RESOLUTION_ACTOR,
    });
    // The constant really is a human identity per the Phase 8.1 vocabulary —
    // not the system falsely attributing a human's decision to itself.
    expect(V1_RESOLUTION_ACTOR).toMatch(/^human:/);
  });

  it("approval_rejected's actor is equally server-controlled, and NO request-body field can reach the immutable event envelope or payload", async () => {
    const created = await driveToTaskBAwaitingApproval("Actor-spoof-reject Goal", "actor spoof reject report content");
    const approvalId = await findPendingApprovalId(created.workflowRunId);

    const res = await app.inject({
      method: "POST",
      url: `/approvals/${approvalId}/reject`,
      payload: {
        // Every field an attacker might hope leaks into the permanent record
        // (Phase 8.7): the recorded actor, the envelope's producer, the typed
        // payload, and the mirrored `resolvedBy`.
        resolvedBy: "system",
        actor: "system",
        producer: "executor",
        payload: { approvalId: "forged", riskTier: "low", resolvedBy: "system" },
        riskTier: "low",
        status: "approved",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      approvalId,
      approvalStatus: "rejected",
      workflowRunId: created.workflowRunId,
      workflowStatus: "failed",
    });

    const approvalRow = await testDb.query.approvals.findFirst({ where: eq(schema.approvals.id, approvalId) });
    expect(approvalRow?.status).toBe("rejected");
    expect(approvalRow?.resolvedBy).toBe(V1_RESOLUTION_ACTOR);

    const rejected = (await eventsForInvocation(approvalRow!.invocationId)).filter((e) => e.eventType === "approval_rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.actor).toBe(V1_RESOLUTION_ACTOR);
    expect(rejected[0]!.actor).not.toBe("system");
    expect(rejected[0]!.producer).toBe("governance");
    expect(rejected[0]!.payload).toEqual({
      approvalId,
      riskTier: approvalRow!.riskTier,
      resolvedBy: V1_RESOLUTION_ACTOR,
    });
  });

  it("the route source never reads a resolvedBy/actor value out of the request at all (structural)", () => {
    const source = readFileSync(fileURLToPath(new URL("../../src/api/routes/approvals.ts", import.meta.url)), "utf8");
    // Comments stripped first: that file's own header deliberately QUOTES the
    // removed `request.body?.resolvedBy` expression to document what was fixed
    // and why, which must not be mistaken for the code still doing it.
    const code = source
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        return !(trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*"));
      })
      .join("\n");

    // Not a sanitization check — a check that no client-supplied string is
    // read in the first place. `request.body` must not be consulted for the
    // resolution identity in any form.
    expect(code).not.toMatch(/request\.body/);
    expect(code).toContain("V1_RESOLUTION_ACTOR");
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
