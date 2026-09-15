/**
 * The publish step's source lookup fails closed on ambiguity: a workflow with two
 * steps of the source Task Definition (possible since Registry writes), or a source
 * Task Instance with more than one completed Run, must not publish an arbitrary report.
 * A retried source's failed attempts (spec §3d) are not candidates.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeTestDb, resetTestSchema, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";
import { seedPublishWorkflow } from "../../src/definitions/seed.js";
import { buildPublishReportInvocationSpecs } from "../../src/capabilities/publishReport/buildInvocationSpecs.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

async function scenario(tx: DrizzleTransaction, sourceSteps: number, sourceRunStatuses: string[]) {
  const seed = await seedPublishWorkflow(tx);
  const [workflowRun] = await tx
    .insert(schema.workflowRuns)
    .values({ workflowDefinitionId: seed.workflowDefinitionId, workflowDefinitionVersion: 1, goalId: seed.goalId, status: "in_progress" })
    .returning();
  const instance = async (taskDefinitionId: string) =>
    (
      await tx
        .insert(schema.taskInstances)
        .values({ taskDefinitionId, taskDefinitionVersion: 1, workflowRunId: workflowRun!.id, projectId: seed.projectId, status: "completed" })
        .returning()
    )[0]!;

  for (let s = 0; s < sourceSteps; s++) {
    const source = await instance(seed.taskDefinitionId);
    for (const status of sourceRunStatuses) await tx.insert(schema.runs).values({ taskInstanceId: source.id, status });
  }
  const own = await instance(seed.reviewAndPublishTaskDefinitionId);
  await tx.insert(schema.runs).values({ taskInstanceId: own.id, status: "active" });

  return buildPublishReportInvocationSpecs(
    tx,
    {
      agentDefinitionId: seed.publisherAgentDefinitionId,
      agentDefinitionVersion: 1,
      researchReportTaskDefinitionId: seed.taskDefinitionId,
      destinationRelativePath: `reports/${own.id}.json`,
    },
    { taskDefinitionId: seed.reviewAndPublishTaskDefinitionId, taskDefinitionVersion: 1, taskInstanceId: own.id, input: {} }
  );
}

describe("publish_report source lookup", () => {
  it("refuses two source steps in the same Workflow Run", async () => {
    await withRollback(async (tx) => {
      await expect(scenario(tx, 2, ["completed"])).rejects.toThrow(/exactly one source task_instances row .* found 2/);
    });
  });

  it("refuses a source Task Instance with two completed Runs", async () => {
    await withRollback(async (tx) => {
      await expect(scenario(tx, 1, ["completed", "completed"])).rejects.toThrow(/exactly one completed runs row .* found 2/);
    });
  });

  it("refuses a source Task Instance whose Runs all failed", async () => {
    await withRollback(async (tx) => {
      await expect(scenario(tx, 1, ["failed", "failed"])).rejects.toThrow(/exactly one completed runs row .* found 0/);
    });
  });

  it("still reaches the Artifact check with one source step and one Run", async () => {
    await withRollback(async (tx) => {
      await expect(scenario(tx, 1, ["completed"])).rejects.toThrow(/exactly one "report"-type Artifact .* found 0/);
    });
  });

  it("ignores a retried source's failed attempts and reaches the Artifact check through its completed Run", async () => {
    await withRollback(async (tx) => {
      await expect(scenario(tx, 1, ["failed", "completed"])).rejects.toThrow(/exactly one "report"-type Artifact .* found 0/);
    });
  });
});
