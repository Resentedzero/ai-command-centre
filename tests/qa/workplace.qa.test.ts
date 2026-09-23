/**
 * Browser QA harness for the workplace (not part of the normal suite: skipped unless QA_SERVE=1).
 * Builds real workplace records against the TEST database — a meeting already in progress, a calendar
 * entry, an announcement, and a refused request — with the Manager's model mocked (no model is called),
 * then serves the API on port 3000 for QA_SECONDS. The Manager's plan for any meeting objective is the
 * interpretation a model would give; code still decides the time, room and participants.
 */
import { describe, expect, it, vi } from "vitest";
import { closeTestDb, resetTestSchema, testDb } from "../testDb.js";
import { seedPublishWorkflow, seedV11Definitions } from "../../src/definitions/seed.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { callClaudeSubscriptionModel } from "../../src/router/providers/claudeSubscription.js";
import { buildServer } from "../../src/api/server.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";
import { createCalendarEntry, listRooms, scheduleMeeting, sendMessage, updateSettings } from "../../src/workplace/workplace.js";

const QA = process.env.QA_SERVE === "1";

describe.skipIf(!QA)("workplace for browser QA", () => {
  it(
    "builds and serves workplace records",
    async () => {
      await resetTestSchema();
      await testDb.transaction((tx) => seedPublishWorkflow(tx));
      await testDb.transaction((tx) => seedV11Definitions(tx));
      const USAGE = { tokensIn: 300, tokensOut: 100, costAmount: 400, costUnit: "subscription_tokens" as const };
      const NONE = { needed: false, action: "none", meetingId: "", title: "", agenda: "", everyone: false, participants: [], durationMinutes: 0, timing: "asap", at: "", roomName: "" };
      vi.mocked(callClaudeSubscriptionModel).mockImplementation(async (_m, ctx, shape) => {
        const props = (shape as { properties?: Record<string, unknown> }).properties ?? {};
        if (!("escalation" in props)) throw new Error("QA harness: only the Manager's plan is mocked");
        const objective = JSON.stringify(ctx).toLowerCase();
        const huge = objective.includes("everyone in the keep twice");
        return {
          result: {
            summary: "A meeting for every agent.",
            assumptions: [],
            tasks: [],
            escalation: { needed: false, reason: "" },
            meeting: { ...NONE, needed: true, action: "schedule", title: huge ? "Impossible gathering" : "All-hands", agenda: "Catch up on the Keep's work", everyone: true, durationMinutes: huge ? 480 : 30, timing: huge ? "today" : "asap" },
          },
          usage: USAGE,
        };
      });

      const t = (fn: (tx: DrizzleTransaction) => Promise<unknown>) => testDb.transaction((tx) => fn(tx as unknown as DrizzleTransaction));
      // Agents leave for a meeting up to an hour early here, so a meeting a few minutes away shows them walking there.
      await t((tx) => updateSettings(tx, { outsideWorkingHours: "allow", gatherMinutes: 60 }, "human:operator"));
      const past = new Date(Date.now() - 5 * 60_000);
      const start = new Date(Math.ceil(past.getTime() / 60_000) * 60_000 + 60_000);
      await t(async (tx) => {
        const board = (await listRooms(tx)).find((r) => r.name === "Boardroom")!;
        await scheduleMeeting(tx, { title: "Research sync", agenda: "Review this week's evidence", participants: ["Researcher", "Reviewer"], startsAt: start, endsAt: new Date(start.getTime() + 25 * 60_000), roomId: board.id }, { actor: "human:operator" }, past);
        await createCalendarEntry(tx, { agentName: "Publisher", kind: "break", title: "Lunch", startsAt: new Date(Date.now() + 3 * 3_600_000).toISOString(), endsAt: new Date(Date.now() + 4 * 3_600_000).toISOString() }, "human:operator");
        await sendMessage(tx, { kind: "announcement", title: "Welcome to the new calendar", body: "Meetings now live in the Keep." }, "human:operator");
      });

      const app = buildServer({ db: testDb });
      await app.ready();
      expect(app).toBeTruthy();
      await app.listen({ port: Number(process.env.QA_PORT ?? 3000), host: "127.0.0.1" });
      await new Promise((r) => setTimeout(r, Number(process.env.QA_SECONDS ?? 900) * 1000));
      await app.close();
      await closeTestDb();
    },
    3_600_000
  );
});
