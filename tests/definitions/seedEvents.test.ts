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

import { DEFAULT_RESEARCH_REPORT_CONTEXT_BUDGET, seedKeeper, seedMissingWorkflows, seedPublishWorkflow } from "../../src/definitions/seed.js";
import { createAgentDefinition, createTaskDefinition, createWorkflowDefinition } from "../../src/definitions/registryWrites.js";
import { findKeeperAgent, findKeeperRefs } from "../../src/definitions/lookupSeed.js";

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
      // R2: + the Field Researcher agent holding both external research Capabilities. `research.search` brings a
      // binding; `research.web` brings none, because its search runs inside a model call rather than a tool.
      // R2 progression: + `peer.endorse` with its binding, held by no agent.
      // R2 character interaction: + the Agent Talk task definition and the Direct requests project (talk workflows are made on first use).
      // R2 management layer: + the Manager (two Grants), manager.inspect_workforce and manager.delegate with bindings, the Manager
      // Plan and Manager Review task definitions, the Missions project and the Manager Plan workflow.
      // R2 observability: + system.keep_stats with its binding and the Keeper's third Grant.
      // Workplace: + workplace.inspect_calendar and workplace.schedule_meeting with bindings, and the Manager's two Grants for them.
      // Manager recovery: + the Manager Recovery task definition and its one-step workflow (no new Capability: it delegates with manager.delegate).
      // Meetings the Keep holds: + workplace.record_outcome with its binding and the Manager's fifth Grant, the Meeting Contribution and
      // Meeting Outcome task definitions, and the "Meetings" Project. No Workflow Definition: a round table's graph names its own
      // participants, so it is created when the meeting is convened.
      const [agents, tasks, caps, grants, bindings, projects, goals, workflows] = before;
      // Organisational memory: + manager.inspect_history with its binding and the Manager's sixth Grant. No
      // table and no projection: history is composed from records that already exist.
      expect(after).toEqual([agents! + 4, tasks! + 10, caps! + 13, grants! + 12, bindings! + 12, projects! + 4, goals, workflows! + 4]);

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

  it("a Keeper seeded before system.keep_stats is upgraded to a new version holding it, Keeper Think pins that version, and the Manager holds no stats Grant", async () => {
    await withRollback(async (tx) => {
      await seedMissingWorkflows(tx);
      const grantNames = async (agentId: string) =>
        (await tx.select({ name: schema.capabilities.name }).from(schema.capabilityGrants).innerJoin(schema.capabilities, eq(schema.capabilities.id, schema.capabilityGrants.capabilityId)).where(eq(schema.capabilityGrants.agentDefinitionId, agentId)))
          .map((r) => r.name)
          .sort();
      // Simulate the pre-observability Keeper: a latest version with only its two original Grants.
      const [inspect, docs] = await Promise.all(["system.inspect", "docs.retrieve"].map((n) => tx.query.capabilities.findFirst({ where: eq(schema.capabilities.name, n) })));
      const old = await createAgentDefinition(
        tx,
        {
          name: "Keeper", previousVersion: 1, role: "r", objective: "o", instructions: "i", executionProfile: { preferredTier: "CHEAP" },
          grants: [inspect!, docs!].map((c) => ({ capabilityId: c.id, permissions: ["READ"], autonomyState: "AUTONOMOUS", maxTrustLevelRequired: 1 })),
        },
        "human:operator"
      );
      expect(await seedKeeper(tx)).toBe(true);
      const keeper = await findKeeperAgent(tx);
      expect(keeper!.version).toBe(old.version! + 1);
      expect(await grantNames(keeper!.id)).toEqual(["docs.retrieve", "system.inspect", "system.keep_stats"]);
      expect(await grantNames(old.id)).toEqual(["docs.retrieve", "system.inspect"]);
      const think = await tx.query.workflowDefinitions.findFirst({ where: eq(schema.workflowDefinitions.id, (await findKeeperRefs(tx))!.workflowDefinitionId) });
      expect((think!.graphDefinition as { steps: { agentDefinitionId: string }[] }).steps[0]!.agentDefinitionId).toBe(keeper!.id);
      for (const manager of await tx.query.agentDefinitions.findMany({ where: eq(schema.agentDefinitions.name, "Manager") })) {
        expect(await grantNames(manager.id)).not.toContain("system.keep_stats");
      }
      expect(await seedKeeper(tx)).toBe(false);
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
