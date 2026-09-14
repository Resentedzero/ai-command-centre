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

import { seedPublishWorkflow } from "../../src/definitions/seed.js";

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
});
