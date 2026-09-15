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
  taskDefinition: { id: string; name: string; version: number } | null;
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

export async function listWorkflowRuns(): Promise<WorkflowRunSummary[]> {
  const data = await apiFetch<{ workflowRuns: WorkflowRunSummary[] }>("/workflow-runs");
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
  agent: { id: string; name: string; version: number; role: string; objective: string; executionProfile?: ExecutionProfile };
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
  autonomyLimits: { maxIterations: number; maxActiveSeconds: number; minActiveSeconds: number; taskInstanceBudgetCeilings: Record<string, string> };
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

export async function listGoals(): Promise<ProjectGoals[]> {
  const data = await apiFetch<{ projects: ProjectGoals[] }>("/goals");
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
