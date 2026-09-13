# Subscription-Backed Claude Provider — Architecture

**Status: IMPLEMENTED (Phases 7A–7H, quota telemetry wired in Phase 8).** This
document began as a design; the status notes below were corrected on
2026-09-13 after an independent review found them stale.

*Implemented:* the resource-unit accounting model (§2.1), the subscription
adapter and its isolation controls (§2.5), quota state and its observation
event (Parts 3–4, 7A), stream-json parsing (Part 5, 7B), the quota guardrail
(Part 6, 7C — **shipped disabled, no thresholds**), candidate routing (Part 9,
7D), and production recording of quota observations on success and failure
(Phase 8, `src/governance/quotaTelemetry.ts`).

*Production default:* `claude_subscription` is the primary candidate for every
tier. That switch was made in Phase 7F on the operator's explicit instruction
("Make Claude Max the Production Runtime Default"), after the 7A–7E validation.

*Not implemented:* observability surfaces (Part 12) and any guardrail
activation — thresholds remain an open operator decision.

**Authority:** Phase 10.6 as amended 2026-09-13
(`docs/superpowers/specs/2026-09-12-ai-command-centre-design.md`). Read that
amendment first.

**Revision history**
- *Step 2 (2026-09-13):* original design draft, written before any live call.
- *Step 4F / Phase 6 (2026-09-13):* revised against measured evidence from
  Phases 1–5 (85 live Max invocations). Four Step-2 claims are **superseded** —
  see §0. Parts 3–14 are new.

### Evidence labels

| Label | Meaning |
|---|---|
| **VERIFIED** | Directly observed in a live measurement recorded under `benchmark/raw/`, or quoted from current official documentation. |
| **ASSUMED** | Reasonable but unproven. Must not be relied on as a guarantee. |
| **UNKNOWN** | Cannot currently be determined. |
| **DESIGN DECISION** | A choice made here, with its reason. Not an observation. |

A measurement is evidence about the runs that produced it. It is **not** a
contractual guarantee from Anthropic, and this document never upgrades one into
the other.

---

## Part 1 — Current architecture review

### 1.0 Claims superseded by measurement

Recorded rather than silently rewritten, for the same reason Phase 10.6's
replacement quotes the text it replaced: a future reader must be able to see
that a claim was tested and replaced, not quietly dropped.

| Step-2 claim | Status | Superseded by |
|---|---|---|
| The secondary internal call appears as a distinct `modelUsage` entry, so `secondaryUsage` shows the split | **SUPERSEDED** | Phase 3/4: a distinct entry appears **only when the primary model is not Haiku**. On the CHEAP tier (Haiku primary) the internal call merges into the single Haiku key, so `secondaryUsage` is empty despite a secondary call occurring. Totals stay correct; the *split* is invisible. |
| Cache-creation token behaviour is ASSUMED/unverified | **SUPERSEDED** | Phase 3 (n=12) + Phase 4: `B ≈ 7,333 + 287 × KB(stdin)` for Haiku; slope 287/KB also for Opus, with a materially lower floor (~3,098, n=1 per size). |
| "The limits are opaque — no documented API exposes remaining headroom before dispatch" | **SUPERSEDED** | Phase 4: `rate_limit_event` under `--output-format stream-json` exposes five-hour and seven-day utilization plus reset timestamps. Headroom is *partially* observable — as a coarse gauge, not a counter (§3). |
| Part 5 "Max benchmark gate" as a pre-condition list | **LARGELY EXECUTED** | Phases 1–5. Remaining items are listed in §15. |

**Also formally withdrawn:** an earlier estimate of "~2,600 invocations per
five-hour window". Phase 5 showed utilization is non-monotonic and quantized to
~1%; no invocations-per-window or tokens-per-window figure is derivable. It must
not reappear anywhere as a planning number.

---

### 1.1 What exists today

Implemented and shipped: the resource-unit model (§2.1), the subscription
adapter and its isolation controls (§2.5), the total-map provider dispatch
(§9.2), and the Phase 10.6 amendment that authorizes all of it.

*(Superseded — see the status block at the top of this document.)* At the time
this section was written, quota state (Part 3), the quota observation Event
(Part 4), stream-json parsing (Part 5), the guardrail (Part 6), and Parts 7–9
and 12–14 were designs only. Parts 3–9 have since been implemented; Part 12 has
not.

**No contradiction was found between the amended spec and this design.** The
only conflicts found were between this document's own Step-2 draft and
subsequent measurement — recorded in §1.0 above rather than silently rewritten.

---

## Part 2 — Subscription accounting

### 2.1 The resource-unit model

`budget_counters` is keyed `(scope, scope_ref_id, resource_unit)`. Three units,
never summed: `usd`, `subscription_tokens`, `local_tokens`
(`src/governance/resourceUnit.ts`). This is the concrete implementation of
Phase 5.0's "Money/**quota**" pair.

### 2.2 What a successful Max invocation records

| Field | Source | Role |
|---|---|---|
| provider | `tierConfig[tier].provider` | routing/audit |
| model | pinned `modelId` | audit; recorded on the Event |
| reported input tokens | `modelUsage[*].inputTokens` | **counted** |
| reported output tokens | `modelUsage[*].outputTokens` | **counted** |
| cache creation tokens | `modelUsage[*].cacheCreationInputTokens` | **diagnostic only** |
| cache read tokens | `modelUsage[*].cacheReadInputTokens` | **diagnostic only** |
| thinking tokens | `modelUsage[*].thinkingTokens` | diagnostic only |
| accounting unit | constant `subscription_tokens` | required on every usage Event |

**Counted today:** `Σ(inputTokens) + Σ(outputTokens)` across **every**
`modelUsage` entry — not just the primary. **VERIFIED** as necessary: Phase 4's
Opus runs show a separate Haiku entry whose input *scales with context*
(1,295 → 3,903 tokens), so counting only the primary would under-report
materially.

**Not counted today:** cache creation and cache read.

**UNKNOWN — the central open question.** Whether cache-creation tokens draw on
Max entitlement is not observable. What *is* **VERIFIED** is the size of the
gap: D/A ratios of **3.25×** (Phase 3), **5.46×** (Phase 4), **6.05×**
(Phase 5) — the ratio rises as context shrinks, so the under-count is worst
exactly where CHEAP-tier traffic lives.

**DESIGN DECISION — leave the counted set unchanged in Phase 7.** Adding
cache-creation to the counted amount would change the meaning of every existing
`subscription_tokens` figure while still not being known to match entitlement.
It trades one unproven mapping for another. Revisit only if entitlement
attribution becomes measurable (§15).

### 2.3 Semantics that are NOT known to hold

**UNKNOWN:** that Anthropic's reported token counts equal Max entitlement
consumption. `subscription_tokens` is therefore a **locally-imposed
self-discipline ceiling**, not a mirror of the plan's real allowance. Every
consumer — UI, dashboards, docs — must be able to tell those apart.

### 2.4 Prohibited representations

- **Never** `usd = 0` for subscription work. It would silently neuter the
  Budget Governor for that tier while it kept emitting events asserting
  enforcement.
- **Never** `total_cost_usd` / `costUSD` as billing. **VERIFIED:** the CLI
  itself tags these `costBasis: "list"`, and Anthropic documents them as
  client-side estimates that must not drive financial decisions.
- **Never** derive `subscription_tokens` from quota utilization (§3).

---

### 2.5 Provider boundary as implemented (isolation controls)

Unchanged from Step 2 except where noted, and now **VERIFIED across 85 live
invocations** (Phases 1–5) rather than argued from documentation.

| Control | Status | Evidence |
|---|---|---|
| `spawn(resolvedExe, argv, {shell:false})` | **VERIFIED** | 85/85; argv never a command string |
| Executable resolution to real `claude.exe` | **VERIFIED** | Step 4A; `.cmd` rejected (Node EINVAL), `shell:true` rejected on security grounds |
| `ANTHROPIC_API_KEY` absent from child | **VERIFIED** | 85/85, including with a key present in the parent |
| 24 forbidden env vars absent | **VERIFIED** | 85/85 |
| Fresh empty cwd outside repo, removed after | **VERIFIED** | 85/85, empty before and after |
| No repository mutation | **VERIFIED** | `git status` byte-identical across every phase |
| `--tools ""` removes built-in tools | **VERIFIED** | init surface is `["StructuredOutput"]` on every stream-json run |
| MCP isolation | **VERIFIED** | `mcp_servers: []` on every stream-json run |
| Pinned model IDs, no `--fallback-model`, no `--bare` | **VERIFIED** | 85/85 |
| Structured-output validity | **VERIFIED** | 85/85 valid, including semantic ground-truth checks |
| Server-side tool foreclosure | **ASSUMED** | Strongly supported (`webSearchRequests` 0/85; 3 runs explicitly instructed to browse did not attempt) but the init list is the *client* registry; the API request the harness sends is not observable. **Not proven.** |

**`StructuredOutput` is itself a tool.** **VERIFIED:** `--tools ""` removes
*caller-supplied* tools; `--json-schema` injects its own, which is why
`stop_reason` is `tool_use` and turn count is 2–3 rather than 1. Phase 3 measured
its cost directly: **+879 cache tokens (+12.8%) and +1 turn** versus an
otherwise identical run with the schema pair removed.

---

## Part 3 — `subscription_quota_state` (design)

### 3.1 What the telemetry actually is

**VERIFIED** (Phase 4/5), `rate_limit_event` under stream-json:

```json
{ "status": "allowed", "rateLimitType": "five_hour",
  "overageStatus": "rejected", "overageDisabledReason": "org_level_disabled",
  "unifiedWindows": {
    "five_hour": { "utilization": 0.45, "resetsAt": 1789331400 },
    "seven_day": { "utilization": 0.17, "resetsAt": 1789448400 } } }
```

**VERIFIED — it is a gauge, not a ledger.** Phase 5's decisive observation: at
19:38:32, four concurrent invocations reported `0.47, 0.47, 0.48, 0.47` — the
value crossed a rounding boundary and came back *within one second*. Resolution
is ~1%. Across 26 invocations total movement was ≤0.01, and the only tick
followed a **2**-call burst while two separate **8**-call bursts moved nothing.

Consequences, all load-bearing:

- **UNKNOWN:** tokens per window, invocations per window, per-invocation cost.
- Utilization deltas are **not** consumption. Subtracting two readings is
  meaningless at this resolution.
- **VERIFIED:** `overageStatus: "rejected"` / `org_level_disabled` — exhaustion
  is a hard stop with no billable spillover.

### 3.2 Fields, each justified

| Field | Why it belongs |
|---|---|
| `provider` | The state is per-provider; `local` and a future second subscription would each have their own. |
| `five_hour_utilization` | The binding window; the only near-term risk signal. |
| `five_hour_reset_at` | Turns "high utilization" into "high, and clearing in N minutes" — changes whether to refuse or wait. |
| `seven_day_utilization` | A slower ceiling that can bind even when the 5h window is clear. |
| `seven_day_reset_at` | Same reason as the 5h reset. |
| `observed_at` | Required to compute freshness; without it no staleness decision is possible. **It is a LOCAL RECEIPT timestamp, not a provider-supplied one** — the CLI attaches no time to `rate_limit_event`. The runtime stamps each reading when the line arrives on the pipe (Phase 7B), so the error is bounded by pipe latency rather than by invocation duration. Measured in the 7B closure check: the reading arrived **2,211 ms before** the subprocess closed on a 4.0 s invocation, so stamping at close would have reported it as that much fresher than it was. |
| `stale_at` | **Phase 5 proves staleness is a real operating state** — telemetry arrives only *from* invocations, so an idle runtime's reading silently ages. An explicit expiry makes UNKNOWN a first-class state rather than an old number masquerading as current. |
| `status` | `"allowed"` is the only value observed; anything else must be treated as a refusal signal, not parsed for meaning. |
| `overage_status` | Determines whether exhaustion is a hard stop. Currently `"rejected"`. |
| `source` | Which mechanism produced it (`rate_limit_event`). Lets a future second source be added without ambiguity. |
| `cli_version` | **Phase 1 found 8 top-level fields absent from the Pro-era spike.** Schema drift is demonstrated, not hypothetical; without the version a stale-parser bug is undiagnosable. |

**Deliberately excluded:** `account_identity` (single-account runtime; add when
a second account exists), `last_successful_observation` (`observed_at` on the
latest row already answers it), any `remaining_tokens` field (would imply
knowledge that does not exist).

### 3.3 It is a projection, not history

Spec Phase 8 (line ~508): *"all projections over one event model — none is a
separate source of truth."*

**DESIGN DECISION — the projection stores the LATEST observation only.** Never a
maximum, never a running total. A projection taking `max(utilization)` would
have been wrong *within a single second* during Phase 5's 19:38:32 sequence.
History lives in the Event table; the projection is current-known-state.

---

## Part 4 — Event model (design)

```
claude subprocess → rate_limit_event (stream)
   → provider observation (in-adapter, no state mutation)
      → immutable Event                       ← the FACT
         → subscription_quota_state projection ← the INTERPRETATION
```

The adapter **must not** mutate quota state directly. Spec Phase 8 makes the
event the source of truth; a projection updated without an event trail would be
a second source of truth.

| Aspect | Decision |
|---|---|
| Event type | `provider_quota_observed` |
| Event version | `1` |
| Producer | `"claude-subscription-provider"` |
| Actor | `"system"` |
| Correlation | the Invocation that produced it (`invocationId`, `runId`, `taskInstanceId`) — telemetry always arrives *because of* a specific invocation |
| `observedAt` | **Local receipt time of the `rate_limit_event` line**, never a provider timestamp (the provider supplies none) and never the subprocess-close time. Any consumer reasoning about freshness must read it as "when this runtime saw it", not "when the provider measured it". |
| Causation | the `invocation_started` event for that Invocation |
| Emission | **synchronously, in the same transaction as `invocation_completed`/`invocation_failed`** — matching how `budget_counters` already projects |
| `usage` envelope | **`null`.** This event records no token usage; a `costAmount` here would invite exactly the conflation this design forbids |
| Idempotency key | `provider_quota_observed:<invocationId>:<n>` where `n` is the observation index within that invocation |

**Coalescing — DESIGN DECISION: emit one event per invocation, carrying the
last observation seen, plus a count of observations.** Every reading is a fact
and *could* be emitted, but Phase 4 saw up to 3 events in one invocation and
Phase 5 saw 20 across 26 — all reporting the same 1%-resolution value. Emitting
each would multiply event volume for no additional information, since the
projection keeps only the latest anyway. The discarded intermediate readings are
recorded as a count, so the event says how many observations it summarizes.

**A failed invocation may still carry an observation.** Telemetry can arrive
before a failure, so emission is tied to the invocation *terminating*, not to
its success.

---

## Part 5 — stream-json vs json — **DESIGN DECISION: Option A**

**Switch the production adapter fully to `--output-format stream-json --verbose`
and reconstruct the final result from the `result` event.**

**Evidence, not preference:**

- **VERIFIED across ~68 invocations** (Phases 3–5): stream-json delivers a
  `result` event containing `structured_output`, `usage`, and `modelUsage` —
  every field the current json parser consumes — **plus** `rate_limit_event` and
  the `system/init` tool surface. It is a demonstrated **strict superset**.
- **VERIFIED:** structured-output validity was **100%** under stream-json.
- **VERIFIED:** the init surface was byte-identical to json mode
  (`{"tools":["StructuredOutput"],"mcp_servers":[]}`) on every run, **with
  `--verbose` present**. Output formatting does not touch the isolation
  boundary. Isolation was re-asserted on every argv before launch in Phases 3–5.

**Option B (separate probe invocations) is disqualified on evidence, not cost:**
a probe is itself an invocation, so it consumes the entitlement it measures and
perturbs the quantity being observed — precisely the confound that made
Phase 5's deltas uninterpretable. It would also double invocation count for
telemetry alone.

**Option C:** no other documented mechanism surfaces `rate_limit_event`.

### 5.1 Parsing architecture

NDJSON, one JSON object per line, dispatched by `type`:

| Event | Handling |
|---|---|
| `system`/`init` | capture tool surface + mcp_servers (isolation assertion) |
| `rate_limit_event` | collect; last one wins for the emitted Event |
| `result` | the authoritative terminal object — parse exactly as the json-mode parser does today |
| anything else | ignore (forward-compatible by construction) |

**Preserved unchanged:** `--json-schema` validation and the
success-without-`structured_output` rejection; `--tools ""`;
`--strict-mcp-config`; `--setting-sources ""`; env sanitization; bounded stdin;
timeout → SIGTERM → release-not-reconcile; per-invocation fresh cwd; pinned
model; no fallback model.

**Fail-closed additions:** absence of a `result` event is a failure
(`no_result`), not an empty success. Non-JSON lines are ignored, but a stream
containing *no* parseable `result` must throw.

---

## Part 6 — Quota guardrail (design; NOT implemented)

### 6.1 Why single-threshold logic is unsafe

**VERIFIED:** utilization crossed 0.47↔0.48 repeatedly within one second. A
single threshold at any value near an observed reading would **flap** —
consecutive invocations alternating allow/refuse with no change in real
conditions.

### 6.2 Hysteresis

Two thresholds, with a latch:

```
if   state == ALLOWING and util >= refuse_above  -> REFUSING
elif state == REFUSING and util <= resume_below  -> ALLOWING
else                                             -> unchanged
```

`refuse_above > resume_below`, with the gap comfortably wider than the ~1%
resolution plus observed jitter. Both values are **configuration**, not
constants.

**DESIGN DECISION — recommend an initial `refuse_above = 0.90`,
`resume_below = 0.80`, and justify it only as follows:** the gap (10 points) is
an order of magnitude above the observed jitter (~1 point), and 0.90 leaves
headroom before a hard stop that has no overage path. It is **not** derived from
any capacity estimate, because none exists. It is a starting configuration to be
tuned against operational experience, and no part of the design depends on the
specific numbers.

### 6.2a As implemented (Phase 7C)

`src/governance/quotaGuardrail.ts`. **Ships `{ enabled: false }` with no thresholds configured** — the 0.90/0.80 pair below was a design suggestion and is deliberately *not* enshrined as production policy, because the capacity behind the gauge is still UNKNOWN.

| Aspect | Implementation |
|---|---|
| Latch storage | The **event log is the latch**: `quota_guardrail_state_changed` is emitted only on a transition, and the last one for a provider is the current state. No new table, no in-memory flag, no policy field on the provider-fact projection. |
| Window interaction | **Either** window at/above its upper threshold CLOSES; **both** configured windows must be at/below their lower thresholds to REOPEN. Not "whichever is larger" — a seven-day ceiling can bind while the five-hour window looks clear. |
| Unjudgeable window | No thresholds configured, or no utilization reported → cannot close dispatch and cannot contribute to reopening. |
| Freshness | `freshnessMs`, optional and unset by default. Unset means readings never expire — no unexplained production constant. |
| Provider status | Judged before utilization and never latched: `status != "allowed"`, or an `overage_status` other than `"rejected"`, → `PROVIDER_REJECTED`. |

### 6.2b Runtime refusals stop the candidate scan (Phase 7G)

**DESIGN DECISION.** A `REFUSE_QUOTA` or `PROVIDER_REJECTED` verdict **ends** candidate selection; it never promotes a lower-ranked candidate.

Phase 7F made Claude Max primary with the billable API ranked behind it. Until 7G, a quota refusal on Max made the scan continue to the API candidate — which has no guardrail configured, is therefore always allowed, and would have been dispatched. That is precisely the silent fallback amended Phase 10.6.7 forbids: a quota refusal converted into unbudgeted spend, with no Policy decision, no separate reservation, and no event marking the switch. It was unreachable while the guardrail was disabled and **armed the moment it is enabled** — closed in 7G before any activation.

The distinction is between kinds of exclusion:

| Exclusion | Kind | Scan |
|---|---|---|
| `disabled`, `tier_mismatch`, `capability_mismatch`, `resource_mismatch` | configuration fact about which candidates apply at all | **continue** |
| `quota_refused`, `provider_unavailable` | live refusal to do this work now | **stop** |

The reported `no_eligible_candidate` reason prefers a runtime refusal over any incidental static skip, so an operator is never told "tier_mismatch" when a provider actually refused.

### 6.3 State machine

| Condition | Decision | Reason |
|---|---|---|
| No observation ever (startup) | **ALLOW**, record UNKNOWN | Telemetry only arrives *from* an invocation; there is no way to observe before dispatching. Fail-closed here makes the first invocation after every process start unserviceable. |
| Observation older than `stale_at` | **ALLOW**, record UNKNOWN | Same argument: an idle runtime cannot refresh without dispatching. |
| `status != "allowed"` | **REFUSE** | Provider is signalling something other than normal service; do not interpret unknown values. |
| `overage_status` changes from `"rejected"` | **REFUSE**, require policy review | The economics changed; a human should confirm before spending continues. |
| util ≥ `refuse_above` | **REFUSE** | Approaching a hard stop with no overage. |
| util ≤ `resume_below` after refusing | **ALLOW** | Hysteresis release. |
| Just after a reset (`reset_at` passed) | **ALLOW**; treat prior reading as stale | The window cleared; the old number is meaningless. Do not wait for a fresh reading — see startup argument. |

**DESIGN DECISION — UNKNOWN allows rather than refuses.** The load-bearing
reason is the separation in Part 7: the *hard* control is the
`subscription_tokens` reservation, which is transactional and works with zero
quota telemetry. The guardrail is a second, independent, **advisory** signal.
Failing closed on UNKNOWN would disable the provider in exactly the states where
telemetry is structurally unavailable, while adding no safety the reservation
does not already provide.

**The guardrail never authorizes.** It can only refuse. Authorization remains the
Budget Governor's.

---

## Part 7 — Budget Governor integration (design)

> **"What can the Budget Governor authorize before dispatch if exact Max
> entitlement remaining is unknown?"**
>
> It authorizes against a **locally-imposed `subscription_tokens` ceiling** that
> this system sets for itself. It does **not** and cannot authorize against
> Anthropic's real allowance. The two are independent, and the design never
> implies otherwise.

Three mechanisms, deliberately not merged:

| | Mechanism | Nature | Source of truth | Failure mode |
|---|---|---|---|---|
| **A** | Accounting authorization | Hard, transactional | `budget_counters(subscription_tokens)` | Pre-dispatch refusal, `insufficient_budget` |
| **B** | Quota risk guardrail | Soft, advisory, configurable | `subscription_quota_state` | Pre-dispatch refusal, `quota_guardrail` |
| **C** | Hard provider rejection | External, unavoidable | The CLI/service itself | Mid-run failure → Invocation fails |

**A is unchanged by this design.** Reserve → dispatch → reconcile → release,
atomic on a single `(scope, scope_ref_id, resource_unit)` row, exactly as
implemented in Step 3.

**B runs after A and before dispatch.** Both must pass. A refusal from B
releases A's reservation — it is a refusal to start, so nothing is consumed and
nothing may be reconciled.

**C cannot be prevented**, only handled (§8). B exists to make C rarer, not to
replace it.

**Hard prohibitions:** no conversion from utilization to tokens in either
direction; B never writes `budget_counters`; A never reads
`subscription_quota_state`.

---

## Part 8 — Exhaustion and failure semantics (design)

> **Amended in Phase 9 (2026-09-14).** The Reservation column originally said
> "release" for every failure, including timeout. That under-reported real
> consumption: a CLI child killed after minutes, or a stream that died mid-way,
> has almost certainly consumed tokens, and releasing hands that capacity back.
> The rule now follows each failure's *consumption*. It is released only when
> the failure provably sent nothing or was refused outright, and otherwise
> charged at the reservation's estimate. Usage is never invented in either case:
> the failure event carries no `usage`, and records the settlement and charged
> amount in its payload. See `DURABLE_EXECUTION.md` §4.1.

| Condition | Code | Reservation | Behaviour |
|---|---|---|---|
| Auth expired | `auth_expired` | release (consumption `none`) | Distinct, operator-actionable; runtime cannot self-recover |
| Quota exhausted | `quota_exhausted` | release (consumption `none`) | **No automatic fallback** |
| Overage rejected | `quota_exhausted` | release (consumption `none`) | Same; no billable spillover exists |
| Provider unavailable / CLI missing | `cli_unavailable` | release (consumption `none`) | Config/operator problem, not runtime (Step 4A) |
| Misconfigured unit / oversized input | `misconfigured` / `input_too_large` | release (consumption `none`) | Refused before spawning |
| Malformed structured result | `schema_validation` | **charge at estimate** | Success-without-`structured_output` is a failure; the CLI did run |
| Missing/malformed usage | `usage_missing` | **charge at estimate** | Fail closed; never invent usage — and never assume none |
| Timeout | `timeout` | **charge at estimate** | Terminated child records no result; reconciling 0, or releasing, would under-report real consumption |
| Non-zero exit / parse error / no result | `nonzero_exit` / `parse_error` / `no_result` | **charge at estimate** | The process ran; consumption unknown |
| CLI version mismatch | `cli_unavailable` | release (consumption `none`) | Surfaced via `cli_version` on quota state |
| Stale / unknown quota | n/a | n/a | Not a failure; ALLOW + record UNKNOWN (§6.3) |

### 8.1 What happens when Max refuses

**Not** "fall back to the API". **VERIFIED** design constraint from amended
Phase 10.6.7.

If fallback is ever wanted it is an **explicit Policy + configuration**
decision, and it must:

1. be authorized by **Policy**, not by the adapter or the Router;
2. create a **new Invocation** with a **new Budget reservation** — the original
   subscription reservation is released, never transferred;
3. reserve in a **different resource unit** (`usd`), because it is different
   money; the units cannot be carried across;
4. require **Approval** if the governing Grant demands one for spend;
5. record the provider change in the event chain via **causation** — the
   fallback Invocation's `causationId` points at the failed subscription
   Invocation, so the transition is auditable rather than invisible.

A silent adapter-level retry against a billable provider is prohibited: it would
convert a quota failure into unbudgeted spend with no reservation and no record.

---

## Part 9 — Model Router implications (design)

**Current defaults (Phase 7F/7H).** Every tier routes to Claude Max, accounted
in `subscription_tokens`:

| Tier | Model | Provider | Unit |
|---|---|---|---|
| CHEAP | `claude-haiku-4-5-20251001` | `claude_subscription` | `subscription_tokens` |
| MID | `claude-sonnet-5` | `claude_subscription` | `subscription_tokens` |
| STRONG | `claude-opus-5` | `claude_subscription` | `subscription_tokens` |

A tier is a model **quality floor**. It is not a price band, and it represents
no particular share of Max entitlement — the per-run subscription ceiling is one
shared budget, not a per-tier or per-model allocation. Task difficulty maps 1:1
onto the ladder (simple/standard/complex), with the risk floor unchanged:
high/highest still forces STRONG.

### 9.1 Five distinct concepts

| Concept | Meaning |
|---|---|
| **Candidate** | A provider a tier *may* use, in preference order (config) |
| **Selected** | The one provider actually chosen for this Invocation |
| **Fallback** | A *different Invocation* after an explicit policy decision (§8.1) — never an in-call retry |
| **Unavailable** | Refused by guardrail, or `cli_unavailable`; skipped in candidate order |
| **Policy override** | An explicit instruction pinning a provider, bypassing candidate order but never the Governor |

Candidate ordering as shipped:

```
CHEAP : claude_subscription → anthropic          (local: future)
MID   : claude_subscription                      (no priced API alternative yet)
STRONG: claude_subscription → anthropic
```

Listing an API candidate below Max is **not** fallback: a runtime refusal stops
the scan (§6.2b). MID has no `anthropic` entry because no VERIFIED USD price for
Sonnet 5 exists in this repository, and a fabricated rate would put imaginary
money into `budget_counters`.

### 9.2 Dispatch safety — already solved

**VERIFIED:** `PROVIDERS: Record<ProviderName, ProviderAdapter>` in
`modelRouter.ts` is a total map. Omitting a provider is a **compile error**, and
there is no else-branch for a value to fall into. This replaced a ternary whose
else-branch sent *any* non-`"anthropic"` value to OpenAI — the exact silent
misroute this section must prevent. A fourth provider inherits the guarantee for
free.

**Constraint for Phase 7D:** candidate ordering must be data (a list in
`tierConfig`), not control flow. Any `if (provider === ...)` chain reintroduces
the bug class the map eliminated.

---

## Part 10 — Development Claude vs runtime Claude (mandatory)

**The developer's interactive Claude Code session is not a runtime component.**
The runtime adapter is a purpose-built provider that happens to use the
supported headless path as transport.

The runtime has its own process boundary, environment policy (allow-list), cwd,
settings isolation, MCP isolation, tool isolation, credential policy, lifecycle,
usage accounting, quota observation, and failure semantics — all **VERIFIED**
across 85 invocations (§2.5).

It inherits **none** of: developer session state, MCP servers, tools, settings,
context, or credentials.

**VERIFIED and operationally significant:** the interactive session and the
runtime **share the same Max entitlement pool**. Phase 5 could not attribute
utilization movement between them. Consequences: the guardrail's signal is
contaminated by human activity; an autonomous run can degrade the operator's own
Claude access; and no measurement can cleanly isolate runtime consumption.

---

## Part 11 — Security review

Verified controls are tabulated in §2.5. What remains **not** verified:

| Assumption | Status | Why it matters |
|---|---|---|
| `--tools ""` forecloses **server-side** tools (web search/fetch) | **ASSUMED** | 0/85 requests observed and 3 explicit browse attempts declined — but the init list is the client registry, and the harness's API request is unobservable. An ungoverned server-side fetch would bypass Capability/Policy and leave no tool Invocation in the Event log. |
| Reported usage ≈ entitlement consumption | **UNKNOWN** | §2.3 |
| The CLI JSON shape is stable | **ASSUMED** | Phase 1 found 8 new top-level fields vs the Pro-era spike. Drift is demonstrated; hence `cli_version` and fail-closed field parsing. |
| No Windows sandbox | **VERIFIED (absent)** | Anthropic documents native Windows as unsupported for sandboxing; isolation rests on flag-level tool removal alone — one layer, not two. |
| Credentials stay out of model context | **VERIFIED** | No `sk-ant-` pattern in any stdin payload; key never in child env |
| Pause cannot stop an in-flight child | **VERIFIED (gap)** | `pauseWorkflowRun` acts between steps; the adapter timeout is the only bound |

**No security boundary discovered in Phase 6 invalidates the current provider
design.**

---

## Part 12 — Observability (design)

Four independently visible layers. They must never be blended into one number.

| Layer | Shows | Must never imply |
|---|---|---|
| Invocation usage | in/out/cache-create/cache-read/thinking per model entry, unit-tagged | that cache tokens are counted, or that tokens are dollars |
| Provider quota state | 5h/7d utilization, reset times, status, overage status, **freshness** | that utilization is a consumed fraction of a known budget |
| Policy decision | ALLOW / REFUSE / UNKNOWN, plus which mechanism decided (A or B) | that a refusal was a provider error |
| Provider result | success/failure + failure code | that `cli_unavailable` and `nonzero_exit` are the same thing |

**Mandatory UI rule:** "47% five-hour utilization" must be rendered as a
provider-reported gauge with its `observed_at` and staleness, never as "47% of
budget used". Every cost figure must display its `cost_unit`; nothing may total
across units.

---

## Part 13 — Test strategy (design)

### Deterministic fixtures (no live Claude) — the large majority

Stream parsing: multi-line NDJSON; `result` extraction; usage extraction across
multiple `modelUsage` entries; `rate_limit_event` extraction; **malformed**
event; **missing** event; **duplicate/multiple** observations (last-wins +
count); non-JSON lines ignored; **absent `result` → failure**.

Quota state: staleness expiry; reset handling; `status != "allowed"`;
`overage_status` change; **hysteresis flap test replaying Phase 5's real
0.47→0.48→0.47 sequence and asserting the decision does not oscillate**.

Governance: resource-unit separation; no USD fabrication anywhere for
subscription; guardrail refusal releases the reservation; guardrail never writes
`budget_counters`; timeout releases rather than reconciles.

Routing/fallback: provider map selects each provider and no other; a fourth
provider cannot fall through; **API fallback disabled → quota failure never
reaches another provider**; API fallback explicitly enabled → new Invocation,
new reservation, unit changes to `usd`, causation recorded.

Structural: no module outside `src/router/providers/` spawns a process; no
`shell: true`.

### Requires live Claude (kept minimal)

Only: the existing `--version` smoke test (free), and a **single** end-to-end
invocation in Phase 7E confirming stream-json parsing against the real CLI.
Everything else is fixture-driven — the Phase 1–5 raw artifacts under
`benchmark/raw/` already provide real response bodies to use as fixtures.

**No new large benchmark.**

---

## Part 14 — Staged implementation plan (Phase 7)

| Stage | Scope | Files likely affected | Production behaviour changed | Migration | Rollback boundary |
|---|---|---|---|---|---|
| **7A** Event + quota-state foundation | `provider_quota_observed` event type; `subscription_quota_state` projection | `db/schema.ts`, new migration, `events/types.ts`, `events/emit.ts`, `api/eventEnvelopeRow.ts` | **None** — nothing emits the event yet | **Yes** (additive table; no change to `budget_counters`) | Drop table + revert types; no behaviour depends on it |
| **7B** stream-json adapter | Switch output format; NDJSON parser; emit observation | `router/providers/claudeSubscription.ts` (+ tests) | Adapter output parsing — **provider still not a default** | No | Revert one file; defaults never changed |
| **7C** Governor/policy integration | Guardrail (B) as a pre-dispatch check, configurable, defaulting to **disabled** | `governance/` (new module), `router/modelRouter.ts` | None while disabled | No | Config flag off |
| **7D** Provider routing / candidates | Candidate ordering as data; explicit fallback policy plumbing | `router/tierConfig.ts`, `router/types.ts`, `router/modelRouter.ts` | Candidate model exists; **defaults still Anthropic API** | No | Revert config shape |
| **7E** Controlled end-to-end verification | One live invocation end-to-end; enable guardrail in a test scope | tests + benchmark only | None | No | n/a |

**No stage in this table flips a default provider.** Enabling
`claude_subscription` was deliberately left as a separate decision after 7E —
and was then taken in **Phase 7F** on the operator's explicit instruction, which
made it the primary candidate for every tier. The "defaults still Anthropic
API" cells above describe the state *during* 7A–7E, not the current system.

**Ordering rationale:** 7A is the only stage needing a migration, so it lands
alone and first. 7B is behaviour-neutral because the provider is not selected by
any tier. 7C ships disabled. Each stage is independently revertible.

---

## Part 15 — Rejected approaches

| Rejected | Why |
|---|---|
| Deriving token consumption from quota utilization | Non-monotonic, ~1% resolution, flapped 0.47↔0.48 within one second; identical bursts gave different deltas; an 8-call burst moved nothing while a 2-call burst ticked. It is a gauge. |
| "~2,600 invocations per five-hour window" | Withdrawn. Not derivable from a quantized non-monotonic gauge, and confounded by shared interactive usage. |
| `total_cost_usd` / `costUSD` as subscription billing | CLI tags it `costBasis: "list"`; Anthropic documents it as a client-side estimate not to be used for financial decisions. |
| Subscription usage as `usd = 0` | Silently converts the Budget Governor into a no-op for that tier while it keeps emitting events asserting enforcement. |
| Silent API fallback | Converts a quota failure into unbudgeted billable spend with no reservation, no approval, no record. Must be explicit Policy (§8.1). |
| Quota utilization as a monotonic ledger | Directly falsified — the value decreased within one second. |
| Inheriting the developer Claude Code session/env | Would import developer MCP servers (Gmail, Calendar on this machine), settings, and context into governed Invocations — bypassing Capability/Policy entirely. |
| `shell: true` to fix Windows spawn | Would concatenate argv into a command string; `--json-schema` carries JSON full of quotes and braces. Security regression. |
| Separate probe invocations for telemetry | A probe is itself an invocation: it consumes the entitlement it measures and perturbs the observation — the confound that made Phase 5 uninterpretable. |
| Counting cache-creation in `subscription_tokens` now | Would change the meaning of every existing figure while still not being known to match entitlement — one unproven mapping for another. |

---

## Remaining UNKNOWNs

1. Whether cache-creation tokens draw on Max entitlement — **the decisive
   unknown** for whether `subscription_tokens` under-reports by ~3–6×.
2. Absolute window capacity (tokens or invocations). Not derivable.
3. Per-invocation entitlement delta — below telemetry resolution and confounded
   by the shared interactive pool.
4. Whether `status` ever leaves `"allowed"`, and CLI behaviour when it does.
5. Server-side tool foreclosure (**ASSUMED**, §11).
6. Why Haiku's cache floor (~7,333) is more than double Opus's (~3,098, n=1).
7. Long-run stability of the CLI JSON shape.
