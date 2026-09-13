# Claude Subscription Runtime Spike — Research + Local Proof

**Status: research and a harmless local proof only. Nothing in this document authorizes
production implementation.** No architecture file, schema, Model Router, Executor, Context
Compiler, Budget Governor, or `src/router/providers/anthropic.ts` was modified to produce
this. No Anthropic API call was made. No `ANTHROPIC_API_KEY` was used, set, or required at
any point. No external side effect occurred.

Every conclusion below is tagged **CONFIRMED** (directly verified against a current official
source, or directly observed on this machine — cited/shown), **INFERRED** (a reasonable
conclusion from available evidence, not directly stated), or **UNKNOWN / REQUIRES TEST**
(cannot be determined here).

---

## 1. Current official Anthropic position

**CONFIRMED**, fetched directly today from `code.claude.com/docs/en/legal-and-compliance`
(full relevant text, verbatim):

> **OAuth authentication** is intended exclusively for purchasers of Claude Free, Pro, Max,
> Team, and Enterprise subscription plans and is designed to support ordinary use of Claude
> Code and other native Anthropic applications.
>
> **Developers** building products or services that interact with Claude's capabilities,
> including those using the Agent SDK, should use API key authentication through Claude
> Console or a supported cloud provider. Anthropic does not permit third-party developers to
> offer Claude.ai login into their own applications, or to route requests through Free, Pro,
> or Max plan credentials on behalf of their users. Moreover, developers may not collect,
> store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account
> must complete through Anthropic's own flow.
>
> ...Nor does it prevent an end user from signing in to the unmodified Claude Code binary with
> their own Claude subscription, including where a platform hosts Claude Code...
>
> Anthropic reserves the right to take measures to enforce these restrictions and may do so
> without prior notice.
>
> Advertised usage limits for Pro and Max plans assume **ordinary, individual usage** of
> Claude Code and the Agent SDK.

**CONFIRMED**, fetched directly today from `support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan`
(matches the exact text you supplied):

> Update June 15: We're pausing the changes to Claude Agent SDK usage described below. For
> now, nothing has changed: Claude Agent SDK, `claude -p`, and third-party app usage still
> draw from your subscription's usage limits.

This is the **authoritative current baseline**, exactly as you framed it: subscription usage
**does** power `claude -p`/Agent SDK/third-party app usage today, and this has not changed
since the June 15 pause. The proposed $20–$200/month separate-credit plan is not in effect;
no monthly credit is currently available; Anthropic says it is "working to update the plan"
and will "share it before anything takes effect" (i.e., **INFERRED**: this could change again,
and the June 16 article date means roughly three months of official silence since — a risk
signal, not a green light, but not a withdrawal either).

**The unresolved tension (carried into §10 as the central open question):** the same page
both (a) directs "developers building products or services that interact with Claude's
capabilities" to API key auth, and (b) explicitly does not restrict "an end user signing in to
the unmodified Claude Code binary with their own Claude subscription." AI Command Centre's
proposed usage — its own orchestration code shelling out to the unmodified `claude` binary,
headlessly, as an internal component — sits exactly on the line between those two clauses.
**UNKNOWN**: whether "an end user running the unmodified binary" is read as being about *who
opens the binary* (you, personally — supporting viability) or *what kind of usage pattern it
serves* (an always-on component inside a separate product you're building — cutting against
it). Anthropic's own text does not resolve this; see §10 and §16.

---

## 2. Subscription authentication mechanism

**CONFIRMED, directly observed on this machine** (read-only command, no model invoked):

```
$ claude auth status
{
  "loggedIn": true,
  "authMethod": "claude.ai",
  "apiProvider": "firstParty",
  "subscriptionType": "pro",
  ...
}
```

**Important factual correction, not glossed over:** this machine's authenticated account
reports `"subscriptionType": "pro"`, not "Max." You referred to "my existing Claude Max
subscription" — the CLI itself reports Pro. This may simply mean the account logged into
Claude Code differs from your Max account, or that your plan is in fact Pro. Either way, this
document reports what was actually observed rather than assuming your stated framing. Nothing
below depends on which tier it is (`--tools ""`/`--restricted`/`--safe-mode` and OAuth-vs-
API-key behavior are identical across Free/Pro/Max/Team/Enterprise per the docs above) — it
only matters for §1's "ordinary individual usage" framing and for which usage-limit numbers
apply, neither of which this proof needed.

Auth is OAuth-token-based (`authMethod: "claude.ai"`), stored locally (per the earlier
research phase's finding — **INFERRED, carried forward, not re-verified this session**: at
`%USERPROFILE%\.claude\.credentials.json`, or a narrower-scoped `CLAUDE_CODE_OAUTH_TOKEN` from
`claude setup-token`, "requires Claude subscription" per today's `claude --help` output).
`apiProvider: "firstParty"` confirms requests route to Anthropic's own service (not
Bedrock/Vertex/Foundry).

---

## 3. Agent SDK findings

**Not directly tested in this proof** — installing the `@anthropic-ai/claude-agent-sdk`
package was avoided deliberately (this spike's hard boundary list did not ask for a package
install, and the CLI alone was sufficient to prove every question asked). **INFERRED**, from
official docs referenced in the June-16 Help Center article and the legal-and-compliance page
above (both name "Agent SDK" and "`claude -p`" together, in the same sentence, as drawing from
the same subscription limits): the Agent SDK is a thin wrapper that bundles and drives the
same underlying `claude` binary/protocol as the CLI — so the auth behavior, isolation flags,
and usage-limit consumption observed for `claude -p` in this document are expected to transfer
to Agent SDK usage, but this transfer was **not empirically verified** this session.
**UNKNOWN / REQUIRES TEST**: whether the Agent SDK's TypeScript/Python option names
(`allowedTools`, `disallowedTools`, `permissionMode`, `settingSources` — its own documented
option surface, distinct from the CLI's flag names) map 1:1 to the CLI flags tested below, or
whether the SDK exposes additional/different isolation knobs.

---

## 4. `claude -p` findings

**CONFIRMED, directly run on this machine, twice, successfully** (full evidence in §12).
`-p`/`--print` is documented as: "Print response and exit (useful for pipes)." It supports
`--output-format json` (structured result + full usage/cost/timing metadata — see §10),
`--json-schema` (schema-validated structured output — see §12, proof 2), `--no-session-
persistence` (no on-disk session record), and every isolation flag tested in §7–§9. This is
the mechanism this proof used for both invocations.

---

## 5. `--safe-mode` findings

**CONFIRMED, from today's `claude --help`, verbatim:**

> `--safe-mode` — Start with all customizations (CLAUDE.md, skills, plugins, hooks, MCP
> servers, custom commands and agents, output styles, workflows, custom themes, keybindings,
> and more) disabled — useful for troubleshooting a broken configuration. Admin-managed
> (policy) settings still apply. **Auth, model selection, built-in tools, and permissions work
> normally.** Sets `CLAUDE_CODE_SAFE_MODE=1`.

**This is the single most important correction to the starting reference for this document.**
`--safe-mode` disables CLAUDE.md/plugins/hooks/MCP/skills — but explicitly states **built-in
tools work normally**. It does **not** disable Bash, file writes, or WebFetch by itself. Using
`--safe-mode` alone would NOT satisfy your isolation requirements (no shell, no filesystem
writes) — it must be combined with `--tools ""` or `--restricted` (§7) for that. This proof
did not use `--safe-mode` at all; it achieved the same CLAUDE.md/settings/MCP disabling via
`--setting-sources ""` + `--strict-mcp-config` instead (§8–§9), which — unlike `--safe-mode` —
are documented to be compatible with subscription auth (nothing in their descriptions
mentions auth at all, and the proof confirms this empirically).

---

## 6. `--bare` findings

**CONFIRMED, from today's `claude --help`, verbatim — and this is the second major
correction:**

> `--bare` — Minimal mode: skip hooks, LSP, plugin sync, attribution, auto-memory, background
> prefetches, keychain reads, and CLAUDE.md auto-discovery. Sets `CLAUDE_CODE_SIMPLE=1`.
> **Anthropic auth is strictly `ANTHROPIC_API_KEY` or `apiKeyHelper` via `--settings` (OAuth
> and keychain are never read).** 3P providers (Bedrock/Vertex/Foundry) use their own
> credentials.

**`--bare` is not subscription-compatible, full stop.** It is documented to refuse OAuth
entirely and require an API key or an API-key helper. Despite being described elsewhere
(prior research, third-party sources) as the isolated, script-friendly mode and the reported
future default for `-p`, it is unusable for this task's stated goal ("use my existing
subscription, not API billing"). This proof deliberately did **not** use `--bare` anywhere.
This directly answers your instruction to "not assume `--bare` is the only valid route" — it
is, in fact, the **wrong** route for subscription auth specifically.

---

## 7. Tool isolation

**CONFIRMED, from today's `claude --help` and directly exercised in both proofs:**

| Flag | Effect (verbatim from `--help`) |
|---|---|
| `--tools ""` | "Use `\"\"` to disable all tools" — the complete disable. Used in both proofs. |
| `--restricted` | Removes Bash/PowerShell/REPL/code-running tools and WebFetch unless named via `--tools`; ignores user/project/local settings; confines file tools to working directories; refuses `bypassPermissions`; requires human/handler approval for writes to settings/git/tool-config files. Leaves Read/Write/Edit available (confined), so weaker than `--tools ""` for a pure-model-provider use case. Not used in this proof — `--tools ""` is strictly stronger for this purpose. |
| `--permission-mode manual` + `--permission-prompts none` | "nobody: anything that would prompt is denied automatically; the permission mode still decides everything else." Used as defense-in-depth in both proofs, on top of `--tools ""`. |
| `--allowedTools` / `--disallowedTools` | Named allow/deny lists, e.g. `"Bash(git *) Edit"` — not needed here since `--tools ""` is a complete disable, but relevant if a future spike needs to allow a narrow, specific tool. |

**Directly observed proof this worked:** both invocations' JSON output included
`"permission_denials":[]` — meaning nothing even *attempted* a denied action (there is no tool
available to attempt one with), and the isolated scratch directory (outside the repo) was
byte-for-byte unchanged (`ls -la` before and after, both empty) after each call.

**What is NOT guaranteed by `--tools ""` alone, stated precisely rather than assumed:** it
guarantees the model has no callable tool in *this specific invocation*. It says nothing about
network egress the harness itself performs outside tool-calling (e.g., its own telemetry, or
Anthropic's own server-side web-search/fetch capability, which appeared as a zeroed field
`"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0}` in both responses,
confirming it exists as a *capability* even though it fired zero times here). **INFERRED**:
this field's presence when unused, at zero, suggests it would need to be explicitly denied too
if a stricter proof required knowing it's structurally impossible rather than merely unused
this time — **UNKNOWN / REQUIRES TEST** whether `--tools ""` also removes eligibility for that
server-side capability or merely means the model chose not to invoke it.

---

## 8. Settings/CLAUDE.md isolation

**CONFIRMED, from today's `claude --help`:**

> `--setting-sources <sources>` — Comma-separated list of setting sources to load (user,
> project, local).

Passing `--setting-sources ""` (empty list) loads none of user/project/local settings —
which is where CLAUDE.md discovery, hooks, and most customization live. **Directly exercised
in both proofs.** This project's own root `CLAUDE.md` and any user-level
`~/.claude/CLAUDE.md` were both run from a directory containing neither (the isolated scratch
dir has zero files), so this is doubly confirmed by construction, not only by the flag.

**Distinction from `--safe-mode` (§5):** `--safe-mode` disables the same category of things
(CLAUDE.md, plugins, hooks, MCP) *and* is framed as a troubleshooting mode with tools left
active; `--setting-sources ""` is a narrower, purely settings-scoped flag. Both were viable for
this specific concern; `--setting-sources ""` was chosen because its description carries no
auth caveat at all (unlike `--bare`), and combining it with `--tools ""` covers both concerns
(no ambient config, no tools) with two independently-understood flags rather than one broader
mode whose full auth interaction isn't documented.

---

## 9. MCP isolation

**CONFIRMED, from today's `claude --help`:**

> `--strict-mcp-config` — Only use MCP servers from `--mcp-config`, ignoring all other MCP
> configurations.

**Directly exercised in both proofs**: `--strict-mcp-config` was passed with **no**
`--mcp-config` argument at all — meaning the allowed set of MCP servers is empty. Combined
with `--setting-sources ""` (which would otherwise be the source of any project/user MCP
config), this gives two independent, overlapping guarantees against MCP access rather than
relying on one. Neither proof's output showed any MCP-related activity.

---

## 10. Usage/accounting

**CONFIRMED, directly observed** (`--output-format json`, both proofs — full raw output in
§12). Available per-invocation:

- **Input/output tokens**: yes, both a top-level `usage.input_tokens`/`usage.output_tokens`
  and a `modelUsage` breakdown per model actually invoked (see below — this is not a single
  number, and the top-level figure is misleadingly small on its own).
- **Cache tokens**: `cache_creation_input_tokens`, `cache_read_input_tokens` — separately
  reported, and in both proofs these dwarfed the "real" task tokens (5,813 then 9,796
  cache-creation tokens vs. 2 real input tokens each time — see the overhead finding below).
- **Model identifier**: yes, `modelUsage` is keyed by exact model id (e.g.
  `"claude-haiku-4-5-20251001"`), each carrying a `"canonicalModel"` field (e.g.
  `"claude-haiku-4-5"`) and `"provider":"firstParty"`.
- **Request/invocation identifier**: `session_id` and `uuid`, both present.
- **Latency**: `duration_api_ms`, `duration_ms`, `ttft_ms` (time-to-first-token),
  `ttft_stream_ms`, `time_to_request_ms` — all present, all real (not identical across the two
  runs).
- **Errors / stop reason / completion state**: `stop_reason`, `terminal_reason`,
  `is_error`, `subtype` (`"success"` in both proofs), `api_error_status` (`null` in both) —
  all present and distinguishable.
- **Cost**: `total_cost_usd` was **non-zero in both proofs** (~$0.0249 and ~$0.0411) despite
  using subscription auth, not an API key. **CONFIRMED from the earlier research phase's
  citation** (Agent SDK docs): this figure is documented as a client-side estimate, "not
  authoritative billing data... Do not bill end users or trigger financial decisions from
  these fields." This document does **not** recommend treating subscription usage as $0 cost
  — as instructed. The honest position: a *notional*, list-price-equivalent resource-
  consumption number is available and non-trivial, but it is not a real invoice line, and per-
  request dollar reconciliation the way `src/governance/budget.ts` does it today has no
  authoritative equivalent under subscription auth. What subscription usage actually consumes
  is **rolling 5-hour and weekly usage-limit budget** (per the earlier research phase's
  citation of Anthropic's own limits documentation — **not re-verified this session**,
  carried forward as INFERRED), not dollars.

**A genuine, first-hand, previously-undocumented finding: this mechanism carries substantial,
uncontrollable per-call overhead.** Both proofs, run from a completely empty directory with
maximal isolation, still incurred:
- **5,813 then 9,796 cache-creation input tokens** — almost certainly Claude Code's own system
  prompt / harness setup, not anything this proof's prompt asked for. (The second proof's
  larger prompt correlates with a larger cache-creation figure, but a `"READY"`-only prompt
  still cost 5,813 tokens of *something* before the model saw 2 tokens of actual input.)
- **A second, internal `claude-haiku-4-5-20251001` invocation in *both* proofs** (899 then
  1,022 input tokens, 9 then 12 output tokens) that this proof's own prompt never requested —
  **INFERRED** to be an internal classifier/routing step (`claude --help` separately lists an
  `auto-mode` command "Inspect or reset auto mode classifier configuration," suggesting such a
  classifier exists as part of the harness). This is not something the caller controls or can
  disable via any flag found in `--help`.

**This is the single most load-bearing finding for §14's recommendation.** `compiled context
-> model -> result + usage metadata` is achievable in shape, but the actual resource cost per
call is dominated by fixed harness overhead (thousands of tokens), not by the payload — the
opposite of what a lean provider adapter should look like, and a real efficiency concern under
Phase 10.5's "useful work per token" principle even setting aside the dollar-cost question
entirely.

---

## 11. Terms/support status

Covered substantively in §1 and §10. Summary: subscription usage for `claude -p`/Agent SDK/
third-party apps is **CONFIRMED currently permitted and currently the status quo** (not paused
— the *change away from* this was paused). It is **CONFIRMED** not the officially recommended
path for "developers building products or services" (§1's direct quote). Enforcement is
**CONFIRMED** reserved "without prior notice." The personal/solo-use carve-out is
**UNKNOWN** in its exact scope, as detailed in §1 and §16.

---

## 12. Local proof results

Both proofs ran from `%TEMP%\claude\...\scratchpad\subscription-proof\` — an empty directory
created solely for this test, entirely outside the AI Command Centre repository, chosen
specifically so that even a hypothetical isolation failure could not touch the project. `ls
-la` confirmed this directory empty before, and confirmed it still empty after, both proofs.
Confirmed beforehand (both `env | grep -i anthropic` and a check of this shell's exported
variables): **no `ANTHROPIC_API_KEY` was present anywhere in the environment at any point.**
`--bare` (the one flag documented to require an API key) was never used.

### Proof 1 — trivial prompt, maximal isolation

Command:
```bash
claude -p "Return exactly the word: READY" \
  --tools "" \
  --strict-mcp-config \
  --setting-sources "" \
  --permission-mode manual \
  --permission-prompts none \
  --output-format json \
  --no-session-persistence
```

Result: **exit code 0.** Relevant fields from the real JSON output:
```json
{
  "is_error": false,
  "subtype": "success",
  "terminal_reason": "completed",
  "result": "READY",
  "stop_reason": "end_turn",
  "permission_denials": [],
  "usage": {"input_tokens": 2, "output_tokens": 4, "cache_creation_input_tokens": 5813, "cache_read_input_tokens": 3289},
  "total_cost_usd": 0.0248978,
  "duration_api_ms": 2387, "duration_ms": 1743, "ttft_ms": 1515
}
```
`result` is exactly `"READY"` — nothing else. This directly proves: **subscription
authentication → headless invocation → model response → process exits successfully**, exactly
as you asked.

### Proof 2 — compiled-context-shaped input, schema-validated structured output

Command (isolation flags identical to proof 1, plus):
```bash
claude -p "You are a text-classification function. Given the compiled context below, return
a bounded structured result. Do not take any action, do not use any tool, only classify.

COMPILED_CONTEXT:
{\"taskInstanceId\":\"test-task-001\",\"intent\":\"classify_sentiment\",
 \"tier1_required\":[{\"kind\":\"instruction\",\"content\":\"Classify the sentiment...\"}],
 \"tier2_high_value\":[{\"kind\":\"input\",\"content\":\"The new governance chain finally
 works end to end and the tests all pass.\"}]}

Return only the classification." \
  ...[same isolation flags]... \
  --json-schema '{"type":"object","properties":{"sentiment":{"type":"string","enum":["positive","negative","neutral"]},"confidence":{"type":"number"}},"required":["sentiment","confidence"],"additionalProperties":false}'
```

Result: **exit code 0.**
```json
{
  "is_error": false,
  "subtype": "success",
  "terminal_reason": "completed",
  "result": "{\"sentiment\":\"positive\",\"confidence\":0.95}",
  "structured_output": {"sentiment": "positive", "confidence": 0.95},
  "permission_denials": [],
  "usage": {"input_tokens": 2, "output_tokens": 80, "cache_creation_input_tokens": 9796, "cache_read_input_tokens": 0},
  "total_cost_usd": 0.04107
}
```
The classification is correct (positive), the output is schema-valid, and `structured_output`
arrives as an already-parsed object separate from the raw text `result` — directly answering
§6/§7 of the original research task (context/input compatibility, structured output). This
proves a compiled-context-shaped JSON blob can be embedded in the prompt and a bounded,
schema-validated structured response returned — **without any tool use, filesystem mutation,
shell action, MCP action, browser action, external side effect, API key, or API charge.**

**Summary answer to the local-proof mandate: YES, subscription authentication → headless
invocation → model response → process exits successfully was proven, twice, with zero side
effects.**

---

## 13. Risks

1. **Terms ambiguity (§1, §16)** — not resolved by this research; a real risk that doesn't
   disappear because the technical mechanism works.
2. **Enforcement-without-notice (§1, CONFIRMED)** — a working integration today could stop
   working at any time, with no contractual notice period, unlike an API key relationship.
3. **Hidden per-call overhead (§10)** — thousands of tokens of fixed harness cost per call,
   consuming subscription usage-limit budget disproportionately to actual task size; at volume
   (an always-on multi-agent orchestrator, exactly what this project is), this could exhaust
   the 5-hour/weekly subscription limits (**INFERRED to exist, not re-verified this session**)
   far faster than the token count of the actual work would suggest.
4. **An internal, undocumented, uncontrollable secondary model call (§10)** — every proof
   incurred an extra `claude-haiku-4-5` invocation neither requested nor controllable via any
   flag found. This is opaque resource consumption from the perspective of a Budget
   Governor that expects to reason about exactly what it authorized.
5. **`--bare` (the apparently "proper" scripting mode) is incompatible with this whole
   approach (§6)** — a future Claude Code upgrade that pushes harder toward `--bare` as the
   standard headless path (as the earlier research phase found was previously announced)
   could narrow or remove the non-`--bare` subscription-auth headless path this proof relies
   on.
6. **No authoritative cost figure (§10)** — `budget.ts`'s reconciliation semantics assume a
   real monetary number; `total_cost_usd` is explicitly documented as not that number. Using
   it anyway would be exactly the "pretend subscription usage has $0 cost" mistake this task
   said not to make, inverted: pretending a client-side estimate is authoritative billing data
   is the same category of error.
7. **Subscription-tier discrepancy (§2)** — this machine authenticates as Pro, not Max; if the
   architectural decision assumes Max-tier limits specifically, that assumption should be
   re-verified against the account actually intended for runtime use.

---

## 14. Recommendation

**Do not adopt subscription-backed Claude as the V1 production provider on the strength of
this proof alone.** The proof succeeds technically — isolation, headless invocation, and
structured output all work, cleanly, with zero side effects and zero API cost. That is a real,
positive result and directly answers what was asked. But two independent, non-technical
findings each individually argue for caution: (a) the Terms question in §1/§16 is genuinely
unresolved by Anthropic's own text, not merely under-researched, and enforcement is reserved
without notice; (b) the overhead finding in §10 means this mechanism is not "the same
inference, free" — it is meaningfully more expensive in subscription-usage-limit terms than
the raw task requires, working against the project's own "maximum useful work per token"
principle regardless of the dollar question entirely.

This is not a rejection of the idea — it is a "the local proof succeeded; the two remaining
blockers are a Terms judgment call only you can make, and a real efficiency cost that should
be weighed with eyes open, not a technical failure." If you decide the personal/solo-use
reading of §1 is acceptable to you, the mechanism is technically ready for a bounded,
narrowly-scoped provider adapter behind the Model Router (§15) — but that is a risk-tolerance
decision, not something this research can resolve on your behalf.

---

## 15. Exact production integration requirements (if you later decide to proceed)

Not implemented here — for planning only, should this be authorized as a future task:

- A new `src/router/providers/claudeSubscription.ts`, structurally parallel to
  `anthropic.ts`/`openai.ts`, invoked only from `modelRouter.ts` — no change to the Model
  Router's own decision logic (it already only decides tier/model; a provider file executing
  a subprocess instead of an SDK call is invisible to it).
- The adapter would need to shell out to the `claude` binary as a child process (Node's
  `child_process`), not link a library, since this proof used the CLI, not the Agent SDK
  package (§3 remains unverified for the SDK specifically).
- Must pass, at minimum, the exact isolation flag set proven in §12:
  `--tools "" --strict-mcp-config --setting-sources "" --permission-mode manual
  --permission-prompts none --output-format json --no-session-persistence`, plus
  `--json-schema` matching whatever `expectedOutputShape` the caller provides.
- Must explicitly NOT set `ANTHROPIC_API_KEY` in the child process's environment (scrub it
  even if present in the parent, to guarantee the OAuth path is taken, per the earlier
  research phase's finding that an API key "always wins" when present).
- Must treat `total_cost_usd` as advisory only, per §10/§13 — the actual budget-governing
  quantity would need to be something else (e.g., a fixed "resource unit" derived from
  `usage.input_tokens + usage.output_tokens`, explicitly NOT labeled as a dollar figure in
  `budget_counters`, or a separate non-monetary tracking mechanism — a real design decision,
  not a detail).
- Must decide what to do with the two internal model-usage entries per call (§10) — does the
  Budget Governor see only the "primary" model's usage, or the sum of everything the harness
  actually consumed? Under-reporting here would itself be a governance gap.
- Working directory for the subprocess should be an isolated, empty directory per invocation
  (as this proof did), not the project repo, as defense-in-depth beyond the CLI flags alone.

---

## 16. Unknowns that require a decision or a further test

- **UNKNOWN (Terms):** does AI Command Centre's usage pattern (an application's own
  orchestration code headlessly invoking the unmodified `claude` binary as an internal
  component, at whatever volume the workflow demands) fall under "an end user signing in to
  the unmodified Claude Code binary with their own subscription" (permitted), or under
  "developers building products or services that interact with Claude's capabilities" (should
  use API key)? Anthropic's own text supports both readings and does not disambiguate this
  specific pattern. **This is a business/risk decision for you, not something further
  research can resolve** — Anthropic support could be asked directly ("contact sales," per
  §1's own text), which is the only way to get a binding answer rather than an inference.
- **UNKNOWN / REQUIRES TEST:** whether the Agent SDK package (as opposed to the `claude -p`
  CLI, which is what was actually tested) exposes equivalent isolation flags, or behaves
  identically under subscription auth — not tested this session (§3).
- **UNKNOWN / REQUIRES TEST:** exact rolling 5-hour/weekly subscription usage-limit numbers,
  and how many of this project's typical LLM-invocation-sized calls (given the ~6-10K token
  overhead observed in §10) they'd actually permit before throttling — would require running
  enough real calls to hit a limit, which is itself a real-cost experiment beyond this spike's
  bounded scope.
- **UNKNOWN:** whether `--tools ""` also structurally forecloses the server-side
  `server_tool_use` capability observed at zero in both proofs, or merely means it went
  unused this time (§7).
- **UNKNOWN:** whether the internal secondary haiku-model invocation (§10) is fixed overhead
  per session or per call — both proofs were single-call sessions, so this wasn't
  distinguishable; a multi-turn session inside one `claude -p` invocation might show whether
  it recurs per turn or only once per process.
- **UNKNOWN:** why this machine's account reports `subscriptionType: "pro"` rather than the
  Max plan you referenced (§2) — worth confirming which account/subscription is actually
  intended for runtime use before any further planning assumes Max-tier limits specifically.
