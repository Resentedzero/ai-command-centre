# Claude Subscription / Local LLM Provider Research

**Status:** RESEARCH ONLY — no code, schema, test, or config was changed by this investigation.
**Repo:** `C:\Users\cress\ai-command-centre` @ `7648cc264633fd23f28f8dbf7382c7c588b62331` (branch `main`)
**Date of research:** 2026-09-13
**Claude Code version observed on this machine:** `2.1.270`
**Scope:** Can subscription-backed Claude, and/or a local model, become a third file under `src/router/providers/` behind the existing Model Router chokepoint?

### How to read the confidence tags

Every load-bearing claim below carries one of:

- **CONFIRMED** — directly verified against a current official Anthropic source that I fetched in this session (cited in §13), or against first-party CLI output from the installed binary (labelled as such).
- **INFERRED** — a reasonable conclusion drawn from evidence, but not stated in those words by any official source. The basis for the inference is always given.
- **UNKNOWN / REQUIRES TEST** — cannot be settled from available documentation; needs the proof-of-concept in §15.

Third-party sources (blogs, news, vendor marketing, community benchmarks) are labelled **[third-party]** inline every time they are used, and no third-party claim is ever tagged CONFIRMED.

---

## 1. Executive conclusion

**Recommendation: OPTION 2 — use the Anthropic API now.** Full justification in §12.

The three findings that decide it:

1. **Anthropic's own legal/compliance documentation tells developers building products or services — explicitly including those using the Agent SDK — to use API key authentication, and the Agent SDK overview states that Anthropic "does not allow third party developers to offer claude.ai login or rate limits for their products."** (CONFIRMED, §2/§10.) AI Command Centre is a service that interacts with Claude's capabilities. There is a genuinely arguable single-user carve-out (§10.3), but there is **no official source that affirmatively permits** subscription OAuth as an application's inference backend, and Anthropic reserves the right to enforce "without prior notice."

2. **Isolation and subscription auth are mutually exclusive in the officially recommended headless path.** `--bare` — the mode Anthropic calls "the recommended mode for scripted and SDK calls" and says "will become the default for `-p` in a future release" — **never reads OAuth credentials or the keychain** and requires `ANTHROPIC_API_KEY`. (CONFIRMED, §5.) So the trajectory of the officially blessed scripted path is *away* from subscription-backed invocation, by construction. A weaker-but-real isolation combination that *does* preserve subscription auth exists (`--restricted --tools "" --strict-mcp-config`, §5.3) — this is a genuine finding, but it is a narrower guarantee and partly untested.

3. **Subscription usage has no per-call dollar cost, and the existing Budget Governor is genuinely monetary.** `callAnthropicModel` takes `pricePerToken` as a required 4th parameter and computes `costAmount = (tokensIn + tokensOut) * pricePerToken`; `authorizeRoute` reserves against that same price and `callModel` reconciles it. Handing a subscription or local adapter `pricePerToken: 0` does not merely report $0 — **it silently converts the Budget Governor into a no-op for that tier, deleting a governance control.** (INFERRED from reading `src/router/`, §7.) This must be decided deliberately, not defaulted into.

On the local-LLM question (§16): **local inference is a legitimate first-class Provider Adapter candidate for the CHEAP tier and should be planned for V1.1, not V1.** This machine's measured hardware (RTX 5070 Laptop, 8 GB VRAM; 31.3 GB RAM; Ryzen 9 270, 8c/16t) supports 7–9B-class quantised models entirely in VRAM — genuinely useful for extraction, classification and summarisation — but not the STRONG tier. Adding it is *semantically* free but *mechanically* not: `ProviderName` is a closed union and provider dispatch is a binary ternary (§16.11).

---

## 2. Current official Anthropic position

### 2.1 Does subscription usage currently power `claude -p` / Agent SDK?

**CONFIRMED — yes, today.** Anthropic's Help Center article *Use the Claude Agent SDK with your Claude plan* carries this notice verbatim:

> **Update June 15:** We're pausing the changes to Claude Agent SDK usage described below. For now, nothing has changed: Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription's usage limits.

The page's own update timestamp reads **June 16, 2026**. The starting reference given to this investigation was therefore accurate on this point, and it is still accurate as of 2026-09-13.

### 2.2 The June 2026 credits change — resolved with dated sources

**CONFIRMED (with an explicitly ambiguous forward position).** The sequence, per the official Help Center article:

| Date | Event | Source class |
| --- | --- | --- |
| May 2026 | Anthropic announces Agent SDK usage will move onto a separate monthly credit effective June 15, 2026 (Pro $20, Max 5x $100, Max 20x $200, Team/Enterprise tiers listed) | Official (article preserves the announcement) |
| June 15, 2026 | Change **paused on the day it was due to take effect**; the monthly credit "isn't available" | Official |
| June 16, 2026 | Article's last update timestamp | Official |
| June 16 → 2026-09-13 | **No further official update found** | Absence of evidence |

Anthropic's only forward commitment is, verbatim: *"When we have an update, we'll share it before anything takes effect."*

**This is the most important thing to be honest about in this document.** The position is not "Anthropic decided subscription-backed Agent SDK use is fine." The position is **"Anthropic announced it would meter this separately, then paused that announcement indefinitely, and has said nothing official for roughly three months."** A paused change is a stated intent that has been deferred, not withdrawn. Treating today's behaviour as a stable foundation for a V1 architecture inverts the actual signal.

The ~3-month silence is itself a finding and belongs in the risk column (§11), not in the "it's fine now" column. **[third-party]** trade press (The New Stack, VentureBeat, Zed's engineering blog, Computing) corroborates the pause and reports no subsequent reversal; none of it is authoritative on Anthropic's forward plan and none is relied on above.

### 2.3 What is officially supported TODAY for programmatic use

**CONFIRMED.** Anthropic's `code.claude.com/docs/en/legal-and-compliance` splits the two authentication methods by purpose, verbatim:

> * **OAuth authentication** is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications.
> * **Developers** building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow.

And, under *Acceptable use*, verbatim:

> Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK.

And:

> Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice.

The Agent SDK overview page repeats this as a standing Note, verbatim:

> Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the Quickstart instead.

**INFERRED:** "officially supported for a production application backend" therefore means **API key (Claude Console) or a supported cloud provider (Amazon Bedrock, Google Cloud's Agent Platform, Microsoft Foundry)** — and nothing else. Basis: the two bullets above are an exhaustive split of Claude Code's auth methods by intended purpose, and the developer bullet names the Agent SDK explicitly.

---

## 3. Subscription vs API distinction

| Question | Answer | Tag |
| --- | --- | --- |
| Can subscription usage power programmatic inference? | Yes — `claude -p` and the Agent SDK draw on subscription limits today | **CONFIRMED** (§2.1) |
| Does it consume subscription usage limits? | Yes, the same pool as interactive Claude Code and claude.ai | **CONFIRMED** — Help Center: "Pro and Max plans offer usage limits that are shared across Claude and Claude Code, meaning all activity in both tools counts against the same usage limits." |
| Is an API key required? | Not for subscription-backed invocation. **Required for `--bare`.** | **CONFIRMED** (§5.1) |
| Are API credits required? | No, for subscription-backed paths. Certain features (1M-token context on Pro; Fable on some tiers) require usage credits | **CONFIRMED** — model-config docs |
| Is this intended/supported as a production application backend? | **No.** Developers building products/services "should use API key authentication" | **CONFIRMED** (§2.3) |
| Could this change independently of the API product? | **Yes — and Anthropic already tried to change it once.** | **CONFIRMED** (§2.2) |

**The structural point (INFERRED, basis: §2.2 + §2.3):** subscription terms and API terms are governed by different documents — Consumer Terms for Free/Pro/Max, Commercial Terms for Team/Enterprise/API (CONFIRMED, legal-and-compliance page). Subscription entitlements are a *consumer product feature* Anthropic prices and re-prices at will; API pricing is a *commercial contract*. A V1 runtime whose unit economics depend on the former is exposed to a change the latter is not. The June 2026 episode is a live demonstration that this exposure is real, not theoretical.

---

## 4. Candidate mechanisms

Before comparing, the **mechanical relationship** between candidates must be stated, or the comparison double-counts. **CONFIRMED:**

- **(C) `claude -p`** is the Claude Code CLI in non-interactive/print mode. Official docs: "Add the `-p` (or `--print`) flag to any `claude` command to run it non-interactively."
- **(B) Claude Agent SDK** is a Python/TypeScript library wrapping that same agent loop. The SDK spawns the Claude Code binary as a subprocess — evidenced by the `pathToClaudeCodeExecutable` option ("Path to Claude Code executable") and by `env` being documented as replacing "the subprocess environment."
- **(D) Claude Code CLI (interactive)** is the same binary in its terminal UI.

So **B, C and D are three faces of one mechanism**, sharing an auth stack, a settings-loading stack, and a tool stack. Official docs make the substitution explicit: "To drive the same agent loop from another language, run the CLI as a subprocess with the `-p` flag and `--output-format json`."

They differ meaningfully in exactly two ways relevant here: the SDK adds in-process hooks, `canUseTool` callbacks and typed messages; the CLI adds flags (`--bare`, `--restricted`, `--tools`, `--safe-mode`) that are the real isolation levers.

| | Mechanism | What it actually is | Subscription-capable? |
| --- | --- | --- | --- |
| **A** | **Anthropic API** (`@anthropic-ai/sdk` → Messages API) | Direct HTTP to the model. No agent loop, no tools, no filesystem. **Already implemented** at `src/router/providers/anthropic.ts`. | No — API key/credits |
| **B** | **Claude Agent SDK** | Library wrapping the Claude Code binary's agent loop | Yes, today (§2.1) |
| **C** | **`claude -p`** | Same binary, print mode, driven as a subprocess | Yes, today (§2.1) |
| **D** | **Claude Code CLI (interactive)** | Same binary, terminal UI | Yes |
| **E** | *(see below)* | — | — |

### 4.1 Candidate (E): is there a fifth subscription-backed mechanism?

**CONFIRMED — no.** I looked specifically. The other officially documented Claude Code auth routes are **Amazon Bedrock, Google Cloud's Agent Platform, Microsoft Foundry, Claude Platform on AWS, Claude apps gateway, Anthropic profiles / Workload Identity Federation, and `apiKeyHelper`**. Every one of these is a *commercial/cloud-provider credential*, not a Pro/Max subscription entitlement — they are API-key-free but **not** subscription-backed, which is a different thing.

Two near-misses worth naming so they are not mistaken for a fifth option:

- **`claude setup-token`** (CONFIRMED): mints a one-year OAuth token for `CLAUDE_CODE_OAUTH_TOKEN`. Official text: *"This token authenticates with your Claude subscription and requires a Pro, Max, Team, or Enterprise plan. It can only make model requests, so it can't establish Remote Control sessions or fetch claude.ai connectors. MCP servers you configure locally still work."* This is **not a fifth mechanism** — it is a credential *for* mechanisms B/C/D. The starting reference's claim that it is narrower than `/login` is **CONFIRMED**, and the narrowing is security-relevant (§5.6). Note also it is explicitly **not read by `--bare`**.
- **Managed Agents** (CONFIRMED): a hosted REST product, described in official docs as "a separate product from the Agent SDK. Anthropic runs the agent and the sandbox." It is API/commercial, not subscription-backed.

So **row E is honestly empty.** I have populated it in §11 with the cloud-provider route purely to show it was considered and why it does not satisfy the subscription question.

---

## 5. Isolation / security analysis

The question: can Claude be invoked so it behaves as a **pure model provider** — no filesystem, no Bash, no browser, no MCP, no inherited CLAUDE.md, no ambient settings, no autonomous tool use?

### 5.1 Mechanism A (Anthropic API): isolation is total, by construction

**CONFIRMED / INFERRED.** The Messages API has no agent loop, no tool executor, no settings loader and no filesystem concept. There is nothing to disable because nothing exists. `src/router/providers/anthropic.ts` already demonstrates this: it builds a system prompt and one user message from `CompiledContext` and returns `response.content` plus `response.usage`. (CONFIRMED by reading the file; INFERRED that this constitutes complete isolation — no official source phrases it that way, because the absence of an agent loop is not something Anthropic documents as a feature.)

**This is the single strongest architectural argument for OPTION 2.** Every other candidate requires *subtracting* capability, and subtraction is where gaps live.

### 5.2 Mechanisms B/C/D: the documented isolation levers

All CONFIRMED. Sources: official docs, plus `claude --help` from the installed binary **v2.1.270** (labelled *[installed-binary v2.1.270]* — this tells you what exists in *this* build, which is not the same as a support guarantee).

| Lever | Exact documented effect | Gap |
| --- | --- | --- |
| `--bare` | *[installed-binary v2.1.270]* "Minimal mode: skip hooks, LSP, plugin sync, attribution, auto-memory, background prefetches, keychain reads, and CLAUDE.md auto-discovery… **Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper via --settings (OAuth and keychain are never read).**" Docs add: "skipping auto-discovery of hooks, skills, custom commands, subagents, plugins, MCP servers, auto memory, and CLAUDE.md" | **Kills subscription auth entirely.** Also: "In bare mode Claude has access to the Bash, file read, and file edit tools" — so `--bare` alone is *not* pure-model-provider isolation |
| `--tools ""` | *[installed-binary v2.1.270]* "Specify the list of available tools from the built-in set. **Use \"\" to disable all tools**, \"default\" to use all tools, or specify tool names" | Not found in the fetched CLI-reference page; verified only against the installed binary |
| `--restricted` | Docs, verbatim: "Use it when **an evaluation harness drives `claude` on a shared machine and Claude Code must not run commands or read that machine's user and project settings.** Claude Code removes the built-in tools that run commands or code, and WebFetch, unless you name them individually in `--tools`… confines the built-in file tools to the working directories, **loads only managed settings and `--settings`**, refuses `bypassPermissions`…" Requires v2.1.248+ | Says *settings files*; **does not state that CLAUDE.md is skipped** |
| `--safe-mode` | Docs, verbatim: "all customizations disabled…: **CLAUDE.md, skills, plugins, hooks, MCP servers, custom commands and agents**, output styles, workflows, custom themes, custom keybindings, status line and file-suggestion commands, LSP servers, and auto memory do not load. **Authentication, model selection, built-in tools, and permissions work normally, which differs from `--bare`.**" | Built-in tools still work; documented as a *troubleshooting* aid, not a security boundary |
| `--strict-mcp-config` | "Only use MCP servers from `--mcp-config`, ignoring all other MCP configurations" | — |
| `--disallowedTools "*"` | "A bare tool name removes the matching tools from Claude's context: `\"*\"` removes every tool" | — |
| `--permission-prompts none` | "anything that would prompt is denied automatically" | — |
| `settingSources: []` (SDK) | "To run without these, pass `settingSources: []`, which limits the agent to what you configure programmatically" | **Explicitly incomplete — see §5.4** |

**Do not assume disabling one tool provides isolation.** Official docs are explicit that `allowedTools` is *not* a restriction: "Tools to auto-approve without prompting. **This does not restrict Claude to only these tools.**" Restriction comes from `--tools`, `--disallowedTools`, or `--restricted`.

### 5.3 The genuinely useful finding: isolation that *preserves* subscription auth

**INFERRED (basis: combining the CONFIRMED flag semantics in §5.2).** The starting reference implied the only strong isolation mode is `--bare`, and therefore that isolation costs you the subscription. That is **not quite right**, and the correction matters.

Because `--safe-mode` explicitly states "Authentication… work[s] normally, which differs from `--bare`", and `--restricted` explicitly ignores user/project/local settings while saying nothing about disabling auth, this combination should give strong isolation **with** subscription OAuth intact:

```
claude -p --restricted --tools "" --strict-mcp-config --permission-prompts none \
       --output-format json --json-schema <schema> --model <id>
```

…optionally `--safe-mode` as well, to cover the CLAUDE.md gap that `--restricted` does not document.

**UNKNOWN / REQUIRES TEST**, specifically:
1. Do `--restricted` and `--safe-mode` **compose**, or does one reject/override the other?
2. Does `--restricted` alone suppress **CLAUDE.md** loading? Its documented text covers *settings files*, not memory files. This repo has a `CLAUDE.md` at its root that would otherwise be injected into every invocation — an unacceptable context contaminant for a task-scoped model call.
3. Does `--tools ""` survive alongside `--restricted` (whose text says code-running tools return only if "you name them individually in `--tools`, not through the `default` preset")?
4. Does a `--tools ""` session still emit a usable result, or does the agent loop require at least one tool?

These are cheap to settle (§15) and are the highest-value unknowns in this document.

### 5.4 Where isolation is *officially documented to leak*

**CONFIRMED — and this is the decisive isolation finding for mechanisms B/C/D.** The Agent SDK docs carry this warning verbatim:

> Do not rely on default `query()` options for multi-tenant isolation. Because the inputs above are read regardless of `settingSources`, an SDK process can pick up host-level configuration and per-directory memory.

The inputs read **regardless of `settingSources`** are documented as:

| Input | Behaviour | Disable how |
| --- | --- | --- |
| Managed policy settings (MDM plist, **Windows registry policy**, managed settings file) | "loads from the host" | Remove from host; **cannot be disabled from the SDK** |
| Server-managed settings | Fetched when authenticating with a qualifying credential, incl. an organization OAuth login | "an Owner in your Claude organization controls them; **you can't disable them from the SDK**" |
| `~/.claude.json` global config | "**Always read**" | Relocate via `CLAUDE_CONFIG_DIR` |
| Auto memory `~/.claude/projects/<project>/memory/` | "Loaded into the system prompt at session start" | `autoMemoryEnabled: false` / `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` |
| claude.ai MCP connectors | "Loaded when the session authenticates with your claude.ai login. **Passing `mcpServers: {}` does not suppress the connectors**" | `strictMcpConfig: true` / `disableClaudeAiConnectors` / `ENABLE_CLAUDEAI_MCP_SERVERS=false` |

**The last row is the sharpest one for this project.** A subscription `/login` credential pulls in **claude.ai MCP connectors** — on this machine that demonstrably includes Gmail and Google Calendar. A Task Instance's model call could, absent explicit suppression, reach live mail and calendar tools that the Capability/Policy system never authorized and that the Event log would never record as tool Invocations. That is a **direct breach of the governance model**, not a theoretical one.

The mitigation is real (`--strict-mcp-config`, or a `setup-token` credential, which per §4.1 "can't… fetch claude.ai connectors"), but note the shape of the problem: **subscription auth is the very thing that pulls the connectors in.** Isolation and subscription auth pull against each other at yet another point.

**INFERRED conclusion for §5:** mechanisms B/C/D can be hardened *substantially* but the residual surface is (a) non-zero, (b) documented by Anthropic itself as unsuitable for isolation guarantees, and (c) dependent on flag semantics that have shifted across recent minor versions (`--restricted` needs v2.1.248+, `--permission-prompts` needs v2.1.259+ — both within the last few releases). Mechanism A has no such surface at all.

### 5.5 Windows note

**CONFIRMED.** The starting reference's claim about sandboxing is accurate. Official sandboxing docs, verbatim: *"The sandbox is built into Claude Code and runs on macOS, Linux, and WSL2. **Native Windows is not supported.** On Windows, run Claude Code inside a WSL2 distribution."*

**INFERRED:** for an always-on **native Windows** runtime (this project's target, per the environment), the OS-enforced Bash-sandbox layer of defence-in-depth is simply unavailable. Isolation on Windows therefore rests entirely on Claude Code's own flag-level tool removal — one layer, not two. This weakens B/C/D on this specific host and does not affect A at all (which has no Bash tool to sandbox).

### 5.6 Credential and session-state location

Where credentials live, whether the runtime would need the user's Claude Code configuration, and whether secrets can stay outside model context.

**Where credential/session state lives — CONFIRMED** (authentication docs):

| Platform | Location |
| --- | --- |
| Windows | `%USERPROFILE%\.claude\.credentials.json` — "inherit[s] the access controls of your user profile directory, which restricts the file to your user account by default" |
| macOS | Encrypted Keychain; falls back to `~/.claude/.credentials.json` mode `0600` when the Keychain rejects the write |
| Linux | `~/.claude/.credentials.json` mode `0600` |
| Relocation | `CLAUDE_CONFIG_DIR` moves `.credentials.json` (and keys the macOS Keychain entry to that directory), so "a session with a different `CLAUDE_CONFIG_DIR` reads a different entry" |

**Would the runtime need the user's Claude Code configuration?**

- **Mechanism A: no.** One environment variable (`ANTHROPIC_API_KEY`), read at call time. `src/router/providers/anthropic.ts` reads it from `process.env` inside the call and never logs or echoes it; a missing key throws a message naming the *variable*, never its value. Nothing else on the host is consulted. (CONFIRMED by reading the file.)
- **Mechanisms B/C/D: yes, unavoidably.** Beyond the credential file, §5.4 documents inputs read **regardless of `settingSources`** — managed policy (including a **Windows registry policy**), `~/.claude.json` ("Always read"), auto memory, and claude.ai MCP connectors. **INFERRED:** a runtime Invocation on B/C/D therefore *can* inherit user/project configuration the runtime never chose, and on Windows the registry-policy path is one this project has never inspected (**U10**).

**Environment variables and config files involved — CONFIRMED.** Credential-bearing or credential-selecting variables include `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_PROFILE`, the WIF federation variables, the cloud-provider selectors (`CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY`), plus the `apiKeyHelper` setting. Note the precedence hazard (CONFIRMED): in non-interactive mode "(`-p`), the key is always used when present" — so a stray `ANTHROPIC_API_KEY` in the runtime's environment would **silently divert a subscription-intended invocation onto billed API usage**, with no prompt.

**The `claude setup-token` narrowing — CONFIRMED and security-relevant.** The token "can only make model requests, so it can't establish Remote Control sessions or fetch claude.ai connectors." **INFERRED:** this is the narrowest subscription credential available and materially reduces §5.4's connector-leak risk. The trade-off is that it is a **one-year bearer credential that must be stored somewhere the always-on runtime can read** — converting a keychain/ACL-protected file into a long-lived secret in an env var or config, whose compromise grants a year of subscription access.

**Can secrets stay completely outside model context?**

- **Mechanism A: yes — CONFIRMED by construction.** The only secret is the API key, used as a transport header; it never enters `CompiledContext` and the Context Compiler never sees it.
- **Mechanisms B/C/D: not guaranteed — INFERRED.** With file tools removed (`--tools ""`) the agent cannot read `.env` or credential files, so the *direct* path closes. But secure-deployment docs warn that even read-only workspace access can expose credentials, listing `.env`, `~/.git-credentials`, `~/.aws/credentials`, `*.pem` among others — a risk that returns the moment any file tool is re-enabled. The documented strong mitigation is the **credential-proxy pattern** (agent never sees the credential; a proxy outside the boundary injects it), which is architecture this project does not have and would have to build.

---

## 6. Context / input compatibility

Target shape: `compiled context -> model -> result + usage metadata`.

### Mechanism A — native fit

**CONFIRMED by reading `src/router/providers/anthropic.ts`.** Already implemented; `CompiledContext` → `system` + `messages[0].content` → `response.content` + `response.usage`. Zero adaptation required.

### Mechanisms B/C/D — workable with real adaptation

- **Input: CONFIRMED.** Non-interactive mode reads stdin ("you can pipe data in and redirect the response out like any other command-line tool"), with a documented **10 MB stdin cap**. A compiled context blob fits comfortably. Alternatively `--system-prompt` / `--append-system-prompt[-file]`.
- **Bounded output: CONFIRMED.** `--output-format json` + `--json-schema` yields a `structured_output` field. `--max-turns` bounds agentic turns ("Exits with an error when the limit is reached").
- **Structured output is NOT a server-side guarantee — CONFIRMED.** Official text, verbatim: *"the SDK validates the output against it, **re-prompting on mismatch**. If validation does not succeed within the retry limit, the result is an error instead of structured data."* Failure surfaces as result subtype `error_max_structured_output_retries`. Also documented: a result can be `success` **with no `structured_output`** — "Treat that case as a failure as well."

  The starting reference's claim here is **CONFIRMED**. Architecturally this matters: **re-prompting consumes additional tokens and additional wall-clock inside a single Invocation**, so a retry storm inflates real usage against a budget reservation that was computed once, pre-dispatch, by `authorizeRoute`. Schema-driven retries are invisible to the reservation.

- **Adaptation required (INFERRED):** a subprocess lifecycle (spawn, stdin write, stdout/stderr capture, exit-code handling, SIGTERM semantics — CONFIRMED: SIGTERM yields exit code 143 and "records no result"), NDJSON parsing for `stream-json`, and turning a multi-turn agent loop into a single logical Invocation. This is **materially more machinery than an HTTP call**, and every line of it lives in a module that must not leak beyond `src/router/providers/`.

---

## 7. Usage / accounting analysis

### 7.1 What the current code actually does

**CONFIRMED by reading `src/router/`:**

```
providers/anthropic.ts : costAmount = (tokensIn + tokensOut) * pricePerToken   // 4th param, required
modelRouter.ts         : estimateCost() reserves (maxInputTokens + expectedOutputTokens) * pricePerToken
                         reconcileBudget(tx, route.reservationId, providerResult.usage.costAmount)
                         invocation_completed.usage = { tokensIn, tokensOut, cacheHit, costAmount, modelId }
```

Budget accounting is **genuinely monetary end to end**: a Pass-1 reservation in dollars, a Pass-3 reconciliation in dollars, against `budget_counters`.

### 7.2 What metadata each mechanism yields

| Field | A (API) | B/C/D (SDK / `-p --output-format json`) |
| --- | --- | --- |
| Input tokens | `usage.input_tokens` — **authoritative** | `usage.input_tokens` (CONFIRMED) |
| Output tokens | `usage.output_tokens` — **authoritative** | **Read from the *result* message only.** Per-step `output_tokens` is documented as "a placeholder" (CONFIRMED) |
| Cache tokens | `cache_creation_input_tokens` / `cache_read_input_tokens` | Same (CONFIRMED) |
| Model identifier | Explicit request + response | `system/init` event; `modelUsage` keys per model (CONFIRMED) |
| Request/invocation id | Response `id` | `session_id`, per-message `id`, event `uuid` (CONFIRMED) |
| Latency | Measure locally | `duration_ms`, `duration_api_ms` (CONFIRMED) |
| Errors | HTTP status + typed errors | `is_error`, result `subtype`, `system/api_retry` events with a documented `error` category enum (CONFIRMED) |
| Stop reason | `stop_reason` | Result `subtype`; `permission_denials` array (CONFIRMED) |
| **Monetary cost** | **Real, from real pricing** | **`total_cost_usd` — an estimate. See below.** |

### 7.3 `total_cost_usd` is not billing data — CONFIRMED

Anthropic's cost-tracking page carries this as a Warning, verbatim:

> The `total_cost_usd` and `costUSD` fields are **client-side estimates, not authoritative billing data.** The SDK computes them locally from a price table bundled at build time… They can drift from what you are actually billed when: pricing changes; the installed SDK version does not recognize a model; billing rules apply that the client cannot model… **Use these fields for development insight and approximate budgeting.** For authoritative billing, use the Usage and Cost API or the Usage page in the Claude Console. **Do not bill end users or trigger financial decisions from these fields.**

The starting reference is **CONFIRMED**. Note the last sentence is a direct instruction against exactly the use the Budget Governor would make of it: `reconcileBudget` *is* a financial decision.

Three further accounting traps, all **CONFIRMED**:
- `usage` **excludes subagent tokens**; only `total_cost_usd` and `modelUsage` include them. A `usage`-based reconciliation would under-count whenever the agent loop spawns anything.
- On `error_during_execution` after a crash, "every cost field may be zeroed" — a crashed Invocation can reconcile to $0 despite having spent real tokens.
- On `error_max_budget_usd`, `usage` omits the response that crossed the budget while `total_cost_usd` includes it.

### 7.4 What accounting is possible under a subscription — stated plainly

**There is no per-call dollar cost under a subscription.** A subscription is a flat periodic entitlement metered as opaque "usage" against a 5-hour and a weekly limit; Anthropic exposes those as progress bars in Settings → Usage (CONFIRMED), **not** as a per-request quantity in any documented API.

**I do not recommend treating subscription usage as $0 cost.** Doing so makes `estimateCost` return 0, makes `reserveBudget` always authorize, and makes `reconcileBudget` a no-op — the Budget Governor would still *run*, still emit events, and still be structurally present in the code while enforcing nothing. That is worse than having no budget governor, because the events would assert governance that is not occurring.

What *is* honestly possible instead (all **INFERRED** — these are architectural options, not documented Anthropic behaviour):

1. **Token accounting as the primary counter.** `tokensIn`/`tokensOut` are real and available for every mechanism including local models. A non-monetary `budget_counters` cost class denominated in tokens preserves genuine enforcement.
2. **An explicit imputed/shadow price**, recorded in the event payload as *imputed* — e.g. price the work at the equivalent API list rate so subscription and API tiers stay commensurable, with the event carrying a flag so no downstream reader mistakes it for money spent.
3. **A separate resource counter per constraint** — e.g. invocations-per-rolling-5-hours, mirroring the real limit that actually binds (§9.1).

Options 1 and 3 are the honest ones. Option 2 is useful for cross-tier comparison but must never be reported as spend. **The key requirement: whichever is chosen, the event record must make the accounting basis explicit, so no consumer of the Event log can mistake imputed units for dollars.**

---

## 8. Model selection

- **CONFIRMED — aliases and full names both work.** `--model` accepts "a model alias such as `sonnet`, `opus`, `haiku`, or `fable`, or a model's full name." Documented aliases include `default`, `best`, `fable`, `sonnet`, `opus`, `haiku`, `sonnet[1m]`, `opus[1m]`, `opusplan`. Selection precedence: `/model` → `claude --model` → `ANTHROPIC_MODEL` → settings `model` → `ANTHROPIC_DEFAULT_MODEL`.
- **INFERRED — a router should prefer explicit model IDs over aliases.** Basis: aliases are documented to resolve differently by provider (the same `sonnet` alias maps to Sonnet 5 on the Anthropic API, Sonnet 4.6 on Claude Platform on AWS, Sonnet 4.5 on Bedrock/Vertex, Sonnet 4.5 on Foundry — CONFIRMED). An alias is therefore a *floating* reference. For a system that records `modelId` on immutable Events and reconciles cost against a per-model price, a floating reference makes the Event log non-reproducible. This directly affects `tierConfig.ts`, whose own header already flags its model IDs as "illustrative placeholders… not a verified product decision."
- **CONFIRMED — subscription-backed selection has different restrictions than API.** Model availability varies by plan: Opus-with-1M is included on Max/Team/Enterprise but "Requires usage credits" on Pro; Fable "can bill to usage credits depending on your plan and seat tier"; defaults differ (Max/Team Premium/Enterprise → Opus 5; Pro and Team Standard → Sonnet 5). Also verbatim: *"Claude Code checks these plan requirements only when it connects to the Anthropic API directly."*
- **INFERRED:** under a subscription, **the set of models a router may select is a function of the user's current plan tier**, which the runtime cannot introspect from any documented API and which changes when the user changes plan. A router's tier→model map would silently become invalid on a downgrade. Under an API key the model set is stable and explicit.
- **CONFIRMED — a useful reliability feature exists on B/C/D and not on A-as-implemented:** `--fallback-model` "Enable automatic fallback to the specified model(s) when the primary model is overloaded or not available… Accepts a comma-separated list tried in order." Note this cuts both ways: an automatic silent model substitution would make the `modelId` recorded on `invocation_started` differ from the model that actually served the request, unless the adapter reads the served model back from `modelUsage`.

---

## 9. Reliability / operations

### 9.1 Rate and session limits — CONFIRMED

The starting reference's claim is accurate. Official Help Center: session-based usage limits **reset every five hours**, and Max plans "also have a weekly usage limit that applies across all models." Users see both as progress bars under Settings → Usage.

**INFERRED — and this is an operational showstopper for an always-on runtime.** A 5-hour rolling limit plus a weekly ceiling, shared with the user's *interactive* Claude Code and claude.ai usage, means:
- An autonomous Workflow Run can exhaust the user's personal Claude access as a side effect. The failure mode is not "the runtime slows down" — it is "the human can no longer use Claude."
- The limits are **opaque**: there is no documented API to query remaining headroom before dispatch. The Budget Governor would be reserving against a budget it cannot observe.
- Limit exhaustion surfaces as a `rate_limit` error category mid-run (CONFIRMED: `system/api_retry` carries `error: "rate_limit"`), i.e. as an Invocation failure rather than a pre-dispatch authorization denial. This **inverts the governance model**, which is designed to refuse work *before* starting it.

By contrast, API rate limits are published per-tier and return standard headers — **UNKNOWN** in precise current numbers (I did not fetch the API rate-limit page), but structurally observable rather than opaque.

### 9.2 Concurrency, timeouts, long-running calls

- **CONFIRMED:** `-p` waits for background subagents/workflows, capped by default at **10 minutes of continuous idle waiting** (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`); background Bash tasks are killed ~5 s after the final result; MCP startup waits up to `MCP_TIMEOUT` (30 s default).
- **CONFIRMED:** SIGTERM → exit 143, turn left unfinished, **no result recorded**. An Invocation killed this way yields no usage data at all.
- **INFERRED:** per-invocation process startup is a real cost for B/C/D. `--bare` exists specifically "to reduce startup time," which is itself evidence that non-bare startup is slow — and `--bare` is unavailable if you want the subscription. **UNKNOWN / REQUIRES TEST:** actual cold-start latency of `claude -p --restricted` on this machine.
- **UNKNOWN:** concurrency limits for parallel `claude -p` subprocesses against one subscription. Not documented. Each is a full Node process with its own context load.

### 9.3 Authentication / session expiry — a real operational hazard

**CONFIRMED, and directly on point.** Official docs:
> Renewing early matters most for sessions that run unattended. A background session… that outlives the login stops making progress once the credential expires and can't recover until you sign in again.

And: "Once the stored login expires and can't be refreshed, each model request fails with `Login expired · Please run /login`."

**INFERRED:** an always-on Windows runtime backed by `/login` OAuth **will eventually halt and require a human at a browser.** `claude setup-token` mitigates this (a one-year token) but does not eliminate it — it relocates the outage to a yearly cliff, and the token is a long-lived subscription-scoped bearer credential that must then be stored somewhere (§5.6). An API key has no interactive renewal requirement at all.

### 9.4 Does it require a logged-in environment?

**CONFIRMED — yes for subscription paths.** Credentials live on disk per-user; on Windows at `%USERPROFILE%\.claude\.credentials.json`, which "inherit[s] the access controls of your user profile directory." A service account or non-interactive Windows service would not see a credential established by an interactive user login unless `CLAUDE_CODE_OAUTH_TOKEN` is supplied explicitly.

---

## 10. Terms / support caveats

### 10.1 The clear prohibitions — CONFIRMED

For any **multi-user or distributed** version of AI Command Centre, subscription-backed Claude is **unambiguously not permitted**:
- "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users."
- "developers may not collect, store, or intermediate Claude.ai credentials or session tokens."
- "Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf."

### 10.2 The clear direction for developers — CONFIRMED

- "Developers building products or services that interact with Claude's capabilities, including those using the Agent SDK, **should use API key authentication**."
- Agent SDK overview: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."

### 10.3 The genuine ambiguity — stated honestly rather than resolved conveniently

**The single-user, local, personal case is not cleanly addressed by these documents, and I will not pretend otherwise.**

Arguments that a purely personal AI Command Centre falls *outside* the prohibitions:
- Every prohibition is scoped to **third-party developers serving other users** ("on behalf of their users", "into their own applications", "their end users"). A single-user local tool has no other users.
- The page contains an explicit preservation, verbatim: *"Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription…"* — and shelling out to the unmodified `claude` binary, signed in by the user themself, on the user's own machine, is arguably exactly that.
- The complementary carve-out for API keys — "configuring an API key in a development environment… for use by the customer's own authorized users" — shows Anthropic does contemplate self-serving infrastructure.

Arguments that it falls *inside*:
- The developer bullet is written about **what you are building** ("products or services that interact with Claude's capabilities"), not about how many people use it. AI Command Centre is a service that interacts with Claude's capabilities.
- **"Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."** An autonomous, always-on orchestration runtime dispatching Invocations without a human in the loop is a poor fit for "ordinary, individual usage" — arguably the strongest single sentence against Option 1, because it applies *regardless* of user count.
- The preservation clause is about **a person signing in and using Claude Code**, not about a daemon driving it unattended.
- "Anthropic reserves the right to take measures to enforce these restrictions and **may do so without prior notice**."

**Tag: UNKNOWN — genuinely ambiguous in the official documentation.** The documents do not contain a sentence that settles it either way. What they *do* contain is a clear statement of which credential Anthropic intends for this shape of work, and no affirmative permission for the other. **The asymmetry matters: an architecture decision should not rest on the absence of an explicit prohibition when an explicit direction points the other way.** For a definitive answer, the legal page's own remedy is to contact Anthropic sales.

### 10.4 Trajectory risk — CONFIRMED facts, INFERRED trend

Three independently confirmed facts point the same direction:
1. Anthropic announced separate metering for Agent SDK/`claude -p` usage, then paused it with no resolution for ~3 months (§2.2).
2. `--bare`, which **cannot** use OAuth, is "the recommended mode for scripted and SDK calls" and "**will become the default for `-p` in a future release**."
3. Developer-facing docs consistently direct programmatic use to API keys (§10.2).

**INFERRED:** the direction of travel is toward separating subscription (interactive, human) from programmatic (API, metered). Building V1's provider on the subscription path means building on the side of that line Anthropic appears to be moving away from — and fact (2) means a future `-p` default change could break a subscription-backed adapter *without any action by this project*.

---

## 11. Comparison table

Scores: **5 = excellent / 1 = poor**, for *this* project's requirements specifically.

| Criterion | **A** Anthropic API | **B** Agent SDK | **C** `claude -p` | **D** CLI interactive | **E** Cloud providers (Bedrock/Vertex/Foundry) |
| --- | --- | --- | --- | --- | --- |
| **Official support for this use** | **5** — explicitly the directed method | **2** — SDK note directs to API keys | **2** — same stack, same direction | **1** — not designed for programmatic use | **5** — explicitly named as supported |
| **Subscription compatibility** | **1** — N/A by design | **4** — works today, paused change pending | **4** — works today, same caveat | **4** — works today | **1** — *not subscription-backed at all* |
| **Isolation** | **5** — no agent loop exists to escape | **2** — documented to leak (§5.4); connectors risk | **3** — better flags (`--restricted`, `--tools ""`); still leaks | **1** — full ambient config | **2** — same agent loop as B/C |
| **Model control** | **5** — explicit IDs, stable | **3** — plan-dependent availability | **3** — same | **2** — same, plus human override | **4** — explicit, but different alias mapping |
| **Usage accounting** | **5** — authoritative tokens + real cost | **2** — "not authoritative billing data"; subagent/crash gaps | **2** — same | **1** — none | **4** — real cost, provider-billed |
| **Reliability / ops** | **5** — stateless HTTP, published limits | **2** — 5h/weekly opaque limits, login expiry, process spawn | **2** — same | **1** — needs a human | **4** — stateless, cloud SLAs |
| **Security** | **5** — key in one env var, nothing else read | **2** — ambient config, connectors, long-lived OAuth on disk | **3** — `--restricted` helps; no Windows sandbox | **1** — worst case | **3** — cloud creds on host |
| **Implementation complexity** | **5** — *already implemented* | **2** — subprocess lifecycle, NDJSON, turn→Invocation mapping | **2** — same | **1** — not viable | **3** — SDK supports it, but new config surface |
| **Suitability as V1 provider** | **5** | **2** | **2** | **1** | **3** — viable but adds cloud dependency for no current benefit |
| **Risk of depending on a changing mechanism** | **5** (low risk) — commercial contract | **1** (high) — paused change; `--bare` default coming | **1** (high) — same | **1** (high) | **4** (low-ish) — third-party roadmaps |
| **TOTAL (/50)** | **46** | **22** | **24** | **14** | **33** |

Note on row **E**: included for completeness per §4.1. It scores respectably but **answers a different question** — it removes the API *key* while remaining fully commercial/metered. It is not a subscription-backed option and adds a cloud dependency that buys this project nothing it does not already have from A.

Note on **B vs C**: C edges out B only because the CLI exposes `--restricted`, `--tools ""` and `--safe-mode` as flags, where the SDK's `settingSources: []` is documented as insufficient (§5.4). This is a narrow, mostly tactical difference between two faces of one mechanism.

---

## 12. Recommendation

### **OPTION 2 — use the Anthropic API now.**

#### Why not OPTION 1 (subscription-backed Claude)

Four independent reasons, any one of which would be sufficient:

1. **Terms.** No official source affirmatively permits subscription OAuth as an application's inference backend; the official documents direct developers building products or services — explicitly naming the Agent SDK — to API keys, and reserve enforcement without notice. The single-user case is genuinely ambiguous (§10.3), but **"not clearly prohibited" is a weak foundation for a frozen architecture**, especially when "ordinary, individual usage" is the stated basis for the limits and an autonomous runtime is not obviously that.
2. **Governance.** Subscription usage cannot produce a real `costAmount`. Adopting it forces either a silently-neutered Budget Governor (unacceptable — it would emit events asserting enforcement that is not happening) or a redesign of budget semantics. **That redesign should be a deliberate decision made on its merits, not a side effect of a provider choice.**
3. **Isolation.** The strongest isolation mode (`--bare`) cannot use the subscription, and subscription auth is precisely what pulls claude.ai MCP connectors (Gmail, Calendar on this machine) into scope — tools the Capability/Policy system never authorized and the Event log would never record. Anthropic itself documents that `settingSources` does not guarantee isolation.
4. **Operations.** Opaque 5-hour/weekly limits shared with the user's own interactive Claude usage, surfacing as mid-run failures rather than pre-dispatch denials; plus an unattended-login-expiry failure mode Anthropic documents explicitly.

#### Why not OPTION 3 (keep the adapter abstract, defer integration)

**Because there is nothing left to defer.** `src/router/providers/anthropic.ts` already exists, already imports `@anthropic-ai/sdk`, already reads `ANTHROPIC_API_KEY` at call time, already returns `{result, usage}`, and is already wired through `callModel` via `tierConfig`. The chokepoint is built and the 264-test suite passes with the provider mocked. Option 3 would mean *un-building* a working adapter, or renaming the status quo "deferral." Deferral is the right posture for the *subscription* and *local* adapters — which is what this document recommends for them — but the API adapter is past that point.

#### What OPTION 2 actually requires (not implementation — scope only)

The adapter works; what is unresolved is **configuration**, and `tierConfig.ts`'s own header says so: its model IDs are "illustrative placeholders (current-generation-looking names), not a verified product decision," and `pricePerToken` is "a flat, blended per-token placeholder… not a claim about real provider pricing." Closing Option 2 means:
- Choosing real, explicit model IDs (not aliases — §8) for `CHEAP` and `STRONG`.
- Replacing the blended `pricePerToken` with real per-model pricing. **Note the flat blended rate structurally under-prices output tokens**, which cost several times input at list price — so Pass-3 reconciliation currently under-reports on output-heavy Invocations.
- Deciding whether `estimateCost`'s worst-case reservation should distinguish input from output pricing.

None of that is provider work; it is config and one pricing decision.

#### On "maximum useful work per token/dollar"

The brief asks not to optimise merely for avoiding cost. Option 2 is the *more expensive* option in immediate cash and the correct one anyway, because:
- It is the only option where `costAmount` means what the schema says it means, so the Budget Governor can actually do its job — which is precisely the mechanism that delivers useful-work-per-dollar over time.
- It preserves the single-chokepoint rule cleanly: one SDK import, one env var, no subprocess, no ambient config.
- **The real token-efficiency lever is §17's hybrid, not the subscription.** Routing cheap deterministic-ish work to a local model is a far larger efficiency win than changing how Claude is billed, and it carries no terms risk at all.

#### Recommended posture, in one line

**Ship V1 on the Anthropic API (Option 2). Treat subscription-backed Claude as REJECTED-for-now on terms and governance grounds, revisit only if Anthropic publishes an affirmative permission or resolves the paused metering in a way that creates one. Treat local inference as an approved V1.1 third adapter, gated on the budget-accounting decision in §7.4.**

---

## 13. Evidence / source links, organised by claim

### Official Anthropic — Help Center
| URL | Fetched? | Supports |
| --- | --- | --- |
| `https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan` | **Fetched (×2)** | §2.1 pause notice verbatim; §2.2 timeline, June 16 2026 timestamp, "we'll share it before anything takes effect" |
| `https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan` | **Fetched** | §3 shared usage limits; ANTHROPIC_API_KEY precedence |
| `https://support.claude.com/en/articles/9797557-usage-limit-best-practices` | **Fetched** | §9.1 five-hour session + weekly progress bars |
| `https://support.claude.com/en/articles/11049741-what-is-the-max-plan` | Found (search) | §9.1 five-hour reset, weekly limit across all models |
| `https://support.claude.com/en/articles/12429409-extra-usage-for-paid-claude-plans` | Found (search) | §3 usage credits |

### Official Anthropic — Claude Code / Agent SDK documentation
| URL | Fetched? | Supports |
| --- | --- | --- |
| `https://code.claude.com/docs/en/legal-and-compliance` | **Fetched** | §2.3, §10.1–10.3 — OAuth vs API key purpose split; "ordinary, individual usage"; enforcement without notice; end-user preservation clause |
| `https://code.claude.com/docs/en/authentication` | **Fetched** | §3 precedence (7 levels); §4.1 `claude setup-token` scope; §5.6 credential storage incl. Windows path, `CLAUDE_CONFIG_DIR`, `-p` always-uses-key hazard; §9.3 login expiry / unattended sessions |
| `https://code.claude.com/docs/en/headless` | **Fetched** | §5.2 `--bare` (never reads OAuth; recommended for scripted/SDK; future `-p` default); §6 stdin 10 MB cap, `--json-schema`, `structured_output`; §7 `total_cost_usd` is a client-side estimate; §9.2 background-wait cap, SIGTERM/exit 143 |
| `https://code.claude.com/docs/en/agent-sdk/overview` | **Fetched** | §2.3 the "does not allow third party developers to offer claude.ai login" Note; §4 SDK↔CLI relationship; §4.1 Managed Agents |
| `https://code.claude.com/docs/en/agent-sdk/claude-code-features` | **Fetched** | §5.4 — `settingSources`, the multi-tenant isolation Warning, and the table of inputs read regardless (managed policy, `~/.claude.json`, auto memory, **claude.ai MCP connectors**) |
| `https://code.claude.com/docs/en/agent-sdk/cost-tracking` | **Fetched** | §7.3 the full "not authoritative billing data" Warning; subagent/crash accounting gaps; cache token fields |
| `https://code.claude.com/docs/en/agent-sdk/structured-outputs` | **Fetched** | §6 client-side validation + re-prompting; `error_max_structured_output_retries`; success-with-no-output case |
| `https://code.claude.com/docs/en/agent-sdk/typescript` | **Fetched** | §5.2 `allowedTools` "does not restrict Claude to only these tools"; `disallowedTools` `"*"`; `pathToClaudeCodeExecutable`; `env` replaces subprocess env |
| `https://code.claude.com/docs/en/agent-sdk/secure-deployment` | **Fetched** | §5 threat model, isolation technologies; §5.6 credential-proxy pattern and the credential-bearing-files warning list |
| `https://code.claude.com/docs/en/cli-reference` | **Fetched (×2)** | §5.2 `--restricted` full text ("evaluation harness… must not run commands or read that machine's user and project settings"); `--safe-mode` full text; `--json-schema`; `--fallback-model`; `--permission-prompts` |
| `https://code.claude.com/docs/en/sandboxing` | **Fetched** | §5.5 "runs on macOS, Linux, and WSL2. Native Windows is not supported." |
| `https://code.claude.com/docs/en/model-config` | **Fetched** | §8 aliases, per-provider alias resolution, plan-dependent availability, "checks these plan requirements only when it connects to the Anthropic API directly" |
| `https://code.claude.com/docs/en/permission-modes` | Found (search) | §5.2 permission modes; `--restricted` refuses `bypassPermissions` (v2.1.248+) |

### First-party CLI output (installed binary, v2.1.270 — labelled distinctly)
| Command | Supports |
| --- | --- |
| `claude --version` → `2.1.270 (Claude Code)` | Version basis for all *[installed-binary]* claims |
| `claude --help` | §5.2 verbatim `--bare`, `--restricted`, `--safe-mode`, `--tools ""`, `--strict-mcp-config` text. **Evidence of what exists in this build — not a support guarantee.** No model was invoked. |

### First-party hardware measurement (this machine — §16)
| Command | Result |
| --- | --- |
| `nvidia-smi --query-gpu=...` | `NVIDIA GeForce RTX 5070 Laptop GPU, 8151 MiB, driver 591.84` |
| Registry `HardwareInformation.qwMemorySize` | RTX 5070 Laptop: **7.96 GB**; Radeon 780M iGPU: 0.5 GB |
| `Win32_ComputerSystem` / `Win32_Processor` | **31.3 GB RAM**; AMD Ryzen 9 270, **8 cores / 16 threads** |
| `Get-Command ollama / lms / llama-server` | **None installed** |
| ⚠️ `Win32_VideoController.AdapterRAM` | Reported **4 GB** — a known WMI artifact (32-bit field caps at 4 GiB). **Do not use.** `nvidia-smi` and the registry agree on ~8 GB. |

### Repository source read (read-only, unmodified)
| Path | Supports |
| --- | --- |
| `C:\Users\cress\ai-command-centre\src\router\providers\anthropic.ts` | §5.1, §7.1 — `pricePerToken` 4th param; `costAmount` formula; SDK-import chokepoint comment |
| `C:\Users\cress\ai-command-centre\src\router\modelRouter.ts` | §7.1 — `estimateCost`, `reserveBudget`, `reconcileBudget`, `invocation_completed.usage`; **binary provider ternary** |
| `C:\Users\cress\ai-command-centre\src\router\tierConfig.ts` | §8, §12 — `ProviderName = "anthropic" \| "openai"` closed union; placeholder model IDs; blended `pricePerToken` |
| `C:\Users\cress\ai-command-centre\src\router\types.ts` | §16.11 — **`ModelTier = "CHEAP" \| "STRONG"` — there is no STANDARD tier** |

### Non-Anthropic sources — used only where no official Anthropic source exists, never load-bearing

**Read the `Fetched?` column carefully: it is what licensed the confidence tag on each claim.** A row marked *Found (search only)* was never opened, so nothing resting on it rises above **[third-party, unverified]** — including the vendor-official-looking llama.cpp row.

| URL | Fetched? | Class | Use |
| --- | --- | --- | --- |
| `https://docs.ollama.com/api/openai-compatibility` | **Fetched** | Vendor-official (Ollama) | §16.2 — supported endpoints, "[x] Tools", `tool_choice` unsupported, "[x] Streaming", `stream_options.include_usage`. The **only** §16 runtime claims backed by a page I actually opened |
| `https://docs.ollama.com/api` | **Fetched** | Vendor-official (Ollama) | §16.2 base URL `localhost:11434`; page did not carry the timing/usage field detail |
| `https://support.claude.com/...15036540...` (re-fetch) | **Fetched** | Official Anthropic | §2.2 — confirmed **no date later than June 15/16, 2026** appears on the page |
| `https://thenewstack.io/anthropic-pauses-claude-agent-sdk-subscription-change/` | Found (search only) | **[third-party]** | Corroborates §2.2 pause date only |
| `https://zed.dev/blog/anthropic-subscription-changes` | Found (search only) | **[third-party]** | Corroborates §2.2 |
| `https://venturebeat.com/technology/anthropic-reinstates-openclaw-and-third-party-agent-usage-on-claude-subscriptions-with-a-catch` | Found (search only) | **[third-party]** | Corroborates §2.2; **not** relied on for Anthropic's forward plan — headline suggests a reinstatement this document does **not** treat as authoritative |
| `https://www.computing.co.uk/news/2026/ai/anthropic-changes-pricing-structure-again` | Found (search only) | **[third-party]** | Corroborates §2.2 |
| `https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md` | Found (search only) | Vendor repo, **not opened** | §16.2 GBNF grammar claims. **Vendor-authored but unverified by me — treat as [third-party, unverified]** |
| localllm.in, inferencerig.com, hostinger.com, modemguides.com, promptquorum.com, atomic.chat, vucense.com | Found (search only) | **[third-party, unverified]** | §16.1/16.3 VRAM rules of thumb, Ollama native-Windows install behaviour, model throughput figures. **Explicitly not CONFIRMED; not usable as planning numbers — see U9** |

---

## 14. Unknowns requiring a local proof-of-concept

Ordered by decision impact.

| # | Unknown | Why it matters | Resolves |
| --- | --- | --- | --- |
| **U1** | Do `--restricted`, `--safe-mode`, `--tools ""` and `--strict-mcp-config` **compose** in one `claude -p` invocation, or do any conflict/override? | This combination is the *only* path to strong isolation **with** subscription auth (§5.3). If it doesn't compose, Option 1 loses its last technical defence. | §5.3 |
| **U2** | Does `--restricted` suppress **CLAUDE.md**? Its text covers settings files only. | This repo's root `CLAUDE.md` would otherwise be injected into every model call — unacceptable context contamination and a silent token cost. | §5.3 |
| **U3** | With `--tools ""`, does a run complete normally, or does the agent loop require ≥1 tool? | Determines whether pure-model-provider behaviour is achievable at all on B/C/D. | §5.3 |
| **U4** | Are **claude.ai MCP connectors** (Gmail/Calendar) actually absent under `--strict-mcp-config` with a `/login` credential? | Governance-critical: an unauthorized live tool reaching an Invocation bypasses Capability/Policy and the Event log. | §5.4 |
| **U5** | Cold-start wall-clock of `claude -p --restricted …` on this Windows host. | If startup is seconds, per-Invocation subprocess overhead may dominate short CHEAP-tier calls. | §9.2 |
| **U6** | Does `--json-schema` in a `--tools ""` run reliably return `structured_output`, and how often does it hit `error_max_structured_output_retries`? | Retry storms inflate real usage against a reservation computed once pre-dispatch (§6). | §6 |
| **U7** | Current **Anthropic API rate limits** for the account's tier. Not fetched. | Needed to size concurrency for Option 2. | §9.1 |
| **U8** | Whether the **Usage and Cost API** could back-fill authoritative cost, and at what lag. | Could allow a delayed authoritative reconciliation pass. | §7.3 |
| **U9** | Actual tok/s and quality of a chosen local model on **this** GPU (8 GB, laptop, thermally constrained). | All §16 throughput figures are third-party. Decides whether LOCAL is viable for CHEAP. | §16 |
| **U10** | Whether Anthropic's Windows **registry** managed-policy path is populated on this machine. | Documented as read regardless of `settingSources`; an unexpected policy would silently alter every B/C/D invocation. | §5.4 |

---

## 15. Proposed next-step spike (described, NOT implemented)

**Name:** Provider Isolation & Accounting Spike
**Budget:** ~2 hours, well under $1 of API usage, a handful of subscription calls.
**Location:** a scratch directory **outside** the repo — critically, outside any directory containing a `CLAUDE.md`, since U2 is one of the things being measured.
**Rule:** the spike writes **no** code into `src/`. It produces a findings note only. Nothing in it becomes the adapter.

### Phase 0 — inventory (no model calls, ~10 min)
Record `claude --version`; check for a Windows managed-policy registry key and `~/.claude.json` (**U10**); `claude /status`-equivalent to confirm which credential is active. Capture the machine's baseline.

### Phase 1 — isolation matrix (**U1–U4**, ~40 min)
From the scratch directory, run a fixed trivial prompt (e.g. *"Reply with the single word OK."*) with `--output-format json`, across a small flag matrix:

| Run | Flags |
| --- | --- |
| 1 | `-p` (baseline) |
| 2 | `-p --restricted` |
| 3 | `-p --restricted --tools ""` |
| 4 | `-p --restricted --tools "" --strict-mcp-config` |
| 5 | run 4 `+ --safe-mode` |
| 6 | `-p --bare --tools ""` (**API key set**) |

For each: does it start, does it error on flag conflict (**U1**), does it return a result (**U3**)? Then re-run runs 3–5 **from a directory containing a sentinel `CLAUDE.md`** holding a unique token plus an instruction to echo it — if the token appears in output, CLAUDE.md loaded (**U2**). Inspect the `system/init` event (via `--output-format stream-json --verbose`) for `mcp_servers` to settle **U4** directly — that event enumerates the session's servers, which is far more reliable than inferring from behaviour.

### Phase 2 — accounting & shape (**U5, U6**, ~30 min)
Take the most-isolated run that works. Pipe a realistic ~4 KB compiled-context-shaped blob on stdin with a small `--json-schema`. Repeat ~10×, recording: wall-clock (**U5**), `usage.input_tokens` / result `usage.output_tokens`, `total_cost_usd`, `modelUsage`, `session_id`, `duration_api_ms`, result `subtype`, and how many runs return `success` **with** `structured_output` (**U6**).

### Phase 3 — API baseline (~20 min)
The same ~10 prompts through the **existing** `callAnthropicModel` path with a real key and a real model ID. Compare token counts, latency, and structured-output reliability head to head. **This is the number that actually decides §12** — if the API is comparable in cost-per-useful-result, the terms and governance arguments win uncontested.

### Phase 4 — local smoke test (**U9**, ~30 min, optional)
Install one runtime (Ollama is the lowest-friction on native Windows) and one 7–9B Q4_K_M model. Measure cold-load time, tok/s, VRAM headroom at 8 GB, and JSON-schema adherence on ~10 extraction prompts via the OpenAI-compatible endpoint. **Do not wire it to anything.**

### Deliverable
A short findings note appended to this document (or beside it) with a filled isolation matrix, a latency/token/cost table for the three providers, and a **go/no-go on the §7.4 accounting decision**. Explicit non-goal: no adapter, no `tierConfig` change, no `ProviderName` widening.

---

## 16. Local LLM options

Evaluated as a **genuine first-class candidate**, not a fallback.

### 16.1 Measured hardware on this machine

Per §13 (first-party tools; the unreliable WMI figure is excluded):

| Component | Value | Implication |
| --- | --- | --- |
| GPU | **NVIDIA GeForce RTX 5070 Laptop, 8151 MiB (~8 GB) VRAM**, driver 591.84 | CUDA-capable; 8 GB is the binding constraint |
| iGPU | AMD Radeon 780M (0.5 GB allocated) | Not useful for inference alongside the dGPU |
| RAM | **31.3 GB** | Comfortable for CPU offload / larger models at low speed |
| CPU | AMD Ryzen 9 270, **8C/16T** | Adequate CPU fallback; slow for generation |
| Runtimes installed | **none** (`ollama`, `lms`, `llama-server` all absent) | Greenfield; nothing to inherit |

This resolves what the brief flagged as hardware-UNKNOWN — by **measuring** rather than assuming. Two caveats remain:
- **UNKNOWN / REQUIRES TEST:** laptop GPUs are power- and thermally-limited; sustained tok/s can fall well below desktop figures for the same chip. Only U9 settles this.
- **UNKNOWN:** how much VRAM is free in practice, with a desktop session and browser running. 8 GB *total* is not 8 GB *available*.

### 16.2 Runtime comparison

| | **Ollama** | **llama.cpp (`llama-server`)** | **LM Studio** |
| --- | --- | --- | --- |
| Native Windows | Yes — single installer, tray app, background server; NVIDIA CUDA auto-detected **[third-party install guides; vendor-official docs confirm the server]** | Yes — prebuilt Windows releases + CUDA builds | Yes — GUI + `lms` CLI + server |
| OpenAI-compatible API | **Yes — vendor-official:** `/v1/chat/completions`, `/v1/completions`, `/v1/models`, `/v1/embeddings`, `/v1/responses` | Yes — `llama-server` OpenAI-compatible mode | Yes — OpenAI-compatible server |
| Streaming | **Yes** (vendor-official: "[x] Streaming") | Yes | Yes |
| Tool/function calling | **Yes** (vendor-official: "[x] Tools"); **`tool_choice` unsupported** | Yes (template-dependent) | Yes |
| Structured output | `format` / JSON-schema support | **Strongest — GBNF grammars; JSON Schema→GBNF converter; `response_format`**, constraining *decoding* itself | JSON schema via server |
| Usage tokens | **Yes** — `stream_options.include_usage` (vendor-official); native API returns `prompt_eval_count` / `eval_count` | Yes — timings + token counts | Yes |
| Model format | GGUF | GGUF | GGUF (+ MLX on Apple) |
| Ops complexity | **Lowest** | Highest (build flags, manual model mgmt) | Low, but GUI-centric |
| Headless/service | Good (background server) | Best (plain binary) | Weakest — GUI-oriented |

**Sourcing caveat for the table above:** only the **Ollama** rows rest on a vendor page I actually fetched (`docs.ollama.com/api/openai-compatibility`). The **llama.cpp** and **LM Studio** rows — including the GBNF "strongest" assessment — come from search results I did not open, so they are **[third-party, unverified]** despite llama.cpp's row originating in a vendor repo. Verify before acting on them. See §13.

**Recommendation (INFERRED): Ollama for the spike and V1.1.** Basis: native Windows installer, background server suited to an always-on runtime, vendor-official OpenAI-compatible endpoint with `include_usage`, and the lowest operational surface. `llama.cpp` is the better choice **if and only if** JSON reliability proves to be the blocker — GBNF constrains decoding so invalid JSON becomes structurally impossible rather than merely unlikely, which is a materially stronger guarantee than anything §6 offers on the Claude side.

### 16.3 Model formats, quantization, RAM/VRAM

- **GGUF** is the common format across all three (vendor-official).
- **[third-party, unverified]** rules of thumb: Q8 ≈ half FP16 VRAM, Q4 ≈ quarter; **Q4_K_M** is the usual quality/size sweet spot for 8 GB; ~3–4 GB for a 3B model, ~50 GB for a 70B at Q4_K_M/8K context.
- **INFERRED for this machine:** 8 GB VRAM comfortably fits **7–9B at Q4_K_M fully on GPU** with modest context. 13B at Q4 is borderline-to-partial-offload; 30B+ requires heavy CPU offload into the 31 GB of RAM at speeds unlikely to suit interactive orchestration. **Context length competes with weights for the same 8 GB**, so long contexts shrink the viable model size — a point the third-party "200K context on 8 GB" claims gloss over and which U9 must verify.

### 16.4 Context windows, throughput, concurrency, startup

- **Context:** runtime-configurable, bounded by VRAM. **UNKNOWN** in practice for this machine until U9.
- **Throughput: UNKNOWN.** Third-party figures (~54–58 tok/s for a 9B at Q4 with full offload) are **[third-party, unverified]** and measured on unstated hardware. Not usable as a planning number.
- **Concurrency: INFERRED — effectively serial.** One ~8 GB-resident model saturates the GPU; a second concurrent request contends for the same VRAM and compute. **This is a hard architectural constraint:** parallel Task Instances routed to LOCAL would queue, not parallelise. The Model Router has no queueing concept today.
- **Startup:** first load pays a model-load cost (seconds); Ollama keeps models resident afterwards with a configurable idle unload. **INFERRED:** an always-on runtime should pin the model resident, trading idle VRAM for predictable latency.

### 16.5 Offline operation and privacy

**CONFIRMED by architecture (vendor-official):** all three runtimes serve on `localhost` and require no network once the model is downloaded.

**INFERRED — the strongest genuine argument for LOCAL in this project:** compiled context never leaves the machine. For Task Instances whose context includes personal mail, calendar or private repository content, a local adapter offers a privacy property **no cloud provider can match at any price**, and it sidesteps every terms question in §10 entirely. It also means the runtime keeps functioning with no network and no subscription.

### 16.6 Model quality relative to cloud

**INFERRED, stated conservatively.** A 7–9B quantised local model is **not** comparable to frontier cloud models on multi-step reasoning, long-context synthesis, or hard coding. It *is* frequently adequate for bounded, well-specified transformations. The honest framing is **task-shape fit, not a quality ladder**: local models fail differently (they degrade on instruction-following and long-range coherence), so the right work is short-context and schema-constrained.

Any specific model ranking here would be **[third-party, unverified]**. A curated starting set, tied to architectural conclusions rather than leaderboards:

| Work type | Local viability on 8 GB | Note |
| --- | --- | --- |
| Extraction (structured fields from text) | **Good** — the best local fit | Schema-constrained; short context; GBNF makes output shape guaranteed |
| Classification / routing / triage | **Good** | Small label space; cheap; high volume — biggest token-saving win |
| Summarization (bounded input) | **Fair–good** | Quality degrades with input length |
| Retrieval assistance (query rewriting, reranking, chunk relevance) | **Good** | High call volume, low per-call difficulty — ideal LOCAL work |
| Planning / decomposition | **Poor** | Needs long-range coherence; keep cloud |
| Analysis / general reasoning | **Poor–fair** | Keep cloud |
| Coding | **Poor** for real changes; fair for snippets | Keep cloud |

A 7–9B general instruct model at Q4_K_M with solid tool-calling and JSON adherence is the right single choice; pick the specific one **empirically in U9/Phase 4**, not from this document. Committing a model name here would be exactly the leaderboard-shopping the brief warns against, and the space moves faster than this document's shelf life.

### 16.7 Tier suitability

| Tier | Local suitable? | Reasoning |
| --- | --- | --- |
| **CHEAP** | **Yes — the strong case** (INFERRED) | Extraction/classification/retrieval-assist at high volume; zero marginal cost; no terms risk; privacy upside |
| **STANDARD** | **N/A — see §16.11** | *No STANDARD tier exists in the code* |
| **STRONG** | **No** (INFERRED) | 8 GB cannot host a model competitive with frontier cloud on the work STRONG exists to serve. `selectTier` routes `riskTier` high/highest here as a **quality floor** — satisfying a quality floor with a weaker model would defeat the rule's entire purpose |

### 16.8 Local vs cloud/subscription, head to head

| Dimension | Local | Subscription Claude | API Claude |
| --- | --- | --- | --- |
| Marginal cost | **Zero** (electricity) | Zero-marginal within opaque limits | Real per-token |
| Token efficiency | Irrelevant — no per-token charge | Consumes shared human budget | Directly billed |
| Latency | Low, no network; **UNKNOWN** tok/s (U9) | Network + process spawn | Network only |
| Quality | Materially lower | Frontier | Frontier |
| Privacy | **Best — data never leaves host** | Cloud | Cloud |
| Reliability | Own hardware; no vendor outage | Vendor + limit exhaustion | Vendor |
| Availability | **Offline-capable** | Needs network + valid login | Needs network |
| Context window | VRAM-bound | Large (1M on some plans) | Large |
| Concurrency | **~Serial** (16.4) | Undocumented | Published limits |
| Maintenance | Model updates, driver/runtime upkeep | None | None |
| Hardware dependency | **Total** | None | None |
| Terms risk | **None** | **Material** (§10) | None |
| Tool/structured output | GBNF = strongest *decode-level* guarantee | Client-side retry (§6) | Server-side structured outputs |

### 16.9 Interface compatibility

**INFERRED — yes, cleanly.** A local adapter implements `compiled context -> model -> result + usage metadata` more naturally than mechanisms B/C/D do:
- One HTTP POST to `localhost` — the same *shape* as `anthropic.ts`, not a subprocess.
- Usage metadata is genuinely available: vendor-official `stream_options.include_usage` on the OpenAI-compatible endpoint, and `prompt_eval_count` / `eval_count` on Ollama's native API. **Token counts are real and locally computed — no estimation involved.**
- Latency and timing come free (`total_duration`, `load_duration`, `eval_duration`).
- The only field with no natural value is **`costAmount`** — see §7.4. This is the same gap as subscription, arriving by a different road.

### 16.10 Non-negotiable constraint

**A local model must NOT bypass any part of the governance chain.** It is *only* another Provider Adapter — a third file under `src/router/providers/`, called by `callModel`, selected by `tierConfig[tier].provider`. Specifically, a LOCAL provider must still:

- receive context **only** from the **Context Compiler** (never read files or reach the network itself);
- be authorized by the **Budget Governor** via `authorizeRoute`/`reserveBudget` before dispatch, and reconciled after — in whatever unit §7.4 settles on;
- respect the **Capability/Policy** system — being local grants **no** additional capability, and *cheap* must never become an implicit *permitted*;
- emit `invocation_started` / `invocation_completed` **Events** identically, with `modelId` naming the local model;
- live inside the **Run/Invocation lifecycle** (retries create new Runs);
- be reached **only** through the **Model Router**. No module outside `src/router/providers/` may import an inference client or open an HTTP connection to a local inference server. The single-chokepoint rule is about *provider access*, not about which company hosts the weights — a `localhost:11434` fetch from the Executor would violate it exactly as much as an `@anthropic-ai/sdk` import would.

**The "it's free, so it can skip the governor" temptation is the single biggest architectural risk in adopting local inference, and it must be refused explicitly.**

### 16.11 Does the existing architecture already support a LOCAL provider?

**Semantically: yes. Mechanically: no.** Both halves matter, and conflating them is how this question gets answered wrongly.

**Unchanged (INFERRED from the interface):**
- `callModel`'s contract `(tx, route, compiledContext, expectedOutputShape) -> {result, usage:{tokensIn,tokensOut,costAmount}}` fits a local provider without alteration.
- Event shapes, reservation/reconciliation flow, and the `tierConfig`-driven provider selection pattern all carry over. `tierConfig.ts`'s header already asserts this is the design intent: "Swapping any value here (a model id, a provider, a price) changes routing behavior with zero code changes elsewhere."

**Requires change (CONFIRMED by reading the source):**

| # | What | Where | Severity |
| --- | --- | --- | --- |
| 1 | `ProviderName` is a **closed union** `"anthropic" \| "openai"` — must be widened | `tierConfig.ts:25` | Trivial |
| 2 | Provider dispatch is a **binary ternary** (`config.provider === "anthropic" ? … : …`) — a third provider requires converting it to a map/switch | `modelRouter.ts:136-139` | Small, but note the current ternary silently routes *any* non-`"anthropic"` value to OpenAI — adding a third member without fixing this would misroute LOCAL to OpenAI, which the type system would **not** catch |
| 3 | `pricePerToken` is a **required** param on the provider signature and the sole basis of `costAmount` | `anthropic.ts:52-84`, `modelRouter.ts:77-79` | **The real decision (§7.4)** — not a code problem |
| 4 | **`ModelTier = "CHEAP" \| "STRONG"` — there is no STANDARD tier** | `types.ts:10` | The brief's CHEAP/STANDARD/STRONG framing does not match the frozen code. `"standard"` exists only as a `taskDifficulty` value on `RouteRequest`, and `selectTier` maps `"simple"`/`"standard"` → **CHEAP**. Any LOCAL plan must be written against the two real tiers |
| 5 | No concept of provider **availability** — a local server that is down throws mid-`callModel`, propagating uncaught (by deliberate design: `invocation_failed` is the future Executor's job) | `modelRouter.ts` | Acceptable today; worth noting a local server is *far* more likely to be down than a cloud API |
| 6 | No **queueing/concurrency** concept, though local inference is ~serial (§16.4) | `modelRouter.ts` | Parallel Task Instances on LOCAL would contend |

**Conclusion:** adding LOCAL is a small, well-scoped change that does **not** disturb the governance semantics — items 1, 2 and 4 are hours of work. Item 3 is a genuine architectural decision that must be made *before* any adapter is written, because a `pricePerToken: 0` default would quietly disable budget enforcement for that tier (§7.4).

---

## 17. Hybrid provider strategy

### 17.1 Is a hybrid the strongest V1/V1.1 architecture?

**Partly — with one component removed.** The brief proposes three legs: LOCAL for cheap work, subscription-backed Claude where legitimately supported, API for strong inference.

**The subscription leg should be dropped**, for the §12 reasons — terms ambiguity with no affirmative permission, unusable monetary accounting, isolation that fights its own auth, and opaque limits shared with the human's own Claude access. The remaining **two-leg hybrid is genuinely strong**:

| Tier | V1 (now) | V1.1 (after the §15 spike) |
| --- | --- | --- |
| **CHEAP** | Anthropic API (Haiku-class) | **LOCAL** where U9 shows adequate quality; API as fallback |
| **STRONG** | Anthropic API (Opus-class) | Unchanged — API |

This delivers the efficiency the brief is actually reaching for. **INFERRED:** high-volume, low-difficulty work (extraction, classification, retrieval assistance) is where token spend accumulates fastest and where quality requirements are loosest — so moving exactly that work to LOCAL is the largest available useful-work-per-dollar gain, with **no** terms risk and a **privacy improvement** as a side effect. The subscription leg would have delivered less and cost more in architectural integrity.

**Note the sequencing, which matters:** LOCAL is a V1.1 item, not a V1 item, because §7.4's accounting decision must be settled first. Shipping LOCAL before that decision is how the Budget Governor quietly becomes decorative.

### 17.2 Could routing stay entirely inside the Model Router?

**Yes — this is a provider-adapter-selection question, not a Model Router logic question.** INFERRED from the source, with the mechanical caveats above.

**No semantic change needed:**
- `selectTier()` already maps `(taskDifficulty, riskTier) -> tier` with zero provider awareness. It needs **no** modification.
- `tierConfig[tier].provider` is already the selection point. A hybrid is expressed by editing config: `CHEAP.provider = "local"`, `STRONG.provider = "anthropic"`.
- No caller of `authorizeRoute`/`callModel` learns anything new. The Workflow Interpreter, Executor and UI remain provider-blind, as Phase 4 requires.
- The single-chokepoint rule is *strengthened*, not weakened: more providers behind one interface is exactly what the chokepoint is for.

**Mechanical changes required** — identical to §16.11 items 1, 2 and 3. No new module, no new interface, no change to Events, Policy, Capabilities, or the Run/Invocation lifecycle.

**Two things that would *not* stay inside the Model Router**, flagged so they are not discovered late:

1. **Per-tier accounting units.** If LOCAL accounts in tokens while API accounts in dollars, `budget_counters` holds two incommensurable units under one `"llm"` cost class. That is a **Budget Governor** concern, not a router concern, and it is the real design work in §7.4. The cleanest resolutions are either a separate cost class per unit, or a single imputed-dollar unit with an explicit `costBasis` marker on the event.
2. **Fallback/degradation policy.** "If the local server is down, fall back to API" is a *routing policy* decision with budget consequences — a silent fallback would convert a free call into a billed one without a new reservation. If that behaviour is ever wanted it belongs in `authorizeRoute` (which holds the reservation), **not** in `callModel` and **not** inside a provider adapter. Today neither exists, and that is fine — but a hybrid makes the question live, and the safe default is **no automatic fallback**: let the Invocation fail and let the Executor's retry policy create a new Run.

### 17.3 Summary position

**V1: ship on the Anthropic API — the adapter already exists.** Replace `tierConfig`'s self-declared placeholder model IDs with real ones and its blended `pricePerToken` with real per-model pricing.

**V1.1: run the §15 spike. If U9 is favourable, add `local.ts` as a third provider adapter for CHEAP — after, and only after, settling the §7.4 accounting question.**

**Subscription-backed Claude: not adopted.** Revisit only if Anthropic publishes an affirmative permission for application backends, or resolves the paused Agent SDK metering in a way that creates one. Until then the honest summary is: *it works today, Anthropic's documentation points developers elsewhere, Anthropic already tried once to change it, and the change is merely paused.*
