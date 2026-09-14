# Third Audit Round: Test Integrity and Uncovered Spec Surfaces

**Started:** 2026-09-14, after the routing record milestone.
**Status:** closed. Local commits on `main`, none pushed.
**Roadmap stage:** V1 conformance. No new capability, infrastructure, migration or live model call.

Two independent read-only audits (Opus). The first asked, for each test that claims a security or governance invariant, which plausible one-line regression it would fail to catch; earlier reviews had found three tests passing for the wrong reason. The second covered what the first two rounds had not: Phase 20 mitigations, Phase 2/4/6 mechanisms, §9.6 handling rules, §17 artifacts and the closure residual lists.

## 1. Spec surfaces

| Finding | Outcome |
|---|---|
| Failure-text redaction matched only `sk-ant-`/`sk-proj-`; OpenAI service-account, admin and legacy keys and bearer tokens could reach the immutable log (§9.8 note) | **Fixed**: every `sk-` key shape of 16+ characters and `Bearer` tokens; one case per shape, and a word containing `sk-` is left alone |
| No backup or restore procedure (Phase 20 #5: only a restored backup is a mitigation) | **Built as an operator procedure** (`ROADMAP_STATUS.md` §7), run end to end against the local database: dump, restore into a scratch database, event count and both immutability triggers match, scratch dropped |
| No CI (§17.1) | **Decision** (§6): new infrastructure that only runs on push, and "lint" needs a linter chosen |
| "Elevated (Class 4) tier" for an unverified binding is undefined (Phase 6) | **Decision** (§6): only the recorded `riskTier` would change; Policy already requires approval |

Checked and conformant: the Phase 20 mechanisms that name one, Phase 2 prohibitions (no pgvector, Temporal, Langfuse, Redis or Docker; loopback-only API; new Grants default to `ALWAYS_APPROVE`), the §13.5 dependency list, Phase 6 trust rules (Policy is stricter than the spec), §9.6 key locations and generic 5xx bodies, and the earlier closure residuals.

## 2. Test integrity

| # | Weakness | Fix | Mutant |
|---|---|---|---|
| 1 | A provider call or tool effect moved inside the pre-dispatch check's callback passed every test: the structural test only rejected `runInTx`/`transaction`, and the check takes no lock the probe sees | The mocked provider and `execute` assert no pool connection is checked out; the structural test rejects either call inside any callback | M1, M1b caught |
| 2 | The pre-dispatch stop re-check was tested at one scope only | Parametrized: global, goal, workflow_run and run before a model call; also agent_definition and capability_grant before a tool effect | M2a (goal), M2b (agent), M2c (Grant stops skipped) caught |
| 3 | A failed stop lookup could be settled as a durable step failure with nothing noticing (`isSettleableStepFailure`) | Test: a lookup failure during `advanceWorkflowRun` propagates with `lookupFailed` | M3 caught |
| 4 | READ COMMITTED was pinned only for the test pool | Test: the pool `src/db/client.ts` builds opens READ COMMITTED transactions (a server default change fails it too; an isolation option inside `DATABASE_URL` itself would not) | M4 caught |
| 5 | "A budget refusal does not fall back" could not detect a fallback, since both tiers share one estimate | Pass-through spy: exactly one reservation attempt | M5 caught |
| 6 | The Grant-scope stop lookup's fail-closed path was untested | Broken-transaction test expecting `lookupFailed` | M6 caught |
| 7 | Structural checks a small edit evaded: `reserveBudget` options through a variable or alias; `executeRun` under an import alias; raw `budget_counters` SQL in a capability; `tx.update(schema.runs)`; line comments satisfying the containment scan | Parsed arity (exactly six, no spread, no aliased import); alias and namespace patterns; snake_case name; property-access tables; line comments stripped | P1, P1b, P2, P3, P4 caught (probe files, deleted after) |
| 8 | "Lifting a stop never bypasses the budget" never engaged or lifted a stop | Engages and lifts a global stop first | n/a |

Left as they are (each is backed by a stronger test the audit named): the quota test's "no fallback" check where every provider refuses (`candidateRouting.test.ts` covers fallback), the Phase 7e API check with both counters drained, the not-called checks after a plain `executeRun` in `executionStop.test.ts` (the `failed` status carries them), and the revocation interleaving test's documented limit.

## 3. Verification

- Backend `tsc --noEmit`: exit 0. Backend suite: 65 files, 795 passed, 2 skipped (the gated live-CLI smoke tests). Web: not changed.
- 14 mutants and probes, each applied, run against its tests, and restored byte-for-byte (probes deleted); all caught.
- No test removed; existing assertions changed only where parametrized (stop scope) or strengthened.
