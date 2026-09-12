/**
 * Builds one minimal, FK-valid row per table, in dependency order. Used by
 * the schema round-trip test to prove migrations produce a schema every
 * table can actually be written to and read back from.
 */
import { randomUUID } from "node:crypto";
import type { DrizzleTransaction } from "../src/events/emit.js";
import * as schema from "../src/db/schema.js";

export async function insertOneRowPerTable(tx: DrizzleTransaction) {
  const [project] = await tx
    .insert(schema.projects)
    .values({ name: "Test Project", description: "fixture" })
    .returning();

  const [capability] = await tx
    .insert(schema.capabilities)
    .values({ name: "test.capability", description: "fixture", staticRiskTag: "low" })
    .returning();

  const [toolBinding] = await tx
    .insert(schema.toolBindings)
    .values({
      capabilityId: capability!.id,
      kind: "internal",
      config: {},
      trustLevel: 1,
      version: 1,
    })
    .returning();

  const [agentDefinition] = await tx
    .insert(schema.agentDefinitions)
    .values({
      name: "test-agent",
      version: 1,
      role: "tester",
      objective: "exercise the schema",
      instructions: "n/a",
      memoryPolicy: {},
      escalationPolicy: {},
    })
    .returning();

  const [capabilityGrant] = await tx
    .insert(schema.capabilityGrants)
    .values({
      agentDefinitionId: agentDefinition!.id,
      agentDefinitionVersion: agentDefinition!.version,
      capabilityId: capability!.id,
      permissions: ["READ"],
      scope: {},
      maxTrustLevelRequired: 1,
      autonomyState: "ALWAYS_APPROVE",
    })
    .returning();

  const [taskDefinition] = await tx
    .insert(schema.taskDefinitions)
    .values({
      name: "test-task",
      kind: "standalone",
      inputSchema: {},
      outputSchema: {},
      defaultContextBudget: {},
      version: 1,
    })
    .returning();

  const [workflowDefinition] = await tx
    .insert(schema.workflowDefinitions)
    .values({ name: "test-workflow", version: 1, graphDefinition: { nodes: [] } })
    .returning();

  const [goal] = await tx
    .insert(schema.goals)
    .values({ projectId: project!.id, title: "Test Goal", description: "fixture", status: "active" })
    .returning();

  const [workflowRun] = await tx
    .insert(schema.workflowRuns)
    .values({
      workflowDefinitionId: workflowDefinition!.id,
      workflowDefinitionVersion: workflowDefinition!.version,
      goalId: goal!.id,
      status: "running",
      variables: {},
    })
    .returning();

  const [taskInstance] = await tx
    .insert(schema.taskInstances)
    .values({
      taskDefinitionId: taskDefinition!.id,
      taskDefinitionVersion: taskDefinition!.version,
      workflowRunId: workflowRun!.id,
      projectId: project!.id,
      status: "pending",
      input: {},
    })
    .returning();

  const [run] = await tx
    .insert(schema.runs)
    .values({
      taskInstanceId: taskInstance!.id,
      agentDefinitionId: agentDefinition!.id,
      agentDefinitionVersion: agentDefinition!.version,
      status: "active",
      budgetEnvelope: {},
      outcome: null,
    })
    .returning();

  const [invocation] = await tx
    .insert(schema.invocations)
    .values({
      runId: run!.id,
      seqNo: 1,
      kind: "deterministic",
      costClass: "free",
      status: "completed",
      idempotencyKey: `fixture-${randomUUID()}`,
    })
    .returning();

  const [event] = await tx
    .insert(schema.events)
    .values({
      idempotencyKey: `fixture-event-${randomUUID()}`,
      eventType: "task_instance_completed",
      eventVersion: 1,
      sequenceNo: 1,
      causationId: null,
      goalId: goal!.id,
      workflowRunId: workflowRun!.id,
      taskInstanceId: taskInstance!.id,
      runId: run!.id,
      invocationId: invocation!.id,
      actor: "system",
      producer: "test-fixture",
      payload: {},
    })
    .returning();

  const [budgetCounter] = await tx
    .insert(schema.budgetCounters)
    .values({
      scope: "run",
      scopeRefId: run!.id,
      limitAmount: "10.00",
      reservedAmount: "0",
      consumedAmount: "0",
    })
    .returning();

  const [approval] = await tx
    .insert(schema.approvals)
    .values({
      invocationId: invocation!.id,
      proposedActionSnapshot: { action: "test" },
      riskTier: "low",
      status: "pending",
    })
    .returning();

  const [artifact] = await tx
    .insert(schema.artifacts)
    .values({
      type: "text",
      version: 1,
      producingInvocationId: invocation!.id,
      hash: "deadbeef",
      size: 4,
      inlineContent: "test",
      summary: "fixture artifact",
    })
    .returning();

  return {
    project,
    capability,
    toolBinding,
    agentDefinition,
    capabilityGrant,
    taskDefinition,
    workflowDefinition,
    goal,
    workflowRun,
    taskInstance,
    run,
    invocation,
    event,
    budgetCounter,
    approval,
    artifact,
  };
}
