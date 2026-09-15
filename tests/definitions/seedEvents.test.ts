/**
 * The seed goes through the Registry (`src/definitions/seed.ts`): every Definition and
 * Grant it creates is logged in the same transaction, including the Researcher's
 * AUTONOMOUS Grant (spec §9.4 "an explicit, logged human edit"), and the seeded Goal
 * emits goal_created (§8.2).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeTestDb, resetTestSchema, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { DEFAULT_RESEARCH_REPORT_CONTEXT_BUDGET, seedMissingWorkflows, seedPublishWorkflow } from "../../src/definitions/seed.js";
import { createTaskDefinition, createWorkflowDefinition } from "../../src/definitions/registryWrites.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

async function eventFor(tx: DrizzleTransaction, idempotencyKey: string) {
  return tx.query.events.findFirst({ where: eq(schema.events.idempotencyKey, idempotencyKey) });
}

describe("the seed logs what it creates", () => {
  it("emits definition_version_created for every Definition, Capability and Tool Binding, capability_granted for both Grants, and goal_created", async () => {
    await withRollback(async (tx) => {
      const seeded = await seedPublishWorkflow(tx);

      const definitions: [string, string][] = [
        [seeded.capabilityId, "capability"],
        [seeded.toolBindingId, "tool_binding"],
        [seeded.agentDefinitionId, "agent_definition"],
        [seeded.taskDefinitionId, "task_definition"],
        [seeded.publishCapabilityId, "capability"],
        [seeded.publishToolBindingId, "tool_binding"],
        [seeded.publisherAgentDefinitionId, "agent_definition"],
        [seeded.reviewAndPublishTaskDefinitionId, "task_definition"],
        [seeded.workflowDefinitionId, "workflow_definition"],
      ];
      for (const [id, definitionType] of definitions) {
        const event = await eventFor(tx, `definition_version_created:${id}`);
        expect(event, `${definitionType} ${id}`).toMatchObject({ actor: "human:operator", producer: "registry", payload: { definitionType, id } });
      }

      const researchGrant = await eventFor(tx, `capability_granted:${seeded.capabilityGrantId}`);
      expect(researchGrant).toMatchObject({
        actor: "human:operator",
        payload: { agentDefinitionId: seeded.agentDefinitionId, capabilityId: seeded.capabilityId, permissions: ["READ"], autonomyState: "AUTONOMOUS" },
      });
      const publishGrant = await eventFor(tx, `capability_granted:${seeded.publishCapabilityGrantId}`);
      expect(publishGrant).toMatchObject({ payload: { permissions: ["PUBLISH"], autonomyState: "ALWAYS_APPROVE" } });

      expect(await eventFor(tx, `goal_created:${seeded.goalId}`)).toMatchObject({ actor: "human:operator", goalId: seeded.goalId });

      // Each Grant is logged before the Workflow Definition that puts its Agent in use.
      const workflow = await eventFor(tx, `definition_version_created:${seeded.workflowDefinitionId}`);
      expect(researchGrant!.globalSeq).toBeLessThan(workflow!.globalSeq);
      expect(publishGrant!.globalSeq).toBeLessThan(workflow!.globalSeq);
    });
  });

  it("still produces the same Definitions: versions 1, the seeded Grants and the two-step graph", async () => {
    await withRollback(async (tx) => {
      const seeded = await seedPublishWorkflow(tx);
      expect(seeded).toMatchObject({ agentDefinitionVersion: 1, taskDefinitionVersion: 1, publisherAgentDefinitionVersion: 1, workflowDefinitionVersion: 1 });
      const grant = await tx.query.capabilityGrants.findFirst({ where: eq(schema.capabilityGrants.id, seeded.capabilityGrantId) });
      expect(grant).toMatchObject({ autonomyState: "AUTONOMOUS", maxTrustLevelRequired: 1, permissions: ["READ"], scope: {} });
      const workflow = await tx.query.workflowDefinitions.findFirst({ where: eq(schema.workflowDefinitions.id, seeded.workflowDefinitionId) });
      expect((workflow!.graphDefinition as { steps: unknown[] }).steps).toHaveLength(2);
      const binding = await tx.query.toolBindings.findFirst({ where: eq(schema.toolBindings.id, seeded.toolBindingId) });
      expect(binding).toMatchObject({ kind: "internal", trustLevel: 2, version: 1 });
    });
  });

  it("npm run seed on a database seeded before Workflow 1 adds exactly its Workflow Definition and the V1.1 building blocks, and a second run adds nothing", async () => {
    await withRollback(async (tx) => {
      const seeded = await seedPublishWorkflow(tx);
      const counts = async () =>
        Promise.all(
          [schema.agentDefinitions, schema.taskDefinitions, schema.capabilities, schema.capabilityGrants, schema.toolBindings, schema.projects, schema.goals, schema.workflowDefinitions].map(
            async (table) => (await tx.select().from(table)).length
          )
        );
      const before = await counts();

      expect(await seedMissingWorkflows(tx)).toEqual({ seededPublish: false, seededResearchReport: true, seededV11: true });
      const after = await counts();
      // V1.1: + the Reviewer and Keeper agents; Agent Task, Autonomous Objective, Approval Gate and Keeper Answer task
      // definitions; review.checkpoint, system.inspect and docs.retrieve with their bindings and Grants; the Keeper
      // project; the Keeper Think workflow; + Workflow 1.
      const [agents, tasks, caps, grants, bindings, projects, goals, workflows] = before;
      expect(after).toEqual([agents! + 2, tasks! + 4, caps! + 3, grants! + 3, bindings! + 3, projects! + 1, goals, workflows! + 2]);

      const row = await tx.query.workflowDefinitions.findFirst({ where: eq(schema.workflowDefinitions.name, "Research-Report") });
      expect(row).toMatchObject({ version: 1 });
      expect((row!.graphDefinition as { steps: unknown[] }).steps).toEqual([
        { taskDefinitionId: seeded.taskDefinitionId, taskDefinitionVersion: 1, agentDefinitionId: seeded.agentDefinitionId, agentDefinitionVersion: 1 },
      ]);
      expect(await eventFor(tx, `definition_version_created:${row!.id}`)).toMatchObject({ actor: "human:operator", payload: { definitionType: "workflow_definition" } });

      expect(await seedMissingWorkflows(tx)).toEqual({ seededPublish: false, seededResearchReport: false, seededV11: false });
      expect(await counts()).toEqual(after);
    });
  });

  it("seeds both workflows on an empty database", async () => {
    await withRollback(async (tx) => {
      expect(await seedMissingWorkflows(tx)).toEqual({ seededPublish: true, seededResearchReport: true, seededV11: true });
    });
  });

  it("still counts Workflow 1 as seeded after the Registry versions it over a new research Task Definition", async () => {
    await withRollback(async (tx) => {
      const seeded = await seedPublishWorkflow(tx);
      await seedMissingWorkflows(tx);
      const task2 = await createTaskDefinition(
        tx,
        { name: "Research-Report", kind: "research_report", defaultContextBudget: DEFAULT_RESEARCH_REPORT_CONTEXT_BUDGET, previousVersion: 1 },
        "human:operator"
      );
      await createWorkflowDefinition(
        tx,
        {
          name: "Research-Report",
          previousVersion: 1,
          graphDefinition: {
            kind: "linear",
            steps: [{ taskDefinitionId: task2.id, taskDefinitionVersion: task2.version!, agentDefinitionId: seeded.agentDefinitionId, agentDefinitionVersion: 1 }],
          },
        },
        "human:operator"
      );
      expect(await seedMissingWorkflows(tx)).toEqual({ seededPublish: false, seededResearchReport: false, seededV11: false });
    });
  });

  it("fails closed when another Workflow Definition already holds Workflow 1's name", async () => {
    await withRollback(async (tx) => {
      const seeded = await seedPublishWorkflow(tx);
      await createWorkflowDefinition(
        tx,
        {
          name: "Research-Report",
          graphDefinition: {
            kind: "linear",
            // V1.1 (R3): a publish step must follow its source, so the imposter is a valid two-step graph.
            steps: [
              {
                taskDefinitionId: seeded.taskDefinitionId,
                taskDefinitionVersion: 1,
                agentDefinitionId: seeded.agentDefinitionId,
                agentDefinitionVersion: 1,
              },
              {
                taskDefinitionId: seeded.reviewAndPublishTaskDefinitionId,
                taskDefinitionVersion: 1,
                agentDefinitionId: seeded.publisherAgentDefinitionId,
                agentDefinitionVersion: 1,
                parameters: { sourceTaskDefinitionId: seeded.taskDefinitionId },
              },
            ],
          },
        },
        "human:operator"
      );
      await expect(seedMissingWorkflows(tx)).rejects.toThrow(/not the one-step Research-Report workflow/);
    });
  });
});
