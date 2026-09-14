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
| **Binding rows are immutable.** | `execute` closes over the row's `config`, and `invocations.tool_binding_id` pins what was authorized only if that row never changes. A change is a new row with a higher version. Enforced in the database (migration `0013`): a trigger refuses changes to `capability_id`, `kind`, `config` or `version`, and `(capability_id, version)` is unique, so selection has no ties. `trust_level` stays updatable because it is re-read before every effect. | `tests/db/toolBindingImmutability.test.ts` |
| **A function fulfils only its own Capability.** | Each `InternalToolFunction` declares `capabilityName`; a binding naming a function of another Capability fails closed. Otherwise a READ Capability's binding could name a PUBLISH function and run that effect under the READ Grant. | `toolAdapters.test.ts` (mutation-checked) |
| **A completed tool position is never re-resolved.** | The research plan's tool position is deferred, so a re-drive after the tool ran does not re-select a binding that may since have been replaced. | `deferredInvocationSpecs.test.ts` |
| **The binding declares cost.** | Whether fulfilling a Capability is metered is a property of the binding, not the Capability. | swap test (free local read reserves 0 USD) |
| **Config stays with the adapter.** | Never placed in model context (CONTEXT_COMPILER §1), never written to an event. | compiler test; events test (milestone step 4) |

Binding kinds with adapters today: `internal` only. `direct_api`, `mcp`, `browser`, `process`, `webhook` fail closed until an adapter is built for a real need (spec Phase 6, Phase 14 rubric).

## 3. Registered internal functions

| `config.function` | Capability | What it does | Cost declaration |
|---|---|---|---|
| `research.retrieve.synthetic` | `research.retrieve` | Fixed synthetic results; no I/O. The seeded, active binding. | `metered_api`, 0.01 USD (unchanged from V1; nothing is actually metered) |
| `research.retrieve.local_corpus` | `research.retrieve` | Plain term matching over `.md`/`.txt` under `RESEARCH_CORPUS_ROOT` (resolved through `realpath`). Bounded (entries visited, files, bytes, results, snippet length), deterministic, root-relative paths only. Symbolic links are not followed; on Windows that includes junctions and cloud placeholder files (e.g. OneDrive), so a synced corpus can return partial results. Each file's real path is re-checked just before reading; an unreadable file or directory is skipped. Only an unusable root refuses, with `consumption: "none"`. Optional `config.maxResults` 1–20. Not seeded. | `local_retrieval`, 0 |
| `publish.report.filesystem` | `publish.report` | `prepare` reads the approved Artifact's bytes; `execute` writes them atomically under `ARTIFACT_ROOT/published/`, re-proving the approved hash; idempotent. | `external_side_effect`, 0.05 USD |

Migration `0011` names these functions on bindings seeded before the registry (`config = {}`).

## 4. Definition-driven step planning

A workflow step's invocation plan is derived only from persisted Definitions (`src/workflow/buildInvocationSpecsFromDefinitions.ts`):

```
Task Instance -> Workflow Run -> Workflow Definition graph step (by the Task Instance's step slot)
  -> step.agentDefinitionId/Version + step.parameters
  -> Task Definition (id, version) -> kind -> registered task plan (src/capabilities/taskPlans.ts)
```

| Rule | Detail | Test |
|---|---|---|
| **The graph step binds the Agent** (spec §3b: a Run is the binding; §18.3 "Workflow composition"). | The builder binds it to the step's Run and provisions governance budgets before any plan runs, so no plan can skip either. | `buildInvocationSpecsFromDefinitions.test.ts` |
| **Binding an Agent authorizes nothing.** | A step whose Agent holds no Grant is denied by Policy at its Tool Invocation. | same |
| **Fail closed on every missing link.** | No Agent on the step, a missing Agent or Task Definition, a step that does not match the Task Instance, or a kind with no registered plan: the step fails (and is settled as `execution_error`). | same |
| **Task Definition `kind` selects the plan** (spec Phase 11 reusable kinds). | Registered kinds: `research_report` (retrieve, synthesize, mark report; requires a complete `default_context_budget`) and `publish_report` (requires step parameter `sourceTaskDefinitionId`). | same; `publishReport.integration.test.ts` |
| **Core names no capability.** | Outside `src/capabilities/` and the seed, no code imports a capability module or names a capability or seeded Definition. | `structuralInvariants.test.ts` |
| **§18.3 acceptance.** | A new Capability, internal function, Tool Binding, Agent, Grant, Task Definition kind and Workflow run end to end through `POST /goals` with no seed and no core change. | `tests/api/extensionAcceptance.test.ts` |

`POST /goals` takes optional `workflowDefinitionId` and `projectId` (UUIDs that must exist); each defaults to the seed's. Approval resolution, advance, the TTL sweep and startup re-drive no longer need the seed.

Migration `0012` gives Definitions seeded before this the new kinds (`research_report`, `publish_report`) and step bindings. It updates those Definition rows in place rather than versioning them, because it only makes explicit what the removed hard-coded dispatcher already did for them; it touches only rows still in the old shape and only when the seeded Agents resolve unambiguously.

**Recorded couplings, unchanged:** the `publish_report` plan finds its report by the source step's Task Definition id and the Artifact type `report`, because steps pass no variables (Advanced Orchestration). A step's difficulty and risk tier for its LLM Invocation are fixed in the `research_report` plan; `task_definitions` has no column for them.

## 5. Registry control plane (`src/api/routes/registry.ts`, roadmap V1.1)

| Route | Behaviour | Test |
|---|---|---|
| `GET /registry` | Agent Definitions, Capabilities with their Tool Bindings (`kind`, `version`, `trustLevel`, internal function name), Capability Grants (incl. `revokedAt`), Task Definitions (`kind`, whether a plan is registered), Workflow Definitions. **Binding `config` is never returned.** | `tests/api/registryRoutes.test.ts` |
| `POST /capability-grants/:id/revoke` | `revokeCapabilityGrant` commits first: the Grant is revoked and pending Approvals no surviving Grant covers are closed as `expired`. Then each affected Workflow Run is re-driven, which releases the hold and fails the step. Re-drive failures are reported per Workflow Run beside the committed revocation (the TTL sweep also settles them). A transient conflict on the revocation is a 503, not retried. Actor: the server-side operator constant. Idempotent. | same |

Revocation expires candidate Approvals in `(runId, approvalId)` order, so concurrent revocations take the per-Run event locks in one order (PHASE8_CLOSURE Risk 3, which this route made reachable). Like that record's lock-ordering fix, this rests on reasoning, not a test: nothing forces two transactions to interleave at the lock.

Not built: creating or editing Definitions, Grants or Tool Bindings (editing creates a new version, spec §15.1; binding rows are immutable, §2), and a Policies editor (no `policies` table; ROADMAP_STATUS §6).

## 6. Binding config isolation (spec §9.6)

A binding's `config` reaches its adapter's `prepare` and `execute` and nothing else: no event, Invocation, Artifact, Run or Task Instance record contains it (`tests/capabilities/bindingConfigIsolation.test.ts`), no model context (CONTEXT_COMPILER §1), no registry response (§5). There is no credential-reference mechanism yet; it waits for the first `direct_api` binding, which is itself a provider/credential decision.

## 7. Seed defaults

`POST /goals` without `workflowDefinitionId`/`projectId` uses the seed's (`src/definitions/lookupSeed.ts`). That lookup no longer resolves Tool Bindings: a Capability with several bindings is a legitimate state, and it made the default goal route fail once a second binding existed (found by the registry route test, confirmed by mutation).

## 8. Residuals

- **Corpus containment race.** A file swapped for a link between its `realpath` check and the read could still be followed. It needs write access to the corpus itself.
- **Corpus root read at execute time.** `RESEARCH_CORPUS_ROOT` is read when the tool runs, not when it is proposed. Prepared inputs are never compared on resume, so reading it earlier would not change what an approval pins. Only relevant if a READ Grant ever requires approval.
- **Migration 0012 fixes Agent versions at 1.** It binds only when exactly one `Researcher` v1 and `Publisher` v1 exist and the graph's steps are the seeded Task Definitions in order. Otherwise the graph is left unbound and its steps fail closed ("binds no Agent Definition").
- **Unique binding versions are assumed.** Migration 0013 fails on a database that already has two bindings with the same `(capability, version)`. The seed never creates one.

**Decision boundary:** a real external search binding for `research.retrieve` needs a provider choice, credentials and spend authorization. Nothing here selects one.
