/**
 * Browser QA for the agent's day (Stages 7-8). Not part of the normal suite: skipped unless QA_SERVE=1.
 *
 * Builds one of every state the Keep can truthfully be in — working, in a meeting, waiting for an
 * approval, waiting for assigned work, on a break, outside working hours, stopped, and simply available —
 * against the TEST database with no model call anywhere, then serves the API for QA_SECONDS so the world,
 * the Overview and the agent views can be inspected at 1280 / 1440 / 1920.
 *
 * Every record here is a real row the runtime would have written. Nothing is a fixture pretending to be a
 * state: the working agent has an active Run, the meeting is event-verified, the stop is a real stop.
 */
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeTestDb, resetTestSchema, testDb } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import { seedPublishWorkflow, seedV11Definitions } from "../../src/definitions/seed.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { callClaudeSubscriptionModel } from "../../src/router/providers/claudeSubscription.js";
import { buildServer } from "../../src/api/server.js";
import { createDefaultWorld } from "../../src/world/worldConfig.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";
import { createCalendarEntry, listRooms, scheduleMeeting, updateSettings } from "../../src/workplace/workplace.js";
import { engageStop } from "../../src/governance/executionStop.js";

const QA = process.env.QA_SERVE === "1";

describe.skipIf(!QA)("the agent's day, for browser QA", () => {
  it(
    "builds one of every truthful state and serves them",
    async () => {
      await resetTestSchema();
      await testDb.transaction((tx) => seedPublishWorkflow(tx));
      await testDb.transaction((tx) => createDefaultWorld(tx as unknown as DrizzleTransaction));
      await testDb.transaction((tx) => seedV11Definitions(tx));
      vi.mocked(callClaudeSubscriptionModel).mockImplementation(async () => {
        throw new Error("QA harness: the agent's day needs no model call");
      });
      const t = <T>(fn: (tx: DrizzleTransaction) => Promise<T>) => testDb.transaction((tx) => fn(tx as unknown as DrizzleTransaction));
      const agent = async (name: string) => (await testDb.select().from(schema.agentDefinitions).where(eq(schema.agentDefinitions.name, name)))[0]!;
      const project = (await testDb.select().from(schema.projects))[0]!;
      const task = (await testDb.select().from(schema.taskDefinitions))[0]!;

      /** A real Run for this agent, in the state the runtime would leave it in. */
      async function work(agentName: string, title: string, status: "active" | "awaiting_approval") {
        const a = await agent(agentName);
        const [goal] = await testDb.insert(schema.goals).values({ projectId: project.id, title, status: "active" }).returning();
        const [wr] = await testDb
          .insert(schema.workflowRuns)
          .values({ workflowDefinitionId: (await testDb.select().from(schema.workflowDefinitions))[0]!.id, workflowDefinitionVersion: 1, goalId: goal!.id, status: "in_progress", variables: {} })
          .returning();
        const [ti] = await testDb.insert(schema.taskInstances).values({ taskDefinitionId: task.id, taskDefinitionVersion: task.version, projectId: project.id, workflowRunId: wr!.id, status: status === "active" ? "active" : "awaiting_approval", input: {} }).returning();
        await testDb.insert(schema.runs).values({ taskInstanceId: ti!.id, status, agentDefinitionId: a.id, agentDefinitionVersion: a.version });
      }

      // Agents gather for a meeting well ahead here, so QA can see them walking to the room.
      await t((tx) => updateSettings(tx, { outsideWorkingHours: "allow", workOutsideHours: "forbid", gatherMinutes: 60, workStartMinute: 540, workEndMinute: 1020, workingDays: [1, 2, 3, 4, 5] }, "human:operator"));

      // WORKING and AWAITING APPROVAL: real Runs.
      await work("Researcher", "Survey the archive", "active");
      await work("Publisher", "Weigh the options", "awaiting_approval");

      // IN A MEETING: a meeting happening now, event-verified.
      const startsAt = new Date(Date.now() - 60_000);
      await t(async (tx) => {
        const room = (await listRooms(tx)).find((r) => r.active && r.capacity >= 2)!;
        await scheduleMeeting(
          tx,
          { title: "Research sync", agenda: "What the archive turned up", participants: ["Keeper", "Reviewer"], startsAt, endsAt: new Date(startsAt.getTime() + 45 * 60_000), roomId: room.id },
          { actor: "human:operator", goalId: null, runId: null, invocationId: null },
          startsAt
        );
      });

      // ON A BREAK: a diary entry covering now. A break is time off, never work.
      await t((tx) =>
        createCalendarEntry(tx, { agentName: "Manager", kind: "break", title: "Tea", startsAt: new Date(Date.now() - 5 * 60_000).toISOString(), endsAt: new Date(Date.now() + 40 * 60_000).toISOString() }, "human:operator")
      );

      // STOPPED: a real emergency stop on one agent.
      const stopped = await agent("Field Researcher");
      await t((tx) => engageStop(tx, { scope: "agent_definition", scopeRefId: stopped.id, reason: "held back for QA" }));

      // Everyone else: available, or outside hours when the clock says so. Nothing is invented for them.
      const app = buildServer({ db: testDb });
      await app.ready();
      expect(app).toBeTruthy();
      await app.listen({ port: Number(process.env.QA_PORT ?? 3000), host: "127.0.0.1" });
      // eslint-disable-next-line no-console
      console.log("QA states:", JSON.stringify((await app.inject({ method: "GET", url: "/agents/state" })).json()));
      await new Promise((r) => setTimeout(r, Number(process.env.QA_SECONDS ?? 900) * 1000));
      await app.close();
      await closeTestDb();
    },
    3_600_000
  );
});
