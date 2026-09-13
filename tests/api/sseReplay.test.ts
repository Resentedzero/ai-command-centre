/**
 * Unit 10's "SSE replay-then-live" test (task-10-brief.md's "Tests
 * required" — Codex-reviewability note: the mid-replay variant is the
 * specific thing to scrutinize).
 *
 * `app.inject()` is NOT used here (unlike `routes.integration.test.ts`):
 * `inject()` buffers the whole response and resolves only once it ends, but
 * an SSE response never ends on its own — so this suite binds a real port
 * (`listen({port: 0})`) and reads the HTTP response body incrementally via
 * the platform `fetch`/`ReadableStream` APIs, exactly like a real SSE
 * client would.
 *
 * Each `it()` gets a FRESH, empty `events` table (`resetTestSchema()` in
 * `beforeEach`) rather than sharing one across the file: this route's
 * Postgres replay query is global (`globalSeq > N` — see
 * `../../src/api/routes/events.ts`'s header), so two tests sharing one
 * events table would otherwise contaminate each other's cursor ranges.
 * `resetTestSchema()` drops the `public` schema outright, which drops the
 * `events_global_seq_seq` sequence with it, so every test's cursors really
 * do start back at 1.
 *
 * Final-review Finding 3 (see the last two `describe` blocks): the replay
 * cursor is `globalSeq`, a genuinely globally-monotonic column, NOT the
 * per-`runId` `sequenceNo`. The two-run tests at the bottom of this file are
 * regression tests for the exact bug that distinction fixes.
 *
 * The mid-replay race is driven through `sseTestHooks.afterReplayRow`
 * (`../../src/api/routes/events.ts`) — a deterministic synchronization seam,
 * not a timing-based sleep — to make the interleaving point exact and
 * reproducible: it fires synchronously between two specific replayed rows,
 * exactly where a live event would need to land to test whether the
 * subscribe-then-query ordering (this route's steps 1-2) actually prevents
 * it from being lost.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { eq, gt } from "drizzle-orm";
import { closeTestDb, resetTestSchema, testDb } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import { events } from "../../src/db/schema.js";
import { emitEvent } from "../../src/events/emit.js";
import type { EventEnvelope } from "../../src/events/types.js";
import { publishLiveEvent } from "../../src/api/eventBus.js";
import { rowToEventEnvelope } from "../../src/api/eventEnvelopeRow.js";
import { buildServer } from "../../src/api/server.js";
import { sseTestHooks } from "../../src/api/routes/events.js";

// Fix round 2, Important #2: mocked ONLY for the new "real relay path" test
// below, which is the one test in this file that exercises POST /goals (and
// therefore Task A's real llm step) end to end — same Ruling 4 convention as
// tests/api/routes.integration.test.ts.
vi.mock("../../src/router/providers/anthropic.js", () => ({
  callAnthropicModel: vi.fn(),
}));
vi.mock("../../src/router/providers/openai.js", () => ({
  callOpenAiModel: vi.fn(),
}));

import { callAnthropicModel } from "../../src/router/providers/anthropic.js";
import { seedPublishWorkflow } from "../../src/definitions/seed.js";

let app: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  app = buildServer({ db: testDb });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 30000);

beforeEach(async () => {
  await resetTestSchema();
  sseTestHooks.afterReplayRow = null;
});

afterEach(() => {
  sseTestHooks.afterReplayRow = null;
  vi.clearAllMocks();
});

function mockLlmOnce(reportText: string): void {
  vi.mocked(callAnthropicModel).mockResolvedValueOnce({
    result: { report: reportText },
    usage: { tokensIn: 100, tokensOut: 50, costAmount: 0.001 },
  });
}

afterAll(async () => {
  await app.close();
  await closeTestDb();
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function seedEvents(count: number): Promise<void> {
  await testDb.transaction(async (tx) => {
    for (let i = 1; i <= count; i++) {
      await emitEvent(tx, {
        idempotencyKey: `sse-seed-${i}-${randomUUID()}`,
        eventType: "test_seed_event",
        eventVersion: 1,
        causationId: null,
        correlation: { goalId: null, workflowRunId: null, taskInstanceId: null, runId: null, invocationId: null },
        actor: "system",
        producer: "test",
        payload: { n: i },
        usage: null,
      });
    }
  });
}

/**
 * Mirrors what `../../src/api/liveEventRelay.ts` does in production: publish
 * only AFTER the emitting transaction has committed, and publish the envelope
 * produced by re-reading the committed ROW through `rowToEventEnvelope` —
 * not `emitEvent`'s own return value.
 *
 * Finding 3 note: that re-read is now load-bearing rather than cosmetic.
 * `emitEvent` returns a plain `EventEnvelope` (Unit 1, frozen — it has no
 * `eventCursor`), while the live/replay WIRE envelope carries the cursor;
 * only `rowToEventEnvelope` produces the latter. Publishing `emitEvent`'s
 * return value directly, as this helper used to, would put a cursor-less
 * envelope on the live bus — which is precisely the divergence between the
 * live path and the replay path that this test file exists to catch.
 */
async function emitAndPublishLive(n: number, runId: string | null = null): Promise<EventEnvelope> {
  const envelope = await testDb.transaction((tx) =>
    emitEvent(tx, {
      idempotencyKey: `sse-live-${n}-${randomUUID()}`,
      eventType: "test_live_event",
      eventVersion: 1,
      causationId: null,
      correlation: { goalId: null, workflowRunId: null, taskInstanceId: null, runId, invocationId: null },
      actor: "system",
      producer: "test",
      payload: { n },
      usage: null,
    })
  );
  const row = await testDb.query.events.findFirst({ where: eq(events.id, envelope.eventId) });
  publishLiveEvent(rowToEventEnvelope(row!));
  return envelope;
}

/** The strong "no duplication, nothing missing" check: the client's received count must equal the DB's own count of everything past the cursor, not merely "nothing more arrived within a timeout." */
async function countEventsSince(sinceEventCursor: number): Promise<number> {
  const rows = await testDb.select({ id: events.id }).from(events).where(gt(events.globalSeq, sinceEventCursor));
  return rows.length;
}

/** The `globalSeq` cursor Postgres actually assigned to a committed event — the value a client would resume from. */
async function cursorOf(eventId: string): Promise<number> {
  const row = await testDb.query.events.findFirst({ where: eq(events.id, eventId) });
  if (!row) throw new Error(`cursorOf: no events row for id "${eventId}"`);
  return row.globalSeq;
}

/** One FK-valid `runs` row (project -> taskDefinition -> taskInstance -> run), so events can carry a real, non-null `runId`. */
async function seedRunChain(label: string): Promise<string> {
  return testDb.transaction(async (tx) => {
    const [project] = await tx.insert(schema.projects).values({ name: `sse-project-${label}` }).returning();
    const [taskDefinition] = await tx
      .insert(schema.taskDefinitions)
      .values({ name: `sse-task-${label}`, kind: "standalone", version: 1 })
      .returning();
    const [taskInstance] = await tx
      .insert(schema.taskInstances)
      .values({
        taskDefinitionId: taskDefinition!.id,
        taskDefinitionVersion: 1,
        projectId: project!.id,
        status: "pending",
      })
      .returning();
    const [run] = await tx.insert(schema.runs).values({ taskInstanceId: taskInstance!.id, status: "active" }).returning();
    return run!.id;
  });
}

/**
 * Emits `count` events correlated to `runId`. Each run gets its OWN
 * `sequenceNo` counter starting back at 1 (Phase 8.1, `emitEvent`'s
 * documented per-`runId` scoping) — which is exactly the precondition
 * Finding 3's bug depends on.
 */
async function seedRunEvents(runId: string, count: number): Promise<EventEnvelope[]> {
  return testDb.transaction(async (tx) => {
    const emitted: EventEnvelope[] = [];
    for (let i = 1; i <= count; i++) {
      emitted.push(
        await emitEvent(tx, {
          idempotencyKey: `sse-run-${runId}-${i}`,
          eventType: "test_run_event",
          eventVersion: 1,
          causationId: null,
          correlation: { goalId: null, workflowRunId: null, taskInstanceId: null, runId, invocationId: null },
          actor: "system",
          producer: "test",
          payload: { n: i },
          usage: null,
        })
      );
    }
    return emitted;
  });
}

type ParsedMessage = {
  eventId: string;
  sequenceNo: number;
  eventCursor: number;
  eventType: string;
  correlation: { runId: string | null; workflowRunId: string | null; taskInstanceId: string | null; invocationId: string | null };
  payload: Record<string, unknown>;
};

class SseClient {
  private reader!: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder();
  private buffer = "";
  private controller = new AbortController();
  readonly events: ParsedMessage[] = [];

  static async connect(url: string): Promise<SseClient> {
    const client = new SseClient();
    const response = await fetch(url, { signal: client.controller.signal });
    if (!response.body) throw new Error("SseClient.connect: response has no body");
    client.reader = response.body.getReader();
    return client;
  }

  private async pumpOnce(): Promise<boolean> {
    const { value, done } = await this.reader.read();
    if (done) return false;
    this.buffer += this.decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = this.buffer.indexOf("\n\n")) !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
      if (dataLine) {
        this.events.push(JSON.parse(dataLine.slice("data: ".length)) as ParsedMessage);
      }
    }
    return true;
  }

  async waitForCount(count: number, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.events.length < count) {
      if (Date.now() > deadline) {
        throw new Error(`SseClient: timed out waiting for ${count} messages; got ${this.events.length}: ${JSON.stringify(this.events)}`);
      }
      const more = await this.pumpOnce();
      if (!more) break;
    }
  }

  /** Polls until `predicate()` is true, rather than pinning an exact message count — used where the exact number of events an operation emits is an implementation detail this test shouldn't pin. */
  async waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error(`SseClient: timed out waiting for condition; got ${this.events.length} messages: ${JSON.stringify(this.events)}`);
      }
      const more = await this.pumpOnce();
      if (!more) break;
    }
  }

  close(): void {
    this.controller.abort();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// NOTE on the two `seedEvents(10)` suites below: they emit every event with
// `runId: null`, i.e. into `emitEvent`'s single shared "no run" bucket, so
// each event's per-run `sequenceNo` and its global `eventCursor` coincide
// (1..10) on a freshly reset schema. Their `sequenceNo` assertions are
// therefore still exactly as meaningful as before Finding 3's fix; only the
// query-parameter NAME changed (`sinceSequenceNo` -> `sinceEventCursor`),
// which is a mechanical adaptation to the renamed route contract, not a
// relaxation of what these two tests prove. The genuinely cross-run cases —
// where the two values diverge and the old behaviour was wrong — are the two
// new suites at the bottom of this file.

describe("GET /events/stream — replay then live (simple case)", () => {
  it("replays events 6-10 for sinceEventCursor=5, then delivers a new live event exactly once", async () => {
    await seedEvents(10);

    const client = await SseClient.connect(`${baseUrl}/events/stream?sinceEventCursor=5`);
    try {
      await client.waitForCount(5);
      expect(client.events.map((e) => e.sequenceNo)).toEqual([6, 7, 8, 9, 10]);

      const eleven = await emitAndPublishLive(11);
      await client.waitForCount(6);
      expect(client.events[5]?.sequenceNo).toBe(11);
      expect(client.events[5]?.eventId).toBe(eleven.eventId);

      // Strong "no duplication, nothing missing" check: the client's total
      // received count equals the DB's own total count of everything past
      // the cursor — not merely "nothing more arrived within a timeout."
      const expectedTotal = await countEventsSince(5);
      expect(client.events).toHaveLength(expectedTotal);
      expect(new Set(client.events.map((e) => e.eventId)).size).toBe(expectedTotal);
    } finally {
      client.close();
    }
  });
});

describe("GET /events/stream — mid-replay race (subscribe-then-query correctness)", () => {
  it("a live event emitted WHILE replay is still streaming earlier rows arrives exactly once — not lost, not duplicated", async () => {
    await seedEvents(10);

    let elevenId: string | null = null;
    sseTestHooks.afterReplayRow = async (rowIndex) => {
      // rowIndex 2 == the 3rd replayed row (sequenceNo 8 of 6..10) — well
      // before step 2's loop finishes, simulating a Run's Event committing
      // to Postgres AFTER this request's replay SELECT already executed
      // (so it can NEVER appear in the replay result) but BEFORE step 3's
      // buffer flush. Only the subscribe-BEFORE-query ordering (step 1
      // before step 2) can save this event from being lost.
      if (rowIndex === 2 && elevenId === null) {
        const eleven = await emitAndPublishLive(11);
        elevenId = eleven.eventId;
      }
    };

    const client = await SseClient.connect(`${baseUrl}/events/stream?sinceEventCursor=5`);
    try {
      await client.waitForCount(6); // 6,7,8,9,10 replayed + 11 delivered live, flushed after replay
      expect(client.events.map((e) => e.sequenceNo)).toEqual([6, 7, 8, 9, 10, 11]);
      expect(client.events[5]?.eventId).toBe(elevenId);

      // Uniqueness: 11 was NOT part of the replay's own SELECT result (it
      // didn't exist yet when that query ran) — it can only have arrived
      // via the live buffer, exactly once.
      const ids = client.events.map((e) => e.eventId);
      expect(new Set(ids).size).toBe(ids.length);

      // Strong "no duplication, nothing missing" check (same as the simple
      // case above): the client's total equals the DB's own total past the
      // cursor — not merely "nothing more arrived within a timeout."
      const expectedTotal = await countEventsSince(5);
      expect(client.events).toHaveLength(expectedTotal);
    } finally {
      client.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Fix round 2, Important #2: the relay mechanism itself
// (`../../src/api/liveEventRelay.ts`'s `runWorkflowMutationAndRelay`) had
// zero test coverage — every test above calls `publishLiveEvent` directly
// with `emitEvent`'s own return value, bypassing BOTH the relay's
// watermark-diff logic AND this API layer's own `rowToEventEnvelope`
// mapper entirely. This test exercises the REAL path: a real `POST /goals`
// request (driving real events deep inside `authorizeRoute`/`callModel`,
// exactly the case the relay design exists for), with nothing publishing
// live events except the production relay code itself.
// ---------------------------------------------------------------------------

describe("GET /events/stream — real relay path (runWorkflowMutationAndRelay, not test-simulated)", () => {
  it("delivers both Task A's and Task B's events live, through the real relay, when POST /goals runs on the same server", async () => {
    await testDb.transaction((tx) => seedPublishWorkflow(tx));
    mockLlmOnce("live relay path report");

    const client = await SseClient.connect(`${baseUrl}/events/stream?sinceEventCursor=0`);
    try {
      const goalRes = await fetch(`${baseUrl}/goals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Live relay path Goal" }),
      });
      expect(goalRes.status).toBe(201);
      const created = (await goalRes.json()) as { goalId: string; workflowRunId: string; status: string };
      // Fix round 1's bounded loop drives this single request all the way
      // to Task B's awaiting_approval gate.
      expect(created.status).toBe("in_progress");

      // Don't pin an exact event count (an internal implementation detail
      // of exactly how many events each step emits) — wait until events
      // from TWO distinct runs have arrived live: Task A's run (created,
      // completed) and Task B's run (created, halted awaiting_approval).
      // This is only possible if the relay's per-workflow-run enumeration
      // (fix round 2, Important #3) actually re-discovers BOTH runs after
      // the single transaction that created them both.
      await client.waitUntil(() => {
        const runIds = new Set(client.events.map((e) => e.correlation.runId).filter((id): id is string => id !== null));
        return runIds.size >= 2;
      }, 10000);

      const runIds = new Set(client.events.map((e) => e.correlation.runId).filter((id): id is string => id !== null));
      expect(runIds.size).toBe(2);

      // Every live-delivered event actually belongs to a `runs` row under
      // THIS workflow run (the relay didn't leak some other run's events).
      const taskInstanceRows = await testDb.query.taskInstances.findMany({
        where: eq(schema.taskInstances.workflowRunId, created.workflowRunId),
      });
      expect(taskInstanceRows).toHaveLength(2);
      const validRunIds = new Set<string>();
      for (const taskInstance of taskInstanceRows) {
        const run = await testDb.query.runs.findFirst({ where: eq(schema.runs.taskInstanceId, taskInstance.id) });
        if (run) validRunIds.add(run.id);
      }
      for (const runId of runIds) {
        expect(validRunIds.has(runId)).toBe(true);
      }

      // No duplicates delivered live, and every envelope round-tripped
      // through the real `rowToEventEnvelope` mapper has the expected shape
      // (this is that mapper's first real execution in this test suite).
      const ids = client.events.map((e) => e.eventId);
      expect(new Set(ids).size).toBe(ids.length);
      for (const event of client.events) {
        expect(typeof event.eventType).toBe("string");
        expect(event.eventType.length).toBeGreaterThan(0);
      }
    } finally {
      client.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Final-review Finding 3: the replay cursor must be globally monotonic, NOT
// the per-`runId` `sequenceNo`.
//
// Both suites below seed TWO runs, each with its own `sequenceNo` counter
// restarting at 1 — the situation a single `POST /goals` really produces (one
// request drives `advanceWorkflowRunUntilBlocked`, which creates Task A's run
// AND Task B's run). Against the old `gt(events.sequenceNo, N)` replay query
// these fail outright; they are regression tests for that exact query, not
// tests of code written alongside them.
// ---------------------------------------------------------------------------

describe("GET /events/stream — Finding 3: replay across two runs whose sequenceNos collide", () => {
  it("replays ALL of run 2's events for a cursor positioned after run 1's last event, skipping none", async () => {
    const runA = await seedRunChain("a");
    const runB = await seedRunChain("b");
    const aEvents = await seedRunEvents(runA, 3);
    const bEvents = await seedRunEvents(runB, 3);

    // The precondition the whole bug rests on: run B's events carry per-run
    // sequence numbers 1,2,3 — identical to run A's, and all <= the cursor a
    // client would hold after run A. A `sequenceNo > 3` query returns NONE of
    // them; every one of run B's events would be silently lost forever.
    expect(aEvents.map((e) => e.sequenceNo)).toEqual([1, 2, 3]);
    expect(bEvents.map((e) => e.sequenceNo)).toEqual([1, 2, 3]);

    const cursorAfterRunA = await cursorOf(aEvents[2]!.eventId);

    const client = await SseClient.connect(`${baseUrl}/events/stream?sinceEventCursor=${cursorAfterRunA}`);
    try {
      await client.waitForCount(3);

      // Exactly run B's three events, in order, and nothing else.
      expect(client.events.map((e) => e.eventId)).toEqual(bEvents.map((e) => e.eventId));
      expect(client.events.map((e) => e.correlation.runId)).toEqual([runB, runB, runB]);

      // None of run A's events were re-delivered...
      const aIds = new Set(aEvents.map((e) => e.eventId));
      expect(client.events.some((e) => aIds.has(e.eventId))).toBe(false);

      // ...and the cursor really is the globally-monotonic column, not
      // `sequenceNo`: run B's events still report per-run sequenceNo 1,2,3
      // (unchanged, per Phase 8.1) while their cursors strictly increase past
      // run A's. These two fields are deliberately NOT the same number.
      expect(client.events.map((e) => e.sequenceNo)).toEqual([1, 2, 3]);
      for (const event of client.events) {
        expect(event.eventCursor).toBeGreaterThan(cursorAfterRunA);
      }

      // Strong "nothing missing, nothing duplicated" check against the DB's
      // own count past that cursor.
      const expectedTotal = await countEventsSince(cursorAfterRunA);
      expect(client.events).toHaveLength(expectedTotal);
      expect(new Set(client.events.map((e) => e.eventId)).size).toBe(expectedTotal);
    } finally {
      client.close();
    }
  });
});

describe("GET /events/stream — Finding 3: reconnect mid-way through run 2 re-delivers nothing", () => {
  it("resuming at the max cursor seen delivers only what follows it — never run 1's already-seen events again", async () => {
    const runA = await seedRunChain("a");
    const runB = await seedRunChain("b");
    const aEvents = await seedRunEvents(runA, 3);
    const bEvents = await seedRunEvents(runB, 3);

    // First connection: the client sees everything up to and including run
    // B's SECOND event, then the connection drops.
    const firstClient = await SseClient.connect(`${baseUrl}/events/stream?sinceEventCursor=0`);
    let seenIds: string[];
    let resumeCursor: number;
    try {
      await firstClient.waitForCount(6);
      seenIds = firstClient.events.slice(0, 5).map((e) => e.eventId);
      // The max cursor across everything actually rendered — which is what
      // `web/lib/api.ts`'s `subscribeToActivity` now tracks.
      resumeCursor = Math.max(...firstClient.events.slice(0, 5).map((e) => e.eventCursor));
    } finally {
      firstClient.close();
    }

    expect(seenIds).toEqual([...aEvents.map((e) => e.eventId), bEvents[0]!.eventId, bEvents[1]!.eventId]);
    // A client tracking the per-run `sequenceNo` of the last event it received
    // would be holding 2 here (run B's second event) — and a `sequenceNo > 2`
    // replay would hand back run A's THIRD event all over again. That is the
    // duplication half of Finding 3.
    expect(bEvents[1]!.sequenceNo).toBe(2);

    const secondClient = await SseClient.connect(`${baseUrl}/events/stream?sinceEventCursor=${resumeCursor}`);
    try {
      await secondClient.waitForCount(1);

      expect(secondClient.events.map((e) => e.eventId)).toEqual([bEvents[2]!.eventId]);

      // Nothing the first connection already rendered came back.
      const alreadySeen = new Set(seenIds);
      expect(secondClient.events.some((e) => alreadySeen.has(e.eventId))).toBe(false);

      const expectedTotal = await countEventsSince(resumeCursor);
      expect(secondClient.events).toHaveLength(expectedTotal);
    } finally {
      secondClient.close();
    }
  });
});
