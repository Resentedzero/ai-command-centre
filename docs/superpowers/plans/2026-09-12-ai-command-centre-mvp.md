# AI Command Centre MVP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement Phase 18's MVP — two workflows proving the full Goal→Workflow Run→Task Instance→Run→Invocation chain, governance (Capability/Grant/Policy/Approval/Budget as separate concerns), Context Compiler, Model Router, and a minimal UI — on the frozen architecture, nothing speculative.

**Architecture:** TypeScript end-to-end (Node/Fastify backend, Next.js frontend, Drizzle/PostgreSQL), per Phase 13. Each unit matches Phase 17.3's scoping rule (one Capability+binding+tests, one Task Definition kind, one Workflow Definition = one unit).

**Tech Stack:** Node.js, TypeScript, Fastify, Drizzle ORM, PostgreSQL (native Windows/EDB install), Vitest, Next.js/React/Tailwind, Anthropic + OpenAI TS SDKs (direct, in-process — no LiteLLM proxy per Phase 13.4's correction).

**Spec:** `docs/superpowers/specs/2026-09-12-ai-command-centre-design.md` (Phases 1–20, frozen).

## Global Constraints

- No Docker, Redis, Temporal, Langfuse, vector DB, or message broker (Phase 2/4/13).
- pgvector stays off (Phase 4).
- Models never receive credentials in compiled context (Phase 9.6) — credentials live only in Tool Adapter/Model Router config.
- Only the Model Router calls LLM providers directly (Phase 4) — no other module holds a provider SDK call.
- `artifacts.storage_reference` is a relative, forward-slash path under `ARTIFACT_ROOT` (Phase 13.3) — never absolute.
- Every Invocation passes through Budget Governor governance, depth scaled by cost class (Phase 4 refinement); every Tool/Action Invocation passes through Policy before executing. **Policy and Budget are separate, independently evaluated concerns** — Policy never takes budget state as an input; the Executor sequences them (see Unit 6).
- The Policy-enforced ceiling on SPEND/TRADE/PUBLISH/DELETE (never reaching `AUTONOMOUS`) is enforced by **Grant validation**, not by hardcoding those permission types into `evaluatePolicy`'s runtime logic (Phase 9.4).
- Standalone Task Instances (`workflow_run_id = null`) and Workflow-created Task Instances are created through **distinct code paths** — the Workflow Interpreter never handles standalone task creation, and vice versa (Phase 3b).
- Memory (`memory_items`), `agent_performance`, `agent_xp_projection`, Registry UI, Cost dashboard, and Agent Detail/Workflow graph views are explicitly out of scope for this plan (Phase 18.1).
- **Reconciliation decisions carried forward** (agreed before planning): Vitest as test runner; SSE delivery combines Postgres replay (authoritative) with an in-process `EventEmitter` (live-only, never a second source of truth — see Unit 10); Approval TTL auto-expiry sweep deferred past MVP; Workflow graph definitions use a minimal linear JSON shape, extensible later without a rewrite. `tierConfig.ts` (Unit 5) is a V1 implementation detail, not an architectural commitment — the Model Router interface remains provider/config-agnostic.

---

### Unit 1: Project Foundation — Schema, Event Primitive, Test Database

**Objective:** Stand up the Node/TS project, the MVP-scoped Postgres schema via Drizzle, the frozen canonical Event envelope (Phase 8.1) with its full field set, and a deterministic local test-database strategy. Establish root `CLAUDE.md`.

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`
- Create: `src/db/schema.ts` (Drizzle table definitions — MVP subset only: `projects`, `goals`, `capabilities`, `tool_bindings`, `agent_definitions`, `capability_grants`, `task_definitions`, `workflow_definitions`, `workflow_runs`, `task_instances`, `runs`, `invocations`, `events`, `budget_counters`, `approvals`, `artifacts`. Excludes `memory_items`, `agent_performance`, `agent_xp_projection` — deferred per Phase 18.1.)
- Create: `src/db/client.ts` (Drizzle client + connection config from `DATABASE_URL`)
- Create: `drizzle.config.ts`, migration output under `drizzle/`
- Create: `src/events/types.ts` (canonical `EventEnvelope` type, Phase 8.1, full field set)
- Create: `src/events/emit.ts` (`emitEvent` primitive)
- Create: `tests/testDb.ts` (test-database reset helper, see below)
- Create: `CLAUDE.md` (root — summarizes Phase 2/3, points to the spec, states the module-boundary rule from Phase 4)
- Test: `tests/events/emit.test.ts`

**Dependencies:** None (first unit).

**Interfaces:**
```ts
// src/events/types.ts — the FROZEN canonical envelope, Phase 8.1 in full
export type EventEnvelope = {
  eventId: string;             // generated UUID, primary key
  idempotencyKey: string;      // caller-supplied, unique constraint — the actual dedup key
  eventType: string;
  eventVersion: number;        // payload shape version for this eventType (Phase 20 risk #9)
  occurredAt: Date;            // display only, never used for ordering
  sequenceNo: number;          // monotonic, scoped per runId — authoritative for ordering
  causationId: string | null;  // the event/invocation that directly caused this one
  correlation: {
    goalId: string | null;
    workflowRunId: string | null;
    taskInstanceId: string | null;
    runId: string | null;
    invocationId: string | null;
  };
  actor: string;                // "agent:<id>@<version>" | "human:<id>" | "system"
  producer: string;             // which module emitted this, e.g. "executor" | "workflow-interpreter" | "api"
  payload: Record<string, unknown>; // typed per eventType by convention; not a discriminated union for MVP
  usage: {
    tokensIn: number;
    tokensOut: number;
    cacheHit: boolean;
    costAmount: number;
    modelId: string;
  } | null; // present only for LLM-related events; never flattened onto the envelope itself
};

// src/events/emit.ts
export type EmitEventInput = Omit<EventEnvelope, "eventId" | "occurredAt" | "sequenceNo">;
export async function emitEvent(
  tx: DrizzleTransaction,
  input: EmitEventInput
): Promise<EventEnvelope>;
```
`emitEvent` computes the next `sequenceNo` for `input.correlation.runId` atomically within the passed transaction, and enforces the `idempotencyKey` unique constraint (a retried caller re-emitting the same logical event is a no-op returning the existing row, not a duplicate insert). The DB table stores `correlation`'s fields as flat columns (`goal_id`, `workflow_run_id`, etc.) per Phase 12's schema shape; `emit.ts` maps between the flat row and the grouped TS type.

**Test-database strategy (no Docker/Redis, one native Postgres instance):**
- A second local database on the same native EDB Postgres install, e.g. `ai_command_centre_test`, referenced via `TEST_DATABASE_URL` in `.env.example`.
- `tests/testDb.ts` exports `resetTestSchema()`: drops and recreates the `public` schema, then applies all Drizzle migrations — run once in Vitest's global `beforeAll` (fast enough to run once per test file, not per test).
- Individual tests run inside a Drizzle transaction that is **rolled back** after each test (`tx.rollback()` pattern) for isolation, rather than truncating tables between every test — this keeps the suite fast while remaining fully deterministic (no shared mutable state leaks between tests).

**Tests required:**
- `emitEvent` inserts a row with all envelope fields (including `producer`, `eventVersion`, `usage`) correctly populated.
- Two `emitEvent` calls within the same `runId` produce strictly increasing `sequenceNo`; different `runId`s have independent counters.
- Re-emitting with the same `idempotencyKey` returns the original row rather than inserting a duplicate.
- `resetTestSchema()` followed by a schema round-trip test (insert+read one row per table) confirms migrations apply cleanly.
- A test demonstrating the rollback-per-test pattern leaves no residual rows visible to the next test.

**Out of scope:** Projection logic (Units 2–3), `memory_items`/`agent_performance`/`agent_xp_projection` tables, per-module `CLAUDE.md` files (added per-module as each module unit lands, per Phase 17.2).

**Codex reviewability:** Fully self-contained — reviewable purely against Phase 8.1's full envelope definition (a reviewer should specifically check nothing was flattened or dropped relative to the frozen spec) and the test-db strategy's determinism, with no dependency on any other unit.

---

### Unit 2: Budget Governor

**Objective:** Implement the reserve/reconcile budget primitive (Phase 4 cost-class governance, Phase 12 `budget_counters`, Phase 10.7's two-pass reservation) — entirely independent of Policy.

**Files:**
- Create: `src/governance/costClass.ts`
- Create: `src/governance/budget.ts` (`reserveBudget`, `reconcileBudget`, `releaseReservation`)
- Test: `tests/governance/budget.test.ts`

**Dependencies:** Unit 1.

**Interfaces:**
```ts
export type CostClass = "deterministic" | "local_retrieval" | "metered_api" | "llm" | "external_side_effect";

export type BudgetScope = "run" | "task_instance"; // agent_definition/goal/day rollups deferred (Phase 18.1)
export type ReservationResult =
  | { authorized: true; reservationId: string }
  | { authorized: false; reason: "insufficient_budget" };

export async function reserveBudget(
  tx: DrizzleTransaction,
  scope: BudgetScope,
  scopeRefId: string,
  costClass: CostClass,
  estimatedAmount: number
): Promise<ReservationResult>;

export async function reconcileBudget(tx: DrizzleTransaction, reservationId: string, actualAmount: number): Promise<void>;
export async function releaseReservation(tx: DrizzleTransaction, reservationId: string): Promise<void>;
```
`costClass: "deterministic"` short-circuits to `{authorized: true, reservationId: <no-op>}` without touching `budget_counters` (Phase 4's trivial-governance-for-free-operations rule).

**Tests required:**
- Rejects reservation past `limit_amount - reserved_amount - consumed_amount`.
- Two concurrent overlapping-transaction reservations against the same scope, together exceeding the limit, never both succeed (a real concurrency test, not sequential calls).
- `reconcileBudget` releases the reservation and adds actual consumption atomically.
- `costClass: "deterministic"` never writes to `budget_counters`.

**Out of scope:** `agent_definition`/`goal`/`day` rollups; cost *estimation* (caller's responsibility); any interaction with Policy (Unit 3) — this module has no knowledge of Policy decisions at all.

**Codex reviewability:** Testable in complete isolation; a reviewer verifies the concurrency test exercises genuinely overlapping transactions.

---

### Unit 3: Capability / Policy / Approval Engine

**Objective:** Implement Phase 9's governance chain — risk-tier computation, Policy evaluation (Grant + trust + risk only, **no budget input**), Grant validation enforcing the SPEND/TRADE/PUBLISH/DELETE autonomy ceiling structurally, and Approval creation/resolution/re-authorization.

**Files:**
- Create: `src/governance/risk.ts` (`computeRiskTier`)
- Create: `src/governance/policy.ts` (`evaluatePolicy`, `validateCapabilityGrant`)
- Create: `src/governance/approvals.ts` (`createApproval`, `resolveApproval`, `reauthorize`)
- Test: `tests/governance/risk.test.ts`, `tests/governance/policy.test.ts`, `tests/governance/approvals.test.ts`

**Dependencies:** Unit 1 only. **Not Unit 2** — Policy is evaluated independently of budget state.

**Interfaces:**
```ts
export type RiskTier = "low" | "medium" | "high" | "highest";
export function computeRiskTier(input: {
  staticRiskTag: RiskTier;
  amountOrScope: number | null;
  isNovelAction: boolean;
  trustLevel: "first_party" | "verified_third_party" | "unverified_third_party";
}): RiskTier;

export type PolicyDecision = "ALLOW" | "DENY" | "REQUIRE_APPROVAL";
export type CapabilityGrant = {
  agentDefinitionId: string;
  agentDefinitionVersion: number;
  capabilityId: string;
  permissions: ("READ" | "WRITE" | "CREATE" | "PUBLISH" | "SPEND" | "TRADE" | "DELETE" | "EXECUTE" | "SEND")[];
  autonomyState: "ALWAYS_APPROVE" | "CONDITIONAL" | "AUTONOMOUS";
};

// Enforces Phase 9.4's structural ceiling: a Grant requesting SPEND/TRADE/PUBLISH/DELETE
// with autonomyState "AUTONOMOUS" is rejected at validation time — evaluatePolicy itself
// contains NO special-cased branch for these permission types; the ceiling is a property
// of what Grants are allowed to exist, not runtime policy logic.
export function validateCapabilityGrant(grant: CapabilityGrant): { valid: true } | { valid: false; reason: string };

// Inputs deliberately exclude budget state. Policy answers "is this agent authorized
// to attempt this action, at this risk level, via this trust level" — nothing about
// affordability. Reads autonomyState generically: ALWAYS_APPROVE -> REQUIRE_APPROVAL;
// CONDITIONAL -> REQUIRE_APPROVAL for V1 (performance-driven relaxation deferred,
// Phase 18.1); AUTONOMOUS -> ALLOW.
export async function evaluatePolicy(
  tx: DrizzleTransaction,
  input: {
    grant: CapabilityGrant | null; // null if no Grant exists for this Agent/Capability pair
    permission: CapabilityGrant["permissions"][number];
    proposedActionSnapshot: Record<string, unknown>;
    trustLevel: "first_party" | "verified_third_party" | "unverified_third_party";
  }
): Promise<{ decision: PolicyDecision; riskTier: RiskTier }>;

export async function createApproval(
  tx: DrizzleTransaction, invocationId: string, proposedActionSnapshot: Record<string, unknown>,
  riskTier: RiskTier, ttlSeconds: number
): Promise<{ id: string; status: "pending" }>;

export async function resolveApproval(
  tx: DrizzleTransaction, approvalId: string, decision: "approved" | "rejected", resolvedBy: string
): Promise<{ id: string; status: "approved" | "rejected" }>;

// Re-checks Grant validity and revocation status immediately before execution (Phase 9.5).
// Deliberately does NOT re-check budget here — budget re-verification is the Executor's
// job via a fresh reserveBudget call in Unit 6's chain, keeping the two concerns separate
// even at the re-authorization boundary.
export async function reauthorize(tx: DrizzleTransaction, invocationId: string): Promise<boolean>;
```

**Tests required:**
- `computeRiskTier` is a pure function: fixed input combinations always produce the same tier.
- `evaluatePolicy` returns `DENY` when `grant` is `null` — never reaches risk computation.
- `validateCapabilityGrant` rejects a Grant with `permissions: ["SPEND"]` and `autonomyState: "AUTONOMOUS"`; accepts the same Grant at `"ALWAYS_APPROVE"` or `"CONDITIONAL"`. Also rejects `TRADE`/`PUBLISH`/`DELETE` at `AUTONOMOUS`, and accepts `READ`/`WRITE` at `AUTONOMOUS` (proving the ceiling applies only to the four named permission types, not universally).
- `evaluatePolicy`'s signature and implementation contain no parameter or branch referencing budget — a structural test (type-level: `evaluatePolicy`'s input type has no `budget`-named field) enforcing the separation-of-concerns correction directly.
- `createApproval` stores the exact snapshot verbatim.
- **Material-change invalidation**: mutate the underlying action's parameters after Approval creation; `reauthorize` returns `false`.
- `reauthorize` returns `false` after the backing Grant is revoked, independent of any budget state.

**Out of scope:** Budget interaction of any kind (Unit 2 and Unit 6 own that); the proactive TTL-expiry sweep; `CONDITIONAL`'s performance-driven relaxation logic (Phase 9.4, deferred).

**Codex reviewability:** The highest-stakes unit (Phase 20 risk #2). A reviewer specifically checks: (a) no budget parameter anywhere in `evaluatePolicy`, (b) the SPEND/TRADE/PUBLISH/DELETE ceiling is enforced in `validateCapabilityGrant`, not as an `if (permission === "SPEND" || ...)` branch inside `evaluatePolicy`, (c) `reauthorize` re-queries current Grant state rather than trusting anything cached.

---

### Unit 4: Context Compiler (MVP scope)

**Objective:** Implement Phase 5's compilation pipeline at MVP scope. Unchanged from prior draft except: candidates consumed here must already be **addressable, persisted records** (Artifacts or equivalent), never raw in-memory tool-call results (enforced structurally by Unit 6/8, tested here by requiring `ContextCandidate.id` to resolve to a real row).

**Files:**
- Create: `src/context/types.ts`, `src/context/compiler.ts`, `src/context/tokenEstimate.ts`
- Test: `tests/context/compiler.test.ts`

**Dependencies:** Unit 1.

**Interfaces:**
```ts
export type ContextBudget = {
  maxInputTokens: number; maxArtifactTokens: number; maxRetrievedItems: number;
  maxToolSchemaTokens: number; compressionThreshold: number;
  freshnessRequirementSeconds: number; expectedOutputTokens: number;
};

export type ContextCandidate = {
  kind: "task_state" | "artifact_ref" | "artifact_content" | "tool_schema";
  id: string; // MUST resolve to a real, persisted row (artifact id, etc.) — never an ad hoc in-memory key
  tier: 1 | 2 | 3 | 4;
  estimatedTokens: number;
  freshnessTimestamp: Date | null;
  trusted: boolean;
};

export type CompiledContext = {
  layers: { instructions: string; constraints: string; taskState: string; memory: string; artifacts: string; toolSchemas: Record<string, unknown>[] };
  provenance: { included: { id: string; tier: number }[]; excluded: { id: string; reason: "budget" | "stale" | "duplicate" | "irrelevant" | "unauthorized" }[] };
  estimatedInputTokens: number;
};

export async function compileContext(
  tx: DrizzleTransaction,
  input: { intent: "classify" | "synthesize" | "extract" | "decide" | "summarize"; taskInstanceId: string;
           candidateArtifactIds: string[]; candidateToolCapabilityIds: string[]; budget: ContextBudget }
): Promise<CompiledContext>;
```

**Tests required:** (unchanged from prior draft) tier-1 never excluded; greedy packing order; reference-vs-content threshold; dedup; every exclusion logged with a reason; untrusted candidates never land in `instructions`/`constraints`; fixed layer order. **Added:** `compileContext` rejects (throws) a `candidateArtifactIds` entry that doesn't resolve to a row in `artifacts` — proving candidates must be persisted, addressable records.

**Out of scope:** Historical-usefulness scoring, LLM summarization, embeddings, compiled-context caching, model-specific window sizing (Unit 5 resolves `maxInputTokens` before this is called).

**Codex reviewability:** Testable against fixture data with no real LLM/Executor dependency.

---

### Unit 5: Model Router

**Objective:** Implement Phase 10's provider-agnostic routing interface. **Risk-driven tier selection is a model-quality floor only — it has zero effect on Policy's authorization decision (Unit 3), and Unit 3's output has zero effect on tier selection here.** The two are computed from the same `riskTier` input independently, never from each other.

**Files:**
- Create: `src/router/tierConfig.ts` — **explicitly a V1 implementation detail** (a swappable static config, not an architectural commitment; the interfaces below are what's actually load-bearing)
- Create: `src/router/types.ts`, `src/router/modelRouter.ts`
- Create: `src/router/providers/anthropic.ts`, `src/router/providers/openai.ts` (the **only** files permitted to import a provider SDK)
- Test: `tests/router/modelRouter.test.ts` (mock providers, no live API calls)

**Dependencies:** Unit 2 (budget reservation, Pass 1), Unit 4 (`ContextBudget.maxInputTokens` as Pass 1's pessimistic ceiling).

**Interfaces:**
```ts
export type ModelTier = "CHEAP" | "STRONG";
export type RouteRequest = {
  taskDifficulty: "simple" | "standard" | "complex";
  riskTier: import("../governance/risk").RiskTier; // "high"/"highest" forces STRONG — QUALITY FLOOR ONLY
  contextBudget: import("../context/types").ContextBudget;
  runId: string; taskInstanceId: string;
};
export type RouteResult = { tier: ModelTier; modelId: string; reservationId: string };

// Pass 1: reserve against contextBudget.maxInputTokens + expectedOutputTokens (worst case).
// This function has NO knowledge of Policy's decision and makes no authorization claim —
// it only ever answers "which model, and is there budget for it."
export async function authorizeRoute(tx: DrizzleTransaction, req: RouteRequest): Promise<RouteResult | { authorized: false }>;

// Pass 2+3: call the provider with the already-compiled context, then reconcile.
export async function callModel(
  tx: DrizzleTransaction, route: RouteResult, compiledContext: import("../context/types").CompiledContext,
  expectedOutputShape: Record<string, unknown>
): Promise<{ result: unknown; usage: { tokensIn: number; tokensOut: number; costAmount: number } }>;
```

**Tests required:**
- `authorizeRoute` selects `STRONG` when `riskTier` is `"high"`/`"highest"`, regardless of `taskDifficulty`.
- **Explicit non-authorization test**: selecting `STRONG` for a high-risk action does not create, resolve, or bypass any Approval — assert Unit 3's `evaluatePolicy`/`createApproval` are never called from within `authorizeRoute`/`callModel` (a spy-based test proving the modules are actually decoupled, not just documented as decoupled).
- `authorizeRoute` returns `{authorized: false}` on budget failure, without calling a provider.
- `callModel` reconciles actual usage in one transaction.
- Tier→model mapping is read from `tierConfig.ts`, not hard-coded — swapping the config changes routing (proving the "V1 detail, not architecture" claim is real, not just asserted).
- The full routing decision is captured as structured payload on the `invocation_started` event.

**Out of scope:** Confidence-based escalation (Phase 10.4), historical-performance-driven tier adaptation (Phase 10.5), `LOCAL` tier.

**Codex reviewability:** Provider wrapper files reviewable purely on "calls the SDK correctly, never leaks a credential." The non-authorization test is the key thing to check here.

---

### Unit 6: Run / Invocation Executor

**Objective:** Implement the thin Executor that sequences Invocations, explicitly enforcing the authorization chain order **Grant → Tool Binding resolution → Policy → Budget → Approval → Invocation execution**, and provides the two distinct Task Instance creation paths (standalone vs. workflow-created).

**Files:**
- Create: `src/execution/types.ts`
- Create: `src/execution/executor.ts` (`executeRun`)
- Create: `src/execution/invocationLifecycle.ts` (`proposeInvocation`, `authorizeInvocation`, `completeInvocation`, `failInvocation`)
- Create: `src/execution/invocationResults.ts` (`persistInvocationResultAsArtifact` — see Unit 8 rationale)
- Create: `src/execution/taskInstance.ts` (`createStandaloneTaskInstance` — Goal→Task direct path; internal `createWorkflowTaskInstance`, used only by Unit 7, never exported for standalone use)
- Test: `tests/execution/executor.test.ts`, `tests/execution/taskInstance.test.ts`

**Dependencies:** Units 1–5.

**Interfaces:**
```ts
export type InvocationKind = "llm" | "tool" | "retrieval" | "deterministic" | "browser";
export type InvocationSpec = {
  kind: InvocationKind;
  costClass: import("../governance/costClass").CostClass;
  payload: Record<string, unknown>; // for "tool": capabilityId, permission, proposedActionSnapshot, toolBindingId
};

export type RunOutcome = { status: "completed" | "failed" | "awaiting_approval"; runId: string };

// Orchestration order for a "tool" InvocationSpec, made explicit here rather than
// left implicit in prose: (1) resolve Capability Grant for the bound Agent, (2) resolve
// the concrete Tool Binding, (3) evaluatePolicy (Unit 3 — Grant/trust/risk only),
// (4) if ALLOW or REQUIRE_APPROVAL-then-approved: reserveBudget (Unit 2), (5) if
// REQUIRE_APPROVAL: createApproval and halt at "awaiting_approval" until resolved,
// (6) immediately before executing the Tool Binding: reauthorize (Unit 3, Grant/revocation)
// AND a fresh budget check (Unit 2) — both re-verified independently, not as one combined
// check. Step ordering is enforced by executeRun's control flow, not left to caller discipline.
export async function executeRun(tx: DrizzleTransaction, runId: string, invocationSpecs: InvocationSpec[]): Promise<RunOutcome>;

// src/execution/taskInstance.ts
// Goal -> Task Instance directly, workflow_run_id = null. Used by standalone tasks (Unit 8).
export async function createStandaloneTaskInstance(
  tx: DrizzleTransaction, taskDefinitionId: string, goalId: string, input: Record<string, unknown>
): Promise<{ taskInstanceId: string }>;

// Workflow Run -> Task Instance, workflow_run_id set. Called ONLY from Unit 7's
// advanceWorkflowRun — not exported for standalone use, keeping the two creation
// paths structurally distinct per Phase 3b.
export async function createWorkflowTaskInstance(
  tx: DrizzleTransaction, taskDefinitionId: string, workflowRunId: string, input: Record<string, unknown>
): Promise<{ taskInstanceId: string }>;

// src/execution/invocationResults.ts
// Persists a Tool Invocation's structured output as an addressable Artifact (small
// inline JSON per Phase 12's inline-content threshold) so it becomes a normal
// ContextCandidate for the NEXT Context Compiler call — never passed as a raw
// in-memory object across Invocation boundaries (this is the fix for Unit 8's
// original shortcut).
export async function persistInvocationResultAsArtifact(
  tx: DrizzleTransaction, invocationId: string, structuredOutput: Record<string, unknown>
): Promise<{ artifactId: string }>;
```

**Tests required:**
- `executeRun` on all-deterministic specs never invokes Unit 3's `evaluatePolicy` (spy-based).
- A `"tool"` Invocation with `REQUIRE_APPROVAL` halts at `awaiting_approval`; re-invoking `executeRun` after the Approval is granted resumes from that exact point, not from the start.
- **Explicit order-of-operations test**: instrument each of Policy/Budget/Approval with spies and assert they're called in the exact sequence Grant-check → Policy → Budget → Approval, for a spec that triggers `REQUIRE_APPROVAL`.
- Immediately-before-execution re-check calls `reauthorize` (Unit 3) and a fresh `reserveBudget` (Unit 2) as **two separate calls**, not one fused check (a spy-based test asserting both are called independently).
- `createStandaloneTaskInstance` produces a Task Instance with `workflow_run_id: null`; `createWorkflowTaskInstance` produces one with it set — and the former is never called by Unit 7's code (a structural/import-graph check).
- `persistInvocationResultAsArtifact` creates a real `artifacts` row with `producing_invocation_id` set, and the returned `artifactId` is usable directly as a `ContextCandidate.id` in a subsequent `compileContext` call (an integration test spanning Units 4 and 6).
- `executeRun` never imports a provider SDK directly (structural check).

**Out of scope:** The dynamic agentic loop (Phase 11.2 — not required by either MVP workflow); retry-with-model-escalation.

**Codex reviewability:** The order-of-operations test is the primary review artifact here — a reviewer confirms Policy and Budget are genuinely sequenced and independently re-checked, not merged into one convenience function.

---

### Unit 7: Workflow Interpreter (linear, 2-task, workflow-scoped only)

**Objective:** Implement Phase 11's Workflow Interpreter at MVP scope, strictly scoped to **Workflow-created** Task Instances — it never creates or touches standalone Task Instances.

**Files:**
- Create: `src/workflow/graphTypes.ts` (minimal linear JSON shape — reconciliation decision, unchanged)
- Create: `src/workflow/interpreter.ts` (`startWorkflowRun`, `advanceWorkflowRun`, `pauseWorkflowRun`, `resumeWorkflowRun`)
- Test: `tests/workflow/interpreter.test.ts`

**Dependencies:** Unit 6 (`executeRun`, and specifically `createWorkflowTaskInstance` — **not** `createStandaloneTaskInstance`).

**Interfaces:**
```ts
export type LinearGraphDefinition = { kind: "linear"; steps: { taskDefinitionId: string; taskDefinitionVersion: number }[] };

export async function startWorkflowRun(tx: DrizzleTransaction, workflowDefinitionId: string, goalId: string): Promise<{ workflowRunId: string }>;

// Internally calls Unit 6's createWorkflowTaskInstance for each step — never
// createStandaloneTaskInstance. This distinction is load-bearing per Phase 3b and
// is checked structurally (see tests).
export async function advanceWorkflowRun(tx: DrizzleTransaction, workflowRunId: string): Promise<{ status: "in_progress" | "completed" | "failed" | "paused" }>;

export async function pauseWorkflowRun(tx: DrizzleTransaction, workflowRunId: string): Promise<void>;
export async function resumeWorkflowRun(tx: DrizzleTransaction, workflowRunId: string): Promise<void>;
```

**Tests required:**
- `startWorkflowRun` + first `advanceWorkflowRun` creates a Task Instance with `workflow_run_id` set to this run — never null.
- `advanceWorkflowRun` does not create step 2's Task Instance until step 1 reaches `completed`.
- Pause/resume scenario A (between steps) and scenario B (during a step's `awaiting_approval`), as in the prior draft.
- A failed Task Instance halts `advanceWorkflowRun` at `"failed"`.
- **Structural test**: `src/workflow/interpreter.ts` never imports `createStandaloneTaskInstance` from Unit 6 (grep-based import check) — the distinct-code-paths requirement enforced mechanically, not just by convention.

**Out of scope:** Branching/looping, multiple Workflow Runs per Goal, retry-with-new-Run.

**Codex reviewability:** Small and self-contained; the import-graph check is the specific thing to verify for the standalone/workflow distinction.

---

### Unit 8: `research.retrieve` Capability + Standalone Workflow 1

**Objective:** Implement the `research.retrieve` Capability, its Tool Binding, the "Researcher" Agent Definition, the "Research → Report" Task Definition, and seed data — as a **standalone** Task Instance (via Unit 6's `createStandaloneTaskInstance`, not the Workflow Interpreter), proving Phase 18.2's workflow 1 end to end, with the tool's output persisted as an addressable Artifact before the LLM Invocation consumes it.

**Files:**
- Create: `src/capabilities/researchRetrieve/capability.ts`
- Create: `src/capabilities/researchRetrieve/toolBinding.ts`
- Create: `src/definitions/seed.ts` (seeds: Project, Goal, "Researcher" Agent Definition + Grant for `research.retrieve` at `READ`/`AUTONOMOUS` — `READ` has no ceiling restriction, so this is a valid Grant per Unit 3's `validateCapabilityGrant` — "Research-Report" Task Definition with its default Context Budget)
- Test: `tests/capabilities/researchRetrieve.integration.test.ts`

**Dependencies:** Units 1–7 (uses `createStandaloneTaskInstance` and `persistInvocationResultAsArtifact` from Unit 6 specifically — not Unit 7's workflow path).

**Interfaces:**
```ts
export const RESEARCH_RETRIEVE_CAPABILITY = {
  id: "research.retrieve", description: "Retrieve information relevant to a query",
  staticRiskTag: "low" as const, costProfile: { costClass: "metered_api" as const },
};

export async function retrieveResearch(query: string): Promise<{ results: { title: string; snippet: string; sourceUrl: string }[] }>;
```

**Tests required:**
- Seeding creates the Project/Goal/Agent Definition/Grant/Task Definition rows correctly, and the seeded Grant passes `validateCapabilityGrant`.
- Starting via `createStandaloneTaskInstance` (not any Workflow Interpreter function) produces a Task Instance with `workflow_run_id: null`.
- The Run executes a `"tool"` Invocation (`retrieveResearch`) whose structured output is persisted via `persistInvocationResultAsArtifact` (Unit 6) into a real Artifact **before** the second, `"llm"` Invocation runs — assert the LLM Invocation's `compileContext` call receives that Artifact's ID in `candidateArtifactIds`, not the raw JS object from `retrieveResearch`'s return value (a test that would fail if someone "optimized" this back into an in-memory pass-through).
- The Run produces exactly one `"report"`-type Artifact, referencable by ID afterward.
- `capability.ts` contains no reference to the concrete API/service used in `toolBinding.ts` (structural test).
- Model routing for this workflow resolves to `CHEAP`.

**Out of scope:** `publish.report` and workflow 2 (Unit 9).

**Codex reviewability:** A reviewer swaps `toolBinding.ts`'s implementation for a fixture and confirms zero other files change; separately confirms the artifact-mediated hand-off test actually fails if the persistence step is skipped (i.e., the test isn't accidentally passing regardless).

---

### Unit 9: `publish.report` Capability + Workflow 2 (full governance chain)

**Objective:** Implement `publish.report` as a **proof/test binding** (a local-filesystem write demonstrating the governance boundary — explicitly not a production integration) with an `ALWAYS_APPROVE` Grant, composed with Unit 8's Task Definition into a two-step Workflow Definition, proving Phase 18.2's full governance chain and pause/resume scenarios.

**Files:**
- Create: `src/capabilities/publishReport/capability.ts` (`staticRiskTag: "highest"`, permission `PUBLISH`)
- Create: `src/capabilities/publishReport/toolBinding.ts` — **explicitly documented as a proof/test binding**: writes the report Artifact's content to a local path under `ARTIFACT_ROOT/published/`, demonstrating that the governance chain (Grant→Policy→Approval→re-authorization→execution) gates a real side effect, without claiming to be a real publishing integration (no Phase 14 rubric evaluation was performed for an actual third-party publish target, nor should one be — that's real future work, not MVP scope)
- Modify: `src/definitions/seed.ts` (add "Publisher" Agent Definition + Grant with `autonomyState: "ALWAYS_APPROVE"` for `PUBLISH` — validated by Unit 3's `validateCapabilityGrant`, which accepts `ALWAYS_APPROVE` for `PUBLISH` but would reject `AUTONOMOUS`; add "Review-and-Publish" Task Definition; add the two-step `LinearGraphDefinition` Workflow Definition)
- Test: `tests/capabilities/publishReport.integration.test.ts`

**Dependencies:** Units 1–8 (reuses Unit 8's Task Definition as step one; uses Unit 7's Workflow Interpreter for orchestration, since this workflow **is** workflow-created, unlike Unit 8's standalone task).

**Interfaces:**
```ts
export const PUBLISH_REPORT_CAPABILITY = {
  id: "publish.report", description: "Write a report artifact's content to a local proof-of-governance output location",
  staticRiskTag: "highest" as const, costProfile: { costClass: "external_side_effect" as const },
};

export async function publishReport(artifactId: string, destinationRelativePath: string): Promise<{ publishedPath: string }>;
```

**Tests required:**
- Task A (Unit 7's `createWorkflowTaskInstance`, reusing Unit 8's Task Definition) completes and produces an Artifact; Task B's Agent Definition consumes it **by reference** (assert the compiled context contains an artifact reference, not duplicated content).
- Task B's `publish.report` Invocation: `evaluatePolicy` (Unit 3, Grant/trust/risk only) returns `REQUIRE_APPROVAL` because the Grant's `autonomyState` is `ALWAYS_APPROVE` — assert this decision is reached without any budget check having occurred yet (order-of-operations, per Unit 6).
- An `Approval` is created with the exact snapshot (artifact ID + destination path).
- **Material-change invalidation, end-to-end**: mutate the destination after Approval creation; `reauthorize` blocks execution.
- **Full chain integration test**, asserting each step in order: Grant validated → Tool Binding resolved → Policy = `REQUIRE_APPROVAL` → Approval created with exact snapshot → `resolveApproval("approved")` → fresh `reauthorize` + fresh `reserveBudget` (both independently, per Unit 6) → `publishReport` executes → outcome Events recorded.
- Rejecting the Approval results in the Task Instance reaching `failed`; `publishReport` is never called (spy-based).
- **Pause/resume scenario A**: pause between Task A completion and Task B start via Unit 7's `pauseWorkflowRun`; Task B doesn't start; resume proceeds correctly.
- **Pause/resume scenario B**: pause while Task B's Invocation is `awaiting_approval`; Approval remains resolvable; resume allows execution to proceed after approval.
- A structural test/comment confirms `publishReport`'s destination is always under `ARTIFACT_ROOT/published/` (local, relative) — reinforcing that this binding is a governance-boundary proof, not a networked integration.

**Out of scope:** Any capability beyond these two; `CONDITIONAL`/`AUTONOMOUS` for this Grant (stays `ALWAYS_APPROVE`, and `AUTONOMOUS` would be rejected by `validateCapabilityGrant` if attempted).

**Codex reviewability:** The single most important integration test in the MVP — verify it exercises every named step in order with real assertions, and verify the toolBinding's doc comment and destination path make its proof-only nature unambiguous to a future reader who might otherwise mistake it for production-ready.

---

### Unit 10: API Layer

**Objective:** Implement the Fastify API layer, including SSE reconnect semantics that correctly combine Postgres replay (authoritative) with in-process live delivery, with no gap or duplication at the transition.

**Files:**
- Create: `src/api/server.ts`
- Create: `src/api/routes/goals.ts`, `src/api/routes/approvals.ts`, `src/api/routes/workflowRuns.ts`, `src/api/routes/events.ts`
- Create: `src/api/eventBus.ts` (in-process `EventEmitter` — **live delivery only**, never a source of truth)
- Test: `tests/api/routes.integration.test.ts`, `tests/api/sseReplay.test.ts`

**Dependencies:** Units 1–9.

**Interfaces:**
```ts
// src/api/eventBus.ts
export function publishLiveEvent(event: import("../events/types").EventEnvelope): void;
export function subscribeToLiveEvents(handler: (e: EventEnvelope) => void): () => void; // unsubscribe fn

// src/api/routes/events.ts — GET /events/stream?sinceSequenceNo=N
// Correct reconnect sequence (no gap, no duplication):
//   1. Subscribe to the live EventEmitter FIRST, buffering incoming events in memory
//      (do not stream them to the client yet).
//   2. Query Postgres for all events with sequenceNo > N, ordered ascending, and stream
//      them to the client — this is the authoritative replay; Postgres, not the
//      EventEmitter, is the source of truth for this backlog.
//   3. Flush the buffered live events collected during step 2, DE-DUPLICATED against
//      what was just replayed (skip any buffered event whose sequenceNo was already
//      sent in step 2's query result).
//   4. Continue streaming subsequent live events directly as they arrive.
// This ordering (subscribe-then-query, not query-then-subscribe) is what prevents an
// event emitted between steps 2 and 4 from being silently lost.
```

**Tests required:**
- `POST /goals` starts a Goal + Workflow Run.
- `GET /approvals` returns pending Approvals with full snapshots.
- `POST /approvals/:id/approve` and `/reject` call Unit 3's functions and the gated Invocation proceeds/fails accordingly.
- `POST /workflow-runs/:id/pause` / `/resume` round-trip against Unit 7.
- **SSE replay-then-live test** (`sseReplay.test.ts`): seed events 1–10 in Postgres; connect with `sinceSequenceNo=5`; assert events 6–10 arrive via replay; then emit a new live event 11 through `emitEvent`+`publishLiveEvent` and assert it arrives exactly once (not duplicated, not missed) — including a variant where event 11 is emitted **during** the replay window (simulated via a controlled delay) to prove the subscribe-then-query ordering actually closes the gap, not just the simple case.
- No route contains policy/budget/workflow logic inline (structural check — each route calls exactly one governance/workflow function).

**Out of scope:** Auth (Phase 9.8); Registry admin routes; Cost dashboard/Memory browser routes; the TTL sweep.

**Codex reviewability:** The SSE replay test with the simulated mid-replay event is the specific thing to scrutinize — it's the one place a subtle race condition could hide.

---

### Unit 11: Minimal UI (Overview, Activity Feed, Approvals Queue)

**Objective:** Implement Phase 18.1's V1 UI scope, with the activity subscription interface reflecting real reconnect semantics.

**Files:**
- Create: `web/app/page.tsx`, `web/app/approvals/page.tsx`, `web/components/ActivityFeed.tsx`, `web/components/AgentCard.tsx`, `web/lib/api.ts`
- Test: `web/tests/overview.test.tsx`, `web/tests/approvals.test.tsx`

**Dependencies:** Unit 10.

**Interfaces:**
```ts
export async function listActiveAgents(): Promise<AgentCardData[]>;
export async function listPendingApprovals(): Promise<ApprovalData[]>;
export async function approveApproval(id: string): Promise<void>;
export async function rejectApproval(id: string): Promise<void>;

// Reconnect is represented explicitly in the interface: the caller always supplies
// the last sequence number it has seen (or null for a fresh start), matching Unit
// 10's GET /events/stream?sinceSequenceNo=N contract exactly.
export function subscribeToActivity(
  sinceSequenceNo: number | null,
  onEvent: (e: EventDisplayItem) => void
): () => void; // returns unsubscribe
```

**Tests required:**
- Overview renders Active Agents from `listActiveAgents()`; no revenue stat when no revenue projection exists.
- Activity Feed renders events from `subscribeToActivity(null, ...)` on initial mount, oldest-to-newest, no client-side re-ordering logic.
- **Reconnect test**: simulate a dropped connection after receiving events up to sequence 7; assert the component calls `subscribeToActivity(7, ...)` (not `null`, not some other value) on reconnect — proving the last-seen sequence is actually tracked and threaded through, not merely accepted as a parameter nobody calls correctly.
- Approvals page renders exact snapshot fields; calls `approveApproval`/`rejectApproval` with no client-side policy logic.

**Out of scope:** Agent Detail, Workflow graph view, Registry admin UI, Cost dashboard, Memory/Artifact browser, visual/gamification styling.

**Codex reviewability:** Each component testable against a mocked `web/lib/api.ts`; the reconnect test is the one to check closely, since a UI that accepts `sinceSequenceNo` as a parameter but never actually tracks/passes it correctly would pass a naive test suite while still losing events in practice.

---

## Self-review

**Spec coverage**: Phase 3 → Units 1, 6, 7 (with the standalone/workflow distinction now structurally enforced). Phase 4 (chokepoints, Policy/Budget as separate boxes) → Units 3, 5, 6, 10. Phase 5 → Unit 4. Phase 6 → Unit 3's `trustLevel`. Phase 8 → Unit 1 (full envelope). Phase 9 → Units 2–3 (now correctly decoupled), exhaustively tested in Unit 9. Phase 10 → Unit 5 (quality-floor-only proven by spy tests). Phase 11 → Unit 7. Phase 12 → Unit 1. Phase 13 → all units. Phase 15 → Units 10–11 (SSE semantics corrected). Phase 18.2 → Units 8–9. No gaps found on this pass.

**Placeholder scan**: none found — all corrections resulted in concrete signatures, concrete test names, and explicit rationale comments rather than TBDs.

**Type consistency**: `EventEnvelope` (now with `eventId`/`idempotencyKey`/`eventVersion`/`correlation`/`producer`/`usage`) is defined once in Unit 1 and referenced identically everywhere it's used (Units 5, 6, 10). `CapabilityGrant`, `PolicyDecision`, `RiskTier` (Unit 3), `ContextBudget`/`CompiledContext`/`ContextCandidate` (Unit 4), `RouteRequest`/`RouteResult` (Unit 5), `InvocationSpec`/`RunOutcome` (Unit 6), and `LinearGraphDefinition` (Unit 7) are each defined once and consumed by identical name/shape downstream.

---

**Status:** Approved by user with corrections (this revision). Not yet executed — no code has been written, no branch/worktree created, no subagent dispatched. Execution mode (subagent-driven vs. inline) to be chosen when the user authorizes starting Unit 1.
