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
provider SDK or holds a model API key. The Model Router does not exist yet
as of this unit; when it lands, this rule is what every review should check
first.

## Module boundaries (Phase 4)

The Run/Invocation Executor is deliberately thin: it coordinates but
contains no workflow topology, context compilation, model routing, policy,
or tool-implementation logic itself — those are separate modules it calls
out to. The Workflow Interpreter never calls an LLM.

## Per-module CLAUDE.md files

None exist yet — this is the first unit (project foundation: schema, the
Event envelope, test-database strategy). Per Phase 17.2, a `CLAUDE.md`
accompanies each module as its unit lands.
