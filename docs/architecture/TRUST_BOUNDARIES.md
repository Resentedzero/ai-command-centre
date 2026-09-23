# Trust boundaries: what is authoritative, what is presentation, what is a guess

The acceptance record for R2 Stage 14 (security), Stage 15 (progression integrity) and Stage 16 (token
accounting). Every claim here was checked against the code on 2026-09-18, and the tests named are real
tests that fail if the claim stops being true.

## 0. Who the adversary is

The API binds loopback and has **no authentication** (`src/api/requestGuards.ts`) — one local operator, by
design. So the operator is root: every `POST /workplace/*`, `/quality-verdicts`, `/approvals/*`,
`/execution-stops` write is authoritative *because* the operator made it, and direct database access is
outside the model entirely. The adversaries this document is about are:

- **the model** — any LLM output: a worker's decisions, a Manager's plan, a meeting contribution, a Keeper
  answer;
- **injected content** riding inside artifacts, research results, handoffs, tool results, meeting agendas;
- **another origin** in the browser (CSRF / DNS rebinding), closed by `refuseRequest`
  (`tests/api/requestGuards.test.ts`).

## 1. The four kinds of fact

| Kind | Meaning | Examples |
|---|---|---|
| **Authoritative** | Written by code, in Postgres, and recorded as an immutable Event | run/workflow/goal status, Grants, budget counters, stops, approvals, artifacts and their hashes, meeting rows, quality verdicts |
| **Code-written record** | Produced by a deterministic Invocation from a validated model proposal, hash-checked before use | the Manager's plan record, the meeting outcome record |
| **Model-generated** | An LLM wrote it. Never authority, always attributed, fenced wherever it re-enters a prompt | deliverable prose, plan briefs, meeting notes and decisions, Keeper answers |
| **Presentation** | Derived for display and never read back as truth | meeting status, agent state, organisational history, operational notices, the living world, progression |

Rule of thumb: **anything a model wrote is data.** It may be stored, shown and attributed. It may never be
an instruction, an authorization, or evidence of itself.

## 2. Structural guarantees (no check can be bypassed because there is no code path)

- **Events and artifacts are immutable in the database**, not by convention: `BEFORE UPDATE OR DELETE` and
  `BEFORE TRUNCATE` triggers raise (`drizzle/0016_events_immutability.sql`, `drizzle/0019_artifacts_immutability.sql`).
  Tool bindings are immutable on `capability_id/kind/config/version` (`drizzle/0013`).
- **`emitEvent` is the only event writer.** It takes a transaction handle at the type level, sets
  `sequenceNo` and `occurredAt` server-side under an advisory lock, and is idempotent on
  `idempotencyKey`. No model-controlled string is ever part of an idempotency key.
- **`actor` is never read from a request body.** It is a server-side constant at every write site. A
  body-supplied `resolvedBy` was removed from approvals for exactly this reason.
- **Progression tables have one writer** (`refreshAgentProgression`), which deletes and rebuilds all four
  every pass. There is no write API. Governance, routing, execution, workflow and context may not even
  import them (`tests/execution/structuralInvariants.test.ts`).
- **The Manager cannot reach authority**: it imports no governance, routing, provider, projection, API or
  world module, and writes no runtime or authority table.
- **The Keeper cannot write at all**: its explainers run in a Postgres `READ ONLY` transaction.
- **Appearance, role icons and the workplace are isolated** from grants, policy, budgets, routing and
  progression by structural invariant. An icon grants nothing; a calendar row changes no authority.

## 3. Where model output is fenced, and why that is the whole ballgame

Untrusted content reaches `layers.artifacts` and — since the fix below — `layers.invocationInstruction`.
In both it is wrapped in `<untrusted_data_<random>>` with a tag
that is regenerated per compilation — content written earlier cannot know the suffix, so it cannot close
its own fence — and any literal fence-like tag inside it is neutralised. Whenever a fenced block is
present, `layers.constraints` carries the untrusted-data policy.

**R2 Stage 14 found one hole in this and closed it.** The Manager's delegated `brief` and
`completionCriteria` are model output, and their words can have arrived inside a fence the Manager was
reading. They were being rendered verbatim into the worker's `invocationInstruction` — the runtime's own
voice, last in the user message. `validateTasks` bounds their length and validates everything *around*
them (the agent exists, is not the Manager, is not stopped; every tool is backed by a live Grant) but
never their prose. So injected text could leave one fence and re-enter another agent's instruction
channel as if the Keep had written it.

It never granted anything — `validateTasks` re-runs against the live database at delegation time, so no
laundered text could add a tool, an agent, a Grant, a budget, an approval, or lift a stop, and evidence
remained code-verified. What it could do was steer an already-granted tool and rewrite the worker's finish
condition. That is enough.

The fix is `CompileContextInput.untrustedDirective` (`src/context/compiler.ts`, `fenceDelegated`): model
text for the instruction layer gets the same fence, the same random tag and the same policy as an
untrusted artifact, and the trusted directive only *points* at it. Regression:
`tests/api/manager.test.ts`, "plans, validates, delegates…" now asserts the brief appears inside the fence
and **not** outside it.

**A fence is a prompt-level mitigation, not a structural one.** A model may still comply with text inside
one. Everything that must not depend on the model's judgement — Grants, budgets, approvals, stops,
evidence, hashes — is enforced in code outside the prompt. The fence is the last layer, not the first.

## 4. What verification rejects, and what happens when it fails

Every one of these fails **closed**: the effect does not happen, and the refusal is recorded with its real
reason.

| Boundary | Check | On failure |
|---|---|---|
| Capability Grant | exact permission, `revokedAt IS NULL`, re-evaluated immediately before the effect | `policy_denied_before_dispatch`; a revoked Grant also cancels a pending Approval and releases its hold |
| Emergency stop | checked before every Invocation, including free and deterministic ones | throws; never authorizes |
| Approval | the exact `proposedActionSnapshot` is frozen; resume re-authorizes **and** re-reserves budget independently | `resume_spec_mismatch` / `reauthorization_failed` |
| Budget | counter row locked; a missing row is a zero limit | `budget_denied` naming the exact refusing counter |
| Unknown tool / capability | exactly one capability must match; no fallback to an older binding | throws at save time, not at run time |
| Unknown or self agent | `validateTasks`, re-checked at delegation | plan refused with the reason |
| Code-written record | `sha256` recomputed against the stored hash; producing invocation must be `deterministic`; producing Task kind must be in `RECORD_WRITING_KINDS` | refused — a model-written artifact claiming to be a plan is not a plan |
| Evidence | every cited id re-read from `artifacts`; must be a completed tool result of *this* Run's ledger, or a handed input whose recorded basis shows evidence | cited ids land in `rejected[]`, never laundered |
| Endorsement | proven three times (at `prove`, at `prepare`, and again from records in the projection): same hash, in the endorser's compiled context, produced by a **different** persistent name | not counted; `same_lineage` / `hash_mismatch` / `duplicate` recorded |
| Meeting attendance | each participant re-checked for existence and availability before any model call | meeting recorded as **not held**, with the reason; no contribution is invented |
| Quality verdict | only the operator's route emits it; the projection accepts only a `human:%` actor | a verdict-shaped event nobody human wrote is ignored |

## 5. Progression: nothing a model says is worth anything

XP, achievements, specialisation and endorsements are rebuilt from records every pass. Work XP is earned
only by Runs that are **performance success samples** — the same rule `agent_performance` uses — so a Run
stopped at its limit, refused by budget or Policy, or halted by an operator earns nothing. Approvals,
notifications, appearance, role icons, versions, names and tokens earn nothing. Peer endorsement is worth
**zero** by design. Progression changes no Grant, permission, policy, budget, route or capability.

**R2 Stage 15 found one real leak and closed it.** A meeting convenes as a Workflow Run with one Run per
participant. Those Runs are non-loop, so they satisfied the success-sample rule, so each attendee was
earning task XP (100) plus the meeting's Workflow Run (250) plus its Goal (500) — **~850 XP each per
meeting**, and the Manager schedules meetings autonomously, so it could mint progression for the whole Keep
by calling an all-hands. Model output turning directly into progression.

Fixed by declaring `meeting_contribution` and `meeting_outcome` in `src/capabilities/progressionFacts.ts`
as Task kinds that are attendance rather than work; the projector filters those Runs out of `successes`
entirely, so no rule can pay for them. Regression: `tests/api/meetings.test.ts`, "earns nobody anything"
(verified to fail without the fix, with 9 awards minted). The kind strings are pinned to their constants by
`tests/capabilities/progressionFacts.test.ts`.

**Two judgements, stated rather than left silent.** The Manager's own plan, review and recovery Runs are
**not** excluded: deciding and reviewing is that agent's work. Neither are `agent_talk` and the Keeper's
answer, so a completed operator request earns its 100 task XP like any other completed Run. Both are
choices, not oversights, and `tests/capabilities/progressionFacts.test.ts` pins them so they stay visible.
Excluding either is a one-line change to `NOT_WORK_TASK_KINDS` if the operator decides otherwise.

**Known semantic limitation.** A loop that concludes `complete` counts as a success whether it ended
`evidence_sufficient` or merely `agent_finished`, and `evidence_sufficient` accepts a handed deliverable
whose basis came from a *fixture* binding. So `evidence_sufficient` means "the code verified the citation
points at recorded evidence", **not** "externally verified". The `verified_research` achievement does
exclude fixtures; `validated_artifact` does not.

## 6. Token accounting: five different things, kept apart

Never combined into one number. `RESOURCE_UNITS` is checked at the reservation id, at emit, at reconcile,
in the projection, in the read API and in the UI. Nothing sums or converts USD, `subscription_tokens` and
`local_tokens`.

**One module was outside that enforcement and has been fixed (R2 Task 42).** `tokenReport.ts` computed
`cost_amount - tokens_in - tokens_out` unconditionally and expressed a token estimate as a percentage of
that figure. For a `usd` run `cost_amount` is money, so the subtraction mixed dollars with tokens. It is
now computed only for a token unit, and an unrecorded unit prints as unknown rather than being labelled
"tokens". The enforcement list above was true of the write and read paths and false by omission about
observability; this closes that omission.

**A `usd` charge marked `basis: "reported"` is not a provider-reported cost.** No provider here reports
money. It means provider-reported TOKENS multiplied by a locally configured list rate - measured
quantity, local price. The Costs screen says so for `usd` specifically rather than claiming "the
provider's own reported usage".

1. **Provider-reported usage** — captured fail-closed. Every adapter refuses missing, partial, NaN or
   non-numeric token counts rather than defaulting to zero.
2. **Client-side estimates** — three estimators (the compiler's 4-chars-per-token approximation, the
   router's worst-case, a tool's `estimatedCost`), each labelled where it is recorded.
3. **Governance reservations** — a separate column, with the estimate carried in the reservation id and
   `basis` separating reconciled-from-measured from charged-at-estimate.
4. **Subscription telemetry** — quarantined; advisory only, never writes a counter, and there is no
   utilization-to-token conversion anywhere.
5. **Monetary USD** — **the weakest boundary, and the only USD in the system is estimates.** No provider
   has ever reported a usd cost. The Costs screen was showing `sum(consumed_amount)` in usd as money
   consumed; it now reports `consumedBasis` per unit and says plainly when a figure was charged at
   estimate rather than measured (`src/api/routes/costs.ts`, `web/app/costs/page.tsx`).

**Since R2 Task 42, `invocation_completed`'s payload carries `usageAccounting`** — per-category, provider-
reported usage with an explicit `unknown[]` list, so a reader can always tell "the provider said zero"
from "the provider said nothing". It is telemetry: it changes no counted amount, no budget and no route,
and a structural invariant confines `buildUsageAccounting` to the three provider adapters, so a
provider-measured-looking value cannot be manufactured from model output. Now recorded: cache read, cache
creation, thinking, the per-model secondary split, how the primary was identified, and — where the
provider offers a second view — whether the primary's entry silently merged a secondary call into it.

**What still cannot be measured** — stated plainly rather than approximated:

- **The real prompt size of any invocation.** `estimatedInputTokens` is an approximation; `tokens_in` is
  the provider's *primary entry* count, and cache tokens are reported SEPARATELY from it (evidenced:
  `inputTokens: 10` beside `cacheCreationInputTokens: 7568`), which is why it can read 2-4 tokens. No
  tokenizer output is persisted. **Do not read `tokens_in` as prompt size.**
- **Whether cache and thinking tokens draw on the Max allowance.** The quantities are now recorded; the
  billing weight is a fact about the provider that no response states, so it cannot be derived. See
  `SUBSCRIPTION_PROVIDER_DESIGN.md`.
- **Which model did what, when the CLI merges them.** If the internal secondary call runs on the same
  model as the request, the CLI reports one entry containing both. The merge is now *detected* where a
  top-level view exists, but the split is unavailable at source. `secondary: []` means "no second model
  was listed", never "no secondary work happened".
- **`events.cache_hit` still collapses "reported nothing" into `false`**, because the frozen envelope
  types it as a plain boolean. Read `usageAccounting.cache.read`, which is null when unreported.
- **Measured USD spend.** Does not exist.
- **Actual Max entitlement consumption.** `subscription_tokens` is a locally imposed ceiling, not a mirror
  of the plan's allowance.
- **Quota state.** Populated, but surfaced by no read API and no UI.
- **Invocation latency.** No timestamps beyond `occurred_at` and `invocations.completed_at`.

**Where the tokens actually go**, measured over 90 recorded compilations: **32.5% of all compiled input is
fixed instruction boilerplate** that does not vary with the task — 56% for the `decide` intent, which is
the most frequent. Artifact payload is 96% of the variable part. Tool-schema overhead is **exactly zero**
across all 90 (capabilities reach the model through provider-side tools and task plans, not the schema
layer). Only 1 of 90 compilations excluded anything for budget, so the ceilings are not currently binding.
The estimator under-counts real input by roughly 1.3–2.2×, and every ceiling is enforced against the
estimate, so the effective limit is looser than it reads.

## 7. Known limitations (accepted, not fixed)

1. **No authentication.** Anyone who can reach the port is the operator. Correct for a single-operator
   local runtime; it is the reason "the operator forged it" is out of scope above.
2. **The Context Compiler does not scope candidates to a Goal or mission.** It validates that a candidate
   artifact is a persisted row, not that it belongs to the compiling Run's Goal. Cross-mission leakage is
   unreachable today because every caller scopes the ids itself, but the last line of defence is caller
   discipline rather than a structural check. Adding the check is a design decision, not a bug fix — a
   meeting decision legitimately becomes a mission in another Goal.
3. **`agent_performance.avg_cost` averages measured and estimated consumption together**, and that
   projection feeds the Model Router's tier preference. Not billing, but decision-affecting.
4. **A meeting decision's text becomes a Goal title, and Goal titles are trusted task state.** A decision
   is model-written. When the operator turns one into work, that text becomes `goals.title`, and the
   Context Compiler deliberately treats a Goal's title and description as **trusted, unfenced** task state
   — anything the operator puts in a Goal is read as part of the task. Same class as the delegated-brief
   hole in §3, a different channel, and **not** fixed here: fencing task state would change the compiler's
   trust model, which is frozen. What stands between the two is the operator's own act of starting the
   follow-up — nothing in the room can start its own work. The operator should read what they start.
5. **Structural invariants are tripwires, not proofs.** They match identifiers and string literals, so a
   table name assembled at runtime or a dynamic import would pass. Same caveat as the `agent_performance`
   firewall.
6. **The fence is prompt-level.** See §3.
7. **`evidence_sufficient` is not external verification.** See §5.

## 8. Explicitly not built

No second runtime. No scheduler — every "when" is derived from the clock at read time. No vector database,
no embeddings, no retrieval: the Context Compiler takes explicit candidate ids only. No agent memory
system (`layers.memory` is hard-coded `""`). No message broker, no Redis, no Temporal. No external
calendar, email or chat provider. No parallel workflow execution — the interpreter is strictly linear and
single-active-step. No recurring calendar events. No model-authored meeting notes without code validation.
No monetary billing integration. No observability product: the token report reads records that already
exist and adds no instrumentation.
