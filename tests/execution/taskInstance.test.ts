import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { resetTestSchema, closeTestDb, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";
import { createStandaloneTaskInstance, createWorkflowTaskInstance } from "../../src/execution/taskInstance.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

async function seedProjectAndGoal(tx: DrizzleTransaction) {
  const [project] = await tx.insert(schema.projects).values({ name: "p-" + randomUUID() }).returning();
  const [goal] = await tx
    .insert(schema.goals)
    .values({ projectId: project!.id, title: "g-" + randomUUID(), status: "active" })
    .returning();
  return { project: project!, goal: goal! };
}

async function seedTaskDefinition(tx: DrizzleTransaction, version = 3) {
  const [taskDefinition] = await tx
    .insert(schema.taskDefinitions)
    .values({ name: "t-" + randomUUID(), kind: "standalone", version })
    .returning();
  return taskDefinition!;
}

describe("createStandaloneTaskInstance", () => {
  it("produces a Task Instance with workflow_run_id null, projectId from the Goal, and the task definition's current version", async () => {
    await withRollback(async (tx) => {
      const { project, goal } = await seedProjectAndGoal(tx);
      const taskDefinition = await seedTaskDefinition(tx, 5);

      const { taskInstanceId } = await createStandaloneTaskInstance(tx, taskDefinition.id, goal.id, { foo: "bar" });

      const row = await tx.query.taskInstances.findFirst({ where: eq(schema.taskInstances.id, taskInstanceId) });
      expect(row).toBeDefined();
      expect(row?.workflowRunId).toBeNull();
      expect(row?.projectId).toBe(project.id);
      expect(row?.taskDefinitionId).toBe(taskDefinition.id);
      expect(row?.taskDefinitionVersion).toBe(5);
      expect(row?.input).toEqual({ foo: "bar" });
      expect(row?.status).toBe("pending");

      // Recorded like the workflow path's creation (spec §8.2 note).
      const created = await tx.query.events.findFirst({
        where: eq(schema.events.idempotencyKey, `task_instance_created:${taskInstanceId}`),
      });
      expect(created).toMatchObject({
        eventType: "task_instance_created",
        goalId: goal.id,
        taskInstanceId,
        workflowRunId: null,
        payload: { taskDefinitionId: taskDefinition.id, taskDefinitionVersion: 5 },
      });
    });
  });

  it("throws when the goal does not exist", async () => {
    await withRollback(async (tx) => {
      const taskDefinition = await seedTaskDefinition(tx);
      await expect(createStandaloneTaskInstance(tx, taskDefinition.id, randomUUID(), {})).rejects.toThrow();
    });
  });

  it("throws when the task definition does not exist", async () => {
    await withRollback(async (tx) => {
      const { goal } = await seedProjectAndGoal(tx);
      await expect(createStandaloneTaskInstance(tx, randomUUID(), goal.id, {})).rejects.toThrow();
    });
  });
});

describe("createWorkflowTaskInstance", () => {
  it("produces a Task Instance with workflow_run_id set, and projectId resolved via the Workflow Run's Goal", async () => {
    await withRollback(async (tx) => {
      const { project, goal } = await seedProjectAndGoal(tx);
      const taskDefinition = await seedTaskDefinition(tx, 2);
      const [workflowDefinition] = await tx
        .insert(schema.workflowDefinitions)
        .values({ name: "wf-" + randomUUID(), version: 1, graphDefinition: { nodes: [] } })
        .returning();
      const [workflowRun] = await tx
        .insert(schema.workflowRuns)
        .values({
          workflowDefinitionId: workflowDefinition!.id,
          workflowDefinitionVersion: workflowDefinition!.version,
          goalId: goal.id,
          status: "running",
        })
        .returning();

      const { taskInstanceId } = await createWorkflowTaskInstance(tx, taskDefinition.id, workflowRun!.id, { step: 1 });

      const row = await tx.query.taskInstances.findFirst({ where: eq(schema.taskInstances.id, taskInstanceId) });
      expect(row).toBeDefined();
      expect(row?.workflowRunId).toBe(workflowRun!.id);
      expect(row?.projectId).toBe(project.id);
      expect(row?.taskDefinitionVersion).toBe(2);
      expect(row?.input).toEqual({ step: 1 });
    });
  });

  it("throws when the workflow run does not exist", async () => {
    await withRollback(async (tx) => {
      const taskDefinition = await seedTaskDefinition(tx);
      await expect(createWorkflowTaskInstance(tx, taskDefinition.id, randomUUID(), {})).rejects.toThrow();
    });
  });
});

describe("structural separation of the two creation paths (Ruling 7)", () => {
  it("createStandaloneTaskInstance's implementation never references createWorkflowTaskInstance", () => {
    const source = readFileSync(fileURLToPath(new URL("../../src/execution/taskInstance.ts", import.meta.url)), "utf8");
    // Extract just the createStandaloneTaskInstance function body (up to the next export) —
    // proving it's a genuinely separate code path, not one calling into the other.
    const start = source.indexOf("export async function createStandaloneTaskInstance");
    const nextExport = source.indexOf("\nexport async function createWorkflowTaskInstance");
    expect(start).toBeGreaterThan(-1);
    expect(nextExport).toBeGreaterThan(start);
    const standaloneBody = source.slice(start, nextExport);
    expect(standaloneBody).not.toMatch(/createWorkflowTaskInstance/);
  });

  it("no file under src/execution other than taskInstance.ts itself references createWorkflowTaskInstance (this unit's own code never calls the workflow path)", () => {
    const executionDir = fileURLToPath(new URL("../../src/execution", import.meta.url));
    const offenders: string[] = [];
    for (const entry of readdirSync(executionDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name === "taskInstance.ts") continue;
      const source = readFileSync(`${executionDir}/${entry.name}`, "utf8");
      if (source.includes("createWorkflowTaskInstance")) offenders.push(entry.name);
    }
    expect(offenders).toEqual([]);
  });

  // Unit 7 (the Workflow Interpreter) now exists — this closes the
  // complementary half Unit 6's report explicitly deferred: "createStandaloneTaskInstance
  // is never called by Unit 7's code". Scans src/workflow/ the same way the
  // check above scans src/execution/. (tests/workflow/interpreter.test.ts
  // also has its own copy of this check, scoped to interpreter.ts
  // specifically — this one additionally covers any other file that might
  // later be added under src/workflow/.)
  it("no file under src/workflow references createStandaloneTaskInstance (Unit 7's code never calls the standalone path)", () => {
    const workflowDir = fileURLToPath(new URL("../../src/workflow", import.meta.url));
    const offenders: string[] = [];
    for (const entry of readdirSync(workflowDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const source = readFileSync(`${workflowDir}/${entry.name}`, "utf8");
      if (source.includes("createStandaloneTaskInstance")) offenders.push(entry.name);
    }
    expect(offenders).toEqual([]);
  });
});
