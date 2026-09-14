/**
 * `GET /workflow-runs` / `GET /workflow-runs/:id` (read model, 2026-09-14) and
 * `POST /workflow-runs/:id/pause` / `/resume` / `/advance`.
 *
 * The two GETs back spec §15.1 screen 3 (Workflow/Task view): a Workflow Run's
 * steps in graph order, each step's Task Instance and Run, the Run's Invocation
 * sequence with failure reasons, and its budget counters per resource unit.
 * Before these, failure reasons, run outcomes and spend were visible only by
 * reading the raw event feed. Read-only; amounts are returned as the exact
 * numeric strings Postgres stores, never converted, and units are never summed.
 *
 * Ruling 3 (see `../server.ts`'s header): pause NEVER drives advancement —
 * pausing should never itself cause more work to happen. Resume re-drives the
 * run as far as automatically possible via the driver
 * (`../../workflow/advanceWorkflowRunUntilBlocked.ts`).
 *
 * `advance` (2026-09-14) re-drives an `in_progress` Workflow Run WITHOUT any
 * state change of its own. It exists because a request now commits in several
 * transactions (Phase 9): if one fails part-way — or its process dies — a
 * Workflow Run can be left `in_progress` with nothing driving it (an Approval
 * committed but not acted on; a dispatch recorded but the Run not continued).
 * Approve would answer "already resolved" and resume only accepts `paused`, so
 * without this the only repair was pause-then-resume or a restart. It runs the
 * ordinary driver, so every governance check runs again; for a Run genuinely
 * waiting on a human it is a cheap no-op.
 *
 * Errors: a non-UUID id is 400; an unknown Workflow Run is 404; a Workflow Run
 * in the wrong state for the operation is 409.
 */
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  agentDefinitions,
  budgetCounters,
  events,
  goals,
  invocations,
  runs,
  taskDefinitions,
  taskInstances,
  workflowDefinitions,
  workflowRuns,
} from "../../db/schema.js";
import { isLinearGraphDefinition } from "../../workflow/graphTypes.js";
import type { ApiDeps } from "../server.js";
import {
  pauseWorkflowRun,
  resumeWorkflowRun,
  WorkflowRunNotFoundError,
  WorkflowRunStateError,
} from "../../workflow/interpreter.js";
import { advanceWorkflowRunUntilBlocked } from "../../workflow/advanceWorkflowRunUntilBlocked.js";
import { buildInvocationSpecsForTaskDefinition } from "../../workflow/buildInvocationSpecsForTaskDefinition.js";
import { requireSeededPublishWorkflow } from "../../definitions/lookupSeed.js";
import { createWorkflowRelay } from "../liveEventRelay.js";
import { isUuid } from "../requestGuards.js";

function replyForWorkflowRunError(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof WorkflowRunNotFoundError) return reply.status(404).send({ error: error.message });
  if (error instanceof WorkflowRunStateError) return reply.status(409).send({ error: error.message });
  throw error;
}

async function driveWithRelay(deps: ApiDeps, workflowRunId: string, beforeAdvance?: () => Promise<void>) {
  const relay = createWorkflowRelay(deps.db);
  await relay.track(workflowRunId);
  const seed = await deps.db.transaction((tx) => requireSeededPublishWorkflow(tx));
  if (beforeAdvance) await beforeAdvance();
  await relay.flush();
  const result = await advanceWorkflowRunUntilBlocked(relay.runInTx, workflowRunId, (tx) =>
    buildInvocationSpecsForTaskDefinition(tx, seed)
  );
  return { workflowRunId, status: result.status };
}

/**
 * Reads one bookkeeping array from `workflow_runs.variables`, padded/truncated
 * to the graph's length. Anything that is not a UUID reads as null — a corrupted
 * or hand-edited slot must not reach a uuid-typed query and turn a read into a 500.
 */
function idSlots(value: unknown, length: number): (string | null)[] {
  const arr = Array.isArray(value) ? value : [];
  return Array.from({ length }, (_, i) => (isUuid(arr[i]) ? (arr[i] as string) : null));
}

async function runDetail(deps: ApiDeps, runId: string) {
  const run = await deps.db.query.runs.findFirst({ where: eq(runs.id, runId) });
  if (!run) return null;

  const agent =
    run.agentDefinitionId && run.agentDefinitionVersion !== null
      ? await deps.db.query.agentDefinitions.findFirst({
          where: and(eq(agentDefinitions.id, run.agentDefinitionId), eq(agentDefinitions.version, run.agentDefinitionVersion)),
        })
      : undefined;

  const invocationRows = await deps.db.query.invocations.findMany({
    where: eq(invocations.runId, runId),
    orderBy: (i, { asc }) => asc(i.seqNo),
  });
  // The failure reason lives on the immutable `invocation_failed` event
  // (already redacted at its write point), not on the invocations row.
  const failures = await deps.db
    .select({ invocationId: events.invocationId, payload: events.payload })
    .from(events)
    .where(and(eq(events.runId, runId), eq(events.eventType, "invocation_failed")));
  const failureByInvocation = new Map(failures.map((f) => [f.invocationId, f.payload as Record<string, unknown>]));

  const counters = await deps.db.query.budgetCounters.findMany({
    where: and(eq(budgetCounters.scope, "run"), eq(budgetCounters.scopeRefId, runId)),
    orderBy: (c, { asc }) => asc(c.resourceUnit),
  });

  // Only the outcome's `reason` — never the whole object: a future writer adding
  // an error message to it would otherwise leak unredacted text through this read.
  const outcomeReason = (run.outcome as Record<string, unknown> | null)?.reason;
  return {
    id: run.id,
    status: run.status,
    outcomeReason: typeof outcomeReason === "string" ? outcomeReason : null,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    agent: agent ? { name: agent.name, version: agent.version } : null,
    invocations: invocationRows.map((i) => {
      const failure = failureByInvocation.get(i.id);
      return {
        id: i.id,
        seqNo: i.seqNo,
        kind: i.kind,
        status: i.status,
        startedAt: i.startedAt,
        completedAt: i.completedAt,
        failureReason: typeof failure?.reason === "string" ? failure.reason : null,
        errorCode: typeof failure?.errorCode === "string" ? failure.errorCode : null,
      };
    }),
    budget: counters.map((c) => ({
      resourceUnit: c.resourceUnit,
      limitAmount: c.limitAmount,
      reservedAmount: c.reservedAmount,
      consumedAmount: c.consumedAmount,
    })),
  };
}

export function registerWorkflowRunsRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get("/workflow-runs", async (_request, reply) => {
    const rows = await deps.db.query.workflowRuns.findMany({
      orderBy: (w, { desc }) => desc(w.createdAt),
      limit: 100,
    });
    const summaries = [];
    for (const row of rows) {
      const goal = await deps.db.query.goals.findFirst({ where: eq(goals.id, row.goalId) });
      const definition = await deps.db.query.workflowDefinitions.findFirst({
        where: and(eq(workflowDefinitions.id, row.workflowDefinitionId), eq(workflowDefinitions.version, row.workflowDefinitionVersion)),
      });
      summaries.push({
        id: row.id,
        status: row.status,
        createdAt: row.createdAt,
        completedAt: row.completedAt,
        goal: goal ? { id: goal.id, title: goal.title } : null,
        workflowDefinition: definition ? { name: definition.name, version: definition.version } : null,
      });
    }
    return reply.send({ workflowRuns: summaries });
  });

  app.get<{ Params: { id: string } }>("/workflow-runs/:id", async (request, reply) => {
    const workflowRunId = request.params.id;
    if (!isUuid(workflowRunId)) {
      return reply.status(400).send({ error: "workflow run id must be a UUID" });
    }
    const workflowRun = await deps.db.query.workflowRuns.findFirst({ where: eq(workflowRuns.id, workflowRunId) });
    if (!workflowRun) {
      return reply.status(404).send({ error: `No workflow run found for id "${workflowRunId}"` });
    }

    const goal = await deps.db.query.goals.findFirst({ where: eq(goals.id, workflowRun.goalId) });
    const definition = await deps.db.query.workflowDefinitions.findFirst({
      where: and(
        eq(workflowDefinitions.id, workflowRun.workflowDefinitionId),
        eq(workflowDefinitions.version, workflowRun.workflowDefinitionVersion)
      ),
    });
    const graphValid = Boolean(definition && isLinearGraphDefinition(definition.graphDefinition));
    const graphSteps = graphValid && definition && isLinearGraphDefinition(definition.graphDefinition) ? definition.graphDefinition.steps : [];
    // Said explicitly, so a run whose steps cannot be shown is never rendered as a clean run with no steps.
    const stepsUnavailableReason = !definition
      ? "the workflow definition this run was started from no longer exists"
      : graphValid
        ? null
        : "the workflow definition's graph is not a valid linear graph";
    const variables = (workflowRun.variables ?? {}) as Record<string, unknown>;
    const taskInstanceSlots = idSlots(variables.stepTaskInstanceIds, graphSteps.length);
    const runSlots = idSlots(variables.stepRunIds, graphSteps.length);

    const steps = [];
    for (let index = 0; index < graphSteps.length; index++) {
      const step = graphSteps[index]!;
      const taskDefinition = await deps.db.query.taskDefinitions.findFirst({
        where: and(eq(taskDefinitions.id, step.taskDefinitionId), eq(taskDefinitions.version, step.taskDefinitionVersion)),
      });
      const taskInstanceId = taskInstanceSlots[index];
      const taskInstance = taskInstanceId
        ? await deps.db.query.taskInstances.findFirst({ where: eq(taskInstances.id, taskInstanceId) })
        : undefined;
      const runId = runSlots[index];
      steps.push({
        index,
        taskDefinition: taskDefinition
          ? { id: taskDefinition.id, name: taskDefinition.name, version: taskDefinition.version }
          : null,
        taskInstance: taskInstance ? { id: taskInstance.id, status: taskInstance.status } : null,
        run: runId ? await runDetail(deps, runId) : null,
      });
    }

    return reply.send({
      workflowRun: {
        id: workflowRun.id,
        status: workflowRun.status,
        createdAt: workflowRun.createdAt,
        completedAt: workflowRun.completedAt,
      },
      goal: goal ? { id: goal.id, title: goal.title, description: goal.description } : null,
      workflowDefinition: definition ? { id: definition.id, name: definition.name, version: definition.version } : null,
      steps,
      stepsUnavailableReason,
    });
  });

  app.post<{ Params: { id: string } }>("/workflow-runs/:id/pause", async (request, reply) => {
    const workflowRunId = request.params.id;
    if (!isUuid(workflowRunId)) {
      return reply.status(400).send({ error: "workflow run id must be a UUID" });
    }

    // No advancement, no events produced by pauseWorkflowRun itself (see
    // module header) — a plain transaction, no live-event relay needed.
    try {
      await deps.db.transaction((tx) => pauseWorkflowRun(tx, workflowRunId));
    } catch (error) {
      return replyForWorkflowRunError(error, reply);
    }

    const row = await deps.db.query.workflowRuns.findFirst({ where: eq(workflowRuns.id, workflowRunId) });
    return reply.send({ workflowRunId, status: row?.status ?? "paused" });
  });

  app.post<{ Params: { id: string } }>("/workflow-runs/:id/resume", async (request, reply) => {
    const workflowRunId = request.params.id;
    if (!isUuid(workflowRunId)) {
      return reply.status(400).send({ error: "workflow run id must be a UUID" });
    }
    try {
      const result = await driveWithRelay(deps, workflowRunId, () =>
        deps.db.transaction((tx) => resumeWorkflowRun(tx, workflowRunId))
      );
      return reply.send(result);
    } catch (error) {
      return replyForWorkflowRunError(error, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/workflow-runs/:id/advance", async (request, reply) => {
    const workflowRunId = request.params.id;
    if (!isUuid(workflowRunId)) {
      return reply.status(400).send({ error: "workflow run id must be a UUID" });
    }
    const row = await deps.db.query.workflowRuns.findFirst({ where: eq(workflowRuns.id, workflowRunId) });
    if (!row) {
      return reply.status(404).send({ error: `No workflow run found for id "${workflowRunId}"` });
    }
    if (row.status !== "in_progress") {
      return reply
        .status(409)
        .send({ error: `Workflow run "${workflowRunId}" is "${row.status}"; only an in_progress run can be advanced` });
    }
    try {
      return reply.send(await driveWithRelay(deps, workflowRunId));
    } catch (error) {
      return replyForWorkflowRunError(error, reply);
    }
  });
}
