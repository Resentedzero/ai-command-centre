/**
 * Migration 0012 gives Definitions seeded before definition-driven planning the
 * new Task Definition kinds and graph-step bindings the removed hard-coded
 * dispatcher implied. Replayed against old-shape rows in a rolled-back transaction.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { closeTestDb, resetTestSchema, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

const statements = readFileSync(fileURLToPath(new URL("../../drizzle/0012_definition_driven_step_plans.sql", import.meta.url)), "utf8")
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

async function replay(tx: DrizzleTransaction) {
  for (const statement of statements) await tx.execute(sql.raw(statement));
}

async function oldShapeSeed(tx: DrizzleTransaction) {
  const agent = async (name: string) =>
    (await tx.insert(schema.agentDefinitions).values({ name, version: 1, role: "r", objective: "o", instructions: "i" }).returning())[0]!;
  const researcher = await agent("Researcher");
  const publisher = await agent("Publisher");
  const [research] = await tx.insert(schema.taskDefinitions).values({ name: "Research-Report", kind: "standalone", version: 1 }).returning();
  const [publish] = await tx.insert(schema.taskDefinitions).values({ name: "Review-and-Publish", kind: "workflow-step", version: 1 }).returning();
  const [workflow] = await tx
    .insert(schema.workflowDefinitions)
    .values({
      name: "Research-and-Publish",
      version: 1,
      graphDefinition: {
        kind: "linear",
        steps: [
          { taskDefinitionId: research!.id, taskDefinitionVersion: 1 },
          { taskDefinitionId: publish!.id, taskDefinitionVersion: 1 },
        ],
      },
    })
    .returning();
  return { researcher, publisher, research: research!, publish: publish!, workflow: workflow! };
}

describe("migration 0012: definition-driven step plans", () => {
  it("sets the kinds and binds each step's Agent and the publish step's source, and is a no-op when replayed", async () => {
    await withRollback(async (tx) => {
      const seed = await oldShapeSeed(tx);
      await replay(tx);

      const kind = async (id: string) => (await tx.query.taskDefinitions.findFirst({ where: eq(schema.taskDefinitions.id, id) }))?.kind;
      expect(await kind(seed.research.id)).toBe("research_report");
      expect(await kind(seed.publish.id)).toBe("publish_report");

      const graph = async () =>
        (await tx.query.workflowDefinitions.findFirst({ where: eq(schema.workflowDefinitions.id, seed.workflow.id) }))?.graphDefinition;
      const expected = {
        kind: "linear",
        steps: [
          { taskDefinitionId: seed.research.id, taskDefinitionVersion: 1, agentDefinitionId: seed.researcher.id, agentDefinitionVersion: 1 },
          {
            taskDefinitionId: seed.publish.id,
            taskDefinitionVersion: 1,
            agentDefinitionId: seed.publisher.id,
            agentDefinitionVersion: 1,
            parameters: { sourceTaskDefinitionId: seed.research.id },
          },
        ],
      };
      expect(await graph()).toEqual(expected);

      await replay(tx);
      expect(await graph()).toEqual(expected);
    });
  });

  it("leaves a graph alone whose steps are not the seeded Task Definitions in order", async () => {
    await withRollback(async (tx) => {
      const seed = await oldShapeSeed(tx);
      const reversed = { kind: "linear", steps: [...(seed.workflow.graphDefinition as { steps: unknown[] }).steps].reverse() };
      await tx.update(schema.workflowDefinitions).set({ graphDefinition: reversed }).where(eq(schema.workflowDefinitions.id, seed.workflow.id));
      await replay(tx);
      const row = await tx.query.workflowDefinitions.findFirst({ where: eq(schema.workflowDefinitions.id, seed.workflow.id) });
      expect(row?.graphDefinition).toEqual(reversed);
    });
  });

  it("leaves the graph alone when its Agents cannot be resolved unambiguously", async () => {
    await withRollback(async (tx) => {
      const seed = await oldShapeSeed(tx);
      // A database from before migration 0014 could hold this; drop its index inside the rolled-back transaction.
      await tx.execute(sql`DROP INDEX agent_definitions_name_version_unique`);
      await tx.insert(schema.agentDefinitions).values({ name: "Researcher", version: 1, role: "r", objective: "o", instructions: "i" });
      await replay(tx);
      const row = await tx.query.workflowDefinitions.findFirst({ where: eq(schema.workflowDefinitions.id, seed.workflow.id) });
      expect(row?.graphDefinition).toEqual(seed.workflow.graphDefinition);
    });
  });
});
