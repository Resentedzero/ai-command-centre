# Roadmap status

**Authoritative current status.** `NEXT_PHASE_PLAN.md` stays the advisory plan; this page says where the implementation actually is. Updated 2026-09-14.

## 1. What the phase labels mean

Three numbering schemes have been used. Only one is the roadmap.

| Label | What it is | Example |
|---|---|---|
| Spec "Phase N" headings | **Design sections** of the frozen spec | spec Phase 9 is *Security / Permissions*, not durable execution |
| "Phase 6–9", "post-Phase 9" in commits and closure records | **Delivery-work labels** used while hardening V1 | "Phase 9: durable execution" (`b33a929`) |
| **V1 → V6** | **The delivery roadmap** (spec Phase 19, restated in `NEXT_PHASE_PLAN.md` §1) | V1.1 = service wrapping + Agent Detail, Workflow graph, Registry |

From here on, work is named by roadmap stage and a descriptive milestone name. Existing closure records keep their historical file names.

## 2. Status by stage

| Stage | Status | Evidence |
|---|---|---|
| **V1** (spec Phase 18 MVP) | **Complete.** Both workflows, the full governance chain, pause/resume, minimal UI. Hardened well beyond MVP scope: durable execution, crash recovery, idempotent tool side effects, emergency stops, approval TTL, context compilation. | `POST_PHASE9_CLOSURE.md`, `EXECUTION_RECOVERY_CLOSURE.md`, `CONTEXT_COMPILER_CLOSURE.md` |
| **V1 success criterion** (spec §18.3) | **Met.** A new Capability, Tool Binding, Agent, Task Definition and Workflow run end to end as data plus a registered adapter and plan, with no core change (acceptance test through the HTTP API; structural test). | `CAPABILITY_PLATFORM_CLOSURE.md` |
| **V1.1** | **Partial.** Built: Agent Detail view, Workflow/Task view (an ordered step list, not a graph), the Registry API (reads, versioned creates of Capabilities, Tool Bindings, Agent/Task/Workflow Definitions and Grants; grant revocation). Not built: Registry UI (UI workstream), a Policies editor (needs the `policies` decision, §6), NSSM service wrapping (installing a service is deployment). | spec §15.1 note; `CAPABILITY_PLATFORM.md` §5 |
| **V2** | **Partial.** Built: the async projection loop and `agent_performance` (per Agent version, Task Definition, tier; cost per unit), shown by `GET /agents/:id`; the Cost/Budget read API (`GET /costs`: counters by scope, per-unit totals, cost-vs-success); the minimum sample criterion (form decided 2026-09-14: `sample_count >= N` per group; N unset, so nothing is eligible), with a structural test keeping Policy off the projection. Not built: `agent_xp_projection` (XP rules and a quality signal are gamification design, UI workstream), the cost dashboard UI, duration and rejection-rate measures. N's value is a decision (§6). | `architecture/AGENT_PERFORMANCE.md` |
| **V3** | Not started. Linear graphs only; no memory (`memory_items` does not exist); two capabilities. | — |
| **V4** | **Partial.** Built: the Model Router's measured tier preference (§10.2, §10.5) behind the sample criterion, inert until N is set. Not built: `CONDITIONAL` autonomy (its thresholds are decisions, §6; it behaves as `ALWAYS_APPROVE`), the confidence-based escalation loop (§10.4 is retry machinery; retry policy is a decision), evaluation (§8.9, evidence-gated). | `TIER_PREFERENCE_CLOSURE.md`, `policy.ts` |
| **V5 / V6+** | Not started, by design. | — |

## 3. Milestones

| Milestone | Stage | Status | Record |
|---|---|---|---|
| Runtime containment ("Phase 8") | V1 hardening | Closed | `development/PHASE8_CLOSURE.md` |
| Durable execution and follow-on hardening ("Phase 9") | V1 hardening | Closed | `development/POST_PHASE9_CLOSURE.md` |
| Execution recovery and idempotency | V1 hardening | Closed | `development/EXECUTION_RECOVERY_CLOSURE.md` |
| Context Compiler hardening | V1 hardening | **Closed** (see §4) | `development/CONTEXT_COMPILER_CLOSURE.md` |
| Capability Platform (spec §18.3 conformance) | V1 success criterion → V1.1 Registry API | **Closed** | `development/CAPABILITY_PLATFORM_CLOSURE.md` |
| Registry writes | V1.1 Registry (API half) | **Closed** | `development/REGISTRY_WRITES_CLOSURE.md` |
| Cost/Budget read API | V2 (screen 7, API half) | **Closed** | `development/COST_VIEWS_CLOSURE.md` |
| Observability conformance and runtime fixes | V1 conformance (§8.2, §8.4, §9.5, §15.1 screen 8 API) | **Closed** | `development/OBSERVABILITY_CLOSURE.md` |
| Agent performance projection | V2 | **Closed.** Its sample criterion's form was decided and built in the tier preference milestone; N's value is open (§6). | `development/AGENT_PERFORMANCE_CLOSURE.md` |
| Minimum sample criterion and measured tier preference | V2 criterion; V4 (§10.2, §10.5) | **Closed.** `CONDITIONAL` autonomy not built (decision, §6). | `development/TIER_PREFERENCE_CLOSURE.md` |
| Routing record and cache hits | V1 conformance (§10.7, §5.11) | **Closed.** Capping output at the reserved estimate was built, reviewed as a product change, and withdrawn to a decision (§6). | `development/ROUTING_RECORD_CLOSURE.md` |
| Event log immutability | V1 conformance (§3e, §8.7) | **Closed.** Migration 0016: the database refuses UPDATE, DELETE and TRUNCATE on `events`. | `development/ROUTING_RECORD_CLOSURE.md` §6 |
| Seed through the Registry | V1 conformance (§8.2, §9.4) | **Closed.** Seeded Definitions and Grants are validated and logged like an operator's writes. | `development/ROUTING_RECORD_CLOSURE.md` §9 |

## 4. Why the Context Compiler phase is closed with §5.16 open

Spec §18.1 lists what V1's Compiler must really do: priority tiers, a hard token ceiling, reference-not-content, dedup and layered assembly. All are built and tested. §5.16 (measuring which included context the output actually used) is *measurement* of compilation, not compilation, and its consumers — `agent_performance`, tier-preference tuning, evaluation — are V2/V4. It is tracked as follow-up in `architecture/CONTEXT_COMPILER.md` §3, not as a blocker. **Update 2026-09-14:** Phase 20 #8 asks for these deterministic measurements early, so the reference match is now built (`CONTEXT_COMPILER.md` §3 item 6).

## 5. Capability Platform (closed)

Goal: make spec §18.3 true — a new Capability, Tool Binding, Task Definition, Agent Definition and Workflow composition are added as data plus a registered adapter, with no edits to the Executor, Interpreter, governance, API or startup.

1. Tool Adapter registry resolved from the persisted Tool Binding row (spec §3c, Phase 4 "Tool Adapters"). **Done** (`14c8f27`).
2. A second, local-corpus `research.retrieve` binding, proving the capability boundary survives replacing its binding (spec §18.2). **Done** (`d53df9a`).
3. Step planning driven by definitions (Task Definition `kind`, per-step Agent in the Workflow graph), with the §18.3 acceptance test. **Done** (`4c251b3`).
4. Binding configuration never reaches events. **Done** (`4c251b3`).
5. Registry read API and grant revocation route (V1.1). **Done** (`4c251b3`).
6. Adversarial review findings fixed or documented. **Done** (`4c251b3`).

Authoritative write-up: `docs/architecture/CAPABILITY_PLATFORM.md`.

**Known decision boundary:** a real external search provider for `research.retrieve` needs a provider choice, credentials and spend authorization.

## 5a. Registry writes (closed)

Goal: an operator extends and edits the system through the API, not SQL (spec §15.1 screen 6: "editing creates a new Definition version, never mutates history"; where `autonomy_state` changes happen). Versioned, explicit, locked creates of every Definition type and of Grants, validated with the same checks the runtime applies, each audited by an event. Authoritative write-up: `docs/architecture/CAPABILITY_PLATFORM.md` §5.1.

**Not next, and why.** Memory (V3) is gated on "a concrete gap that appears in practice" and variable passing / branching on "a real workflow that needs it" (`NEXT_PHASE_PLAN.md` §10–11). `CONDITIONAL` autonomy (V4) needs its thresholds decided, and tier preference needs N's value (§6).

**Position after 2026-09-14.** `agent_performance`, the Cost/Budget read API, the observability conformance batch and, once the sample criterion's form was decided, the Router's tier preference followed (§3). Three spec-to-code audits found and closed the last items the spec determines (`OBSERVABILITY_CLOSURE.md`), including a single-Artifact read API (screen 8's API half) and Artifact ids on the Workflow Run detail; a browse/listing surface still waits for a need. A third round (`AUDIT_ROUND3_CLOSURE.md`) widened key redaction, recorded a verified backup procedure, and strengthened the governance tests that could not fail (every fix mutation-checked). No decision-free, evidence-backed item remains: every open item is a decision in §6 or a handoff in §7. One engineering residual is open but is not a decision (a second, a dispatch slot held after an ambiguous COMMIT, was closed 2026-09-14, DURABLE_EXECUTION §7 #4): an SSE cursor ordered by commit rather than insert (`global_seq` is assigned at insert, so a reconnect can skip a late-committing event, contrary to §15.3's "only to momentarily lag"; the second audit agreed it is determined, and found it also reachable when the server closes a slow stream or a live relay fails; since 2026-09-14 a failed relay ends open streams, so clients replay by cursor, which recovers those events unless the client already holds a higher cursor from a concurrent commit). The SSE fix is not a local change: a sound resume token (the snapshot `xmin` over an `xid8` column) is only valid if every event below it was delivered, which the best-effort live relay cannot promise, so it needs either replay-driven delivery or a changed client resume contract (`web/lib/api.ts`), both changes to §15.3's delivery design.

## 6. Decisions required (governance, not engineering)

Carried from earlier records, still open:
- Retry policy (limit, eligible failures, interaction with Approvals and budgets).
- DAY budget ceiling values and timezone.
- Whether stops permanently fail parked Runs.
- Artifact filesystem storage threshold.
- Live check of a separate system channel on the Claude CLI.
- DURABLE_EXECUTION §7 #13, #14, #16, #19.
- Context Compiler: stable cacheable prefix vs. the unguessable fence tag.

Surfaced by the 2026-09-14 roadmap reconciliation:
- **`capability_grants.scope` is stored but never evaluated.** No scope semantics are defined (spec §9.2).
- **Policy has no rate or time-window inputs** (spec §9.3).
- **No `policies` table** (spec Phase 12; roadmap Appendix A #1): Policy is code. A Registry Policies editor needs this decided.

Surfaced by the agent performance projection:
- ~~The minimum sample criterion's form~~ **decided 2026-09-14**: `sample_count >= N` per (Agent Definition version, Task Definition, tier). Still open: **the value of N** (`MIN_PERFORMANCE_SAMPLES`). Until it is set, tier preference changes nothing.
- **XP rules** (spec §16.1): the XP amounts and the quality signal they need. Gamification design, shared with the UI workstream.
- **The external search provider for `research.retrieve`**: provider, credentials and spend authorization.
- **NSSM service wrapping** (V1.1): installing a Windows service is a deployment action.

Surfaced by the 2026-09-14 spec-to-code audits (none blocks other work):
- **Retrying a failed recording transaction** (DURABLE_EXECUTION §7 #5): a successful call's result is discarded if its recording transaction is a deadlock victim. The fix is a bounded retry of the recording only, never the dispatch — retry machinery, which the operator excluded.
- **Workflow Run pause/resume events**: §8.2's note defines none; §3e says every meaningful transition emits one. Add `workflow_run_paused/resumed`, or keep status-only.
- **Agent pause/resume** (§15.1 screen 2, `agent_paused/resumed`): no per-agent pause exists; only stops. Define it, or retire the event names.
- **Goal status lifecycle**: `goals.status` is always `active`; nothing defines when a Goal completes or fails (derive from its Workflow Runs, store transitions with events, or drop the field).
- **`POST /goals` idempotency key**: a client retry creates a second Goal; no idempotency contract is specified for API commands.
- **Artifact versioning** (`artifacts.version`, `artifact_updated`): immutable-only (enforce with a trigger, retire the event) or new rows with `supersedes_id`. In-place updates are ruled out by the §9.5 hash pin.
- **Step output → input binding** (§3d variables, §18.2 "by reference"): storage is specified, binding syntax is not; also gated on a real workflow needing it (V3).
- **Citation convention for §5.16 usage measurement**: the deterministic reference match is built and recorded on `invocation_completed`, but models are never asked to cite artifact ids, so it records mostly zero until the prompt asks them to.
- **What counts as "referenced"** for `artifact_referenced` and XP: inclusion in a compiled context only, or also a hash-pinned tool snapshot.
Surfaced by the tier preference milestone:
- **`CONDITIONAL` autonomy rule** (spec §9.4, V4). The spec says `CONDITIONAL` "leans toward auto-`ALLOW` for below-threshold instances" but gives none of the values: (a) which instances are below threshold (a risk tier cut, an amount, or both); (b) what performance leans toward `ALLOW` (for example a minimum success rate, and its value); (c) which `agent_performance` row a tool action consults, since rows are per model tier and a tool Invocation has none (the Run's LLM tier, every tier of the group, or all must qualify). Until decided, `CONDITIONAL` requires approval. Unlocks V4 conditional autonomy; V5 graduation stays human-only regardless.
- **Tier preference below the default** (§10.2 "among models the risk tier already permits"). Built upward only. Letting data move a Task to a cheaper tier than its difficulty tag is an efficiency choice the spec permits but does not require; decide whether difficulty is a floor.
- **A preferred tier that cannot be authorized.** Once N is set, data may move a Run to a stronger tier whose budget, day ceiling or candidates refuse it where the default would have run; the Invocation then fails, because falling back is forbidden without a decision. Options: keep failing (current), exclude tiers the static candidate configuration cannot serve before preferring, or allow a recorded fallback to the default tier.
- **Confidence-based escalation** (§10.4, V4) escalates one tier with "bounded retry count": the retry policy decision above (limit, eligible failures). It is also what would produce samples on a second tier for tier preference to compare.
Surfaced by the second round of spec-to-code audits (not decisions; recorded so they are not lost):
- **Should `expected_output_tokens` cap provider output?** (decision). The reservation prices output at it (§10.7 Pass 1), but no adapter caps output there: Anthropic sends a fixed 4096, OpenAI and the Claude CLI send none. So one call can reconcile past its reservation and its Run's limit; every later reservation is refused (tested). Capping would make the ceiling hard but is a product change: seeded Tasks expect 500 output tokens, and nothing detects a truncated result, which would be stored as a completed Artifact. Deciding yes also needs truncation detection (`stop_reason`/`finish_reason`) and a verified CLI flag.
- ~~Packing to the chosen model's window~~ **built 2026-09-14** (`ROUTING_RECORD_CLOSURE.md` §10): each candidate records its model's context window, verified against Anthropic's models overview, and the Compiler packs to the Task budget capped at that window less the expected output. Still open: the Claude CLI's own system prompt shrinks a subscription call's effective window by an unmeasured amount; and §5.17's cache-block granularity, which is meaningless while the untrusted-data fence tag changes per call (the stable cacheable prefix question).
- **`retrieval` Invocations: read scope, not budget** (corrected 2026-09-14). §3a says a Retrieval Invocation is "read-scope checked only", so no reservation is the spec's reading. What is unbuilt is the read-scope check: `RetrievalInvocationSpec` names no Capability or scope to check. No plan emits the kind (`research.retrieve` runs as a Tool Invocation), so adding a scope to the spec type waits for the first retrieval plan.
- **A deadline for executing an approved action.** Spec §9.5's TTL expires unresolved Approvals, and since 2026-09-14 an approved Approval keeps authorizing past it (a paused Workflow Run resumed later no longer fails). Nothing now limits how long after approval the action may run; the Grant, revocation, snapshot and Policy re-checks still apply at execution. Options: no limit (current), or a separate approved-to-execution deadline and its value.
Surfaced by the third audit round (Phase 20, Phase 2/4/6, §9.6, §17):
- **CI** (§17.1 "lightweight GitHub Actions (lint, typecheck, test on push)"). Not built: it is new infrastructure that only runs on push (both need authorization), and "lint" needs a linter chosen (none is installed). A workflow would run `npm ci`, `tsc --noEmit` and `npm test` against a Postgres service with `TEST_DATABASE_URL`.
- **What "Elevated (Class 4) tier" means for an unverified binding** (Phase 6). `risk.ts` raises the risk tier one step; the spec never defines "Class 4", which could mean `highest`. Policy already requires approval for every unverified-binding action, so only the recorded `riskTier` would change.
- Fixed in this round: failure-text redaction now removes every `sk-` key shape and bearer tokens (§9.8 note), not only `sk-ant-`/`sk-proj-`.
Surfaced by an independent review (Fable, 2026-09-14):
- **The Budget Governor's downgrade and degrade outcomes** (Phase 4: "authorized / authorized-at-downgraded-tier / denied / degrade"; §5.0 the Context Budget is "tightenable by the Budget Governor when funds are constrained"). The Governor only authorizes or denies. When to downgrade, to which tier, and how far to tighten a budget has no spec values and meets the no-fallback rule, so it is a decision, related to but not the same as "a preferred tier that cannot be authorized".
- **Artifact bytes on the filesystem** (§12 "Postgres is never the storage location for every artifact regardless of size"; §13.3 relative paths under `ARTIFACT_ROOT`). Every stored result is inline JSON with no size bound. The mechanism waits with the threshold decision: built inert, it would also fix choices the spec leaves open (writing bytes before the recording COMMIT, and orphaned files when that transaction rolls back).
- **Cache hit/miss per layer** (§5.16, Phase 20 #8): not measurable as providers report it (one cache read per call; no per-layer breakpoints). Per-call `cache_hit` is recorded.

## 7. Handoffs and operator actions

UI workstream (APIs built, no UI):
- Registry screen against `GET /registry` and the six create routes plus revocation (`CAPABILITY_PLATFORM.md` §5).
- Agent Detail: `web/lib/api.ts` still types `performance` as `null`; the API returns rows.
- Cost dashboard against `GET /costs` (settle field names such as `agentVersion` when typing it).
- Run trace view against `GET /runs/:id/trace` (events in sequence order, each Invocation's context lineage).
- Artifact view against `GET /artifacts/:id`: Agent Detail `outputs` ids and the Workflow Run detail's per-Invocation `artifactIds` (typed in `web/lib/api.ts`) link straight to it.

Operator:
- Apply migrations 0014 (unique Definition versions and Capability names; fails if duplicates were hand-inserted), 0015 (`agent_performance`) and 0016 (events immutable) with `npm run db:migrate`. **All three applied to the local database 2026-09-14.**
- Back up and prove the restore (spec Phase 20 #5: only a restored backup is a mitigation). The Postgres client tools are in `C:\Program Files\PostgreSQL\18\bin` (not on `PATH`). Dump: `pg_dump --dbname="<DATABASE_URL>" -Fc -f acc-YYYYMMDD.dump`, kept off this disk. Restore check: `psql "<server>/postgres" -c "create database ai_command_centre_restore_check"`, `pg_restore --no-owner --dbname="<server>/ai_command_centre_restore_check" acc-YYYYMMDD.dump`, compare `select count(*) from events` with the live database, then drop the scratch database. Run end to end against the local database 2026-09-14 (4 events restored, both immutability triggers present). How often, and where dumps are kept, is the operator's choice.
