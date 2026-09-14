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
| **V1 success criterion** (spec §18.3) | **Not met.** Adding a third Capability, Task Definition or Agent Definition still needs edits to the step dispatcher, seed lookup, API routes and startup. | Current milestone: *Capability Platform* (below) |
| **V1.1** | **Partial.** Agent Detail view and Workflow/Task view (an ordered step list, not a graph) are built. Not built: Registry API and UI, NSSM service wrapping. | spec §15.1 note |
| **V2** | Not started. No `agent_performance` / `agent_xp_projection`, no async projection loop, no cost dashboard. | `schema.ts` header |
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
| **Capability Platform** (spec §18.3 conformance) | V1 success criterion → V1.1 Registry API | **In progress** | — |

## 4. Why the Context Compiler phase is closed with §5.16 open

Spec §18.1 lists what V1's Compiler must really do: priority tiers, a hard token ceiling, reference-not-content, dedup and layered assembly. All are built and tested. §5.16 (measuring which included context the output actually used) is *measurement* of compilation, not compilation, and its consumers — `agent_performance`, tier-preference tuning, evaluation — are V2/V4. It is tracked as follow-up in `architecture/CONTEXT_COMPILER.md` §3, not as a blocker.

## 5. Current milestone: Capability Platform

Goal: make spec §18.3 true — a new Capability, Tool Binding, Task Definition, Agent Definition and Workflow composition are added as data plus a registered adapter, with no edits to the Executor, Interpreter, governance, API or startup.

1. Tool Adapter registry resolved from the persisted Tool Binding row (spec §3c, Phase 4 "Tool Adapters").
2. A second, local-corpus `research.retrieve` binding, proving the capability boundary survives replacing its binding (spec §18.2).
3. Step planning driven by definitions (Task Definition `kind`, per-step Agent in the Workflow graph).
4. Binding configuration never reaches events.
5. Registry read API and grant revocation route (V1.1).

**Known decision boundary:** a real external search provider for `research.retrieve` needs a provider choice, credentials and spend authorization.

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
