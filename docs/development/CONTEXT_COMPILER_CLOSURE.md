# Context Compiler hardening: Closure

**Started:** 2026-09-14, after the execution recovery milestone ([`EXECUTION_RECOVERY_CLOSURE.md`](EXECUTION_RECOVERY_CLOSURE.md)).
**Status:** closed. Local commits on `main`, none pushed. §5.16 usage measurement is follow-up work for the V2/V4 measurement stage, not a blocker (`docs/roadmap/ROADMAP_STATUS.md` §4).
**Authoritative write-up:** [`docs/architecture/CONTEXT_COMPILER.md`](../architecture/CONTEXT_COMPILER.md).

No live Claude invocations. Every dispatch-capable test mocks all three provider adapters.

## What changed

1. **Grant-scoped tool schemas (spec §5.7, §5.18).** Before, the `"unauthorized"` exclusion could never happen: any capability id a caller passed was compiled. Now a tool schema is eligible only if the Run's Agent Definition version holds an unrevoked Grant for its capability, with at least one permission.
2. **Minimal tool schema variant (§5.7).** Tool Binding `config` was previously placed in `toolSchemas` and counted in the budget. It no longer enters context.
3. **Content-hash dedup (§5.10).** Two artifact ids with the same hash: the later one is excluded as `duplicate`.
4. **Provenance depth (§5.13).** Each included entry records `kind`, `trusted`, `estimatedTokens`, and for artifacts `version` and `hash`. These flow into `context_compiled`.
5. **`untrustedDataFenced`** is now derived from provenance. A trusted artifact containing fence-like text used to set it.
6. **Invocation instruction layer (§5.14 layer 7).** The Compiler builds the intent and expected-output-shape instruction, and counts it as required context. The adapters render that layer last. Before, each adapter appended its own uncounted `Respond with JSON` suffix, so the real prompt could exceed the recorded estimate.
7. **Determinism** is pinned by a test.

## Decisions

- **Fail closed.** No `runId`, or a Run with no bound Agent: every tool schema is excluded `unauthorized`.
- **A `runId` of a different Task Instance throws.** Otherwise one Run could borrow another Agent's Grants and instructions.
- **Schema eligibility needs any permission, not a specific one.** A schema describes a tool rather than using it. Every use is still authorized through Policy at execution.
- **All bindings of a granted capability are listed.** The Grant's trust bar is enforced by Policy at execution, not at compilation (CONTEXT_COMPILER §3.3).
- **Provenance `estimatedTokens` is what the entry added to the prompt**, framing included. The first untrusted artifact also carries the untrusted-data policy's cost. Provenance total + instructions + invocation instruction = `estimatedInputTokens` (tested).
- **Adapter signatures unchanged.** The API adapters keep `_expectedOutputShape`, so the router interface and arity tests are stable. The Claude CLI still passes `--json-schema`; only the stdin text changed (mock-tested; argv, which was live-verified, is unchanged).
- **Random fence tag kept.** See decisions required.

## Mutation checks

Each mutant was applied, the named suite run, and the source restored from a backup.

| Mutant | Result |
|---|---|
| M1 Grant check fails open | 3 compiler tests fail |
| M2 binding `config` re-added to schema entries | 3 fail |
| M3 hash dedup disabled | 1 fails |
| M4 Run/Task Instance mismatch check disabled | 1 fails |
| M5 invocation instruction not budgeted | 3 fail |
| M6 invocation instruction not rendered by `promptBuilder` | 4 router tests fail |
| M7 `untrustedDataFenced` back to the fence-text regex | 1 executor test fails |

## Verification (at the final commit)

- Backend `tsc --noEmit`: clean. Backend suite: 44 files, 668 passed, 2 skipped.
- Web `tsc --noEmit`: clean. Web suite: 6 files, 33 passed (the richer `context_compiled.included` entries are a superset of the web type).
- `git diff --check`: clean.

## Decisions required (user)

- **Stable cacheable prefix vs. the unguessable fence tag** (CONTEXT_COMPILER §3.1). Needed when prompt caching is built.
- **Reference mode without a summary** needs on-demand retrieval before it can be honest (§3.2).

## Commits

| Commit | What |
|---|---|
| `52603fa` | Grant-scoped minimal tool schemas, hash dedup, richer provenance, `untrustedDataFenced` fix, CONTEXT_COMPILER.md |
| `78ee3c9` | Invocation instruction layer, budgeted |
| (this commit) | Provenance-based `untrustedDataFenced` + regression test, determinism test, this record |
