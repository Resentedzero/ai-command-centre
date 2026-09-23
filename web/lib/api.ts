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
  /** The current Task Instance's mission (spec §15.1 screen 1): its Task Definition name. */
  taskDefinitionName: string | null;
  /** Null for a standalone Task Instance (no Workflow Run to reach a Goal through). */
  goalTitle: string | null;
  latestActivitySummary: string | null;
  /** The Run's Workflow Run and Goal, so a stop at those scopes can be matched. Absent from older API builds. */
  workflowRunId?: string | null;
  /** The Workflow Run's own status (`paused` holds a step whose Task Instance still reads active). Absent from older API builds. */
  workflowRunStatus?: string | null;
  goalId?: string | null;
  /** What the Run is doing now (its latest non-bookkeeping Invocation). Absent from older API builds; null before its first. */
  activity?: { invocationKind: string; invocationStatus: string; capability: string | null; intent: string | null; taskKind?: string | null } | null;
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
  /** What the approval gates and what it would act on, assembled by the API. Optional so older responses still type-check. */
  context?: ApprovalContext;
};

export type ApprovalContext = {
  capabilityName: string | null;
  permission: string | null;
  agent: { name: string; version: number } | null;
  goal: { id: string; title: string } | null;
  workflowRunId: string | null;
  runId: string | null;
  artifact: {
    id: string;
    type: string;
    size: number;
    hash: string;
    /** Model output: always rendered as text, never HTML. */
    preview: string | null;
    truncated: boolean;
    /** Whether the artifact's current content still matches the hash pinned in the snapshot; null when none is pinned. */
    hashMatchesSnapshot: boolean | null;
  } | null;
  /** The Policy evaluation that required this approval (checkpoint `propose`). Absent from older API builds. */
  policyDecision?: PolicyDecisionRecord | null;
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

/**
 * `Content-Type: application/json` only when there IS a body: Fastify answers a
 * JSON-typed request with an empty body 400 (FST_ERR_CTP_EMPTY_JSON_BODY), which
 * made body-less POSTs (approve/reject) always fail. It also keeps GETs simple
 * requests, with no CORS preflight.
 *
 * A failure carries the API's own `{ error }` message when it sends one — e.g.
 * why a 409 was refused — rather than only the status line.
 */
async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
      const message = parsed.error ?? parsed.message;
      // A body that only repeats the status text ("Not Found: Not Found") adds nothing.
      if (typeof message === "string" && message.length > 0 && message !== res.statusText) detail = `${res.statusText}: ${message}`;
    } catch {
      // Not JSON: the status line is all there is.
    }
    throw new Error(`API request failed: ${init?.method ?? "GET"} ${path} -> ${res.status} ${detail}`);
  }
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

/**
 * The decision's outcome. `advanceError` is set when the decision was recorded
 * but advancing the workflow run past it failed — the decision stands.
 */
export type ApprovalResolution = { approvalStatus: string; workflowStatus: string | null; advanceError?: string };

/** No client-side policy logic — just a pass-through POST, per the brief's constraints. */
export async function approveApproval(id: string): Promise<ApprovalResolution> {
  return apiFetch<ApprovalResolution>(`/approvals/${encodeURIComponent(id)}/approve`, { method: "POST" });
}

/** No client-side policy logic — just a pass-through POST, per the brief's constraints. */
export async function rejectApproval(id: string): Promise<ApprovalResolution> {
  return apiFetch<ApprovalResolution>(`/approvals/${encodeURIComponent(id)}/reject`, { method: "POST" });
}

// ---------------------------------------------------------------------------
// Workflow/Task view (spec 15.1 screen 3) — read-only
// ---------------------------------------------------------------------------

export type WorkflowRunSummary = {
  id: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  goal: { id: string; title: string } | null;
  workflowDefinition: { name: string; version: number } | null;
};

export type InvocationDetail = {
  id: string;
  seqNo: number;
  kind: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  failureReason: string | null;
  errorCode: string | null;
  /** Artifacts this Invocation produced; each resolves via `GET /artifacts/:id`. */
  artifactIds: string[];
  /** Policy's latest recorded decision; null for Invocations Policy does not govern (llm, deterministic). Absent from older API builds. */
  policyDecision?: PolicyDecisionRecord | null;
  /**
   * The Budget Governor's outcome for this Invocation, as the runtime recorded it; null when no reservation was
   * made or none is recorded. `downgraded`: authorized one tier lower after a denial; `degraded`: authorized at the
   * same tier with a 75% Context Budget. Display it; never infer it from a failure reason or event order.
   */
  budgetOutcome?: "authorized" | "downgraded" | "degraded" | "denied" | null;
  /** The Model Router's recorded route; null for kinds it does not route. Absent from older API builds. */
  route?: RouteRecord | null;
};

/**
 * The Model Router's recorded route for an LLM Invocation, assembled by the API. `tierSource` is the
 * Router's own record of which rule set the tier (null on routes recorded before it existed);
 * `resultingTier` is null and `attemptedTier` set when the route was refused. Display it; never re-derive it.
 */
export type RouteRecord = {
  defaultTier: string | null;
  escalationFloor: string | null;
  resultingTier: string | null;
  attemptedTier: string | null;
  tierSource: "default" | "escalation_floor" | "performance_preference" | "budget_downgrade" | null;
  attempt: number | null;
  modelId: string | null;
  /** The Budget Governor's one fallback after the routed tier was denied; null when none happened. Absent from older API builds. */
  budgetFallback?: {
    outcome: string | null;
    attemptedOutcome?: string | null;
    fromTier: string | null;
    fromTierSource?: string | null;
    attemptedTier: string | null;
    authorized: boolean | null;
    refusal?: string | null;
    contextBudgetFactor: number | null;
    maxInputTokens: number | null;
  } | null;
  /** The performance rows the Router consulted when it routed, as recorded then. Absent from older API builds. */
  performance?: {
    consulted: boolean;
    reason: string | null;
    rows: { tier: string | null; sampleCount: number | null; successRate: string | null; eligible: boolean | null }[];
  } | null;
};

/**
 * Policy's own record of one evaluation (`policy_evaluated`), assembled by the API.
 * Display it; never derive a decision, threshold or eligibility from it.
 * `basis` says why; null on evaluations recorded before it existed. `conditionalRule` and
 * `performanceEvidence` are what a CONDITIONAL Grant's rule applied and consulted; null otherwise.
 * `autonomy_conditional_rule_undecided` appears only on evaluations recorded before the rule existed.
 */
export type PolicyDecisionRecord = {
  checkpoint: "propose" | "resume" | "pre_dispatch" | null;
  decision: "ALLOW" | "REQUIRE_APPROVAL" | "DENY" | null;
  basis:
    | "no_grant"
    | "permission_not_granted"
    | "binding_below_grant_trust_bar"
    | "autonomy_always_approve"
    | "autonomy_conditional_rule_undecided"
    | "autonomy_autonomous"
    | "autonomy_state_unrecognized"
    | "unverified_binding_requires_approval"
    | "conditional_human_gated_action"
    | "conditional_insufficient_evidence"
    | "conditional_performance_meets_allow_threshold"
    | "conditional_performance_below_allow_threshold"
    | "conditional_performance_below_deny_threshold"
    | null;
  autonomyState: string | null;
  riskTier: string | null;
  grantId: string | null;
  capabilityId: string | null;
  permission: string | null;
  toolBindingId: string | null;
  trustLevel: string | null;
  /** The trust bar Policy applied and the binding's level it compared. */
  maxTrustLevelRequired: number | null;
  bindingTrustLevel: number | null;
  conditionalRule?: {
    id: string | null;
    allowAtOrAboveSuccessRate: number | null;
    requireApprovalAtOrAboveSuccessRate: number | null;
    autoAllowPermissions: string[];
    autoAllowRiskTiers: string[];
  } | null;
  performanceEvidence: {
    agentDefinitionId: string | null;
    agentDefinitionVersion: number | null;
    taskDefinitionId: string | null;
    effectiveTier: string | null;
    sampleCount: number | null;
    successRate: string | null;
    minSamples: number | null;
    eligible: boolean | null;
    eligibilityReason: string | null;
  } | null;
};

/** Amounts are the exact decimal strings the API stores. Units are separate counters and are never summed. */
export type BudgetCounterDetail = {
  resourceUnit: string;
  limitAmount: string;
  reservedAmount: string;
  consumedAmount: string;
};

export type RunDetail = {
  id: string;
  status: string;
  outcomeReason: string | null;
  startedAt: string;
  completedAt: string | null;
  agent: { name: string; version: number } | null;
  invocations: InvocationDetail[];
  budget: BudgetCounterDetail[];
};

export type WorkflowStepDetail = {
  index: number;
  /** `kind` is absent from older API builds. */
  taskDefinition: { id: string; name: string; version: number; kind?: string } | null;
  taskInstance: { id: string; status: string } | null;
  /** The current Run. A Task Instance can have several Runs (retries); see `attempts`. */
  run: RunDetail | null;
  /** Every Run of the step, ordered by attempt (1..3; retries). Absent from older API builds. */
  attempts?: {
    id: string;
    attempt: number;
    /** The Run this one retries and the retry policy's cause (`provider_outcome_unknown`, `output_validation_failed`); null on a first attempt. Absent from older API builds. */
    retryOfRunId?: string | null;
    retryCause?: string | null;
    /** The tier floor a retry after a validation failure carries (§10.4 escalation). */
    minimumModelTier?: string | null;
    status: string;
    outcomeReason: string | null;
    /** Redacted by the API. */
    failureReason: string | null;
    errorCode: string | null;
    startedAt: string;
    completedAt: string | null;
  }[];
};

export type WorkflowRunDetail = {
  workflowRun: { id: string; status: string; createdAt: string; completedAt: string | null };
  goal: { id: string; title: string; description: string | null } | null;
  workflowDefinition: { id: string; name: string; version: number } | null;
  steps: WorkflowStepDetail[];
  /** Why no steps can be shown (definition missing or not a linear graph); null when steps are shown. */
  stepsUnavailableReason: string | null;
};

/** `withinHours`: only current work — unfinished, or finished within that many hours. Absent: every unarchived run. */
export async function listWorkflowRuns(withinHours?: number): Promise<WorkflowRunSummary[]> {
  const data = await apiFetch<{ workflowRuns: WorkflowRunSummary[] }>(`/workflow-runs${withinHours === undefined ? "" : `?within=${withinHours}`}`);
  return data.workflowRuns;
}

export async function getWorkflowRun(id: string): Promise<WorkflowRunDetail> {
  return apiFetch<WorkflowRunDetail>(`/workflow-runs/${encodeURIComponent(id)}`);
}

// ---------------------------------------------------------------------------
// Goals & Projects (spec 15.1 screen 5)
// ---------------------------------------------------------------------------

export type GoalWorkflowRun = { id: string; status: string; createdAt: string; completedAt: string | null };

export type GoalSummary = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  createdAt: string;
  workflowRuns: GoalWorkflowRun[];
};

export type ProjectGoals = { id: string; name: string; description: string | null; goals: GoalSummary[] };

// ---------------------------------------------------------------------------
// Agent Detail (spec 15.1 screen 2)
// ---------------------------------------------------------------------------

export type AgentDetail = {
  agent: { id: string; name: string; version: number; role: string; objective: string; executionProfile?: ExecutionProfile; appearance?: Appearance | null; look?: Appearance };
  /** Measured outcomes summed over every version of this agent's name (display only). Absent from older API builds. */
  performanceAcrossVersions?: { samples: number; successes: number; versions: number };
  activeStop: { id: string; scope: string; scopeRefId: string; reason: string | null; engagedAt: string } | null;
  grants: {
    id: string;
    capabilityId: string;
    capabilityName: string;
    permissions: string[];
    autonomyState: string;
    maxTrustLevelRequired: number;
    revoked: boolean;
  }[];
  runs: {
    runId: string;
    status: string;
    startedAt: string;
    completedAt: string | null;
    outcomeReason: string | null;
    taskInstance: { id: string; status: string } | null;
    taskDefinitionName: string | null;
    workflowRunId: string | null;
    goal: { id: string; title: string } | null;
    latestInvocation: { seqNo: number; kind: string; status: string } | null;
  }[];
  /** Consumption per resource unit. Exact decimal strings; units are never combined. */
  budgetTotals: { resourceUnit: string; consumed: string; reserved: string }[];
  recentEvents: {
    eventId: string;
    eventType: string;
    occurredAt: string;
    runId: string | null;
    invocationId: string | null;
    eventCursor: number;
  }[];
  outputs: { id: string; type: string; size: number; createdAt: string; invocationId: string; runId: string }[];
  contextLineage: {
    invocationId: string | null;
    occurredAt: string;
    intent: string | null;
    estimatedInputTokens: number | null;
    maxInputTokens: number | null;
    /** The ceiling the Compiler packed to. Absent from older API builds. */
    effectiveMaxInputTokens?: number | null;
    /** Set only when the Budget Governor tightened the Task's Context Budget (`downgraded` / `degraded`). */
    budgetOutcome?: string | null;
    taskMaxInputTokens?: number | null;
    included: { id: string; tier: number }[];
    excluded: { id: string; reason: string }[];
  } | null;
  /**
   * This version's `agent_performance` rows, refreshed asynchronously (lags recent
   * Runs). A measurement, shown whatever the sample count. Each row's `eligible` is the
   * runtime's gate (N = 10): an eligible row may steer the Model Router's tier choice.
   * Never rank from it or compare `sampleCount` with N here.
   */
  performance: AgentPerformanceRow[];
};

/** Exact decimal strings; `avgCost` is keyed by resource unit, never combined. */
export type AgentPerformanceRow = {
  taskDefinitionId: string;
  modelTier: string;
  sampleCount: number;
  successRate: string;
  avgRetries: string;
  avgCost: Record<string, string>;
  updatedAt: string;
} & PerformanceEligibility;

/** The runtime's eligibility gate for one performance row, as the API decided it. Absent from older API builds. */
export type PerformanceEligibility = {
  eligible?: boolean;
  eligibilityReason?: "insufficient_samples" | "no_criterion" | null;
  minSamples?: number | null;
};

export async function getAgentDetail(id: string): Promise<AgentDetail> {
  return apiFetch<AgentDetail>(`/agents/${encodeURIComponent(id)}`);
}

/**
 * Engages the agent-scope emergency stop (spec 9.7) for THIS agent definition
 * VERSION: its next Invocation, in any workflow, is refused. Other versions of
 * the same agent are not stopped. A call already in flight finishes.
 */
export async function engageAgentStop(agentDefinitionId: string, reason?: string): Promise<void> {
  await apiFetch<unknown>("/execution-stops", {
    method: "POST",
    body: JSON.stringify({ scope: "agent_definition", scopeRefId: agentDefinitionId, ...(reason ? { reason } : {}) }),
  });
}

/**
 * Lifts the agent-scope stop the page SHOWED (`stopId`). If a different stop has
 * since replaced it, the API refuses (409) rather than lifting a stop the
 * operator never saw. Forward-only: work a stop already failed is not revived (spec 9.7).
 */
export async function liftAgentStop(agentDefinitionId: string, stopId: string): Promise<void> {
  await apiFetch<unknown>("/execution-stops/lift", {
    method: "POST",
    body: JSON.stringify({ scope: "agent_definition", scopeRefId: agentDefinitionId, stopId }),
  });
}

// ---------------------------------------------------------------------------
// Execution stops (spec 9.7): active stops, all scopes, one read
// ---------------------------------------------------------------------------

export type ActiveStop = { id: string; scope: string; scopeRefId: string | null; reason: string | null };

export async function listActiveStops(): Promise<ActiveStop[]> {
  const data = await apiFetch<{ stops: ActiveStop[] }>("/execution-stops");
  return data.stops;
}

// ---------------------------------------------------------------------------
// Artifacts (spec 15.1 screen 8): one Artifact with provenance. No list route.
// ---------------------------------------------------------------------------

export type ArtifactDetail = {
  artifact: {
    id: string;
    type: string;
    version: number;
    size: number;
    hash: string;
    summary: string | null;
    createdAt: string;
    storedInline: boolean;
    /** Model or tool output: rendered as text, never HTML. */
    preview: string | null;
    truncated: boolean;
    /** Present only when requested with `full`. */
    content?: string | null;
    /** Whether the stored content still hashes to the stored hash; null with no inline content. */
    contentHashMatches: boolean | null;
  };
  producedBy: {
    invocation: { id: string; kind: string; seqNo: number };
    runId: string;
    agent: { id: string; name: string | null; version: number | null } | null;
    taskInstanceId: string;
    taskDefinition: { id: string; name: string; version: number };
    workflowRunId: string | null;
    goal: { id: string; title: string | null } | null;
  } | null;
  referencedBy: {
    invocationId: string | null;
    runId: string | null;
    occurredAt: string;
    kind: unknown;
    tier: unknown;
    version: unknown;
    hash: unknown;
  }[];
  referencedByTruncated: boolean;
};

export async function getArtifact(id: string, full = false): Promise<ArtifactDetail> {
  return apiFetch<ArtifactDetail>(`/artifacts/${encodeURIComponent(id)}${full ? "?full=1" : ""}`);
}

// ---------------------------------------------------------------------------
// Registry (spec 15.1 screen 6): every Definition, read-only
// ---------------------------------------------------------------------------

/** An Agent Definition's execution profile, as the Registry stored it (`src/definitions/executionProfile.ts`). */
export type ExecutionProfile = {
  preferredTier?: string;
  provider?: string;
  loop?: { maxIterations?: number; maxActiveSeconds?: number };
};

/** What an Agent Builder may offer, read from the runtime's configuration (`GET /registry` `builder`). */
export type BuilderOptions = {
  permissions: string[];
  autonomyStates: string[];
  tiers: string[];
  providers: { name: string; enabled: boolean; tiers: string[]; resourceUnits: string[] }[];
  /** Thinking actions an autonomous objective may take (no Grant needed). Absent from older API builds. */
  thinkingIntents?: string[];
  /** Capabilities an autonomous loop can use (each still needs the agent's Grant). Absent from older API builds. */
  loopActions?: { capability: string; permission: string; describe: string }[];
  autonomyLimits: { maxIterations: number; maxActiveSeconds: number; minActiveSeconds: number; taskInstanceBudgetCeilings: Record<string, string> };
  /** The character kit's parts (presentation only). Absent from older API builds. */
  appearance?: AppearanceOptions;
};

/** How a persistent agent looks: one catalogue option per part (`src/definitions/appearanceCatalogue.json`). Presentation only. */
export type Appearance = Record<string, string>;

export type AppearanceOptions = {
  version: number;
  poses: string[];
  /** Absent from older API builds. */
  facings?: string[];
  frameSize: number;
  frames: Record<string, number>;
  /** Ready-made looks the builder offers (each a valid appearance). Absent from older API builds. */
  presets?: { id: string; name: string; appearance: Appearance }[];
  parts: Record<string, { label: string; default: string; options: string[] }>;
};

export type RegistryData = {
  agentDefinitions: {
    id: string;
    name: string;
    version: number;
    role: string;
    objective: string;
    instructions: string;
    createdAt: string;
    executionProfile?: ExecutionProfile;
    /** Keyed on the agent's name, so every version shares it; null = the default character. Absent from older API builds. */
    appearance?: Appearance | null;
    /** How it is drawn: the chosen appearance, else the look derived from its name (never stored). Absent from older API builds. */
    look?: Appearance;
  }[];
  /** Absent from older API builds. */
  builder?: BuilderOptions;
  capabilities: {
    id: string;
    name: string;
    description: string | null;
    staticRiskTag: string;
    costProfile: Record<string, unknown> | null;
    toolBindings: { id: string; kind: string; version: number; trustLevel: number; internalFunction: string | null }[];
  }[];
  capabilityGrants: {
    id: string;
    agentDefinitionId: string;
    agentDefinitionVersion: number;
    capabilityId: string;
    permissions: string[];
    autonomyState: string;
    maxTrustLevelRequired: number;
    scope: Record<string, unknown> | null;
    createdAt: string;
    revokedAt: string | null;
  }[];
  taskDefinitions: { id: string; name: string; kind: string; version: number; planRegistered: boolean }[];
  workflowDefinitions: { id: string; name: string; version: number; createdAt: string; graphDefinition?: WorkflowGraph }[];
};

/** A Workflow Definition's graph as the Registry stores it (`src/workflow/graphTypes.ts`): linear steps, optional ids and labels. */
export type WorkflowGraph = {
  kind: "linear";
  description?: string;
  steps: {
    stepId?: string;
    label?: string;
    taskDefinitionId: string;
    taskDefinitionVersion: number;
    agentDefinitionId?: string;
    agentDefinitionVersion?: number;
    parameters?: Record<string, unknown>;
  }[];
};

export type WorkflowDefinitionInput = { name: string; graphDefinition: WorkflowGraph; previousVersion?: number };

/** Saves a Workflow Definition version. The Registry validates every step (R3) and never updates an older version. */
export async function createWorkflowDefinition(input: WorkflowDefinitionInput): Promise<{ id: string; name: string; version: number }> {
  return apiFetch("/workflow-definitions", { method: "POST", body: JSON.stringify(input) });
}

/** Runs every Registry check without writing anything (`?dryRun=1`). Resolves when valid; throws with the Registry's reason otherwise. */
export async function validateWorkflowDefinition(input: WorkflowDefinitionInput): Promise<{ valid: true; name: string; version: number }> {
  return apiFetch("/workflow-definitions?dryRun=1", { method: "POST", body: JSON.stringify(input) });
}

export async function getRegistry(): Promise<RegistryData> {
  return apiFetch<RegistryData>("/registry");
}

export type GrantInput = { capabilityId: string; permissions: string[]; autonomyState: string; maxTrustLevelRequired: number };

export type AgentDefinitionInput = {
  name: string;
  role: string;
  objective: string;
  instructions: string;
  executionProfile: ExecutionProfile;
  grants: GrantInput[];
  /** The version this write supersedes; omitted for a new agent. */
  previousVersion?: number;
};

/** A Registry write: a new Agent Definition version and its Grants, validated and versioned by the API. Nothing is updated. */
export async function createAgentDefinition(input: AgentDefinitionInput): Promise<{ id: string; name: string; version: number }> {
  return apiFetch("/agent-definitions", { method: "POST", body: JSON.stringify(input) });
}

// ---------------------------------------------------------------------------
// Agent progression (R2): an interpretation of real work, keyed on the agent's name. Grants nothing.
// ---------------------------------------------------------------------------

export type QualityVerdict = "POOR" | "ACCEPTABLE" | "GOOD" | "EXCELLENT";

export type AgentProgression = {
  name: string;
  level: number;
  xp: number;
  levelStartXp: number;
  nextLevelXp: number;
  awards: {
    rule: string;
    xp: number;
    awardKey: string;
    runId: string | null;
    workflowRunId: string | null;
    goalId: string | null;
    artifactId: string | null;
    evidence: Record<string, unknown>;
    earnedAt: string;
  }[];
  achievements: { achievement: string; label: string; domain: string | null; earnedAt: string; evidence: Record<string, unknown> }[];
  specialisation: { domain: string; runs: number } | null;
  domains: Record<string, number>;
  specialisationMinRuns: number;
  reputation: {
    verdicts: Record<QualityVerdict, number>;
    verdictCount: number;
    enoughVerdicts: boolean;
    minVerdicts: number;
    independentEndorsers: string[];
    mutualEndorsements: number;
    unverifiedEndorsements: number;
  };
  endorsementsGiven: number;
};

export async function getAgentProgression(name: string): Promise<AgentProgression> {
  return apiFetch(`/agent-progression/${encodeURIComponent(name)}`);
}

export type QualityVerdictRecord = {
  eventId: string;
  actor: string;
  occurredAt: string;
  verdict: QualityVerdict;
  rationale: string | null;
  agentName: string | null;
  previousVerdict: QualityVerdict | null;
};

export async function getQualityVerdicts(artifactId: string): Promise<{ verdicts: QualityVerdictRecord[] }> {
  return apiFetch(`/artifacts/${artifactId}/quality-verdicts`);
}

/** The operator's judgement of an artifact's quality. Not an approval; only the latest verdict counts. */
export async function recordQualityVerdict(input: { artifactId: string; verdict: QualityVerdict; rationale?: string }): Promise<{ verdict: QualityVerdict; agentName: string | null; xp: number; note: string | null }> {
  return apiFetch("/quality-verdicts", { method: "POST", body: JSON.stringify(input) });
}

// ---------------------------------------------------------------------------
// Living workplace: the workspace configuration (space only, never authority) and work history
// ---------------------------------------------------------------------------

export type WorldBuilding = { id: string; name: string; x: number; y: number; w: number; h: number; active: boolean };
export type WorldAreaRow = { id: string; buildingId: string; name: string; purpose: string; x: number; y: number; w: number; h: number; active: boolean };
export type WorldWorkstationRow = { id: string; areaId: string; name: string; activity: string; x: number; y: number; active: boolean; facing?: string };
export type WorldData = {
  workspace: { id: string; name: string; width: number; height: number; template?: string | null } | null;
  buildings: WorldBuilding[];
  areas: WorldAreaRow[];
  workstations: WorldWorkstationRow[];
  purposes: string[];
  activities: string[];
  /** Absent from older API builds. */
  facings?: string[];
  /** Ready-made worlds; applying one retires the current world (kept, not deleted). Absent from older API builds. */
  templates?: { id: string; name: string; description: string }[];
  /** When no world was created yet: the current keep as it would be created (not saved). */
  preview?: { buildings: WorldBuilding[]; areas: WorldAreaRow[]; workstations: WorldWorkstationRow[] };
};

export async function getWorld(): Promise<WorldData> {
  return apiFetch("/world");
}

/** Make a new current world from a template; the previous one is retired, not deleted. */
export async function applyWorldTemplate(id: string): Promise<{ world: WorldData }> {
  return apiFetch(`/world/templates/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({}) });
}

export async function createWorld(): Promise<{ world: WorldData }> {
  return apiFetch("/world", { method: "POST", body: JSON.stringify({}) });
}

export type WorldKind = "buildings" | "areas" | "workstations";

/** Creates (no id) or updates a building, area or workstation. `active: false` deactivates it. Validated by the API. */
export async function saveWorldItem(kind: WorldKind, id: string | null, fields: Record<string, unknown>): Promise<{ saved: Record<string, unknown> }> {
  return apiFetch(id ? `/world/${kind}/${id}` : `/world/${kind}`, { method: "POST", body: JSON.stringify(fields) });
}

export async function renameWorkspace(name: string): Promise<unknown> {
  return apiFetch("/world/workspace", { method: "POST", body: JSON.stringify({ name }) });
}

export type HistoryGoal = {
  id: string;
  title: string;
  project: string;
  status: string;
  lifecycle: string;
  createdAt: string;
  archivedAt: string | null;
  archivedBy: string | null;
  agents: string[];
  workflowRuns: { id: string; status: string; createdAt: string; completedAt: string | null; workflow: string | null }[];
};

export type HistoryData = { goals: HistoryGoal[]; capped: boolean; limit: number; filters: { lifecycles: string[]; agents: string[]; workflows: string[] } };

export type HistoryWorkflowRun = {
  id: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  goal: { id: string; title: string; archivedAt: string | null };
  workflow: string | null;
};

export async function getHistoryWorkflowRuns(filters: Record<string, string>): Promise<{ workflowRuns: HistoryWorkflowRun[]; capped: boolean; limit: number }> {
  const q = new URLSearchParams(Object.entries(filters).filter(([, v]) => v !== ""));
  return apiFetch(`/history/workflow-runs${q.size > 0 ? `?${q.toString()}` : ""}`);
}

/** Archive every finished goal idle for `finishedBeforeHours`. A dry run counts; the real call must repeat that count. */
export async function archiveFinished(finishedBeforeHours: number, expectedCount?: number): Promise<{ dryRun: boolean; count: number }> {
  return apiFetch("/history/archive", {
    method: "POST",
    body: JSON.stringify(expectedCount === undefined ? { finishedBeforeHours, dryRun: true } : { finishedBeforeHours, dryRun: false, expectedCount }),
  });
}

export async function getHistory(filters: Record<string, string>): Promise<HistoryData> {
  const q = new URLSearchParams(Object.entries(filters).filter(([, v]) => v !== ""));
  return apiFetch(`/history${q.size > 0 ? `?${q.toString()}` : ""}`);
}

/** Archiving moves a finished Goal out of current work. Nothing is deleted. */
export async function setGoalArchived(goalId: string, archived: boolean): Promise<{ id: string; archivedAt: string | null }> {
  return apiFetch(`/goals/${goalId}/${archived ? "archive" : "unarchive"}`, { method: "POST", body: JSON.stringify({}) });
}

/** Sets how a persistent agent looks. Writes no Definition version, Grant or event: presentation only. */
export async function setAgentAppearance(name: string, appearance: Appearance): Promise<{ name: string; appearance: Appearance }> {
  return apiFetch(`/agent-appearances/${encodeURIComponent(name)}`, { method: "POST", body: JSON.stringify({ appearance }) });
}

// ---------------------------------------------------------------------------
// Keeper (V1.1): explain and guide use no model; Think starts a governed Goal
// ---------------------------------------------------------------------------

export type KeeperExplanation = {
  subject: { type: string; id: string | null };
  headline: string;
  status: string | null;
  facts: { label: string; value: string }[];
  reasons: string[];
  next: { label: string; href: string }[];
};

export type KeeperGuideCard = { slug: string; title: string; body: string };

/** `subject`: "system" or "<workflow_run|goal|approval|agent|artifact|run>:<id>". Deterministic; no model. */
export async function keeperExplain(subject: string): Promise<KeeperExplanation> {
  return apiFetch(`/keeper/explain?subject=${encodeURIComponent(subject)}`);
}

/** The guide cards matching a question. Deterministic; no model. */
export async function keeperGuide(q: string): Promise<KeeperGuideCard[]> {
  return (await apiFetch<{ cards: KeeperGuideCard[] }>(`/keeper/guide?q=${encodeURIComponent(q)}`)).cards;
}

/** R2 Stage 6: one intent answer, deterministic, from the authoritative records. FACT / DERIVED / UNKNOWN. */
export type KeeperLine = { text: string; source: string; links: { label: string; href: string }[] };
export type KeeperAnswer = {
  intent: string | null;
  intentLabel: string | null;
  subject: { type: string; id: string | null; name: string | null };
  question: string | null;
  headline: string;
  facts: KeeperLine[];
  derived: KeeperLine[];
  unknown: string[];
  sources: string[];
  canExplain: { intent: string; label: string }[];
  size: { characters: number; estimatedTokens: number };
};

export async function keeperExplanation(subject: string, ask: { question?: string; intent?: string }): Promise<KeeperAnswer> {
  const q = new URLSearchParams({ subject, ...(ask.question ? { question: ask.question } : {}), ...(ask.intent ? { intent: ask.intent } : {}) });
  return apiFetch(`/keeper/explanations?${q.toString()}`);
}

export type KeeperIdentity = {
  agentDefinitionId: string;
  name: string;
  version: number;
  appearance: Appearance | null;
  /** The chosen appearance, else the look derived from its name. Absent from older API builds. */
  look?: Appearance;
  intents: { id: string; label: string; subjects: string[] }[];
};

/** The Keeper's persistent agent, its appearance (presentation), and the questions it can explain. */
export async function keeperIdentity(): Promise<KeeperIdentity> {
  return apiFetch("/keeper/identity");
}

/**
 * Talk to an agent (R2 character interaction): request work from one persistent agent. Only the message
 * is sent; the API chooses the agent's latest version and everything that governs it. 409 when the agent
 * is stopped, awaiting approval, paused or already working (nothing is started).
 */
export async function talkToAgent(
  agentDefinitionId: string,
  message: string
): Promise<{ goalId: string; workflowRunId: string; agent: { id: string; name: string; version: number }; /** True when the agent was the Manager: the message became a mission. */ mission?: boolean }> {
  return apiFetch(`/agents/${encodeURIComponent(agentDefinitionId)}/talk`, { method: "POST", body: JSON.stringify({ message }) });
}

// ---------------------------------------------------------------------------
// Command: missions for the Manager (R2 management layer)
// ---------------------------------------------------------------------------

export type MissionStatus = "planning" | "working" | "awaiting_approval" | "paused" | "completed" | "escalated" | "failed" | "stopped" | "finished_without_report";

export type MissionTask = { stepId: string; agentName: string; brief: string; expectedOutput: string; completionCriteria: string; dependsOn: string[]; intents: string[]; tools: string[] };

export type MissionStep = {
  taskInstanceId: string;
  kind: string | null;
  taskStatus: string;
  agentName: string | null;
  runId: string | null;
  runStatus: string | null;
  failure: string | null;
  /** The deterministic reason the step's run failed (e.g. worker_timed_out). Absent from older API builds. */
  failureCode?: string | null;
  deliverableArtifactId: string | null;
  completion: { status?: string; reason?: string } | null;
};

export type MissionDetail = {
  goal: {
    id: string;
    title: string;
    objective: string | null;
    status: string;
    createdAt: string;
    /** The operator's deadline, when one was set. Nothing estimates or promises a finish time. */
    dueAt: string | null;
    /** Derived from the clock by the server, like a meeting's status. Late is not failed. */
    overdue: boolean;
  };
  status: MissionStatus;
  /** One governed recovery round after delegated work failed, when the runtime started one. */
  recovery: { round: number; failures: string[]; action: string | null } | null;
  /** The meeting decision this mission answers, when it answers one. */
  fromDecision: { meetingId: string; text: string } | null;
  /** The first authoritative reason code for a blocked, escalated, stopped or failed mission; null otherwise. */
  reason: string | null;
  /** Every reason, from code and runtime facts; `detail` may quote the model. */
  reasons: { code: string; detail: string; runId?: string }[];
  /** The mission's recorded facts in order: Manager decisions, policy, budget, approvals, stops, outcomes. */
  trace: { seq: number; type: string; at: string; runId: string | null; actor: string; summary: string }[];
  plan: {
    status: "delegated" | "plan_rejected" | "escalated" | "scheduled" | "rescheduled" | "cancelled";
    /** Workplace: the meeting code decided and applied (time, room and participants chosen by code). */
    meeting?: { action: string; meetingId: string; title: string; participants: string[]; startsAt: string | null; endsAt: string | null; roomName: string | null; previous: { startsAt: string; endsAt: string; roomName: string } | null } | null;
    tasks: MissionTask[]; errors: string[]; blockers?: { code: string; detail: string }[]; delegatedWorkflowRunId: string | null; artifactId: string; summary: string | null } | null;
  report: {
    status: "completed" | "follow_up_started" | "escalated";
    artifactId: string;
    body: string | null;
    work: { stepId: string; agentName: string; artifactId: string; verified: boolean; problems: string[]; runId: string; workerLoop?: { status: string; reason: string } }[];
    assessments: { stepId: string; sufficient: boolean; reason: string }[];
    /** Coded findings written by the review's code; `detail` may quote the model. */
    blockers: { code: string; detail: string }[];
    followUpWorkflowRunId: string | null;
  } | null;
  workflowRuns: { id: string; status: string; workflow: string | null; createdAt: string; completedAt: string | null; steps: MissionStep[] }[];
  pendingApprovals: string[];
  blockers: string[];
};

/** Give the Manager an objective. Only the objective is sent; 409 when the Manager is stopped or already running a mission. */
export async function startMission(objective: string): Promise<{ goalId: string; workflowRunId: string; agent: { id: string; name: string; version: number } }> {
  return apiFetch("/manager/missions", { method: "POST", body: JSON.stringify({ objective }) });
}

export async function listMissions(): Promise<{ missions: { goal: MissionDetail["goal"]; status: MissionStatus; blockers: number }[]; manager: { id: string; name: string; version: number } | null }> {
  return apiFetch("/manager/missions");
}

export async function getMission(goalId: string): Promise<MissionDetail> {
  return apiFetch(`/manager/missions/${encodeURIComponent(goalId)}`);
}

/** Keeper Think: an explicit, governed Goal in the Keeper project (CHEAP tier, READ-only). Uses subscription quota. */
export async function askKeeper(question: string, subject: string): Promise<{ goalId: string; workflowRunId: string; status: string }> {
  return apiFetch("/keeper/questions", { method: "POST", body: JSON.stringify({ question, subject }) });
}

/** Revokes one Grant (spec §9.7); the API closes its pending Approvals. */
export async function revokeCapabilityGrant(grantId: string): Promise<{ grantId: string; revoked: boolean; cancelledApprovalIds: string[] }> {
  return apiFetch(`/capability-grants/${encodeURIComponent(grantId)}/revoke`, { method: "POST" });
}

// ---------------------------------------------------------------------------
// Costs (spec 15.1 screen 7): budget counters, per-(scope, unit) totals, agent_performance
// ---------------------------------------------------------------------------

export const BUDGET_SCOPES = ["run", "task_instance", "agent_definition", "goal", "day"] as const;

export type CostsData = {
  counters: {
    scope: string;
    scopeRefId: string;
    resourceUnit: string;
    limitAmount: string;
    reservedAmount: string;
    consumedAmount: string;
    updatedAt: string;
    run: { agent: { name: string; version: number } | null; taskDefinitionName: string | null } | null;
  }[];
  countersTruncated: boolean;
  /** Summed per (scope, unit) by the API. Never add across units or scopes. */
  totals: { scope: string; resourceUnit: string; consumed: string; reserved: string; counters: number }[];
  /**
   * Per unit, how much recorded consumption came from the provider's OWN report and how much was
   * charged at a client-side estimate. An estimate is not spend and must never be labelled as such.
   */
  consumedBasis: Record<string, { reported: string; estimate: string }>;
  costVsSuccess: ({
    agentDefinitionId: string;
    agentName: string;
    agentVersion: number;
    taskDefinitionId: string;
    taskDefinitionName: string;
    modelTier: string;
    sampleCount: number;
    successRate: string;
    avgRetries: string;
    avgCost: Record<string, string>;
    updatedAt: string;
  } & PerformanceEligibility)[];
};

export async function getCosts(scope?: string): Promise<CostsData> {
  return apiFetch<CostsData>(`/costs${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`);
}

// ---------------------------------------------------------------------------
// Run trace (spec 8.4): a Run's events in sequence order
// ---------------------------------------------------------------------------

export type RunTrace = {
  run: {
    id: string;
    status: string;
    startedAt: string;
    completedAt: string | null;
    taskInstanceId?: string;
    agentDefinitionId?: string | null;
    agentDefinitionVersion?: number | null;
  };
  events: { eventId: string; eventType: string; occurredAt: string; sequenceNo: number; actor: string; payload: Record<string, unknown> }[];
  invocations: {
    id: string;
    seqNo: number;
    kind: string;
    status: string;
    capabilityId?: string | null;
    permission: string | null;
    toolBindingId?: string | null;
    startedAt?: string;
    completedAt?: string | null;
    contextLineage: unknown;
    /** Every Policy evaluation, in sequence order (tool Invocations only). Absent from older API builds. */
    policyEvaluations?: PolicyDecisionRecord[];
    /** The same fields as the Workflow Run detail's Invocations. Absent from older API builds. */
    budgetOutcome?: InvocationDetail["budgetOutcome"];
    route?: RouteRecord | null;
  }[];
};

export async function getRunTrace(runId: string): Promise<RunTrace> {
  return apiFetch<RunTrace>(`/runs/${encodeURIComponent(runId)}/trace`);
}

/** `withinHours`: only current work — unfinished, or active within that many hours. Absent: every unarchived goal. */
export async function listGoals(withinHours?: number): Promise<ProjectGoals[]> {
  const data = await apiFetch<{ projects: ProjectGoals[] }>(`/goals${withinHours === undefined ? "" : `?within=${withinHours}`}`);
  return data.projects;
}

/**
 * Starts REAL work: the API creates the Goal and drives its Workflow Run
 * synchronously, which can take minutes and consumes subscription quota. No
 * client-side policy logic — governance runs server-side as for any request.
 */
export async function createGoal(
  title: string,
  description?: string,
  options: { workflowDefinitionId?: string; async?: boolean } = {}
): Promise<{ goalId: string; workflowRunId: string; status: string }> {
  return apiFetch("/goals", {
    method: "POST",
    body: JSON.stringify({
      title,
      ...(description ? { description } : {}),
      ...(options.workflowDefinitionId ? { workflowDefinitionId: options.workflowDefinitionId } : {}),
      // V1.1 (R2): the API answers once the Goal is committed; the run continues and the UI follows its events.
      ...(options.async ? { async: true } : {}),
    }),
  });
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

/** Client-only connection state of the event stream (never a health claim about the system). */
export type StreamStatus = "connecting" | "live" | "reconnecting";

export function subscribeToActivity(
  sinceEventCursor: number | null,
  onEvent: (e: EventDisplayItem) => void,
  onStatus?: (status: StreamStatus) => void
): () => void {
  let closed = false;
  let currentSource: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let delayMs = RECONNECT_BASE_MS;
  let maxSeen = sinceEventCursor ?? 0;

  function connect(since: number): void {
    if (closed) return;

    onStatus?.("connecting");
    const source = new EventSource(`${API_BASE_URL}/events/stream?sinceEventCursor=${since}`);
    currentSource = source;
    source.onopen = () => {
      if (!closed) onStatus?.("live");
    };

    source.onmessage = (message: MessageEvent<string>) => {
      if (delayMs !== RECONNECT_BASE_MS) onStatus?.("live");
      delayMs = RECONNECT_BASE_MS; // healthy again
      const raw = JSON.parse(message.data) as RawEventEnvelope;
      // The HIGHEST cursor seen so far — never merely the most recent one.
      maxSeen = Math.max(maxSeen, raw.eventCursor);
      onEvent(toEventDisplayItem(raw));
    };

    source.onerror = () => {
      source.close();
      if (closed) return;
      onStatus?.("reconnecting");
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

// ---------------------------------------------------------------------------
// Workplace: calendar, meetings, rooms, internal notifications (`src/api/routes/workplace.ts`).
// Every rule is the backend's; these are observability and operator controls only.
// ---------------------------------------------------------------------------

export type WorkplaceSettings = {
  timezone: string;
  workStartMinute: number;
  workEndMinute: number;
  workingDays: number[];
  outsideWorkingHours: "forbid" | "allow";
  /** Whether WORK may START outside an agent's hours. Distinct from booking a meeting then. */
  workOutsideHours: "forbid" | "allow";
  defaultMeetingMinutes: number;
  reminderMinutes: number;
  gatherMinutes: number;
  notifyInvitations: boolean;
  notifyReminders: boolean;
  notifyAnnouncements: boolean;
};
export type WorkplaceRoom = { id: string; name: string; purpose: string; capacity: number; locationAreaName: string | null; active: boolean };
export type WorkplaceEntry = { text: string; actor: string; at: string };
/** `starting`: inside the gather window, when participants leave for the room; it has not begun. */
export type MeetingStatus = "scheduled" | "starting" | "in_progress" | "completed" | "cancelled";
export type Meeting = {
  id: string;
  title: string;
  agenda: string;
  organiser: string;
  room: { id: string; name: string; purpose: string; capacity: number; locationAreaName: string | null };
  startsAt: string;
  endsAt: string;
  status: MeetingStatus;
  cancelledAt: string | null;
  cancelReason: string | null;
  participants: { agentName: string; role: string }[];
  notes: WorkplaceEntry[];
  decisions: WorkplaceEntry[];
  actions: (WorkplaceEntry & { goalId: string })[];
  goalId: string | null;
  runId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
};
export type CalendarEntry = { id: string; agentName: string | null; kind: string; title: string; startsAt: string; endsAt: string; createdBy: string };
export type CalendarData = { now: string; settings: WorkplaceSettings; rooms: WorkplaceRoom[]; meetings: Meeting[]; entries: CalendarEntry[] };
/**
 * What one agent is doing now, decided by the server (`GET /agents/state`). One vocabulary for the whole
 * browser: the world, the agent views and the Keeper all render this rather than each deriving its own.
 */
export type AgentStateName = "stopped" | "awaiting_approval" | "in_meeting" | "working" | "waiting_dependency" | "on_break" | "outside_hours" | "unavailable" | "available";
export type AgentState = {
  agentName: string;
  state: AgentStateName;
  detail: string;
  until: string | null;
  work: { runId: string | null; goalId: string | null; goalTitle: string | null; taskKind: string | null } | null;
  nextMeeting: { meetingId: string; title: string; roomName: string; startsAt: string } | null;
};

export type MeetingPresence = { agentName: string; meetingId: string; title: string; roomName: string; locationAreaName: string | null; phase: "gathering" | "in_meeting"; startsAt: string; endsAt: string };
export type AgentSchedule = {
  now: string;
  timezone: string;
  current: MeetingPresence | null;
  meetings: { id: string; title: string; startsAt: string; endsAt: string; status: MeetingStatus; roomName: string }[];
  entries: CalendarEntry[];
  next: { id: string; title: string; startsAt: string; endsAt: string; roomName: string } | null;
};
export type WorkplaceNotification = { id: string; recipient: string; kind: string; title: string; body: string; sender: string; meetingId: string | null; goalId: string | null; channel: string; deliverAt: string; readAt: string | null };
export type WorkplaceSettingsData = {
  settings: WorkplaceSettings;
  rooms: WorkplaceRoom[];
  agentHours: { agentName: string; workStartMinute: number | null; workEndMinute: number | null; workingDays: number[] | null }[];
  allowed: { roomPurposes: string[]; calendarKinds: string[]; notificationKinds: string[]; timingWindows: string[] };
};
export type Timing = { window: string; at?: string };

function postJson<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });
}

export const getWorkplaceSettings = () => apiFetch<WorkplaceSettingsData>("/workplace/settings");
export const saveWorkplaceSettings = (changes: Partial<WorkplaceSettings>) => postJson<{ settings: WorkplaceSettings }>("/workplace/settings", changes);
export const saveAgentHours = (name: string, hours: { workStartMinute: number | null; workEndMinute: number | null; workingDays: number[] | null }) => postJson<unknown>(`/workplace/agent-hours/${encodeURIComponent(name)}`, hours);
export const createRoom = (room: Omit<WorkplaceRoom, "id">) => postJson<{ room: WorkplaceRoom }>("/workplace/rooms", room);
export const updateRoom = (id: string, changes: Partial<Omit<WorkplaceRoom, "id">>) => postJson<{ room: WorkplaceRoom }>(`/workplace/rooms/${id}`, changes);
export function getCalendar(from: Date, to: Date, filter: { agent?: string; room?: string } = {}): Promise<CalendarData> {
  const q = new URLSearchParams({ from: from.toISOString(), to: to.toISOString(), ...(filter.agent ? { agent: filter.agent } : {}), ...(filter.room ? { room: filter.room } : {}) });
  return apiFetch(`/workplace/calendar?${q.toString()}`);
}
export const getMeeting = (id: string) => apiFetch<{ meeting: Meeting; settings: WorkplaceSettings }>(`/workplace/meetings/${id}`);
export const scheduleMeeting = (body: { title: string; agenda?: string; participants: string[]; durationMinutes?: number; timing?: Timing; roomName?: string }) => postJson<{ meetingId: string; meeting: Meeting }>("/workplace/meetings", body);
export const rescheduleMeeting = (id: string, body: { timing: Timing; durationMinutes?: number; roomName?: string }) => postJson<{ meeting: Meeting }>(`/workplace/meetings/${id}/reschedule`, body);
export const cancelMeeting = (id: string, reason: string) => postJson<unknown>(`/workplace/meetings/${id}/cancel`, { reason });
export const recordMeetingOutcome = (id: string, body: { notes?: string[]; decisions?: string[] }) => postJson<unknown>(`/workplace/meetings/${id}/outcome`, body);
export const startWorkFromDecision = (id: string, decision: number) => postJson<{ goalId: string }>(`/workplace/meetings/${id}/actions`, { decision });
export const getAgentSchedule = (name: string) => apiFetch<AgentSchedule>(`/workplace/agents/${encodeURIComponent(name)}/schedule`);
export const getMeetingPresence = () => apiFetch<{ now: string; presence: MeetingPresence[] }>("/workplace/presence");
export const getAgentStates = () => apiFetch<{ agents: AgentState[]; states: AgentStateName[] }>("/agents/state");
export const listNotifications = (recipient?: string) => apiFetch<{ notifications: WorkplaceNotification[] }>(`/workplace/notifications${recipient ? `?recipient=${encodeURIComponent(recipient)}` : ""}`);
export const markNotificationRead = (id: string) => postJson<unknown>(`/workplace/notifications/${id}/read`, {});
export const sendWorkplaceMessage = (body: { kind: "message" | "announcement"; recipients?: string[]; title: string; body?: string }) => postJson<{ count: number }>("/workplace/messages", body);
export const createCalendarEntry = (body: { agentName: string | null; kind: string; title: string; startsAt: string; endsAt?: string }) => postJson<{ id: string }>("/workplace/calendar-entries", body);
export const cancelCalendarEntry = (id: string) => postJson<unknown>(`/workplace/calendar-entries/${id}/cancel`, {});

// ---------------------------------------------------------------------------
// Role icons (`src/api/routes/roleIcons.ts`): identity beside a name, never authority.
// ---------------------------------------------------------------------------

export type RoleIconDefinition = { id: string; name: string; colorToken: string; description: string; pixels: string[] };
export type RoleIconCatalogue = { version: number; size: number; icons: RoleIconDefinition[] };
export type RoleIconEntry = { name: string; iconId: string; chosen: boolean };

export const getRoleIcons = () => apiFetch<{ catalogue: RoleIconCatalogue; agents: RoleIconEntry[] }>("/role-icons");
export const setAgentRoleIcon = (name: string, iconId: string) => apiFetch<{ agentName: string; iconId: string }>(`/agent-role-icons/${encodeURIComponent(name)}`, { method: "POST", body: JSON.stringify({ iconId }) });
