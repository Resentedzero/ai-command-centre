# Capability Platform

**Implements:** spec §3c (Capability / Grant / Tool Binding / Policy / Approval), Phase 4 "Tool Adapters", Phase 6 (binding kinds and trust), §18.2 (the binding must be replaceable), §18.3 (the V1 success criterion). **Status:** in progress — see `docs/roadmap/ROADMAP_STATUS.md` §5.

## 1. Chain

```
Capability (what it is: capabilities row, name = logical id)
  -> Capability Grant (what an Agent Definition version may do)
  -> Tool Binding (which concrete code fulfils the Capability now: tool_bindings row)
  -> Policy (Grant + binding trust + risk -> ALLOW / DENY / REQUIRE_APPROVAL)
  -> Budget reservation (in the unit and amount the binding's adapter declares)
  -> Approval (only on REQUIRE_APPROVAL, pinned to the exact proposed action)
  -> executing committed, pre-effect re-authorization, adapter execute (no transaction)
  -> Events + Artifacts (tool output is untrusted data for later compilation)
```

## 2. Tool Adapter registry (`src/capabilities/toolAdapters.ts`)

A spec builder names a Capability and proposes an action. `resolveToolInvocation` selects the binding and returns the Tool Invocation spec whose `execute` runs that binding's adapter.

| Rule | Detail | Test |
|---|---|---|
| **Code comes from the binding row.** | `internal` bindings name a registered `InternalToolFunction` in `config.function`. Builders never import an implementation. | `tests/capabilities/toolAdapters.test.ts` |
| **Selection: highest version wins; ties by lowest id.** | Exactly one Capability must match the name. | same (mutation-checked: oldest-wins mutant fails 2 tests) |
| **No fallback.** | If the selected binding cannot run here (a kind with no adapter, an unregistered function), resolution throws. An older binding is never used in its place. | same (mutation-checked: fallback mutant fails 2 tests) |
| **Selection is not Policy (§3c).** | A newest binding below the Grant's trust bar is selected and then DENYed. The Capability stops working for that Agent until the binding or Grant changes. | `researchRetrieveBindingSwap.test.ts` |
| **Two phases.** | `prepare(tx, {config, proposedActionSnapshot})` runs in the builder's transaction, validates the action, reads what the effect needs, and declares `costClass` and `estimatedCost`. `execute({config, inputs}, ctx)` runs with no transaction, at most once (DURABLE_EXECUTION §2.1). | structural invariant (adapter call only inside the spec closure) |
| **Deterministic.** | Selection and `prepare` read only persisted rows, so a resume rebuilds an identical spec. A binding added while an Approval is pending changes the selection; the resume fails closed as `resume_spec_mismatch`, and the recovery is a new Run. | `toolAdapters.test.ts` (determinism) |
| **Binding rows are immutable.** | `execute` closes over the row's `config`, and `invocations.tool_binding_id` pins what was authorized only if that row never changes. A change is a new row with a higher version. Registry write routes must honour this. | — (convention; enforced when writes exist) |
| **The binding declares cost.** | Whether fulfilling a Capability is metered is a property of the binding, not the Capability. | swap test (free local read reserves 0 USD) |
| **Config stays with the adapter.** | Never placed in model context (CONTEXT_COMPILER §1), never written to an event. | compiler test; events test (milestone step 4) |

Binding kinds with adapters today: `internal` only. `direct_api`, `mcp`, `browser`, `process`, `webhook` fail closed until an adapter is built for a real need (spec Phase 6, Phase 14 rubric).

## 3. Registered internal functions

| `config.function` | Capability | What it does | Cost declaration |
|---|---|---|---|
| `research.retrieve.synthetic` | `research.retrieve` | Fixed synthetic results; no I/O. The seeded, active binding. | `metered_api`, 0.01 USD (unchanged from V1; nothing is actually metered) |
| `research.retrieve.local_corpus` | `research.retrieve` | Plain term matching over `.md`/`.txt` under `RESEARCH_CORPUS_ROOT`. Bounded (files, bytes, results, snippet length), deterministic, symlinks not followed, root-relative paths only. Unset root refuses with `consumption: "none"`. Optional `config.maxResults` 1–20. Not seeded. | `local_retrieval`, 0 |
| `publish.report.filesystem` | `publish.report` | `prepare` reads the approved Artifact's bytes; `execute` writes them atomically under `ARTIFACT_ROOT/published/`, re-proving the approved hash; idempotent. | `external_side_effect`, 0.05 USD |

Migration `0011` names these functions on bindings seeded before the registry (`config = {}`).

**Decision boundary:** a real external search binding for `research.retrieve` needs a provider choice, credentials and spend authorization. Nothing here selects one.
