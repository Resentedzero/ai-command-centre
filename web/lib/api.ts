/**
 * The ONLY module in this app allowed to talk to anything outside the
 * browser. Every function here calls the Unit 10 API over HTTP — nothing in
 * `web/` may import from `src/db/*`, `src/governance/*`, `src/router/*`,
 * `src/execution/*`, or `src/workflow/*` (see task-11-brief.md's IMPORTANT
 * constraints); if a feature seems to need one of those, it needs a new API
 * route instead (see Unit 11's Ruling 1, `src/api/routes/agents.ts`, for the
 * one precedent this unit itself added).
 *
 * ---------------------------------------------------------------------------
 * API_BASE_URL (Ruling 7)
 * ---------------------------------------------------------------------------
 * `src/api/start.ts:19` binds the API on `Number(process.env.PORT ?? 3000)`,
 * and this repo's `.env` sets no `PORT` — so the API's real local default is
 * `http://localhost:3000`, NOT the `:3001` the brief used as a placeholder
 * example. That default is used as the fallback here, overridable via
 * `NEXT_PUBLIC_API_BASE_URL` (the `NEXT_PUBLIC_` prefix is required for a
 * Next.js env var to be readable in browser-rendered code, which
 * `subscribeToActivity`'s `EventSource` usage below needs).
 *
 * That also means Next's own literal default dev port (3000) COLLIDES with
 * the API's default port — that's why `web/package.json`'s `dev` script
 * explicitly binds Next to `:3100` instead (`next dev -p 3100`), and why
 * `src/api/server.ts`'s CORS origin defaults to `http://localhost:3100` to
 * match. Documented here once since it's the reason this constant and that
 * script disagree with the brief's own port-number examples.
 */
const DEFAULT_API_BASE_URL = "http://localhost:3000";
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? DEFAULT_API_BASE_URL;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Mirrors `src/api/routes/agents.ts`'s `ActiveAgentData` exactly (Unit 11's
 * own new route — see that file's header for the join/status-vocabulary
 * reasoning). No revenue stat: there is no revenue projection anywhere in
 * this MVP (task-11-brief.md's "Out of scope"), so this type simply never
 * has one to render.
 */
export type AgentCardData = {
  agentDefinitionId: string | null;
  agentName: string;
  runId: string;
  taskInstanceId: string;
  taskStatus: string;
  latestActivitySummary: string | null;
};

/**
 * Mirrors `GET /approvals`'s actual, documented response shape exactly: raw
 * `approvals` table rows (Unit 10's own accepted MVP simplification — see
 * `src/api/routes/approvals.ts`), JSON-serialized. Drizzle's `timestamp`
 * columns become ISO date strings over the wire, not `Date` objects — hence
 * `string | null` here rather than `Date | null`.
 */
export type ApprovalData = {
  id: string;
  invocationId: string;
  proposedActionSnapshot: Record<string, unknown>;
  riskTier: string;
  status: "pending" | "approved" | "rejected" | "expired";
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  ttl: string | null;
};

/**
 * This UI's OWN display type (Ruling 5), derived from `src/events/types.ts`'s
 * `EventEnvelope` but NOT importing it — `web/` is fully self-contained (no
 * compile-time coupling to the backend's `src/` tree either), and this type
 * only needs the handful of fields an activity feed actually renders.
 * `summary` is derived from `eventType` + a best-effort rendering of any
 * primitive-valued `payload` fields (see `summarizeEvent` below) — `payload`
 * is documented as NOT a discriminated union (`src/events/types.ts`), so no
 * field is guaranteed present across every `eventType`.
 */
export type EventDisplayItem = {
  eventId: string;
  eventType: string;
  occurredAt: string;
  /** Per-`runId` causal order (Phase 8.1). Display/ordering-within-a-run only — NEVER a resume position; see `subscribeToActivity`. */
  sequenceNo: number;
  /** Globally monotonic across all runs — the value a reconnect resumes from. */
  eventCursor: number;
  summary: string;
};

/** The wire shape of one SSE message's `data:` payload — a JSON-serialized `WireEventEnvelope` (`src/api/eventEnvelopeRow.ts`), independently declared per the note above. Only the fields `toEventDisplayItem` actually uses. */
type RawEventEnvelope = {
  eventId: string;
  eventType: string;
  occurredAt: string;
  sequenceNo: number;
  eventCursor: number;
  payload: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    throw new Error(`API request failed: ${init?.method ?? "GET"} ${path} -> ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  return (text.length > 0 ? JSON.parse(text) : undefined) as T;
}

export async function listActiveAgents(): Promise<AgentCardData[]> {
  const data = await apiFetch<{ agents: AgentCardData[] }>("/agents/active");
  return data.agents;
}

export async function listPendingApprovals(): Promise<ApprovalData[]> {
  const data = await apiFetch<{ approvals: ApprovalData[] }>("/approvals");
  return data.approvals;
}

/** No client-side policy logic — just a pass-through POST, per the brief's constraints. */
export async function approveApproval(id: string): Promise<void> {
  await apiFetch<unknown>(`/approvals/${encodeURIComponent(id)}/approve`, { method: "POST" });
}

/** No client-side policy logic — just a pass-through POST, per the brief's constraints. */
export async function rejectApproval(id: string): Promise<void> {
  await apiFetch<unknown>(`/approvals/${encodeURIComponent(id)}/reject`, { method: "POST" });
}

// ---------------------------------------------------------------------------
// subscribeToActivity (Ruling 5)
// ---------------------------------------------------------------------------

/**
 * Best-effort, generically-safe summary: `eventType` always exists; a small
 * number of primitive-valued `payload` fields are appended for extra
 * context, when present, without assuming any particular field exists
 * (mirrors `src/api/routes/agents.ts`'s own `eventType`-only reasoning, with
 * this bit of extra detail being acceptable here since it's presentation
 * only, not something anything downstream depends on being stable).
 */
function summarizeEvent(raw: RawEventEnvelope): string {
  const payload = raw.payload ?? {};
  const parts = Object.entries(payload)
    .filter((entry): entry is [string, string | number | boolean] => {
      const value = entry[1];
      return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
    })
    .slice(0, 3)
    .map(([key, value]) => `${key}=${String(value)}`);
  return parts.length > 0 ? `${raw.eventType} (${parts.join(", ")})` : raw.eventType;
}

function toEventDisplayItem(raw: RawEventEnvelope): EventDisplayItem {
  return {
    eventId: raw.eventId,
    eventType: raw.eventType,
    occurredAt: raw.occurredAt,
    sequenceNo: raw.sequenceNo,
    eventCursor: raw.eventCursor,
    summary: summarizeEvent(raw),
  };
}

/**
 * Subscribes to `GET /events/stream`, matching Unit 10's replay-then-live
 * contract exactly. Reconnect (Ruling 5) is handled ENTIRELY inside this
 * function: the resume cursor is tracked in a closure variable, and on the
 * underlying `EventSource`'s `onerror` (connection dropped), that
 * `EventSource` is explicitly closed and a brand NEW one is opened against
 * `?sinceEventCursor=<maxSeen>` — the browser's native same-URL
 * auto-reconnect is never relied on, since this endpoint's reconnect
 * contract is the query parameter, not `Last-Event-ID`.
 *
 * This means the interface's caller (e.g. `ActivityFeed`) calls this
 * function exactly ONCE and keeps receiving events across any number of
 * reconnects — the returned unsubscribe function is the only handle it
 * needs. The `(sinceEventCursor, onEvent)` signature has no "connection
 * dropped" callback, so there is no way for a CALLER to itself decide when
 * to re-subscribe; ownership of reconnect has to live here.
 *
 * ---------------------------------------------------------------------------
 * Two Finding-3 corrections, both load-bearing
 * ---------------------------------------------------------------------------
 * 1. The cursor is `eventCursor` (globally monotonic across every Run), NOT
 *    the envelope's `sequenceNo` (monotonic only per `run_id` — Phase 8.1).
 *    A single `POST /goals` creates TWO Runs, and the second Run's events
 *    start back at `sequenceNo: 1`. Resuming from a per-run counter therefore
 *    both skipped whole Runs and re-delivered already-rendered events.
 * 2. `maxSeen`, not "last received". Tracking the last-received value lets
 *    the cursor be driven BACKWARDS by any event that arrives out of cursor
 *    order, after which the next reconnect re-replays everything in between —
 *    and the server's per-connection `sentEventIds` de-dup set cannot catch
 *    it, because a reconnect is a brand new connection with a brand new,
 *    empty set, and this client does no de-duplication of its own. Under the
 *    old per-run `sequenceNo` this regression was routine (every new Run
 *    restarted at 1); with a global cursor it is rare but still reachable,
 *    since a sequence guarantees monotonic ASSIGNMENT, not monotonic COMMIT
 *    order. `Math.max` is correct under both, and never regresses.
 */
/**
 * Reconnect backoff: starts at `RECONNECT_BASE_MS`, doubles per consecutive
 * failure up to `RECONNECT_MAX_MS`, and resets once a message proves the
 * connection healthy. Reconnecting instantly on every error hammered a down
 * or at-capacity API (which answers 503 past its open-stream cap) in a tight
 * loop.
 */
export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 15_000;

export function subscribeToActivity(sinceEventCursor: number | null, onEvent: (e: EventDisplayItem) => void): () => void {
  let closed = false;
  let currentSource: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let delayMs = RECONNECT_BASE_MS;
  let maxSeen = sinceEventCursor ?? 0;

  function connect(since: number): void {
    if (closed) return;

    const source = new EventSource(`${API_BASE_URL}/events/stream?sinceEventCursor=${since}`);
    currentSource = source;

    source.onmessage = (message: MessageEvent<string>) => {
      delayMs = RECONNECT_BASE_MS; // healthy again
      const raw = JSON.parse(message.data) as RawEventEnvelope;
      // The HIGHEST cursor seen so far — never merely the most recent one.
      maxSeen = Math.max(maxSeen, raw.eventCursor);
      onEvent(toEventDisplayItem(raw));
    };

    source.onerror = () => {
      source.close();
      if (closed) return;
      const wait = delayMs;
      delayMs = Math.min(delayMs * 2, RECONNECT_MAX_MS);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect(maxSeen);
      }, wait);
    };
  }

  connect(maxSeen);

  return () => {
    closed = true;
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    currentSource?.close();
  };
}
