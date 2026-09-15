# AI Command Centre

This project implements the frozen spec at
`docs/superpowers/specs/2026-09-12-ai-command-centre-design.md`. Read it —
especially Phases 2–4, 8, and 12 — before touching anything
architecture-affecting. This file is an orientation summary, not a
substitute for the spec.

## Core abstraction chain

```
Goal -> Workflow Run (of a Workflow Definition)
     -> Task Instance (of a Task Definition)
        -> Run (one attempt; retries create additional Runs)
           -> Invocation (LLM | Tool | Retrieval | Deterministic | Browser)
```

Definitions (Workflow/Task/Agent/Capability) are versioned, reusable
templates; Runs/Task Instances/Workflow Runs are their runtime instances.
Every meaningful state transition emits one or more immutable Events
(Phase 8); current state is a same-transaction projection over those
events, never a replay.

## The single-chokepoint rule

**Only the Model Router may call LLM providers directly.** See Phase 4 of
the spec. Provider SDKs and API keys live only inside that module. No other
module — Workflow Interpreter, Executor, Tool Adapters, UI — ever imports a
provider SDK or holds a model API key. The Model Router lives in
`src/router/` (adapters under `src/router/providers/`); this rule is what
every review should check first. Provider calls are never made inside a
database transaction — see `docs/architecture/DURABLE_EXECUTION.md`.

Documentation index: `docs/README.md`.

## Module boundaries (Phase 4)

The Run/Invocation Executor is deliberately thin: it coordinates but
contains no workflow topology, context compilation, model routing, policy,
or tool-implementation logic itself — those are separate modules it calls
out to. The Workflow Interpreter never calls an LLM.

Tool code is resolved from the persisted `tool_bindings` row through the
adapter registry (`src/capabilities/toolAdapters.ts`), and a step's plan from
its Task Definition `kind` (`src/capabilities/taskPlans.ts`). Definitions,
Grants and bindings are created through the Registry API
(`src/definitions/registryWrites.ts`) and never updated: an edit is a new
version. See `docs/architecture/CAPABILITY_PLATFORM.md`.

Asynchronous projections (`src/projections/`) are rebuilt from Events by an
in-process loop, never on the execution path. `agent_performance` reaches a
decision only through its minimum sample criterion
(`src/governance/performanceEligibility.ts`; N = 10, set by the operator) and only in the Model Router's tier preference. Policy must not read
it. See `docs/architecture/AGENT_PERFORMANCE.md`.

## Per-module CLAUDE.md files

None exist yet (`web/CLAUDE.md` only points at the Next.js version notes in
`web/AGENTS.md`). Module contracts live in each source file's header comment.
Architecture invariants that can be checked statically — no provider call or
tool side effect inside a transaction, the single chokepoint, status changes
recorded as events, core code naming no capability, Definitions and Grants
inserted only by the Registry, `agent_performance` read
only by its projector, read APIs and eligibility gate (imported only by the Router) — are enforced by `tests/execution/structuralInvariants.test.ts`.
