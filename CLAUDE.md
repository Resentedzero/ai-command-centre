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

## Per-module CLAUDE.md files

None exist yet (`web/CLAUDE.md` only points at the Next.js version notes in
`web/AGENTS.md`). Module contracts live in each source file's header comment.
Architecture invariants that can be checked statically — no provider call or
tool side effect inside a transaction, the single chokepoint, status changes
recorded as events — are enforced by `tests/execution/structuralInvariants.test.ts`.
