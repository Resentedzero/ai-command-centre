# Capability Platform: Closure

**Started:** 2026-09-14, after the roadmap reconciliation (`docs/roadmap/ROADMAP_STATUS.md`).
**Status:** closed. Local commits on `main`, none pushed.
**Roadmap stage:** the V1 success criterion (spec §18.3), now met, and the runtime half of V1.1's Registry.
**Authoritative write-up:** [`docs/architecture/CAPABILITY_PLATFORM.md`](../architecture/CAPABILITY_PLATFORM.md).

No live Claude invocations and no paid services. Every dispatch-capable test mocks all three provider adapters.

## Why this was the next phase

Spec §18.3 makes V1 successful only if adding a third Capability, Task Definition or Agent Definition needs "no changes to core execution semantics, authorization semantics, the event schema, or the UI architecture". A code-to-spec gap map found it failed. A Tool Binding row never selected the code that ran: builders imported implementations. A hard-coded dispatcher knew only the two seeded Task Definitions. The API routes and startup were wired to the one seeded workflow.

## What changed

| # | Change | Commit |
|---|---|---|
| 0 | Roadmap reconciliation: phase labels mapped to V1–V6; Context Compiler phase closed (§5.16 follow-up) | `7061dcb` |
| A | **Tool Adapter registry.** Code is resolved from the persisted Tool Binding row: highest version wins, no fallback, adapters declare cost, `prepare` in the builder transaction, `execute` with none. Migration 0011 names the functions on seeded bindings. | `14c8f27` |
| B | **Local-corpus `research.retrieve` binding.** Switching the Capability from the synthetic stub is one binding row. Free local read; output fenced as untrusted. | `d53df9a` |
| C | **Definition-driven step planning.** Graph steps bind their Agent and parameters; Task Definition `kind` selects a registered plan; the dispatcher is removed; routes, the TTL sweep and startup need no seed. `POST /goals` takes optional `workflowDefinitionId`/`projectId`. Migration 0012. | `4c251b3` |
| D | **Binding config isolation.** Config reaches only its adapter. | `4c251b3` |
| E | **Registry control plane.** `GET /registry`, and `POST /capability-grants/:id/revoke` (commit, then re-drive). | `4c251b3` |
| R | **Adversarial review fixes.** Immutable bindings in the database (migration 0013); functions tied to their Capability; corpus containment, bounds and resilience; deferred tool position; migration 0012 guards; single-transaction goal creation. | `4c251b3` |

## Decisions made

- **No fallback between bindings.** An unexecutable newest binding fails closed rather than silently running an older one (the user's "no silent fallback" principle, applied to tools).
- **Selection is not Policy (§3c).** A newest binding below a Grant's trust bar is selected and then DENYed.
- **The Workflow graph binds the Agent (§3b, §18.3 "Workflow composition").** Binding authorizes nothing; Grants still govern.
- **The binding, not the Capability, declares cost class and estimate.** Both seeded bindings keep their V1 values unchanged (the synthetic stub still reserves 0.01 USD); the corpus binding reserves 0.
- **Binding rows are immutable; a change is a new version.** Enforced by trigger; `trust_level` stays updatable because it is re-read before every effect.
- **Migrations 0012/0013 update seeded Definition rows in place** rather than versioning them, because they only make explicit what the removed dispatcher did.
- **Revocation re-drives after commit**, per `revokeCapabilityGrant`'s contract. A transient conflict is a 503, not retried.
- **Not built:** Definition/Grant/binding write routes, a Policies editor, a credential-reference mechanism, any `direct_api`/`mcp`/`browser` adapter.

## Adversarial review (independent, Opus)

Targets: determinism vs. resume, authorization through graph data, the execute closure, mutable registries, corpus containment on Windows and POSIX, migrations, `POST /goals`. No Critical or High findings.

| Finding | Disposition |
|---|---|
| 1 Medium: a second binding broke default `POST /goals` and `npm run seed` | **Fixed** (also found independently by the registry route test); regression test; mutation-checked |
| 2 Medium: one unreadable corpus file failed the whole step | **Fixed**; test; mutation-checked |
| 3 Medium: binding immutability unenforced; ties in selection | **Fixed**: migration 0013 trigger + unique `(capability_id, version)`; test |
| 4 Low-Medium: an adapter function not tied to its Capability | **Fixed**; test; mutation-checked |
| 5 Low: containment weaker than documented; filesystem-root edge | **Fixed** (`realpath` root and per-file check, root-safe prefix); residual race documented |
| 6 Low: unbounded directory walk | **Fixed** (`MAX_ENTRIES`, index-based queue) |
| 7 Low: Windows reparse points skipped | **Documented** (`CAPABILITY_PLATFORM.md` §3) |
| 8 Low: corpus root read at execute time | **Not changed**, documented: prepared inputs are not compared on resume, so moving the read changes nothing an approval pins |
| 9 Low: re-drive re-resolves an already-run tool's binding | **Fixed**: tool position deferred |
| 10 Low: migration 0012 edge cases | **Fixed**: step-order and both-steps guards, `jsonb_set` merge; Agent v1 assumption documented; test; mutation-checked |
| 11 Low: validation and creation in two transactions | **Fixed**: one transaction |

## Mutation checks

Each mutant was applied, its suite run, and the source restored from a backup.

| Mutant | Result |
|---|---|
| M1 fall back past an unexecutable newest binding | 2 tests fail |
| M2 oldest binding wins | 2 fail |
| M3 corpus binding declared metered | 1 fails |
| M4 host path in corpus results | 2 fail |
| M5 step builder does not bind the Agent | 2 fail |
| M6 no-Agent check removed | 1 fails |
| M7 core code names a capability | 1 fails (structural) |
| M8 revoke does not re-drive | 1 fails |
| M9 registry exposes binding config | 1 fails |
| M10 seed lookup refuses a second binding again | 1 fails |
| M11 function not tied to its Capability | 1 fails |
| M12 one unreadable file fails the search | 1 fails |
| M13 migration 0012 ignores step order | 1 fails |

Not testable, argued: the revocation lock order (nothing forces two transactions to interleave at the lock), as with PHASE8_CLOSURE's own lock-order fix.

## Verification (at `4c251b3`)

- Backend `tsc --noEmit`: clean. Backend suite: 55 files, 706 passed, 2 skipped (the gated live-CLI smoke tests).
- Web `tsc --noEmit`: clean. Web suite: 6 files, 33 passed. The API changes are additive; the UI was not modified (a separate workstream).
- `git diff --check`: clean.

## Decisions required (user)

- **A real external search provider for `research.retrieve`.** Provider choice, credentials and spend authorization. Everything short of it is built: a new `direct_api` binding row plus its adapter would replace the local ones.
- Carried: see `docs/roadmap/ROADMAP_STATUS.md` §6.
