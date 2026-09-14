# Capability Platform

**Implements:** spec §3c (Capability / Grant / Tool Binding / Policy / Approval), Phase 4 "Tool Adapters", Phase 6 (binding kinds and trust), §18.2 (the binding must be replaceable), §18.3 (the V1 success criterion). **Status:** built. Milestones closed: Capability Platform (`docs/development/CAPABILITY_PLATFORM_CLOSURE.md`) and Registry writes (`docs/development/REGISTRY_WRITES_CLOSURE.md`).

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
| `GET /registry` | Every field an edit surface needs: Agent Definitions (incl. instructions and policies), Capabilities with their Tool Bindings (`kind`, `version`, `trustLevel`, internal function name), Capability Grants (incl. `scope`, `revokedAt`), Task Definitions (`kind`, whether a plan is registered, schemas, context budget), Workflow Definitions. **Binding `config` is never returned.** | `tests/api/registryRoutes.test.ts` |
| `POST /capabilities`, `/tool-bindings`, `/agent-definitions`, `/task-definitions`, `/workflow-definitions`, `/capability-grants` | Create one row and its event in one transaction (§5.1). 201 `{id, name, version}`; a refused write is 400 or 409; a transient conflict 503. | `tests/api/registryWrites.test.ts` |
| `POST /capability-grants/:id/revoke` | `revokeCapabilityGrant` commits first: the Grant is revoked and pending Approvals no surviving Grant covers are closed as `expired`. Then each affected Workflow Run is re-driven, which releases the hold and fails the step. Re-drive failures are reported per Workflow Run beside the committed revocation (the TTL sweep also settles them). A transient conflict on the revocation is a 503, not retried. Actor: the server-side operator constant. Idempotent. | same |

Revocation expires candidate Approvals in `(runId, approvalId)` order, so concurrent revocations take the per-Run event locks in one order (PHASE8_CLOSURE Risk 3, which this route made reachable). Like that record's lock-ordering fix, this rests on reasoning, not a test: nothing forces two transactions to interleave at the lock.

### 5.1 Registry writes (`src/definitions/registryWrites.ts`)

| Rule | Detail | Test |
|---|---|---|
| **Nothing is updated.** | An edit is a new row: same `name` (the logical identity), `version = latest + 1`. Grants, Runs and graph steps pin `(id, version)`, so older versions keep working. There is no update or delete route. | `registryWrites.test.ts` (versioning) |
| **Versioning is explicit.** | The caller names `previousVersion`. Omitted, the name must be new; given, it must equal the latest version; otherwise 409. A name collision never becomes a version, and two concurrent edits cannot both win. | same; mutation-checked |
| **Allocation is locked per name.** | `pg_advisory_xact_lock(20260914, hashtext('registry:<table>:<name>'))`, a lock class of its own (the executor holds `(20260912, 1)` for its life). Tool Binding versions are also backed by the unique `(capability_id, version)` index. | same (the test holds the lock and the write waits); mutation-checked |
| **Tool Binding: checked with resolution's own check.** | `adapterFor`: a kind with an adapter (`internal`), a registered function, of this Capability. Trust level 0–2 (`mapTrustLevel`'s three categories). Config is neither echoed nor put in the event. A new version is selected from the next resolution on; an Approval pending across it fails closed on resume (§2 "Deterministic"). | same; mutation-checked |
| **Task Definition.** | `kind` has a registered plan; a supplied `defaultContextBudget` is complete. A plan's own parameter requirements are still checked when it runs. | same |
| **Workflow Definition.** | A valid linear graph; every step binds an existing Agent version and an existing Task Definition version whose kind has a plan. | same; mutation-checked |
| **Capability.** | Unique name, because resolution requires exactly one; `staticRiskTag` from the risk tier order. | same |
| **A Grant only for an Agent version not yet in use.** | Spec §9.2: "A Grant is static, versioned alongside its Agent Definition — changing authorization is a new Agent Definition version, never a silent runtime mutation." A version bound by a Run or named by a Workflow Definition gets no new Grant (409); the edit is a new Agent version, its Grants, then a new Workflow version naming it. Revocation (§9.7) stays available on any version. The Grant create locks the Agent row (`FOR NO KEY UPDATE`) and a Workflow create share-locks its step Agents, so a graph cannot start naming a version while a Grant is added to it. | same; mutation-checked |
| **Capability Grant.** | Omitted `autonomyState` is `ALWAYS_APPROVE` (§9.4 default). `validateCapabilityGrant` (the §9.4 autonomy ceiling); the Agent version and Capability exist; distinct known permissions; **no `scope`** (stored but never evaluated, so a scoped Grant would promise a restriction nothing enforces); **no unrevoked Grant on the same Agent version and Capability sharing a permission** (409), because `resolveCapabilityGrant` would pick between them arbitrarily. | same; mutation-checked |
| **Autonomy changes are individual, versioned acts.** | For an Agent version in use, a new Agent version with the new Grant (§9.2, §9.4 "explicit, logged human edit"). Before first use, revoke and create. One Grant per request; a new Agent version inherits no Grants. | same |
| **Uniqueness in the database.** | Migration `0014`: unique `(name, version)` on Agent, Task and Workflow Definitions and unique `capabilities.name`, so the invariant holds for every writer, not only the locked routes. A concurrent violation is a 409. | `registryWrites.test.ts` |
| **Seed defaults follow versions.** | `POST /goals` without ids runs the latest "Research-and-Publish" version; versioning a seeded name no longer makes the seed lookup ambiguous. | same (found by review, H1) |
| **Audited.** | `definition_version_created` (`definitionType`, `id`, `name`, `version`; a Tool Binding's also `capabilityId`, `kind`, `function`, `trustLevel`, never config) and `capability_granted` (spec §8.2), in the write's transaction, actor `human:operator`, then relayed live. | same |
| **§18.3 without SQL.** | A Capability, binding, Agent, Grant, Task Definition and Workflow created only through these routes run end to end through `POST /goals`. | same |

Not built: a Policies editor (no `policies` table; ROADMAP_STATUS §6), Grant `scope` (undefined semantics), and per-function config validation at write time (a binding whose config its function rejects fails closed when it runs).

## 6. Binding config isolation (spec §9.6)

A binding's `config` reaches its adapter's `prepare` and `execute` and nothing else: no event, Invocation, Artifact, Run or Task Instance record contains it (`tests/capabilities/bindingConfigIsolation.test.ts`), no model context (CONTEXT_COMPILER §1), no registry response (§5). There is no credential-reference mechanism yet; it waits for the first `direct_api` binding, which is itself a provider/credential decision.

## 7. Seed defaults

`POST /goals` without `workflowDefinitionId`/`projectId` uses the seed's (`src/definitions/lookupSeed.ts`). That lookup no longer resolves Tool Bindings: a Capability with several bindings is a legitimate state, and it made the default goal route fail once a second binding existed (found by the registry route test, confirmed by mutation).

## 8. Residuals

- **Corpus containment race.** A file swapped for a link between its `realpath` check and the read could still be followed. It needs write access to the corpus itself.
- **Corpus root read at execute time.** `RESEARCH_CORPUS_ROOT` is read when the tool runs, not when it is proposed. Prepared inputs are never compared on resume, so reading it earlier would not change what an approval pins. Only relevant if a READ Grant ever requires approval.
- **Migration 0012 fixes Agent versions at 1.** It binds only when exactly one `Researcher` v1 and `Publisher` v1 exist and the graph's steps are the seeded Task Definitions in order. Otherwise the graph is left unbound and its steps fail closed ("binds no Agent Definition").
- **Unique binding versions are assumed.** Migration 0013 fails on a database that already has two bindings with the same `(capability, version)`. The seed never creates one.
- **Unique Definition versions and Capability names are assumed.** Migration 0014 likewise fails on a database holding a duplicate `(name, version)` or Capability name. The seed never creates one; hand-inserted duplicates must be resolved first.
- **A Grant create reads Workflow graphs by JSON containment** (`graph_definition->'steps' @> …`), a sequential scan over Workflow Definitions. Fine at operator scale.

**Decision boundary:** a real external search binding for `research.retrieve` needs a provider choice, credentials and spend authorization. Nothing here selects one.
