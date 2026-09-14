# Registry Writes: Closure

**Started:** 2026-09-14, after the Capability Platform closed.
**Status:** closed. Local commits on `main`, none pushed.
**Roadmap stage:** V1.1 Registry, API half (spec §15.1 screen 6). The Registry UI belongs to the UI workstream.
**Authoritative write-up:** [`docs/architecture/CAPABILITY_PLATFORM.md`](../architecture/CAPABILITY_PLATFORM.md) §5.1.

No live model invocations, no paid services. One migration (0014, unique indexes). Every dispatch-capable test mocks all three provider adapters.

## Why this was the next milestone

The §18.3 acceptance test added a Capability with direct inserts: an operator had no path but SQL to extend or edit the system. Spec §15.1 screen 6 specifies the Registry as the versioned edit surface and the place autonomy changes happen, and it needs no decision the user has not made. Memory, variable passing and branching are gated by the roadmap on concrete evidence, and autonomy promotion on `agent_performance` and a threshold (`ROADMAP_STATUS.md` §5a).

## What changed

| Change | Where |
|---|---|
| Versioned, explicit, locked creates of Capabilities, Tool Bindings, Agent/Task/Workflow Definitions and Capability Grants; nothing updated | `src/definitions/registryWrites.ts` |
| Six `POST` routes; `GET /registry` returns every field an edit surface needs (still never binding config) | `src/api/routes/registry.ts` |
| `adapterFor` exported as the write-time binding check, so write and resolution cannot disagree | `src/capabilities/toolAdapters.ts` |
| `definition_version_created` and `capability_granted` events (spec §8.2 note) | same transaction as each write |
| Tests, including a workflow built only through the API running end to end | `tests/api/registryWrites.test.ts` |
| Root `CLAUDE.md`: tool code resolved from bindings, Registry writes, "core names no capability" invariant; `.env.example`: corpus reparse points | carried from Capability Platform review #7 |

## Decisions made

- **Logical identity is `name`; a version is a new row.** Grants, Runs and graph steps already pin `(id, version)`, and ids are row primary keys, so this is the only versioning the schema allows without a migration.
- **`previousVersion` is required to version.** Without it a name collision would silently become a new version of someone else's Definition, and concurrent edits would both succeed.
- **Advisory lock per name, backed by unique indexes** (migration 0014, after review M1). The lock gives a clear 409 before any insert; the indexes hold the invariant for every writer.
- **Grants only on an Agent version not yet in use** (spec §9.2, found by review L1). Authorization of anything a Run or Workflow already references never changes except by revocation. An operator edits authority by creating the next Agent version, its Grants, then the next Workflow version.
- **A new Agent version inherits no Grants.** Authority is granted to a version explicitly (spec §9.2); copying would promote a changed Agent without a human act.
- **One Grant per request; no bulk path.** Spec §9.4 and `NEXT_PHASE_PLAN.md` §6 rule out bulk promotion.
- **Grant `scope` is refused.** It is stored but never evaluated (ROADMAP_STATUS §6); accepting one would promise a restriction nothing enforces.
- **Overlapping unrevoked Grants are refused.** `resolveCapabilityGrant` picks the first match, so two Grants covering one permission with different autonomy would make authorization arbitrary. The route made that state reachable without SQL.
- **Not built:** a Policies editor (no `policies` table, a user decision), per-function config validation at write time (a rejected config still fails closed when the binding runs), NSSM service wrapping (deployment).

## Adversarial review (independent, Opus)

Targets: bypassing the autonomy ceiling or overlap check, cross-capability functions, pending approvals across a new binding, version races, mutation paths, lock deadlocks, config leakage, malformed bodies. No Critical findings. Checked and fine: permission matching (no type-juggling or case variants), overlap vs. concurrent revocation (fails closed either way), resume after a new binding (`resume_spec_mismatch`), lock ordering (no cycle), no update path, config never leaks.

| Finding | Disposition |
|---|---|
| H1: versioning a seeded name (e.g. "Researcher") made default `POST /goals` and `npm run seed` fail as ambiguous | **Fixed**: the seed lookup resolves the latest version per name; regression test; mutation-checked |
| M1: no database uniqueness for `(name, version)` or capability names | **Fixed**: migration 0014 unique indexes; the 0012 test drops the Agent index inside its rolled-back transaction to build its pre-0014 ambiguous case |
| M2: the Tool Binding event omitted what governs it | **Fixed**: `capabilityId`, `kind`, `function`, `trustLevel` (never config); test |
| M3: out-of-int4 or fractional versions reached SQL (500) | **Fixed**: bounded integers for every version field incl. graph steps (400); test |
| L1: spec §9.2 "changing authorization is a new Agent Definition version" contradicted granting on an in-use version | **Fixed, spec wins**: Grants only for an Agent version bound by no Run and named by no Workflow Definition (409); Agent row lock vs. Workflow share lock; spec §9.2 note; test; mutation-checked |
| L2: §9.4 "new Grant defaults to ALWAYS_APPROVE", but the field was required | **Fixed**: omitted means `ALWAYS_APPROVE`; test |
| L3: some writes pass but fail when run (a `research_report` Task Definition without a budget, budget value ranges, `publish_report` parameters, binding config beyond `function`) | **Documented** (`CAPABILITY_PLATFORM.md` §5.1 "Not built"): plan- and function-specific checks live with the plan or function and still fail closed at run time; adding write-time hooks is warranted when a real misconfiguration occurs |
| L4: untrimmed names became distinct identities | **Fixed**: leading/trailing whitespace refused; test |
| L5: unbounded graph size | **Fixed**: at most 100 steps |

## Mutation checks

Each mutant was applied to `src/definitions/registryWrites.ts`, `tests/api/registryWrites.test.ts` run, and the source restored and compared.

| Mutant | Result |
|---|---|
| M1 no advisory lock | 2 fail (after adding the held-lock test; the concurrency test alone passed by timing) |
| M2 no overlapping-Grant check | 1 fails |
| M3 no autonomy ceiling check | 1 fails |
| M4 no adapter check on bindings | 1 fails |
| M5 re-create without `previousVersion` allowed | 3 fail |
| M6 Grant `scope` accepted | 1 fails |
| M7 unbound workflow step accepted | 1 fails (a first, equivalent mutant was discarded) |
| M8 Grant allowed on an in-use Agent version | 2 fail |
| M9 seed lookup does not resolve the latest version | 2 fail |

Not testable, argued: the Agent row lock between a Grant create and a Workflow create (nothing forces the two transactions to interleave at the lock), as with earlier lock-order fixes.

## Verification

- Backend `tsc --noEmit`: clean. Backend suite: 56 files, 718 passed, 2 skipped (the gated live-CLI smoke tests).
- Web `tsc --noEmit`: clean. Web suite: 6 files, 33 passed. API changes are additive; the UI was not modified.
- `git diff --check`: clean.
- Three existing tests that deliberately build now-unrepresentable duplicates (migration 0011 and 0012 replays, the ambiguous-capability resolution case) drop the relevant 0014 index inside their rolled-back transaction; no test was removed.

## Decisions required (user)

Unchanged by this milestone: see `docs/roadmap/ROADMAP_STATUS.md` §6, and the external search provider for `research.retrieve` (`CAPABILITY_PLATFORM_CLOSURE.md`).
