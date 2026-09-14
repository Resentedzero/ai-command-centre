# AI Command Centre — Architecture & Design

Status: **Complete — Phases 1–20 approved**, with iterative refinements incorporated
throughout. This is the frozen V1 architecture. Implementation has not begun; further
architecture changes are made only in response to a concrete implementation
discovery, not proactively.

## Phase 1 — Vision

Not a dashboard with chatbots bolted on. This is **an operating system for delegated
cognitive labor**: a runtime that turns goals into tasks, selects the minimum
capability/context/model needed per task, executes it, records what happened as
structured events and artifacts, and renders that stream as a living command center.
The UI is a *view* over an event log — it has no logic of its own. The hard problem is
the **context/capability/cost governance layer** between "an agent wants to do
something" and "an LLM call actually happens." Gamification, visuals, and specific
agents are decoration on top of that layer — which is why the platform is built before
the agents.

## Phase 2 — Governing principles

1. **Capability-first, not tool-first, not framework-first.** The Capability Registry
   is the spine; MCP, direct APIs, browser automation, and hand-written functions are
   implementations a capability can bind to — never the organizing concept.
2. **Context is compiled, never inherited.** No agent ever receives "everything so
   far." Every LLM call is built from an explicit, minimal, task-scoped context object.
3. **Determinism before delegation.** If a step can be plain code, it is plain code —
   never an LLM call.
4. **Cost is a hard constraint, not a metric checked later.**
5. **Everything observable is a fact, not a log line.** Events are the system of
   record; UI, cost tracking, and debugging are queries over the event store.
6. **Progressive autonomy, not day-one autonomy.** Every capability starts at
   READ/PROPOSE; EXECUTE/SPEND/PUBLISH are earned per-capability via track record.
7. **Boring infrastructure by default.** One local Postgres beats a vector DB,
   Temporal, and a message broker until there's measured evidence they're needed.
8. **Optimize for total useful work per token/dollar, not lowest raw inference cost.**
   Cheap models are not used when they produce substantially worse outcomes that
   require retries, human correction, or additional model calls.

### Corrections to the original brief (research-backed)

- **Subscription-backed programmatic compute is not free/unlimited.** The only
  sanctioned path for using a Claude Pro/Max subscription programmatically is
  Anthropic's own **Claude Agent SDK** / `claude -p` (confirmed via Anthropic's own
  Help Center). Reusing subscription OAuth to serve *other users* — offering
  claude.ai login in your own app, or routing others' requests through your plan
  credentials — is prohibited. Billing mechanics for Agent SDK usage are **actively in
  flux** — specific dollar figures must not be hard-coded into the architecture;
  re-verify against `support.claude.com` before any component depends on a number.
  **(AMENDED 2026-09-13.)** This bullet previously ended: *"The runtime never assumes
  it can ride on a developer's interactive subscription."* That sentence stands as a
  principle but no longer implies a blanket prohibition: per the amended 10.6, the
  runtime may use a **dedicated subscription-backed provider adapter** with its own
  credential and isolation, and still never rides on, inherits, or requires the
  developer's interactive session. Development-time AI (Claude Code, Codex —
  interactive, used by the human to build the system) remains a fully separate concern
  from Runtime AI (the Command Center's own model gateway/router calling models
  programmatically at runtime).
  **Verified 2026-09-13** (see `docs/research/`): subscription usage currently powers
  `claude -p`/Agent SDK; Anthropic announced separate metering in May 2026, paused it
  on 15 June 2026, and has published nothing since. Anthropic's developer
  documentation still directs those "building products or services" to API keys, and
  states plan limits "assume ordinary, individual usage." The single-user, local,
  personal case is **genuinely ambiguous in Anthropic's own text** and is an accepted,
  recorded risk of this architecture — not a resolved question. Enforcement is
  reserved "without prior notice."
- **MCP is not the default integration mechanism.** MCP tool schemas run ~1000
  tokens/tool (5–15x a minimal function schema) and are typically loaded eagerly. MCP
  is one Tool binding a Capability can point to, loaded lazily only when a task's
  compiled context needs it — never globally registered.
- **Temporal is dropped for V1.** Self-hosted Temporal targets distributed,
  high-throughput, team-scale workloads. A solo local MVP gets pause/resume/retry from
  a Postgres-backed run-state table with zero extra services.
- **No dedicated vector database for V1.** pgvector inside the one Postgres instance
  is mature well past the scale this project will hit; enabled only if a specific
  retrieval need justifies it later (off by default).
- **No Langfuse dependency at MVP.** Real value, real operational weight (4+
  containers) for a solo user. Structured event logging into the same Postgres covers
  cost/token tracking at MVP; Langfuse is an later addition, not a day-one dependency.
- **Gamification XP is derived, not authored.** Computed as a pure function over the
  event log — agents never award themselves XP.

Net effect on infra: **MVP runs on one local Postgres (with pgvector available but
off) and nothing else mandatory** — no Redis, no Temporal, no Langfuse, no separate
vector DB.

## Phase 3 — Core abstractions

### 3a. Invocation layer (Context and Model are per-invocation, not per-Run)

- **Run** = one bounded attempt by (optionally) one Agent Definition to complete one
  Task Instance. A container/ledger holding an ordered sequence of Invocations, an
  overall budget envelope, and a final outcome. No context or model of its own.
- **Invocation** = one concrete callable operation inside a Run, one of five kinds:
  **LLM**, **Tool**, **Retrieval**, **Deterministic function**, **Browser/external
  action**. Lifecycle: `proposed → authorized → executing → completed/failed`.

  > **Implementation note (Phase 9, 2026-09-14) — makes `executing` durable.**
  > An LLM Invocation commits `executing` *before* its provider call, which happens
  > with no database transaction open. The outcome is recorded in a fresh
  > transaction. An `executing` Invocation whose process died has an **unknown**
  > outcome. It is failed and never re-dispatched (a retry is a new Run, §3b). Its
  > reservation is charged at the full estimate, not released. Exactly one process
  > may execute against a database (§13.2, enforced at startup). Authoritative
  > write-up: `docs/architecture/DURABLE_EXECUTION.md`.
  - *LLM Invocation*: Context Compiler compiles minimal context fresh for this
    invocation only; Model Router selects model/provider; Budget Governor
    estimates/authorizes before the call; structured events + usage recorded after.
  - *Tool Invocation*: Capability Grant + Policy check before execution; concrete Tool
    executes; structured output becomes available to subsequent context compilation.
  - *Retrieval Invocation*: feeds future context compilation; read-scope checked only.
  - *Deterministic function*: free, no governance overhead beyond existence check.
  - *Browser/external action*: highest-scrutiny policy tier.

This is the mechanism, not just the principle, behind "context is never inherited
wholesale": nothing except the Context Compiler is allowed to hand an LLM Invocation
its input, and it does so fresh every time.

### 3b. Definition vs. instance

- **Workflow Definition** (reusable DAG template) vs **Workflow Run** (one
  instantiation against one Goal).
- **Task Definition** (reusable node-type) vs **Task Instance** (one concrete node in
  a Workflow Run, or a standalone ad hoc task with `workflow_run_id = null`).
- **Agent Definition** (versioned identity/objective/instructions/capabilities/policy)
  — a Run *is* the binding (`agent_definition_id@version` + `task_instance_id`); no
  separate "Agent Binding" entity. Retries create additional Runs against the same
  Task Instance.
- **Capability Definition** vs **Capability Grant** (see 3c).
- **Tool Definition** (versioned implementation) — an Invocation record is the
  instance; no separate entity needed.

### 3c. Capability vs. authorization (four separate concerns)

1. **Capability** (what it IS): id, description, required permission types, cost/risk
   profile. No authorization semantics.
2. **Capability Grant** (what an Agent Definition is ALLOWED to do):
   `(agent_definition_id, capability_id, permission_level, scope)`.
3. **Tool binding** (which concrete Tools implement a Capability right now) —
   selection among eligible bindings is a routing/availability decision, not a policy
   decision.
4. **Policy evaluation** (what's permitted for *this* Run/Invocation, right now) —
   takes the Grant plus budget state, risk, trust level as inputs; outputs
   `ALLOW / DENY / REQUIRE_APPROVAL`.
5. **Approval** — created only when Policy returns `REQUIRE_APPROVAL`; gates one
   specific Invocation, not a whole Run or Task Instance (see Phase 9 refinement).

A grant alone never authorizes execution by itself.

### 3d. Workflow execution semantics

```
Goal
 -> Workflow Run (instance of a Workflow Definition; owns status + variable bindings)
     -> Task Instances (status: pending/active/skipped/blocked/failed/completed)
         -> Run(s) (one per attempt; retries create additional Runs)
             -> Invocation(s) (LLM / Tool / Retrieval / Deterministic / Browser)
```

- **Branching/looping** resolved by the Workflow Definition's graph (conditional
  edges evaluated by plain deterministic code against a Task Instance's
  output/artifact) — never by an LLM deciding workflow topology at runtime.
- **Retries**: a failed Run doesn't mutate Task Instance history — a new Run is
  created against the same Task Instance, up to a policy-defined retry limit.
- **Failed Task Instance** (retries exhausted): Workflow Run routes to a defined
  failure edge, marks dependents `blocked`, or halts — a property of the Workflow
  Definition.
- **Skipped Task Instance**: an explicit graph outcome, distinguishable from `failed`.
- **Human approval mid-workflow**: a Task Instance in state `awaiting_approval`,
  derived from an unresolved Approval on one of its Runs' Invocations (see Phase 9).
- **Standalone tasks**: Task Instances with `workflow_run_id = null`.
- **Structured Workflow vs. agentic loop** (Phase 11): use a structured Workflow when
  the sequence of task types is known ahead of time; use an agentic loop (multiple
  Invocations inside one Run) when the step count/shape genuinely can't be known ahead
  of time within one bounded Task. Both compose: a Workflow node's Task Instance may
  internally run an agentic loop. The Workflow never delegates topology decisions to a
  model.

### 3e. Event Store semantics (hybrid, not full event-sourcing)

- **Events are append-only, immutable**, the only system of record for *what
  happened*. Principle: *"Every meaningful state transition or externally significant
  action produces one or more immutable structured Events. Events represent facts,
  not arbitrary application logs."* A single operation may legitimately emit several
  related events (e.g. `invocation_completed` + `artifact_created` +
  `budget_consumed`).
- **Current state is a transactional projection, not a replay.** Run/Task
  Instance/Workflow Run status and budget counters are mutable columns updated in the
  *same transaction* as the triggering Event insert.
- **UI reads projections** for current-state views and the **Event table** for
  activity feed/timeline/audit/replay/debugging.
- **Cost, XP, and other metrics are derived aggregates**, updated incrementally in the
  same transaction as the triggering Event (synchronous) or via a background
  projection loop (asynchronous) — never batch-recomputed from scratch, never scattered
  ad hoc logic in the UI layer.
- **Idempotency**: every Invocation carries a unique id and a per-Run monotonic
  sequence number, used as an idempotency key for Event inserts.
- **Ordering**: sequence numbers scoped per Run (and per Workflow Run) are
  authoritative for causal order; wall-clock timestamps are for display only.
- **Domain/audit Events vs. diagnostic/application logs** are explicitly distinct.
  Diagnostic logs (stdout/local files) exist for debugging only and are never part of
  the authoritative event history or queried for state, cost, or history.

### Updated dependency chain

Goal → Workflow Run (of a Workflow Definition) → Task Instance (of a Task Definition)
→ Run (Agent Definition optionally bound to a Task Instance) → Invocation (LLM / Tool
/ Retrieval / Deterministic / Browser) → *(LLM: Context Compiler + Model Router +
budget check)* / *(Tool: Capability Grant + Policy → optional Approval → Tool
execution)* → emits Event(s) → may produce Artifact(s) → projections update state →
next Invocation, next Task Instance, or completion.

## Phase 4 — System architecture

Constraint governing this diagram: everything except **PostgreSQL** and the **local
filesystem** is a layer of one application, not a separate service. No message
broker, no separate cache service, no microservices.

```
UI / CONTROL PLANE
  - renders projections + event feed; sends commands (start Goal, approve/reject,
    pause/resume). Talks ONLY to the API layer. No business logic here.
        |  HTTP (commands/queries) + SSE/WS (live events)
API / APPLICATION LAYER
  - only entry point; validates commands; streams Event feed + projections to UI.
        |
WORKFLOW INTERPRETER
  - reads Workflow Definition + Task Instance projections; evaluates graph edges with
    plain code; creates/transitions Task Instances. NEVER calls an LLM.
        |  "run this Task Instance"
RUN / INVOCATION EXECUTOR  (deliberately thin — coordinates, does not absorb logic)
  - owns the Run; steps through Invocations in order. Contains no workflow topology,
    context compilation, model routing, policy, capability selection, tool
    implementation, or UI logic — those remain separate modules it calls out to.
    |-> CONTEXT COMPILER (LLM Invocations only; builds minimal per-invocation payload)
    |-> CAPABILITY REGISTRY + POLICY/APPROVAL ENGINE (Tool/Action Invocations)
    |-> BUDGET / COST GOVERNOR (every Invocation; depth of check scales with cost
    |     class — trivial for deterministic, full estimate for LLM/paid calls)
    |-> MODEL ROUTER / GATEWAY — the ONLY component allowed to call LLM providers
    |     directly. Provider SDKs/API keys live only here.
    |-> TOOL ADAPTERS — internal functions, MCP client (loaded lazily), direct API
          clients, browser automation driver, local process runner. Only reachable
          after Policy = ALLOW. Never call LLMs themselves.
        |  events + results
POSTGRESQL  (single local instance — the only durable service)
  - Events (append-only, authoritative)
  - Projections (current Run/Task/Workflow/budget state, same-transaction)
  - Definitions (Workflow/Task/Agent/Capability/Policy, versioned)
  - Small/structured Artifact metadata + optional inline content
  - pgvector extension OFF by default
ARTIFACT STORAGE (large/binary) — local filesystem, path+hash referenced from Postgres
        |
EXTERNAL PROVIDERS
  - Anthropic (API / Agent SDK), OpenAI, other model providers, local models,
    third-party APIs, MCP servers, browser targets. Reachable only through Model
    Router (LLMs) or Tool Adapters (everything else).
```

### Where cost/token governance happens

Two enforcement points, both **before** anything expensive runs:
1. **Budget/Cost Governor**, consulted for every Invocation — checks remaining
   budget, estimates cost, returns `authorized / authorized-at-downgraded-tier /
   denied / degrade`.
2. **Model Router**, which folds difficulty + the Governor's authorization into the
   actual model/provider choice.
Actual usage is recorded via the Invocation's Event write, updating budget-consumed
projections in the same transaction.

### Infra justification ledger

| Component | Real infra? | Why justified for V1 |
|---|---|---|
| PostgreSQL | Yes | Single durable store for events, projections, definitions, artifact metadata. |
| Local filesystem | Yes (trivial) | Large/binary artifact bytes; zero cost. |
| SSE/WS (API→UI) | Yes, in-process | Live activity feed; polling would be laggy/wasteful. Via Postgres LISTEN/NOTIFY or in-process pub-sub. |
| Redis/queue/broker | No | Nothing needs cross-process pub-sub/distributed queuing at solo scale. |
| Temporal/workflow engine | No | Covered by the Workflow Interpreter. |
| Vector DB/pgvector | No (default off) | Enabled only when a concrete retrieval need justifies it. |
| Object storage (S3/MinIO) | No | Single machine/user; local disk is durable enough. |
| Langfuse | No | Events + projections already give trace/cost data. |

## Phase 5 — Token / Context Optimization (Context Compiler)

### 5.0 Two distinct budgets

- **Financial/Resource Budget** (Budget Governor): can we afford this call, at what
  model tier? Money/quota.
- **Context Budget**: given that we're making this call, what's the minimum
  sufficient input? Token efficiency, independent of financial scarcity.

**Context Budget fields** (Task Definition default, overridable per Task Instance,
tightenable by the Budget Governor when funds are constrained): `max_input_tokens`,
`max_artifact_tokens`, `max_retrieved_items`, `max_tool_schema_tokens`,
`max_memory_items`, `compression_threshold`, `freshness_requirement`,
`expected_output_tokens`.

`max_input_tokens` is **load-bearing**, not advisory (see Phase 10.7 fix below) — it
is the pessimistic ceiling the Budget Governor uses for pre-authorization before
compilation happens.

### 5.1 Context sources

Five source types, queried independently: Task/Run state; Artifacts (by reference,
resolved per 5.5); Memory (per 5.6, never all scopes by default); Tool/Capability
schemas (per 5.7); Instructions/constraints.

### 5.2 The compilation pipeline

1. **Declare need**: a typed intent (`classify`, `synthesize`, `extract`, `decide`,
   `summarize`, ...) plus candidate input references — never "give me context."
2. **Candidate gathering**: cheap structural filters only (task scope, time window,
   capability grant), no LLM calls.
3. **Relevance scoring** (5.3).
4. **Priority-tiered greedy packing** (5.4) against the Context Budget's token
   ceiling — a bin-packing step, not "include everything under some limit."
5. **Reference-vs-content decision** (5.5) per included artifact.
6. **Compression pass** (5.9) on anything over threshold that made the cut.
7. **Deduplication pass** (5.10).
8. **Layered assembly** (5.14): instructions → constraints → task state → memory →
   artifacts → tool schemas → this invocation's specific instruction.
9. **Provenance stamp** (5.13).
10. **Emit** the compiled context object to the Model Router.

### 5.3 Relevance scoring

Deterministic/cheap first: structural signals (lineage, explicit ID reference,
capability match, recency), lexical/keyword overlap, embedding similarity (only if
pgvector is enabled for this project — off by default), historical usefulness
(derived from Events: items actually referenced in past outputs for similar tasks
score higher). LLM-based scoring is a last resort, not the default (scoring is itself
a cost).

### 5.4 Priority tiers

Fixed order, always honored regardless of raw score: **1. Required** (task's own
declared input; never dropped — exceeding budget here is a configuration error
surfaced to the Executor, not silent truncation). **2. High-value derived**
(top-scored support for success criteria). **3. Supporting context.** **4.
Nice-to-have** (routinely empty in the compiled result, by design). Packing fills
tier 1 → 4, stopping the instant the budget is hit.

### 5.5 Artifact references vs. content

Default is **reference** (ID + one-line summary + schema). Content is inlined only
when the artifact is small enough to fit trivially *and* the task's declared intent
requires content, not existence/metadata. Otherwise a reference is included, and
content is pulled via a new Retrieval Invocation only on demonstrated need.

### 5.6 Memory selection

Never "all memory of this scope." Working state (Phase 7 renamed this to Run State,
not memory) — only prior Invocation outputs within this Run, structured, never a raw
transcript. Task/Agent/Project/Organizational memory — filtered by relevance and
explicit promotion (Phase 7).

### 5.7 Tool-schema selection

Lazy, capability-scoped, per Invocation: start from the bound Agent's Capability
Grants → narrow to capabilities the declared intent needs → load schemas only for
eligible Tool bindings under those capabilities, minimal schema variant. MCP-backed
tools are loaded here, lazily, exactly once per Invocation that needs them — never
registered globally.

### 5.8 Dynamic recompilation after tool calls

Each subsequent LLM Invocation in a Run gets a fresh compilation. A prior Tool
Invocation's *structured output* becomes a new high-priority candidate for the next
compilation — the raw tool call/response pair is never replayed, keeping a multi-step
agent loop's context flat instead of monotonically growing.

### 5.9 Compression & summarization

Deterministic compression first (field projection, tabular reduction) — free,
preferred for structured sources. LLM-based summarization only for genuinely
unstructured prose exceeding the compression threshold — itself a tracked, budgeted
Invocation producing a new cached, reusable Artifact, versioned against its source's
hash (invalidated if the source changes).

### 5.10 Deduplication

Content-hash and source-artifact-ID comparison before final assembly; collapse
duplicates to the highest-priority framing.

### 5.11 Caching

Three layers, all keyed off content hashes: compiled-context cache (reuse on retry
with same intent/candidates/budget); summary/derived-artifact cache (reusable across
consumers); provider prompt caching (layered assembly, 5.14, keeps the stable prefix
identical across calls). Cache hit/miss is logged as part of the Invocation's Event
data.

### 5.12 Stale-context detection

Every source item carries a freshness stamp. Anything older than
`freshness_requirement` is excluded or flagged for a refreshing Retrieval Invocation —
never silently served stale.

### 5.13 Context lineage / provenance

The compiled context object records exactly which artifact IDs/versions, memory item
IDs, and tool schemas went in, at what priority tier, and why excluded candidates were
excluded — stored as structured metadata on the Invocation's Event.

### 5.14 Prompt/instruction layering

Fixed order for clarity and cache-friendliness: (1) system/role instructions
(stable) → (2) task constraints/success criteria (stable per Task Instance) → (3)
current task state → (4) memory → (5) artifacts → (6) tool schemas → (7) this
invocation's specific instruction. Layers 1–2 are what get prompt-cached.

### 5.15 Context poisoning / injection concerns

Anything from an external Tool result, retrieved document, or another agent's output
is tagged **untrusted data**, structurally separated from instructions in the layered
assembly — never concatenated as if equally authoritative. The Compiler is the
enforcement point.

> **Implementation note (2026-09-14): layers 1–3 and untrusted-data fencing
> (`src/context/compiler.ts`).**
>
> **The layers the Compiler now fills:**
> - **Instructions.** Taken from the Run's bound Agent Definition (role, objective,
>   instructions).
> - **Task state.** A workflow step's task state includes the Goal it serves. Steps
>   carry no input of their own yet.
> - **Untrusted artifacts.** Every artifact from a prior Invocation is wrapped in
>   `<untrusted_data artifact=… mode=…>…</untrusted_data>`. Any fence tag inside
>   the content is neutralised, so a block cannot close itself early. Whenever a
>   fenced block is present, the constraints layer carries a fixed policy: fenced
>   content is data and must never be obeyed.
>
> **Budget and lineage:**
> - Task state that alone exceeds `max_input_tokens` throws `ContextBudgetError`
>   (§5.4), and nothing is sent.
> - Each LLM Invocation emits `context_compiled`, recording provenance, excluded
>   candidates with reasons, and the token estimate (§5.13/§5.16). Content is never
>   recorded.
>
> **Residuals:**
> - **No separate system channel on the Claude CLI.** The API adapters send the
>   instruction and constraint layers as system content. The Claude CLI adapter
>   prepends them to the same stdin text. Moving them to a CLI system-prompt flag
>   would change the command-line arguments, which were verified against the live
>   CLI (SUBSCRIPTION_PROVIDER_DESIGN), so it needs its own live check.
> - **Intent does not yet choose reference vs content (§5.5).** Every current
>   intent needs content.
> - **Not built:** compression (§5.9), caching (§5.11) and relevance scoring
>   (§5.3).

### 5.16 Measuring context efficiency

Per Invocation, recorded as Event data: input tokens included, cache hit/miss per
layer, candidates considered vs. included vs. excluded-and-why. "Tokens actually
used" is measured **deterministically** — included artifacts/memory carry IDs; check
whether those IDs are referenced in the output (a citation/reference match) — not via
an additional LLM classifier call, which would itself be a redundant inference cost.

### 5.17 Model-specific context constraints

The Compiler asks the Model Router what the target model's effective window and
cache-block granularity are, and packs accordingly. Model choice and context size are
coupled (see Phase 10.7 fix).

### 5.18 What NOT to include — explicit exclusion rule

An item is excluded when: it fails the tier-1 test and the budget is already met by
higher tiers; it's stale beyond `freshness_requirement`; it's a duplicate; it's below
the relevance threshold for *this* declared intent; or it belongs to a scope the
current Agent isn't granted. Exclusion is always logged, never silent.

### Cost-optimization principle carried through

None of the above means "always pick the smallest context." A Context Budget too
tight for a genuinely hard task produces bad output, triggering retries or human
correction — strictly worse total cost than compiling sufficient context once. Token
efficiency and task success are optimized jointly.

## Phase 6 — MCP / API / Plugin Strategy

Decision framework for any new integration, in order: (1) own the implementation? →
internal function. (2) clean third-party API, no MCP server worth trusting? → direct
API client. (3) well-maintained MCP server exists and hand-rolling costs more than the
token overhead? → MCP-backed Tool binding, loaded lazily. (4) no programmatic access
at all? → browser automation (Class 4 governance always). (5) time-based trigger? →
scheduled job (creates a Task Instance/Goal directly, not a Tool). (6) external push?
→ webhook receiver in the API layer (same). (7) queues/brokers: not introduced —
webhooks/scheduled jobs write directly to Postgres; the Workflow Interpreter picks
them up on its normal cycle.

### Trust levels

Every Tool binding (MCP especially) carries a trust level, an explicit Policy input
alongside permission and risk:

| Trust level | Examples | Policy effect |
|---|---|---|
| First-party | Code you wrote, direct clients you control | Normal policy tier |
| Verified third-party | Widely-audited MCP server/API | Normal tier; output still treated as untrusted data (5.15) |
| Unverified third-party | Unaudited community MCP server | Elevated (Class 4) tier; `REQUIRE_APPROVAL` on first use per capability; never eligible for autonomous EXECUTE-class permissions until explicitly upgraded |

Trust level is a property of the **binding**, not the Capability.

## Phase 7 — Memory Architecture

Four durable scopes (not five — Working memory is **Run State**, part of the Run
entity itself, not a memory scope):

| Scope | What it holds | Storage | Promotion rule |
|---|---|---|---|
| Task | Curated facts/outcomes about a specific Task Instance's history | Postgres, keyed to `task_instance_id` | **Deliberate write**, not automatic — Task History (every Run's outcome via Events) is not the same as Task Memory |
| Agent | Patterns/lessons across many Task Instances for one Agent Definition | Postgres, keyed to `agent_definition_id` + category tag | Deliberate write; subject to historical-usefulness decay |
| Project | Facts scoped to one initiative | Postgres, keyed to `project_id` | Deliberate write, usually human-authored/approved |
| Organizational | Cross-project standing facts/policy | Postgres, unscoped/global | Deliberate write, **strongly restricted** — default policy `REQUIRE_APPROVAL` |

### Explicitly not memory

Raw Event history (a complete separate audit trail; memory is a curated derivation of
it, never a proxy for "query all events"). Artifacts (full outputs live in the
Artifact system, referenced from memory, never duplicated). General long-term
knowledge (deliberately out of scope for V1 — no dedicated knowledge-base subsystem
until a concrete gap appears).

### Authority, confidence, provenance, supersession

Every durable Memory Item carries: `source` (originating Invocation/Run or "human"),
`confidence`, `authority` (`human_authored` / `human_approved` / `agent_inferred`),
and a `provenance` trail (referenced artifact/event IDs backing the claim). A new item
may declare `supersedes_id`. Conflicting items are never silently overwritten —
resolution order: **authority first, confidence second, recency only as final
tiebreaker.** An unresolved contradiction (equal authority/confidence, conflicting
content) is flagged for human review, not auto-resolved.

### Memory writes are governed capabilities

Writing to Task/Agent/Project memory requires a Capability Grant + Policy check like
any other action. Organizational writes are the most restricted (default
`REQUIRE_APPROVAL`).

### Why no vector store for memory (reaffirming Phase 4)

Memory volume per scope stays small even at meaningful usage, and items carry
structural tags making relevance filtering a plain SQL query. Embedding-based recall
is deferred until structural+lexical filtering demonstrably fails.

## Phase 8 — Events + Observability

Central claim: **UI, cost accounting, XP, audit, analytics, debugging, and agent
performance are all projections over one event model — none is a separate source of
truth.**

### 8.1 Canonical event envelope

```
event_id, event_type, occurred_at, sequence_no (monotonic, per run_id),
causation_id, correlation { goal_id, workflow_run_id, task_instance_id, run_id,
invocation_id }, actor (agent_definition_id@version | "human:<id>" | "system"),
payload (typed JSON per event_type),
cost { tokens_in, tokens_out, cache_hit, cost_amount, model_id }  (where applicable)
```

`occurred_at` is for display only; `sequence_no` is authoritative for ordering.
Mirrors OpenTelemetry GenAI semantic-convention shape without requiring that
infrastructure.

### 8.2 Event taxonomy (categories)

Lifecycle (`goal_created`, `workflow_run_started/completed/failed`,
`task_instance_created/transitioned/skipped/completed/failed`,
`run_started/completed/failed`); Invocation (`invocation_started/completed/failed`,
`tool_called`, `tool_result_received`); Artifact (`artifact_created/updated/
referenced`); Memory (`memory_written`, `memory_superseded`,
`memory_contradiction_flagged`); Governance (`capability_granted`,
`policy_evaluated`, `approval_required/granted/rejected`, `budget_denied`,
`budget_consumed`); Operational (`agent_paused/resumed`).

> **Implementation note (2026-09-14): what is emitted.** Every status change below is
> recorded in the same transaction as the write it describes (`src/events/lifecycle.ts`).
>
> **Lifecycle:**
> - `goal_created`
> - `workflow_run_started/completed/failed`
> - `task_instance_created/transitioned/completed/failed`
> - `run_started/completed/failed`, plus `run_halted` for an emergency stop
>
> A Run's terminal event is exactly one of `run_completed`, `run_failed` or
> `run_halted`.
>
> **Invocation:** `invocation_started/completed/failed`.
>
> **Artifact:** `artifact_created`.
>
> **Governance and accounting:**
> - `approval_required/granted/rejected/expired`
> - `capability_grant_revoked`
> - `execution_stop_engaged/lifted`
> - `budget_consumed`, one per reconciled reservation. Its `basis` is `reported` or
>   `estimate`, so each counter's `consumed_amount` equals the sum of its events.
>
> **Observational:** `provider_quota_observed`.
>
> **Correlation.** `emitEvent` completes correlation from `runId`: a null task
> instance, workflow run or goal id is filled from the Run's own rows. Lifecycle
> events about a step share that Run's sequence.
>
> **Not yet emitted:**
> - `tool_called`, `tool_result_received` (covered by the invocation events)
> - `artifact_updated/referenced`
> - the Memory events
> - `capability_granted`, `policy_evaluated`, `budget_denied`
> - `agent_paused/resumed`

### 8.3 Projections — the general pattern

**Synchronous** (same transaction as the event write): Task Instance/Run/Workflow Run
status, budget-consumed counters, `awaiting_approval` derivation — must never lag.
**Asynchronous** (background loop reading new events via `sequence_no` watermarks,
still just Postgres, no broker): XP totals, cost rollups, agent performance
aggregates, analytics — kept async so the hot execution path never blocks on rollups.

### 8.4 Tracing/debugging

A "trace" is a query: all events where `run_id = X`, ordered by `sequence_no`, joined
with each Invocation's context-lineage stamp. No separate tracing system.

### 8.5 Cost accounting

Synchronous projection: `budget_consumed` events roll up at
Run/Task-Instance/Agent-Definition/Goal/day granularity, updated atomically.

### 8.6 XP / gamification

Asynchronous projection, a pure function over event patterns (e.g.
`task_instance_completed` with quality signal above threshold → +N XP). Agents never
grant themselves XP — it only exists as a read-side aggregate. Stored in
`agent_xp_projection` (named as a projection, not a "ledger," since it is not a
transactional source of truth).

### 8.7 Audit trail

The raw Event table itself, immutable — no separate audit log.

### 8.8 Agent performance

Async projection, aggregated per **Agent Definition version** (not just per Agent):
success rate, average cost, average retries, average duration, approval-rejection
rate — per (task type, model tier) for routing purposes (Phase 10.5).

### 8.9 Evaluation (future, not built now)

Same pattern deferred: an evaluation run compares an outcome against a success
criterion and writes `evaluation_completed` — consumes/extends the same event model,
not a parallel system.

### 8.10 Infra

Postgres plus an in-process background loop for async projections (the same worker
process already justified for long-running Executors) — no new service. Diagnostic
logs remain separate local files, never queried.

## Phase 9 — Security / Permissions

### 9.1 Permission types

READ, WRITE, CREATE, PUBLISH, SPEND, TRADE, DELETE, EXECUTE, SEND — each with a
default risk tier (Low through Highest) — the vocabulary a Capability Grant is
expressed in.

### 9.2 Capability Grant structure

```
CapabilityGrant {
  agent_definition_id, agent_definition_version
  capability_id
  permissions: [READ, WRITE, ...]           // plain enum array, no inline scope encoding
  scope: { project_id?, resource_pattern? }  // applies uniformly to all permissions in this grant
  max_trust_level_required
  autonomy_state: ALWAYS_APPROVE | CONDITIONAL | AUTONOMOUS
}
```

If two permissions on the same Capability need different scopes, that's two separate
Grant rows, never mixed encoding in one field. A Grant is static, versioned alongside
its Agent Definition — changing authorization is a new Agent Definition version, never
a silent runtime mutation.

### 9.3 Policy engine

Inputs: Capability Grant, trust level of the specific Tool binding, **risk tier**
(computed deterministically — see below), Budget Governor's current authorization,
Agent performance projection (advisory only — see 9.4), rate/time constraints.
Output: `ALLOW | DENY | REQUIRE_APPROVAL`. `DENY` fires when the Grant doesn't cover
the action at all (a configuration fact, not a judgment call).

**Risk tier is a deterministic, structured computation**:
`risk_tier = f(capability.static_risk_tag, action.amount_or_scope, action.novelty,
binding.trust_level)` — same inputs always produce the same tier, logged with the
Approval/Policy-evaluation event for auditability. Risk establishes a **model-quality
floor** (route to a stronger model for better judgment), never a substitute for
Policy/Approval gating — a strong model's high-risk output still goes through the
same Policy/Approval path as a cheap model's would.

### 9.4 Progressive autonomy

New Capability Grant defaults to `ALWAYS_APPROVE`. `CONDITIONAL` consults the
performance projection to lean toward auto-`ALLOW` for below-threshold instances,
while anything above threshold still escalates. `AUTONOMOUS` is reached only by an
explicit, logged human edit to the Grant — **the system never self-promotes
autonomy_state; the performance projection is advisory only and can never itself
authorize anything.** SPEND/TRADE/PUBLISH/DELETE default to a policy-enforced ceiling
of `CONDITIONAL` at most; reaching `AUTONOMOUS` for these always requires an explicit
human policy change, never earned automatically.

### 9.5 Approval workflow

```
Invocation proposed -> Policy = REQUIRE_APPROVAL
  -> Approval created, referencing the EXACT proposed action (parameters snapshotted
     at creation — amount, recipient, content, target; a category is not sufficient)
  -> status: pending
  -> surfaced in UI (a projection over Approval + Event data)
  -> human: approve | reject
  -> resolution event recorded
  -> Invocation proceeds (approve) or fails/cancels (reject)
```

> **Implementation note (2026-09-14): TTL expiry.** Three places enforce it:
> - **Resolution.** `resolveApproval`'s conditional UPDATE refuses any Approval past
>   its TTL, and reports it as `expired` (409). A human decision therefore never
>   lands on an expired Approval.
> - **Listing.** `GET /approvals` hides past-TTL Approvals.
> - **Sweep.** `expireStaleApprovals` runs at startup and then every minute. It
>   records `approval_expired` (actor `system:approval_ttl`) and re-drives the
>   Workflow Run. The expired Approval is then handled like a rejection: the budget
>   hold is released, and the Invocation, Run and Workflow Run fail with their
>   events.
>
> The TTL is the documented MVP default, one hour (`APPROVAL_TTL_SECONDS`).
>
> **Tool binding re-check on resume.** On resume, Policy is re-evaluated against the
> Tool Binding persisted with the Invocation. A binding whose trust has fallen
> below the Grant's bar is denied before execution.

Any parameter change after Approval creation invalidates it; execution must match the
snapshot exactly. Unresolved Approvals past a TTL auto-resolve to reject
(`expired`). **Immediately before execution of a high-risk side effect, Grant
validity, budget state, and revocation status are re-checked** — closing the gap
between "Approval granted" and "action actually runs" (a budget spent by a concurrent
Run, or a Grant revoked in the interim, blocks execution even post-approval). Batch
approval and modify-in-place are deferred past MVP (a modified action is a new
proposed Invocation, not an edit to the old one).

### 9.6 Credentials and secrets

Not part of the domain model. API keys/credentials live in local secrets
storage, referenced only by Tool Adapter and Model Router configuration. **Models
never hold credentials, full stop** — an LLM Invocation's compiled context never
contains a credential in any field; the model's only output is a logical call ("use
Tool X with these arguments"); credentials are resolved and applied exclusively
inside the Tool Adapter, in plain code, after Policy clears the call.

### 9.7 Emergency pause / revocation

An immediate, synchronous state flip (a Postgres row update, not a queued event).
The Executor checks pause/revocation state before *every* Invocation, including
free/deterministic ones — taking effect at the next Invocation boundary regardless of
what Run is mid-flight. Scopes: global, per-Agent-Definition, per-Capability-Grant,
per-Goal/Workflow-Run. Revoking a Grant auto-cancels its still-pending Approvals.

> **Implementation note (Phase 8, 2026-09-13) — clarifies, does not weaken.**
> "per-Goal/Workflow-Run" is implemented as **two** scopes, `goal` and
> `workflow_run`, because one Goal may own several Workflow Runs and an operator
> may need to halt either one run or all of a Goal's work. A sixth, finer scope,
> `run`, is **additive**: it halts a single Run and narrows nothing above it.
> Every scope listed above is present and enforced; none was dropped. Stops
> apply to Tool, LLM, Retrieval and Deterministic Invocations alike. A stopped
> Run is terminal: lifting a stop is forward-only and never resumes or
> retroactively authorizes refused work. "Auto-cancels" is recorded as approval
> status `expired` (the `approval_status` enum has no `cancelled` member), with
> `resolved_by` naming the cause. Implemented in
> `src/governance/executionStop.ts` and `src/governance/approvals.ts`.

### 9.8 Scope note for solo/V1

No user-to-user permission complexity; permissions apply agent-to-action. The model
generalizes to multi-user later without rework.

> **Implementation note (2026-09-14): "no user auth" does not mean "no request
> guards".**
>
> **The threat.** The unauthenticated API binds loopback, but the operator's own
> browser is on loopback too. Any page the operator visits can therefore send
> requests to it, and CORS only governs whether that page may *read* the response.
> Two attacks follow:
> - **DNS rebinding** can read approval ids and then approve, lift a global stop,
>   or start goals.
> - **Cross-site POSTs** can fire the no-body approve/reject routes.
>
> **The guards** (`src/api/requestGuards.ts`), which run before every route:
> - **Host.** A request whose `Host` is not a loopback name, or an
>   operator-configured `API_ALLOWED_HOSTS` entry, is refused.
> - **Origin.** A state-changing request whose `Origin` is present and is not the
>   UI's origin is refused.
>
> **Error responses.**
> - Malformed route ids are 400s.
> - Wrong-state Workflow Run operations are 409s.
> - 5xx bodies are generic. Database errors embed SQL text, so their details go to
>   the server log only.
>
> **Failure text in events.** Failure text in immutable events is redacted at its
> single write point, `failInvocation` (`src/execution/failureReason.ts`):
> - **Removed:** SQL text, absolute host paths and key-shaped strings, which are
>   also length-capped. Once an event is written it cannot be cleaned.
> - **Kept:** reasons stay human-readable, and a stable `errorCode` is added when
>   the error carries one.
>
> **Event stream bounds** (`src/api/routes/events.ts`):
> - Replay is paged and respects socket backpressure.
> - The per-connection de-dup set is bounded.
> - Open streams are capped (503 past the cap), and the UI reconnects with
>   exponential backoff.

## Phase 10 — Model Routing

### 10.1 Provider abstraction

One internal interface: `{model_tier_or_id, compiled_context, expected_output_shape}
-> {result, usage}`, implemented via a self-hosted LiteLLM-style proxy/library
(verified: ~2ms overhead, no per-request markup, genuinely provider-agnostic). The
interface is the architectural commitment, not the specific library.

### 10.2 Routing inputs

```
route(task_difficulty, required_capabilities, risk_tier, budget_authorization,
      context_budget, historical_tier_performance) -> model_id, tier
```

Risk tier can force a floor (route to `STRONG` regardless of cost) independent of
budget. Budget authorization can force a ceiling. Historical tier performance
adapts tier *preference* automatically — safe to self-tune since it's an efficiency
choice among models the risk tier already permits, never an authorization change
(unlike Grant autonomy, which requires a human).

### 10.3 Abstract tiers

`CHEAP / STANDARD / STRONG` (plus optional `LOCAL`) are the only concepts domain logic
knows; which model/provider backs each tier is a config table
(`tier -> {provider, model_id, accounting}`), editable without touching routing logic.

**Amended 2026-09-13:** the config entry's third field was `price` (a single blended
per-token number). It is now an `accounting` descriptor carrying the tier's
**resource unit** and the rate(s) that unit requires — `usd` with separate
input/output per-token rates for metered providers, `subscription_tokens` with no
monetary rate at all, `local_tokens` likewise. Two reasons: real provider pricing is
asymmetric (output costs ~5x input, so one blended rate structurally under-prices
output-heavy work), and non-monetary providers have no honest dollar rate to put
here. A provider whose unit is not `usd` must not be given a fabricated `price: 0` —
that would silently convert the Budget Governor into a no-op for that tier while it
continued emitting events asserting enforcement.

### 10.4 Escalation pattern

```
attempt at selected tier
  -> confidence/validation check:
       - model self-reported confidence is ADVISORY ONLY — never bypasses a
         deterministic validator or a required Approval
       - deterministic validator checks output against Task's expected shape/success
         criteria
  -> sufficient? done. insufficient? escalate one tier, bounded retry count
  -> exhausted at STRONG? surface as task failure or REQUIRE_APPROVAL, never silent
     infinite escalation
```

Each escalation step is its own LLM Invocation with a fresh Context Compilation.

### 10.5 "Useful work per token/dollar," measured not asserted

Phase 8.8's projection is per (task type, model tier): success rate, retry rate, and
*total* cost including retries — the concrete mechanism for discovering when a
cheaper tier's retry rate makes its total cost per successful outcome higher than a
stronger tier's.

### 10.6 Development-time vs. runtime (AMENDED 2026-09-13)

> **Amendment notice.** This section previously read, in full: *"Claude Code and
> Codex are development tools for building/maintaining the system — never wired in
> as runtime Model Router providers. The Router only calls providers explicitly
> configured in the tier-mapping table."* That absolute prohibition is **replaced**
> by the rule below, which permits a subscription-backed Claude provider **only** as
> an explicitly governed provider adapter. The prohibition is not silently weakened:
> the development-time/runtime separation it existed to protect is restated as
> 10.6.1 and strengthened with seven additional constraints. Superseded by decision
> of the architect, recorded here rather than by deletion. See also the amended
> 13.4 and the Phase 5.0 "Money/quota" accounting basis this depends on.

**The distinction being preserved:** we are *not* saying "Claude Code is now the
runtime." We are saying the runtime may have a purpose-built, subscription-backed
Claude **provider adapter** whose *implementation* happens to use the supported
headless Claude mechanism. The adapter is a runtime component with its own
authentication, isolation, accounting and lifecycle — not a developer's session.

**10.6.1 — Development-time Claude Code remains separate from runtime execution.**
The interactive Claude Code/Codex session a human uses to build and maintain this
system is never itself a runtime component. The runtime must remain fully operable
with no interactive development session running, logged in, or installed in the
developer's configuration.

**10.6.2 — Subscription-backed Claude may only be invoked through an explicit
provider adapter.** No module outside `src/router/providers/` may spawn the `claude`
binary, link the Agent SDK, or otherwise reach subscription-backed inference. This
is the Phase 4 single-chokepoint rule applied unchanged; the chokepoint is about
*provider access*, not about which company hosts the weights or which credential
pays for it.

**10.6.3 — The Model Router selects it only when explicitly configured.** The
provider is reachable solely via the tier-mapping table (10.3). There is no implicit,
ambient, or default-on subscription path, and no environment variable that silently
enables one.

**10.6.4 — The provider owns its own authentication, isolation, resource accounting
and lifecycle boundary.** Subscription OAuth, subprocess lifecycle, environment
sanitization, and token-denominated accounting live inside the adapter and are
invisible to every caller. `callModel`'s contract is unchanged.

**10.6.5 — The runtime never inherits the developer's Claude Code session, tools,
settings, or MCP configuration.** Settings sources, MCP servers, CLAUDE.md
discovery, and the built-in tool set are all explicitly disabled per invocation. A
subscription credential is precisely what pulls claude.ai MCP connectors into scope,
so suppressing them is mandatory, not best-effort.

**10.6.6 — The provider must not expose credentials to the model.** No credential
enters a compiled context, prompt, tool result, Event payload, or error message.

**10.6.7 — The provider must not silently fall back from subscription usage to
billable API usage.** A quota failure surfaces as an Invocation failure. Converting
it into a billed API call requires a fresh, explicit Policy and Budget decision —
never an automatic retry inside the adapter or the Router.

**10.6.8 — Every invocation remains represented by the existing Invocation/Event
architecture.** Same `invocation_started`/`invocation_completed`/`invocation_failed`
events, same correlation, same Run/Invocation lifecycle, same immutability.

**10.6.9 — Subscription usage must never be represented as USD 0.** It consumes a
real, finite entitlement. It is accounted in its own resource unit (Phase 5.0's
"quota" half), never as a zero-dollar monetary amount, and never from Anthropic's
client-side `total_cost_usd` estimate. See 12.x resource-unit accounting.

**10.6.10 — Runtime authorization is unchanged.** Capability → Grant → Binding →
Policy → Budget → Approval → Invocation governs subscription-backed invocations
exactly as it governs every other kind. Being cheap, free, or quota-backed grants no
capability and bypasses no gate.

**Codex** remains development-only and is **not** amended by this section: no
Codex-backed runtime provider is contemplated or permitted.

### 10.7 Ordering (corrected — two-pass, reserve-then-reconcile)

The naive ordering (Governor estimates cost → needs token count → Compiler must have
already compiled → Compiler needs the chosen model → Router needs the Governor's tier
cap) is circular. Resolved as:

- **Pass 1**: Governor estimates cost against the Context Budget's `max_input_tokens`
  *ceiling* (a worst-case bound known without compiling) plus `expected_output_tokens`,
  authorizes a tier, and **reserves** budget at that pessimistic estimate (atomic
  reservation, Phase 12 budget model).
- **Pass 2**: Model Router picks the specific model within the authorized tier;
  Context Compiler compiles to fit that model's actual window/cache constraints.
- **Pass 3**: actual usage **reconciles** the reservation in the same transaction as
  the completion Event.

This makes `max_input_tokens` load-bearing (used for pre-authorization), not just
advisory.

### Full recorded routing decision

Every routing decision's complete input set (`task_difficulty`, `risk_tier`,
`budget_authorization`, `context_budget`, the historical-performance snapshot
consulted) and resulting `{tier, model_id}` is captured as structured payload on the
Invocation's event — reproducible and auditable, not a separate table.

## Phase 11 — Workflow Engine

The **Workflow Interpreter** (Phase 4) is plain deterministic code reading a Workflow
Definition's graph and Task Instance projections — no separate engine, no Temporal.

- **Structured Workflow**: use when the sequence of task types is known ahead of
  time; the Interpreter decides what runs next.
- **Agentic loop**: use when the number/shape of steps within one bounded Task can't
  be known ahead of time; an LLM Invocation's output can determine the next
  Invocation, but only within the Run's fixed Task/budget/Agent scope — never
  spawning new Task Instances or altering Workflow topology.
- Both compose: a Workflow node's Task Instance may internally run an agentic loop.

### Reusable primitives

A small library of **Task Definition kinds** (research, retrieval, extraction,
classification, planning, analysis, writing, coding, validation, simulation,
approval, execution, monitoring) that any Workflow Definition composes from —
different Workflows reuse the same kinds with different parameters, rather than each
reinventing its steps.

## Phase 12 — Data Model

Grouped by role.

### Definitions (versioned; human/config-authored; rarely change at runtime)

- `projects(id, name, description, created_at)`
- `capabilities(id, name, description, static_risk_tag, cost_profile)`
- `tool_bindings(id, capability_id, kind[internal|direct_api|mcp|browser|process|
  webhook], config, trust_level, version)` — `capability_id` is the **sole**
  authoritative FK; no duplicate array on `capabilities`.
- `agent_definitions(id, name, version, role, objective, instructions, memory_policy,
  escalation_policy, created_at)`
- `capability_grants(id, agent_definition_id, agent_definition_version, capability_id,
  permissions[], scope, max_trust_level_required, autonomy_state, created_at)`
- `task_definitions(id, name, kind, input_schema, output_schema,
  default_context_budget, version)`
- `workflow_definitions(id, name, version, graph_definition, created_at)` — graph
  references Task Definitions by `(id, version)` pairs.
- `policies(id, scope[global|capability|agent], rule_definition, version)`

### Runtime instances

- `goals(id, project_id, title, description, status, created_at)`
- `workflow_runs(id, workflow_definition_id, workflow_definition_version, goal_id,
  status, variables, created_at, completed_at)`
- `task_instances(id, task_definition_id, task_definition_version, workflow_run_id
  NULL, project_id, status, input, created_at, updated_at)`
- `runs(id, task_instance_id, agent_definition_id NULL, agent_definition_version
  NULL, status, budget_envelope, outcome, started_at, completed_at)`
- `invocations(id, run_id, seq_no, kind[llm|tool|retrieval|deterministic|browser],
  cost_class, status, idempotency_key, started_at, completed_at)`

### Execution ledger

- `events(id, event_type, occurred_at, sequence_no, causation_id, goal_id,
  workflow_run_id, task_instance_id, run_id, invocation_id, actor, payload,
  tokens_in, tokens_out, cache_hit, cost_amount, cost_unit, model_id)` — append-only,
  authoritative; diagnostic logs never live here.
  **`cost_unit` added 2026-09-13** (amended 10.6): `cost_amount` is meaningless
  without it once more than one resource unit exists. Every usage-bearing event
  states the unit its `cost_amount` is denominated in, so no reader can mistake
  subscription tokens for dollars. Additive and non-breaking: existing rows are
  `usd` by backfill, and no existing field changes meaning.
- `budget_counters(scope[run|task_instance|agent_definition|goal|day], scope_ref_id,
  resource_unit, limit_amount, reserved_amount, consumed_amount, updated_at)` —
  synchronous projection; reservation is atomic (checked against
  `limit_amount - reserved_amount - consumed_amount` in one transaction) at
  authorization time, reconciled (reservation released, actual consumption added) in
  the same transaction as the completion event.
  **`resource_unit` added 2026-09-13** (amended 10.6): the uniqueness key becomes
  `(scope, scope_ref_id, resource_unit)`, so one scope holds one counter **per unit**
  — `usd`, `subscription_tokens`, `local_tokens`. Incommensurable quantities are
  never summed into one `consumed_amount`. Atomicity is unchanged: `SELECT … FOR
  UPDATE` still locks exactly one row, now on a three-column key. This is the
  concrete implementation of Phase 5.0's "Money/**quota**" — quota was always in
  scope; it simply had no representation until now.

### Governance

- `approvals(id, invocation_id, proposed_action_snapshot, risk_tier,
  status[pending|approved|rejected|expired], created_at, resolved_at, resolved_by,
  ttl)`

### Knowledge

- `artifacts(id, type, version, producing_invocation_id, hash, size,
  storage_reference NULL, inline_content NULL, summary, created_at)` — Postgres holds
  metadata/version/hash/storage_reference; the filesystem holds actual bytes for
  anything above a small inline-content threshold or inherently binary. Postgres is
  never the storage location for every artifact regardless of size.
- `memory_items(id, scope[task|agent|project|organizational], scope_ref_id, content,
  source_invocation_id, provenance, confidence, authority, supersedes_id NULL,
  created_at)`

### Observability projections (async)

- `agent_performance(agent_definition_id, agent_definition_version, task_definition_id,
  model_tier, success_rate, avg_cost, avg_retries, sample_count, updated_at)`
- `agent_xp_projection(agent_definition_id, xp_total, updated_at)` — a pure derived
  aggregate; no Invocation writes to it directly.

### Idempotency, including external side effects

Internal dedup via `event_id`/`sequence_no` (Phase 3e). For external side effects
(SEND/PUBLISH/SPEND-class Tool Invocations), `invocations.idempotency_key`
(deterministic, derived from `run_id + seq_no` or explicit) is passed through to
external APIs supporting idempotency keys; for ones that don't, the Tool Adapter
checks "has an Invocation with this key already succeeded" before re-attempting —
making crash-and-resume safe for real-world effects, not just internal state.

### Deliberately absent

Separate event store, vector table (pgvector column added only if justified later),
message-broker-backed queue table, user/auth tables (solo, single-user V1), separate
"routing decisions" table (captured in `events.payload` instead).

## Phase 13 — Infrastructure

### 13.1 PostgreSQL on Windows — native EDB installer

**Decision**: install PostgreSQL natively via the EDB (EnterpriseDB) installer — the
officially recommended Windows installer, linked directly from postgresql.org's own
downloads page. **Verified** (postgresql.org/download/windows, EDB docs, Sept 2026):
free for this use case, current stable is the PostgreSQL 18.x line, bundles the
server + pgAdmin + StackBuilder, and registers as a Windows Service with standard
auto-start behavior out of the box. No Windows Home-specific restriction was found
(Windows Home supports standard Windows Services generally) — worth a one-time manual
check of the service's recovery-action settings after install, but not a blocker.

Rejected: **Docker Desktop** (runs Postgres inside a WSL2-backed VM anyway — strictly
more moving parts and idle overhead for zero benefit at solo scale). **WSL2 directly**
(introduces a real filesystem boundary between wherever the backend process runs and
wherever artifact bytes are read/written — native Windows Postgres avoids this
entirely).

**pgvector** stays off by default (Phase 2/4). **Verified**: pgvector's own README
provides no official precompiled Windows binary — enabling it later requires
compiling from source via NMAKE + Visual Studio C++ Build Tools, or an unofficial
community-compiled binary. A real build step to do *when* pgvector is actually
needed, not a blocker on today's install choice.

### 13.2 Background process supervision — manual for V1, NSSM for V1.1

No systemd on Windows, so this gets a stated answer:
- **V1**: the backend (API + Workflow Interpreter + Executor + async projection loop)
  runs as a manually started foreground process — appropriate for an actively
  developed, actively watched solo MVP.
- **V1.1** (once the platform is stable enough to want unattended operation): wrap the
  backend as a Windows Service via **NSSM** (free, lightweight, auto-start-on-boot,
  auto-restart-on-crash) — a deliberate, cheap deferral, not a gap.

> **Implementation note (Phase 9, 2026-09-14).** "One backend process" is now a
> load-bearing invariant, and startup enforces it. The process takes a session
> advisory lock and refuses to start if another process holds it. It then settles any
> Invocation a previous process left `executing` before it accepts requests. So an
> NSSM auto-restart after a crash recovers interrupted work rather than stranding it.
> See `docs/architecture/DURABLE_EXECUTION.md` §4–5.

### 13.3 Artifact storage paths — relative, POSIX-style, root-configured

`artifacts.storage_reference` stores a forward-slash **relative** path, resolved
against a configured `ARTIFACT_ROOT` environment variable (a local folder kept outside
the git repo). Never an absolute Windows path — keeps the reference portable across
machines or into WSL2/Docker later without a migration.

### 13.4 Language/stack — TypeScript end-to-end, not Python/FastAPI + Next.js

The original brief's Python/FastAPI backend + Next.js frontend is a genuine
two-runtime split: two package managers, two type systems, a hand-maintained contract
at the API boundary, and — concretely — Claude Code/Codex switching mental models
between languages every session. Nothing in the core platform (Workflow Interpreter,
Executor, Context Compiler, Policy Engine, Capability Registry) needs Python
specifically; these are plain application logic.

**Decision: TypeScript end-to-end.** Node.js backend (Fastify or similar) hosting the
API/Application layer and everything beneath it; Next.js/React/TypeScript/
Tailwind/shadcn frontend (unchanged from the original brief, since it was never
contested). Postgres access via **Drizzle ORM** — types generated directly from the
schema, achieving single-source-of-truth types by having only one language, not by
codegen across a language boundary.

Python remains available **only** as an isolated **local process Tool Adapter** for a
specific capability that genuinely benefits from its ecosystem (e.g. a future
financial-backtesting capability shelling out to a Python script) — never as a second
application runtime.

**Correction to Phase 10.1**: a self-hosted LiteLLM proxy, reasonable under a Python
backend, would mean supervising a second long-running process under a TypeScript
backend — another Windows-service problem and a violation of Phase 4's own "no extra
service" principle. **Revised**: the Model Router module calls the official Anthropic
and OpenAI TypeScript SDKs (or the Vercel AI SDK's unified interface) directly,
in-process. The Phase 10.1 interface
(`{model_tier_or_id, compiled_context, expected_output_shape} -> {result, usage}`) is
unchanged; only the implementation detail changes, toward less infrastructure.

**Narrow amendment (2026-09-13) — short-lived provider subprocesses are permitted.**
The rule above rejects supervising **a second long-running service**, and that
rejection stands: no proxy daemon, no persistent gateway, nothing requiring its own
Windows-service registration, health-checking, or restart policy. It does **not**
prohibit a provider adapter spawning a **short-lived, per-invocation child process**
that the adapter itself starts, bounds by timeout, and reaps within the lifetime of a
single Invocation. That is the same process model Phase 13.3 already sanctions for a
Python local-process Tool Adapter, applied to a provider instead of a tool.

Concretely, this permits the amended 10.6's subscription-backed adapter (one
`claude -p` child per Invocation) while continuing to forbid a resident model-gateway
service. The distinction is **lifetime and supervision**, not process count: a child
that cannot outlive its Invocation needs no supervisor, so the "no extra service"
principle is untouched. Operational consequences the adapter must own — timeout,
termination, orphan prevention — are specified in its own design document, not here.

### 13.5 Final V1 infrastructure list

| Component | Choice | Cost |
|---|---|---|
| Backend runtime | Node.js + TypeScript (Fastify) | $0 |
| Frontend | Next.js + React + TypeScript + Tailwind + shadcn/ui | $0 |
| Database | PostgreSQL, native Windows install (EDB), Windows Service | $0 |
| ORM | Drizzle | $0 |
| Model access | Anthropic + OpenAI TS SDKs, in-process; plus (amended 2026-09-13) a subscription-backed Claude adapter spawning one short-lived `claude -p` child per Invocation | API: $0 fixed, pay-as-you-go per call. Subscription: no per-call dollar cost; consumes a flat entitlement, accounted in its own resource unit (never USD 0). Both governed by Phase 4/9 budgets |
| Artifact bytes | Local filesystem under `ARTIFACT_ROOT`, relative paths | $0 |
| Process supervision | Manual (V1) -> NSSM (V1.1) | $0 |
| Version control | GitHub | $0 |

No Docker, no Redis, no Temporal, no Langfuse, no separate Model Router service, no
second language runtime.

## Phase 14 — Extension Strategy

### 14.1 Purpose

Every candidate integration has to earn its place through explicit scoring — never
because it's popular, novel, or "obviously useful." This phase is the evaluation
framework; Phase 6 already covers *how* a chosen integration gets implemented
(internal/direct API/MCP/browser/scheduled/webhook).

### 14.2 Scoring rubric

Score each candidate on: **usefulness** (does it unlock or meaningfully improve a
capability actually needed by an **existing, approved, and near-term** Task
Definition — not a speculative future one), **frequency** (how often real tasks would
invoke it), **token overhead** (schema cost per Phase 5.7), **latency**,
**reliability** (uptime/quality of the API or MCP server), **maintenance burden**
(who keeps it working as the third party changes their API), **cost** (metered fees),
**rate limits**, **trust level implications** (Phase 6 — does it start at
`unverified_third_party`, forcing elevated governance), **strategic importance**
(does it unlock a whole category of future capability, e.g. browser automation
unlocks many things at once, vs. a narrow single-purpose API).

### 14.3 Decision rule

An integration is built only when **(a)** an existing, approved, and near-term Task
Definition/Capability needs it — never a merely "imminent" or speculative one, a
looser word that could otherwise excuse building ahead of real demand — **and (b)**
it clears a minimum bar on usefulness + reliability + trust even if convenience alone
is high. Convenience without a concrete consuming Task Definition is exactly the
"collection of disconnected chatbots" anti-pattern from Phase 1 — this rule is what
prevents it.

### 14.4 Worked example

Early e-commerce capability needing product/listing data: **Shopify's direct API**
scores high (well-documented, low token overhead as a hand-written schema, first-party
trust level, predictable rate limits) vs. **generic browser automation against
arbitrary e-commerce sites** scores low (fragile, high latency, `unverified` trust
by default, Class 4 governance) for the same underlying need. Decision: direct API
when a clean one exists (per the Phase 6 decision framework); browser automation only
as the fallback when no API exists at all.

### 14.5 Category checklist (deferred, not built)

The original brief's categories (research, productivity, commerce, finance,
development, creative, execution) remain a useful **lens**, not a build list — none
of them get an integration until a real, existing Task Definition in the MVP or its
approved near-term successor actually needs one and clears the 14.2 rubric.

## Phase 16 — Gamification

Already substantially settled: XP is a pure derived function over Events (Phase 2,
Phase 8.6), stored in `agent_xp_projection`, and agents never award themselves XP.
This phase finalizes the design.

### 16.1 XP rules (event pattern -> XP)

Examples matching the original brief's intent, all computed by the async XP
Projector (Phase 8.3) reading Events — never authored by an agent inline:
- `task_instance_completed` (successful) -> small XP.
- `artifact_created` later **referenced by other Task Instances' compiled context**
  (Phase 5.5/5.13 provenance) -> additional XP. **This is a weak structural
  usefulness signal only, not evidence of quality** — being referenced by another
  Task does not inherently mean the artifact was good, correct, or valuable; it only
  means it was consulted. Artifact reuse may contribute to XP as a weak structural
  usefulness signal, but XP rules must not be interpreted as quality or governance
  metrics.
- `approval_granted` on a proposed action that later shows a successful outcome ->
  larger XP.
- A human-graded high-value outcome (once Phase 8.9 evaluation exists) -> largest XP.

Levels are a simple threshold curve over cumulative XP (e.g. level = floor of a
monotonic function of `xp_total`) — no separate design needed beyond the projection
already storing `xp_total`.

### 16.2 Critical boundary: XP is not authorization evidence

`agent_xp_projection` (human-facing, motivational, dashboard-only) and
`agent_performance` (Phase 8.8, governance-facing — success rate, retry rate, cost —
used by Phase 9.4's `CONDITIONAL` autonomy logic and Phase 10.5's routing) are **both
derived from Events but must never be interchanged.** XP is for the Command Center
UI's leaderboard/agent-card display; **only `agent_performance` ever feeds a Policy
or Model Router decision.** This prevents a purely motivational display number from
ever becoming a de facto — and un-audited — authorization signal.

### 16.3 Idempotent projection

The XP Projector is **idempotent**: reprocessing or replaying Events (e.g. after a
crash-recovery replay of the async projection loop, per Phase 8.3) must never award
XP twice for the same Event. In practice this means the Projector's incremental
update is keyed by `event_id` (each Event contributes to `xp_total` at most once,
tracked the same way Invocation idempotency is tracked in Phase 12), not a simple
"add N and move on" that could double-count on replay.

### 16.4 UI surface

Agent cards show level + XP bar + recent XP-earning events, per the original brief's
mockup. Organizational-level metrics (leaderboards, aggregate XP) are additional
views over the same projection tables — no separate system.

---

## Phase 15 — Command Center UI

Governing constraint, restated from Phase 4: the UI is a *pure view* over
projections and the Event stream — every screen is a **query**, and every control is
a **command sent to the API layer**. No screen writes to Postgres directly, computes
cost/XP, or evaluates policy client-side.

### 15.1 Screens

**1. Overview (landing screen)** — top-level stat bar and Active Agents panel, built
entirely from projections. **Revenue is displayed only if a real project/outcome
projection actually exists for that Project/Goal** — it is not a universal core
metric and the UI must never invent or approximate a revenue figure itself; a Project
with no defined revenue-outcome projection simply omits that stat rather than showing
a fabricated or zero value. Active Agents panel: one card per Agent Definition
currently bound to a running Run — status, current Task Instance's mission, progress,
latest Invocation's activity, all read from `runs`/`task_instances`/latest `events`.
A Live Activity feed renders a tail of the Event stream via SSE (see 15.3), rendered
human-readably per `event_type`.

**2. Agent Detail** (click a card) — current Task Instance and *why* (its
Goal/Workflow Run lineage), current Invocation, capabilities in use (context lineage
per Phase 5.13), recent actions (event trace for its Runs, Phase 8.4), outputs
(linked Artifacts), performance (`agent_performance` projection), token usage/cost
(`budget_counters`), permissions (its Capability Grants, read-only display), and
controls: pause / resume / stop (see 15.2 on how these are modeled).

**3. Workflow/Task view** — a Workflow Run's graph (Task Instance nodes + status),
drillable into a Task Instance's Run(s) and each Run's Invocation sequence. A visual
graph library (e.g. React Flow) renders the Workflow Definition's `graph_definition`
with live status overlaid from `task_instances` — the library only renders; the
Workflow Interpreter (backend) is the only thing that ever decides the graph's actual
state.

**4. Approvals queue** — every `pending` Approval, showing the exact proposed action
snapshot (Phase 9.5), risk tier, and the Invocation/Run it gates. Approve/reject
buttons are API commands (15.2); the UI never resolves an Approval itself.

**5. Goals & Projects** — list of Goals, their Workflow Runs, grouped by Project.

**6. Registry (admin view)** — Agent Definitions, Capability Grants, Policies:
read/edit surface for *definitions*, versioned per Phase 3/12 — editing creates a new
Definition version, never mutates history. Where `autonomy_state` changes happen
(Phase 9.4's explicit-human-action requirement).

**7. Cost/Budget dashboard** — `budget_counters` by scope, and the (task type, model
tier) cost-vs-success comparison from Phase 10.5.

**8. Memory/Artifact browser** — Artifacts and Memory Items by scope, with
provenance chains visible (Phase 5.13/7).

### 15.2 UI commands vs. Invocations — not the same model

Every mutating UI action — start a Goal, pause/resume/stop, edit a Definition,
approve/reject — is an **API command**, not necessarily an LLM/Tool Invocation. Many
of these (edit a Definition, approve/reject, pause/resume) are deterministic
control-plane operations with no model or tool execution involved at all, and are
**not forced into the Invocation model** just for architectural uniformity. They
still go through the appropriate authorization/policy checks for their own kind of
action (e.g. editing a Capability Grant's `autonomy_state` is itself a governed,
logged change per Phase 9.4, and resolving an Approval follows the Phase 9.5
lifecycle exactly) — but that governance is modeled on its own terms, not shoehorned
into `invocations`/`runs` rows that represent agent execution.

### 15.3 SSE / Event stream — a delivery mechanism, not a second source of truth

The SSE feed used for live UI updates (Overview, Agent Detail, Activity feed) is
**purely a delivery mechanism for already-authoritative Events and projections** — it
is not a second event system and holds no state of its own. On reconnect (network
drop, tab refresh), the client resumes from a **known event/projection position**
(the last `sequence_no` it successfully rendered, or a fresh projection query) rather
than relying on browser-local state to have remained consistent — a dropped
connection can never cause the UI to silently diverge from Postgres, only to
momentarily lag behind it.

### 15.4 Visual direction, and the gamification/presentation boundary

The "sci-fi ops center" aesthetic (glowing status indicators, progress bars, agent
cards) — and any future stylized presentation layer built on top of it, such as a
pixel-art tileset/game-world view — is styling over the data sources above.
Consistent with Phase 16, that boundary is explicit: such a presentation layer **must
never read raw Events directly, make business decisions, award XP, or contain
runtime logic** of any kind. It consumes the same projections (including
`agent_xp_projection`) as every other screen, purely for rendering. Detailed visual
design is deferred to a dedicated pass once Phase 18's MVP is running against real
data, rather than designed against imagined data now.

---

## Phase 17 — Development Workflow

### 17.1 Roles in the loop

- **Architecture**: human + Claude Code, interactively, producing and refining this
  spec. Codex isn't well-suited here — it's an implementation/review agent, not a
  substitute for iterative architectural back-and-forth.
- **Implementation**: Claude Code, working from this spec plus a scoped
  implementation plan (via the `writing-plans` skill, invoked once a phase of the
  spec is frozen) — TDD by default (`test-driven-development` skill).
- **Review**: Codex, run **non-interactively** via `codex exec` (headless, CI-safe,
  streams progress, typed SDK available) against Claude Code's diffs, as a genuinely
  independent second opinion — cross-model review catches blind spots same-model
  self-review doesn't. Not a second implementer by default; a reviewer.
- **CI**: lightweight GitHub Actions (lint, typecheck, test on push) — free at this
  scale, catches breakage before it reaches you.

### 17.2 How context is shared without re-discovery

A root `CLAUDE.md` plus additive per-directory `CLAUDE.md` files, since Claude Code
auto-scans upward regardless of where work starts.

- **Root `CLAUDE.md`**: a short summary of the core abstractions (Phase 3) and
  governing principles (Phase 2), pointing to this spec as the source of truth for
  anything architecture-affecting — never duplicating its content.
- **Per-module `CLAUDE.md`** (one per major module directory — Workflow Interpreter,
  Executor, Context Compiler, Model Router, Capability Registry, Policy Engine, Tool
  Adapters, UI): describes just that module's contract (inputs/outputs/invariants).

### 17.3 Task scoping

Implementation units mirror the domain model itself: one Capability + its Tool
binding(s) + tests is a unit; one Task Definition kind + its default Context Budget
is a unit; one Workflow Definition composing existing Task Definitions is a unit.
This keeps each `writing-plans` cycle bounded and each PR reviewable by Codex in
isolation.

### 17.4 The loop, concretely

Human + Claude Code settle a spec section → `writing-plans` produces a scoped
implementation plan for one unit → Claude Code implements via TDD → `codex exec`
reviews the diff independently → CI runs → human merges. Repeats per unit.

## Phase 18 — MVP

### 18.1 What's V1-real vs. V1-stub, per subsystem

| Subsystem | V1 (real) | Deferred (stub/absent) |
|---|---|---|
| Goal→Task→Run→Invocation chain | Full chain, both LLM and Tool Invocations | — |
| Capability/Grant/Policy | Grant check + `ALLOW`/`DENY`/`REQUIRE_APPROVAL`, exercised end-to-end by one deliberately risky action (18.2) | `CONDITIONAL` autonomy and performance-driven auto-relaxation (Phase 9.4) |
| Context Compiler | Priority tiers, hard token ceiling, reference-not-content, dedup, layered assembly | Historical-usefulness scoring, LLM-based summarization, embedding-based relevance (pgvector stays off) |
| Model Router | Three tiers (`CHEAP`/`MID`/`STRONG` — amended 2026-09-13, Phase 7H; V1 shipped two), static difficulty tag per Task Definition | Confidence-based escalation loop (Phase 10.4), auto-adapting tier preference from performance data |
| Budget Governor | Reserve/reconcile per Run/Task, hard ceiling enforcement; **per-day aggregate ceiling (amended 2026-09-13, Phase 8 — un-deferred by operator decision; mechanism implemented, inert until a daily limit is configured)** | Per-Agent/per-Goal rollups beyond basic tracking |
| Event store + projections | Full envelope; **minimum synchronous projections required for correctness** (Run/Task Instance/Workflow Run status, `budget_counters`) — see 18.1a | `agent_performance` and `agent_xp_projection` (both async) deferred entirely, along with their consuming UI |
| Memory | Deliberately stubbed seam only (see 18.1b) | Task/Agent/Project/Organizational scope write paths, supersession/contradiction handling |
| Workflow Interpreter | Linear 2-task graph, no branching | Conditional branching, loops, failure-routing |
| UI | Overview + Activity feed + Approvals queue | Agent Detail, Workflow graph view, Registry admin UI (Definitions seeded via config/scripts, not a UI), Cost dashboard, Memory browser, any gamification/tileset layer |
| Process supervision | Manual start | NSSM service wrapping (Phase 13.2 V1.1) |

**18.1a — Projections, precisely.** Phase 15's V1 screens (Overview, Activity feed,
Approvals queue) are fully served by the **synchronous** projections already
required for correctness — Run/Task Instance/Workflow Run status and
`budget_counters` — plus the raw Events table (Activity feed is a direct tail of
Events, not a separate projection) and the `approvals` table (direct governance
state, not a projection). **No additional asynchronous projection is required for
the V1 UI.** `agent_performance` and `agent_xp_projection` are both async (Phase
8.3) and both deferred in full, along with everything that consumes them (Agent
Detail's performance panel, any gamification surface) — the V1 UI never depends on a
projection that doesn't exist.

**18.1b — Memory, precisely.** Reviewing the two MVP workflows below: Task B
consumes Task A's output via the **Artifact** system (by reference), not via Task
Memory — neither workflow genuinely requires cross-Run recall from a memory scope.
Task Memory is therefore a **deliberately stubbed seam**: the `memory_items` table
exists in the schema (Phase 12) and the write path is designed (Phase 7), but no
memory write is implemented until a real workflow actually needs one — memory
infrastructure is not built merely to satisfy architectural completeness.

### 18.2 The concrete MVP: two workflows

1. **Standalone Task: "`research.retrieve` → Report."** One Task Instance, one Agent
   Definition, an agentic loop internally (Phase 11.2): a Retrieval/Tool Invocation
   against a **`research.retrieve` Capability** feeds a subsequent LLM Invocation,
   producing a Report Artifact. The Capability is defined by its contract (retrieve
   information relevant to a query), not by a named external provider — its concrete
   Tool Binding (direct API, or a deterministic/local implementation where
   practical) is chosen at implementation time per the Phase 6 decision framework,
   and the capability boundary must survive replacing that binding entirely. Proves:
   task receipt, capability selection, tool call, structured tool output, artifact
   creation, event emission, per-invocation context compilation (including the
   recompilation-after-tool-call mechanic from Phase 5.8), and model routing at the
   `CHEAP` tier for retrieval-adjacent steps.

2. **Structured Workflow: "Research → Review-and-`publish.report`."** Two Task
   Instances: Task A reuses workflow 1's pattern to produce a Report Artifact; Task B
   (a *different* Agent Definition) consumes Task A's artifact **by reference** and
   invokes a **`publish.report` Capability** — a clearly bounded external side
   effect (not merely "a WRITE-class action"), tagged with elevated risk so it
   deterministically triggers `REQUIRE_APPROVAL`. This is the scenario that exercises
   the full governance chain end to end:
   ```
   Capability Grant -> Policy evaluation -> REQUIRE_APPROVAL
     -> Approval created with the EXACT proposed action snapshot
     -> human approval
     -> re-authorization immediately before execution (Phase 9.5)
     -> publish.report executes
     -> outcome Event recorded
   ```
   including a specific test of the **material-change invalidation rule**: altering
   the proposed action's parameters after the Approval is created must invalidate
   it, requiring a fresh proposal rather than allowing stale-approved execution.

   **Pause/resume is exercised explicitly within this workflow**, not merely
   claimed: the Workflow Run is deliberately paused either between Task A's
   completion and Task B's start, or while Task B's `publish.report` Invocation sits
   `awaiting_approval`, and then resumed — proving Phase 9.7's pause/resume mechanics
   at a concrete, defined point rather than asserting the capability abstractly.

Together, these two cover all 14 of your original proof points without needing
branching, looping, multiple memory scopes, or the escalation/autonomy machinery —
those stay real, designed, and dormant until a genuine second capability demands
them.

### 18.3 Success criterion

The MVP is successful if adding a third Task Definition, a third Capability, or a
third Agent Definition afterward requires **no changes to core execution semantics,
authorization semantics, the event schema, or the UI architecture** — only the new
Definition, its Tool Binding(s), its Workflow composition (if any), and its tests.
If a third addition forces a change to any of those four, that's a signal the
architecture, not the addition, needs revisiting.

---

## Phase 19 — Roadmap

Staged by **evidence, not calendar time** — each stage advances when a concrete need
or enough real data exists, not on a schedule. This mirrors the YAGNI discipline
running through the whole document.

- **V1 (Phase 18's MVP)**: two workflows, full governance chain proven once, manual
  process start, minimal UI (Overview/Activity/Approvals).
- **V1.1**: NSSM service wrapping (unattended operation); UI expands to Agent Detail,
  Workflow graph, and a Registry admin UI (so Definitions no longer require
  redeploying config files by hand).
- **V2**: `agent_performance` and `agent_xp_projection` (both deferred at V1) come
  online, with enough real Run data to be meaningful; Cost dashboard and
  gamification UI surfaces appear, now backed by real projections instead of
  imagined mockups. **`agent_performance` may be displayed in the UI as soon as it
  exists, even before it is statistically meaningful** — but it must not be allowed
  to influence Model Router tier-preference adaptation (Phase 10.5) or feed Phase
  9.4's `CONDITIONAL` autonomy logic until a defined minimum sample-size/confidence
  criterion is met. Defining and testing that threshold is an explicit part of V2's
  implementation work, not left implicit or assumed self-evident at build time.
- **V3**: New Capabilities added strictly per the Phase 14 rubric as real Goals
  demand them (e.g., a genuine e-commerce or marketing need arrives) — never
  speculative. Workflow Interpreter gains branching/looping only once a real
  workflow's logic actually requires it. Agent/Project/Organizational memory scopes
  are implemented only against concrete gaps that appear in practice, per Phase 7's
  deliberate-write discipline.
- **V4**: Model Router's confidence-based escalation loop (Phase 10.4) activates.
  `CONDITIONAL` autonomy (Phase 9.4) activates for capabilities with a large enough
  `agent_performance` sample size to clear the **same minimum-sample-size/confidence
  criterion defined in V2** — never on a hunch, and never before that threshold is
  met even if the feature is otherwise implemented. pgvector, Langfuse, and the
  evaluation system (Phase 8.9) are each reconsidered only if a concrete gap in
  structural retrieval, trace debugging, or grading demonstrably appears — the Phase
  2/4 "boring infrastructure" defaults hold until then, not indefinitely by
  assumption.
- **V5**: Capabilities progressively graduate `ALWAYS_APPROVE → CONDITIONAL →
  (human-elected) AUTONOMOUS`, always via explicit, logged human decisions informed
  by real performance data — never a system-driven promotion (Phase 9.4, unchanged).
  SPEND/TRADE/PUBLISH/DELETE retain their policy-enforced ceiling indefinitely, by
  design, regardless of stage.
- **V6+**: Multi-user generalization (Phase 9.8) or a move off single-machine infra
  (object storage, managed Postgres) only if the platform genuinely outgrows
  local/solo use — not built ahead of that need. The "digital workforce" vision
  materializes as an accretion of Capabilities and Workflows on an unchanged core,
  per Phase 18.3's success criterion — the architecture's job was always to make
  that accretion cheap, not to anticipate its content.

## Phase 20 — Risks / Failure Modes

What could actually go wrong, and what I'd change if it did:

1. **Scope creep back into "a collection of chatbots."** The Phase 14 rule is a
   discipline, not an enforcement mechanism — under time pressure it's tempting to
   add an integration because it's convenient, not because a Task Definition needs
   it. Mitigation is procedural: treat any integration added without a consuming
   Task Definition as a spec violation to be caught in review (Phase 17's Codex
   review pass is a real checkpoint for this, not just code quality).
2. **Implementation drift from the spec's safety properties.** The architecture
   forbids models from bypassing Policy/Approval, but that guarantee only holds if
   the Context Compiler and Policy engine are actually built as specified — a solo
   implementer under deadline pressure could quietly skip a check (e.g., skip
   re-authorization-before-execution, Phase 9.5) without the architecture itself
   catching it. Mitigation: the MVP's Phase 18.2 test scenarios exist specifically to
   make this drift visible early, not theoretical.
3. **Human-driven autonomy overreach.** Phase 9.4 requires an explicit human act to
   promote autonomy — but a human eager to reduce approval friction can still make
   that act carelessly (promoting SPEND/TRADE without real track record). No
   architecture prevents a human from overriding their own governance design; this is
   a discipline risk on you, not a gap in the system, and worth naming rather than
   pretending a technical control exists where none should.
4. **Budget misconfiguration.** A Task Definition's default budget set too high
   defeats cost governance without breaking anything visibly. In V1 (Cost dashboard
   deferred to V2 per Phase 19), this must be watched via direct `budget_counters`
   queries rather than a UI — an explicit operational gap worth acknowledging rather
   than assuming away.
5. **Single-machine fragility.** Local-first means no redundancy — a corrupted disk
   or failed Postgres instance loses everything. Acceptable for a solo user, but only
   if paired with a deliberate practice (periodic `pg_dump` backups) — and that
   practice must include periodically **actually restoring** a backup, not merely
   generating backup files. A backup that has never been successfully restored is not
   considered proven; "the backup file exists" and "the backup works" are different
   claims, and only the second one is a real mitigation.
6. **Manual process start undercuts the "living organization" feel.** Until V1.1's
   NSSM wrapping, the system only works when you remember to start it — worth setting
   that expectation explicitly rather than letting the UI's "always-on ops center"
   aesthetic imply otherwise before it's true.
7. **Trust-level drift.** Phase 6/9's trust levels are assigned at integration time;
   they don't protect against a previously-verified third-party source degrading or
   being compromised later. Recommend periodic re-review of trust levels for
   capabilities in active use, not a set-once-forget assumption.
8. **Context Compiler under-building.** Phase 5 is the deepest, most
   implementation-effort-heavy part of the spec; the easiest thing to shortcut under
   solo-dev pressure is exactly the priority-tiering/dedup/compression discipline
   that prevents the token waste the whole platform exists to eliminate. Mitigation:
   implement the **deterministic** context-efficiency measurements early rather than
   deferring them — tokens included vs. tokens actually referenced via ID/citation
   matching (Phase 5.16), cache hit/miss per layer, and the exclusion-reasoning
   already captured in context lineage/provenance (Phase 5.13) — so drift shows up as
   data, not as a vague feeling that "context feels bloated." This must not be
   satisfied by reintroducing an LLM-based classifier or any other model call whose
   sole purpose is measurement — Phase 5.16 deliberately removed that approach, and
   the mitigation here relies only on the deterministic signals that remain.
9. **Event schema lock-in.** Everything downstream (UI, cost, XP, audit, future
   evaluation) derives from the Phase 8.1 event envelope — a poorly shaped early
   `event_type`/`payload` is expensive to unwind later. Mitigated by treating
   `payload` as versioned/extensible per event type from day one, and by keeping the
   MVP's taxonomy (Phase 8.2) deliberately small so there's less surface to get wrong
   early.
10. **Premature trust in early performance data.** With only two MVP workflows and
    low volume, `agent_performance` won't have statistically meaningful signal for a
    long while. Risk: acting on Phase 9.4's `CONDITIONAL` logic or Phase 10.5's tier-
    preference adaptation before there's enough data is worse than not having the
    data at all. Mitigation: the explicit minimum-sample-size/confidence criterion
    required by Phase 19's V2/V4 entries is the concrete answer to this risk, not
    merely a stated intention.

---

**This completes the AI Command Centre architecture/design specification, Phases
1–20.** Further architecture phases are added only if a concrete implementation
discovery exposes a genuine contradiction or missing boundary — not proactively.
Implementation (writing-plans, code, or any subagent/fork that would modify
production code) begins only on explicit authorization.
