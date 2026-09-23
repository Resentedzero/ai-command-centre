/**
 * Operational notices (R2 Stage 11): meaningful runtime facts, told to whoever needs to know.
 *
 * A notice is NEVER a new fact. Every one is derived from a record the runtime already wrote — an event
 * it emitted, or a deadline the clock has passed — and carries that record's own identity. Nothing here
 * calls a model, starts work, changes authority, or invents a reason: the reason is the one the runtime
 * recorded. A notice that could not be derived is simply not written.
 *
 * SHAPE
 *   `NOTICES` maps an event type to zero or more notices. Each entry decides, from the event's own
 *   payload and correlation: who is told, the title, and the idempotency key. `sweepOperationalNotices`
 *   reads recent events once a minute (`api/start.ts`) and writes what is missing.
 *
 * IDEMPOTENCY
 *   The key is `<kind>:<eventId>:<recipient>` — the event's own identity plus who is being told, because
 *   one failure legitimately tells both the operator and the Manager. `workplace_notifications`'
 *   idempotency key is unique, and `recordNotices` conflicts-do-nothing, so re-deriving is free. The
 *   sweep may therefore re-scan the same events safely; the window below is only about cost.
 *
 * WINDOW
 *   One pass looks at events from the last `LOOKBACK_HOURS`, at most `SCAN_LIMIT` of them. There is NO
 *   watermark: nothing is stored about where the sweep got to, so there is nothing to keep in step,
 *   rebuild or corrupt — re-deriving is free because the keys collide. A Keep that was off for a week
 *   does not wake up and announce the whole week; it announces the last day, and the rest is history,
 *   which is read rather than announced (`api/organisationHistory.ts`).
 *
 * TWO NOTICES COME FROM THE CLOCK, NOT AN EVENT
 *   `goal_overdue` has no event — a goal becomes overdue because time passed, exactly like a meeting
 *   becoming `in_progress`. It is derived from `goals.due_at` and written once per goal.
 *   The pending-approval notice is deliberately NOT here: `GET /workplace/notifications` already derives
 *   it live from the approvals themselves, so it disappears when the approval is resolved and can never
 *   go stale. Two sources for one fact would be worse than one.
 */
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import type { Database } from "../db/client.js";
import type { DrizzleTransaction } from "../events/emit.js";
import { agentDefinitions, events, goals, runs } from "../db/schema.js";
import { recordNotices } from "../workplace/workplace.js";

/** Who a notice can be addressed to. `operator` is the human at the Keep, matching the actor convention. */
export const OPERATOR = "operator";

/** How far back a single sweep will ever look, however long the Keep was off. */
export const LOOKBACK_HOURS = 24;
/** Events examined in one pass. Bounded so a busy Keep never scans without limit. */
export const SCAN_LIMIT = 500;

type EventRow = { id: string; eventType: string; goalId: string | null; runId: string | null; payload: unknown; occurredAt: Date; globalSeq: number };
type Notice = { recipient: string; kind: Parameters<typeof recordNotices>[1][number]["kind"]; title: string; body?: string; goalId?: string | null; meetingId?: string | null };

const text = (v: unknown, max = 160): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * One event, zero or more notices. `ctx` supplies only what the runtime already knows: the goal's title
 * and the agent a run belonged to. Anything it cannot resolve is left out of the words rather than guessed.
 */
type Ctx = { goalTitle: (goalId: string | null) => string | null; agentOfRun: (runId: string | null) => string | null };

export const NOTICES: Readonly<Record<string, (e: EventRow, ctx: Ctx) => Notice[]>> = Object.freeze({
  run_failed: (e, ctx) => {
    const p = (e.payload ?? {}) as { reason?: unknown };
    const who = ctx.agentOfRun(e.runId);
    const why = text(p.reason, 120);
    return [
      {
        recipient: OPERATOR,
        kind: "task_failed",
        title: `${who ?? "A task"} failed${why ? ` — ${why}` : ""}`,
        body: ctx.goalTitle(e.goalId) ?? "",
        goalId: e.goalId,
      },
    ];
  },
  goal_completed: (e, ctx) => [{ recipient: OPERATOR, kind: "mission_completed", title: `Completed: ${ctx.goalTitle(e.goalId) ?? "a goal"}`, goalId: e.goalId }],
  goal_failed: (e, ctx) => [{ recipient: OPERATOR, kind: "mission_failed", title: `Failed: ${ctx.goalTitle(e.goalId) ?? "a goal"}`, goalId: e.goalId }],
  manager_recovery_started: (e, ctx) => {
    const p = (e.payload ?? {}) as { failures?: { code?: unknown }[] };
    const codes = (p.failures ?? []).map((f) => text(f.code, 40)).filter(Boolean).join(", ");
    return [{ recipient: OPERATOR, kind: "mission_recovered", title: `Recovering: ${ctx.goalTitle(e.goalId) ?? "a mission"}${codes ? ` (${codes})` : ""}`, goalId: e.goalId }];
  },
  meeting_convened: (e) => {
    const p = (e.payload ?? {}) as { meetingId?: unknown };
    return [{ recipient: OPERATOR, kind: "meeting_held", title: "A meeting was held", meetingId: text(p.meetingId, 64) || null, goalId: e.goalId }];
  },
  meeting_not_convened: (e) => {
    const p = (e.payload ?? {}) as { meetingId?: unknown; reason?: unknown };
    return [{ recipient: OPERATOR, kind: "meeting_not_held", title: `A meeting could not be held — ${text(p.reason, 120) || "no reason recorded"}`, meetingId: text(p.meetingId, 64) || null }];
  },
  meeting_closed: (e) => {
    const p = (e.payload ?? {}) as { meetingId?: unknown; decisions?: unknown };
    const n = typeof p.decisions === "number" ? p.decisions : 0;
    return [{ recipient: OPERATOR, kind: "decision_recorded", title: n > 0 ? `A meeting recorded ${n} decision(s)` : "A meeting ended with no decision", meetingId: text(p.meetingId, 64) || null }];
  },
  meeting_action_started: (e, ctx) => {
    const p = (e.payload ?? {}) as { meetingId?: unknown; text?: unknown };
    return [
      {
        recipient: OPERATOR,
        kind: "follow_up_created",
        title: `Follow-up started: ${text(p.text, 120) || ctx.goalTitle(e.goalId) || "a decision"}`,
        meetingId: text(p.meetingId, 64) || null,
        goalId: e.goalId,
      },
    ];
  },
});

/** The events this module can turn into a notice. Anything else is left alone. */
export const NOTIFIED_EVENT_TYPES = Object.keys(NOTICES);

/**
 * Derive the notices that are missing, once. Bounded by `SCAN_LIMIT` and by the window described above.
 * Returns how many were written — 0 on a quiet Keep, and 0 again on a re-run over the same events.
 */
export async function deriveOperationalNotices(tx: DrizzleTransaction, now = new Date()): Promise<number> {
  const floor = new Date(now.getTime() - LOOKBACK_HOURS * 3_600_000);
  const rows = (await tx
    .select({ id: events.id, eventType: events.eventType, goalId: events.goalId, runId: events.runId, payload: events.payload, occurredAt: events.occurredAt, globalSeq: events.globalSeq })
    .from(events)
    .where(and(inArray(events.eventType, NOTIFIED_EVENT_TYPES), gt(events.occurredAt, floor)))
    .orderBy(asc(events.globalSeq))
    .limit(SCAN_LIMIT)) as EventRow[];

  // Resolve the few names the words need, once, rather than per event.
  const goalIds = [...new Set(rows.map((r) => r.goalId).filter((x): x is string => x !== null))];
  const runIds = [...new Set(rows.map((r) => r.runId).filter((x): x is string => x !== null))];
  const goalTitles = new Map(goalIds.length ? (await tx.select({ id: goals.id, title: goals.title }).from(goals).where(inArray(goals.id, goalIds))).map((g) => [g.id, g.title]) : []);
  const runAgents = new Map(
    runIds.length
      ? (
          await tx
            .select({ id: runs.id, name: agentDefinitions.name })
            .from(runs)
            .leftJoin(agentDefinitions, eq(agentDefinitions.id, runs.agentDefinitionId))
            .where(inArray(runs.id, runIds))
        ).map((r) => [r.id, r.name])
      : []
  );
  const ctx: Ctx = { goalTitle: (id) => (id ? goalTitles.get(id) ?? null : null), agentOfRun: (id) => (id ? runAgents.get(id) ?? null : null) };

  const pending: Parameters<typeof recordNotices>[1] = [];
  for (const row of rows) {
    for (const notice of NOTICES[row.eventType]!(row, ctx)) {
      pending.push({ ...notice, sender: "runtime", idempotencyKey: `${notice.kind}:${row.id}:${notice.recipient}` });
    }
  }
  pending.push(...(await overdueNotices(tx, now)));
  if (pending.length === 0) return 0;
  await recordNotices(tx, pending, now);
  return pending.length;
}

/**
 * The one notice the clock writes rather than an event: a goal whose `due_at` has passed and which has
 * not finished. Written once per goal (the key names no event), and only while the goal is still open —
 * a goal that completed late is history, not an alert.
 */
async function overdueNotices(tx: DrizzleTransaction, now: Date): Promise<Parameters<typeof recordNotices>[1]> {
  const overdue = await tx
    .select({ id: goals.id, title: goals.title, dueAt: goals.dueAt })
    .from(goals)
    .where(and(isNotNull(goals.dueAt), lt(goals.dueAt, now), isNull(goals.archivedAt), eq(goals.status, "active")))
    .orderBy(desc(goals.dueAt))
    .limit(50);
  return overdue.map((g) => ({
    recipient: OPERATOR,
    kind: "goal_overdue" as const,
    title: `Overdue: ${g.title.slice(0, 120)}`,
    body: `Due at ${g.dueAt!.toISOString()}. It is still active — being late is not a failure.`,
    goalId: g.id,
    sender: "runtime",
    idempotencyKey: `goal_overdue:${g.id}`,
  }));
}

/** `deriveOperationalNotices` in its own transaction, for the sweep in `api/start.ts`. */
export function sweepOperationalNotices(db: Database, now = new Date()): Promise<number> {
  return db.transaction((tx) => deriveOperationalNotices(tx as unknown as DrizzleTransaction, now));
}
