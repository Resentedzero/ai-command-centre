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
| **V2** | **Partial.** Built: the async projection loop and `agent_performance` (per Agent version, Task Definition, tier; cost per unit), shown by `GET /agents/:id`; the Cost/Budget read API (`GET /costs`: counters by scope, per-unit totals, cost-vs-success); a structural test keeps Policy and the Router from reading the projection. Not built: `agent_xp_projection` (XP rules and a quality signal are gamification design, UI workstream), the cost dashboard UI, duration and rejection-rate measures, the minimum sample criterion (decision, §6). | `architecture/AGENT_PERFORMANCE.md` |
| **V3** | Not started. Linear graphs only; no memory (`memory_items` does not exist); two capabilities. | — |
| **V4** | Not started. No escalation loop; `CONDITIONAL` autonomy behaves as `ALWAYS_APPROVE`; no evaluation. | `policy.ts` |
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
| Agent performance projection | V2 | **Closed as built; its sample criterion is open.** Phase 19 makes defining that criterion part of V2; choosing its form and values is a governance decision (§6), so the projection ships display-only behind a structural firewall. V2 itself stays partial. | `development/AGENT_PERFORMANCE_CLOSURE.md` |

## 4. Why the Context Compiler phase is closed with §5.16 open

Spec §18.1 lists what V1's Compiler must really do: priority tiers, a hard token ceiling, reference-not-content, dedup and layered assembly. All are built and tested. §5.16 (measuring which included context the output actually used) is *measurement* of compilation, not compilation, and its consumers — `agent_performance`, tier-preference tuning, evaluation — are V2/V4. It is tracked as follow-up in `architecture/CONTEXT_COMPILER.md` §3, not as a blocker.

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

**Not next, and why.** Memory (V3) is gated on "a concrete gap that appears in practice" and variable passing / branching on "a real workflow that needs it" (`NEXT_PHASE_PLAN.md` §10–11). Autonomy (V4/V5) needs the sample criterion (§6).

**Position after 2026-09-14.** `agent_performance` and the Cost/Budget read API followed (§3). No decision-free, evidence-backed item remains: every open item is a decision in §6 or a handoff in §7. The Artifact browser API (`NEXT_PHASE_PLAN.md` §8) is small and ungated by stage but waits for "a concrete need to browse Artifacts outside" the views that already show them (Agent Detail outputs, Approval previews); none has appeared.

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
- **The minimum sample-size/confidence criterion** (spec Phase 19 V2, Phase 20 Risk #10) before Policy's `CONDITIONAL` logic or Router tier adaptation may read `agent_performance`: its form (a sample count, or a confidence bound on success rate) and its values. Nothing reads the projection until then, so it blocks only V4.
- **XP rules** (spec §16.1): the XP amounts and the quality signal they need. Gamification design, shared with the UI workstream.
- **The external search provider for `research.retrieve`**: provider, credentials and spend authorization.
- **NSSM service wrapping** (V1.1): installing a Windows service is a deployment action.

## 7. Handoffs and operator actions

UI workstream (APIs built, no UI):
- Registry screen against `GET /registry` and the six create routes plus revocation (`CAPABILITY_PLATFORM.md` §5).
- Agent Detail: `web/lib/api.ts` still types `performance` as `null`; the API returns rows.
- Cost dashboard against `GET /costs` (settle field names such as `agentVersion` when typing it).

Operator:
- Apply migrations 0014 (unique Definition versions and Capability names; fails if duplicates were hand-inserted) and 0015 (`agent_performance`) with `npm run migrate`.
