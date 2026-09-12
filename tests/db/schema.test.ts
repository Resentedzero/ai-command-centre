import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resetTestSchema, closeTestDb, withRollback } from "../testDb.js";
import { insertOneRowPerTable } from "../fixtures.js";
import * as schema from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

describe("resetTestSchema + migrations", () => {
  it("applies cleanly: one row can be inserted and read back per table", async () => {
    await withRollback(async (tx) => {
      const inserted = await insertOneRowPerTable(tx);

      const project = await tx.query.projects.findFirst({ where: eq(schema.projects.id, inserted.project!.id) });
      expect(project?.name).toBe("Test Project");

      const capability = await tx.query.capabilities.findFirst({ where: eq(schema.capabilities.id, inserted.capability!.id) });
      expect(capability?.staticRiskTag).toBe("low");

      const toolBinding = await tx.query.toolBindings.findFirst({ where: eq(schema.toolBindings.id, inserted.toolBinding!.id) });
      expect(toolBinding?.kind).toBe("internal");

      const agentDefinition = await tx.query.agentDefinitions.findFirst({ where: eq(schema.agentDefinitions.id, inserted.agentDefinition!.id) });
      expect(agentDefinition?.name).toBe("test-agent");

      const capabilityGrant = await tx.query.capabilityGrants.findFirst({ where: eq(schema.capabilityGrants.id, inserted.capabilityGrant!.id) });
      expect(capabilityGrant?.autonomyState).toBe("ALWAYS_APPROVE");

      const taskDefinition = await tx.query.taskDefinitions.findFirst({ where: eq(schema.taskDefinitions.id, inserted.taskDefinition!.id) });
      expect(taskDefinition?.kind).toBe("standalone");

      const workflowDefinition = await tx.query.workflowDefinitions.findFirst({ where: eq(schema.workflowDefinitions.id, inserted.workflowDefinition!.id) });
      expect(workflowDefinition?.name).toBe("test-workflow");

      const goal = await tx.query.goals.findFirst({ where: eq(schema.goals.id, inserted.goal!.id) });
      expect(goal?.status).toBe("active");

      const workflowRun = await tx.query.workflowRuns.findFirst({ where: eq(schema.workflowRuns.id, inserted.workflowRun!.id) });
      expect(workflowRun?.status).toBe("running");

      const taskInstance = await tx.query.taskInstances.findFirst({ where: eq(schema.taskInstances.id, inserted.taskInstance!.id) });
      expect(taskInstance?.status).toBe("pending");

      const run = await tx.query.runs.findFirst({ where: eq(schema.runs.id, inserted.run!.id) });
      expect(run?.status).toBe("active");

      const invocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.id, inserted.invocation!.id) });
      expect(invocation?.kind).toBe("deterministic");

      const event = await tx.query.events.findFirst({ where: eq(schema.events.id, inserted.event!.id) });
      expect(event?.eventType).toBe("task_instance_completed");

      const budgetCounter = await tx.query.budgetCounters.findFirst({ where: eq(schema.budgetCounters.id, inserted.budgetCounter!.id) });
      expect(budgetCounter?.scope).toBe("run");

      const approval = await tx.query.approvals.findFirst({ where: eq(schema.approvals.id, inserted.approval!.id) });
      expect(approval?.status).toBe("pending");

      const artifact = await tx.query.artifacts.findFirst({ where: eq(schema.artifacts.id, inserted.artifact!.id) });
      expect(artifact?.hash).toBe("deadbeef");
    });
  });
});
