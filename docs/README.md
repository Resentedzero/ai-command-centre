# Documentation index

If a lower tier disagrees with a higher one, the higher tier wins. The spec's dated implementation notes record every place the implementation clarifies or extends it.

## 1. Specification (frozen)
- [`superpowers/specs/2026-09-12-ai-command-centre-design.md`](superpowers/specs/2026-09-12-ai-command-centre-design.md): the product and architecture spec, Phases 1–20. Each subsystem doc below links back to the section it implements.

## 2. Architecture: authoritative subsystem designs
- [`architecture/DURABLE_EXECUTION.md`](architecture/DURABLE_EXECUTION.md) covers:
  - the transaction boundaries around provider calls;
  - the `executing` state and interruption recovery;
  - the single-executor-process invariant and lock order. (Phase 9)
- [`architecture/CONTEXT_COMPILER.md`](architecture/CONTEXT_COMPILER.md) covers:
  - what may enter a model's context, and the invariants that bound it;
  - grant-scoped tool schemas, trusted/untrusted separation, budgets and provenance;
  - open questions (cacheable prefix, reference mode). (Phase 5)
- [`architecture/CAPABILITY_PLATFORM.md`](architecture/CAPABILITY_PLATFORM.md) covers:
  - the Tool Adapter registry and binding selection (no fallback, immutable bindings);
  - definition-driven step planning and the spec §18.3 acceptance criterion;
  - the Registry read API and grant revocation. (Phases 3c, 6, 18.3)
- [`architecture/AGENT_PERFORMANCE.md`](architecture/AGENT_PERFORMANCE.md) covers:
  - the V2 `agent_performance` projection: sample, tier, retry and per-unit cost rules;
  - the full-rebuild in-process loop, and the firewall keeping Policy and the Router off it. (Phases 8.8, 12, 19)
- [`architecture/SUBSCRIPTION_PROVIDER_DESIGN.md`](architecture/SUBSCRIPTION_PROVIDER_DESIGN.md) covers:
  - the Claude Max (`claude -p`) provider adapter;
  - quota state and telemetry, and the disabled quota guardrail;
  - the tier ladder and candidate routing. (Phases 6–7H)

Module-level contracts live in the header comment of each source file. The root `CLAUDE.md` is the orientation summary. Spec §17.2 anticipates per-module `CLAUDE.md` files, but none exist yet.

## 3. Development records: phase closures and reviews
- [`development/PHASE8_CLOSURE.md`](development/PHASE8_CLOSURE.md): Phase 8, runtime containment. Emergency stop, DAY budget, run budgets, quota telemetry, deferred decisions.
- [`development/PHASE8_REVIEW.md`](development/PHASE8_REVIEW.md): independent review of Phase 8.
- [`development/POST_PHASE9_CLOSURE.md`](development/POST_PHASE9_CLOSURE.md): Phase 9 durable execution and the hardening that followed. Lists the commits, decisions made, review dispositions, residuals, and decisions still required.
- [`development/EXECUTION_RECOVERY_CLOSURE.md`](development/EXECUTION_RECOVERY_CLOSURE.md): the milestone after Phase 9 — step failure settlement, crash-safe tool side effects, and the recovery/concurrency review.
- [`development/CONTEXT_COMPILER_CLOSURE.md`](development/CONTEXT_COMPILER_CLOSURE.md): Context Compiler hardening — grant-scoped minimal tool schemas, hash dedup, provenance, the budgeted invocation instruction layer.

- [`development/CAPABILITY_PLATFORM_CLOSURE.md`](development/CAPABILITY_PLATFORM_CLOSURE.md): the Capability Platform — Tool Adapter registry, local-corpus binding, definition-driven planning (spec §18.3 met), Registry API, adversarial review dispositions.
- [`development/REGISTRY_WRITES_CLOSURE.md`](development/REGISTRY_WRITES_CLOSURE.md): Registry writes — versioned, audited creation of Definitions, Tool Bindings and Capability Grants through the API; review dispositions.
- [`development/AGENT_PERFORMANCE_CLOSURE.md`](development/AGENT_PERFORMANCE_CLOSURE.md): the V2 agent performance projection — rules, rebuild loop, firewall, review dispositions.
## 4. Planning and research (advisory, authorizes nothing)
- [`roadmap/NEXT_PHASE_PLAN.md`](roadmap/NEXT_PHASE_PLAN.md): the V1 → V6 roadmap, expanded.
- [`roadmap/ROADMAP_STATUS.md`](roadmap/ROADMAP_STATUS.md): **where the implementation actually is**, by roadmap stage (V1–V6); what the phase labels mean; current milestone; open governance decisions. Status only, not an authorization.
- [`superpowers/plans/2026-09-12-ai-command-centre-mvp.md`](superpowers/plans/2026-09-12-ai-command-centre-mvp.md): the original MVP implementation plan.
- `research/`: the subscription provider research, runtime spike and benchmark notes.
- `gamification/`: the tile pack inventory.
