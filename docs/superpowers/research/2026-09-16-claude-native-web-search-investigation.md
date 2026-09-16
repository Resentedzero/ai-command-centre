# Can our subscription runtime do real web search?

**Date:** 2026-09-16. **Question (operator brief §8):** can the existing Claude Max subscription-backed runtime invoke Claude's native web search, with no API key and no API billing? **Gate for:** general web research (D1).

## 1. Conclusion

**Yes — proven live.** Claude's built-in `WebSearch` tool is available in the same headless runtime we already use, under the same subscription login, alongside structured output. It was never reachable before for one reason: **our own adapter passes `--tools ""`, which disables every tool.** Naming the tool restores it.

Two caveats, neither of which blocks D1:

1. **Billing is proven by absence, not by a statement.** No Anthropic document says "web search under a Max login is not billed to API credits". What is documented is that API charges begin when `ANTHROPIC_API_KEY` is set — and it was not set. The call carried subscription quota telemetry with `overageStatus: "rejected"`, so there is no billable spillover path. That is the strongest available confirmation short of asking Anthropic.
2. **It is expensive in tokens.** The single proof call cost **~54,000 subscription tokens**, because search results are charged as input tokens. That is more than the entire Task Instance ceiling for an autonomous run.

## 2. Official evidence

- Claude Code tools reference: `WebSearch` "runs a query against Anthropic's web search backend and returns result titles and URLs. It doesn't fetch the result pages." It "may issue up to eight backend searches per call", is capped at 200 calls per session, and is **not** in the default tool preset — it must be named.
- CLI reference: `--tools ""` "disables all tools". This is the line that explains 85 archived benchmark runs with `web_search_requests: 0`.
- Permissions: web search requires approval, so under `--permission-mode manual --permission-prompts none` it must also appear in `--allowedTools` or it is denied.
- Structured outputs: "The agent can use any tools it needs to complete the task, and you still get validated JSON matching your schema at the end." Tools and `--json-schema` coexist; `--tools ""` was the blocker, not structured output.
- Pro/Max support article: API charges arise when `ANTHROPIC_API_KEY` is set, "resulting in API usage charges rather than using your subscription's included usage".
- Messages API web search is $10 per 1,000 searches and requires an API key — **the path we must not use**, and did not.

## 3. Runtime path used

The same `claude -p` binary, the same subscription login (`authMethod: claude.ai`, `apiProvider: firstParty`, `subscriptionType: max`), no API key in the environment, an empty working directory outside the repository, a pinned model, no MCP, no settings sources, and every tool denied except the one named.

```
--tools WebSearch --allowedTools WebSearch --strict-mcp-config --setting-sources ""
--permission-mode manual --permission-prompts none --output-format stream-json --verbose
--no-session-persistence --json-schema <schema> --model claude-sonnet-5
```

## 4. The proof

**Question asked:** the latest published version of the npm package `@anthropic-ai/claude-code`, and when it was published — a fact that changes several times a week and post-dates the model's training cutoff.

**Answer returned:** 2.1.273, published "about 3 hours" before the search, as of 2026-09-16.

**Independent verification:** `npm view @anthropic-ai/claude-code version` → **2.1.273**, run separately with no model involved.

Everything the evidence required:

| Check | Result |
|---|---|
| Tool surface | `["StructuredOutput", "WebSearch"]` and `mcp_servers: []` — nothing else was available |
| Real searches | Five `WebSearch` tool calls with visible queries, each answered by result blocks of real titles and URLs |
| Search counter | `modelUsage["claude-haiku-4-5"].webSearchRequests: 5` |
| Permission gate | `permission_denials: []` — nothing was blocked |
| Sources | Four sources returned, each also present in the raw search results (so none was fabricated) |
| Not memory | The answer matches today's npm registry and could not have come from training data |
| No API key | Environment checked empty before the call |
| Subscription path | Quota telemetry present: five-hour utilization 0.57 → 0.58, seven-day 0.21, `overageStatus: "rejected"` |

**A counter worth knowing about:** the top-level `usage.server_tool_use.web_search_requests` reported **0** while the per-model entry reported **5**. Anything measuring search volume must read `modelUsage[...].webSearchRequests`, or it will conclude no search happened.

## 5. Limitations

- **Domain restriction is not enforceable from the command line.** The web-search permission rule takes no specifier, and the allow/block domain lists are chosen by the model per call, not pinned by the caller. A capability binding cannot constrain which hosts are searched except by asking politely in the prompt.
- Search returns titles and URLs only. Reading a page needs `WebFetch`, which is a separate tool and a separate decision.
- A search that fails or is capped can still leave the model answering from memory; the counter alone does not prove a search succeeded, so result blocks must be inspected.
- One structured-output validation retry occurred in the proof (a missing required field), which re-sent the whole context — a real and repeatable cost.
- **Search reaches pages our own code cannot.** Fetching one cited source directly (`npmjs.com`) returns 403 to an automated client, while the search backend reads it perfectly well. That is an argument for native search over a home-grown fetcher for general web material, and a reminder that a `research.open` of an arbitrary URL will fail on a meaningful share of the web.

## 6. Security implications

The isolation that V1 verified 85 times over rests on `--tools ""`. Allowing search **widens a verified invariant**, so it must be narrowed deliberately: exactly one tool named, everything else denied by the permission mode, MCP empty, settings sources empty, environment sanitized, working directory outside the repository. The proof ran under exactly that shape and the tool list confirms it held.

Two rules follow for the implementation:
1. **The allowed-tool list must come from the Capability Grant**, never from configuration and never from anything in the compiled context — otherwise page content could widen the model's own tool surface.
2. **Search results are untrusted data.** They enter the model as tool output and must be fenced as such, exactly like every other untrusted source today.

## 7. Token implications

| Model entry | Input | Output | Cache read | Cache created | Searches |
|---|---|---|---|---|---|
| claude-haiku-4-5 | 51,216 | 1,283 | 0 | 0 | 5 |
| claude-sonnet-5 | 10 | 1,489 | 51,124 | 15,621 | 0 |

Counted the way our adapter counts (input + output across every model entry): **53,998 subscription tokens** for one question. Search results are charged as input tokens and are re-sent on each subsequent turn, and this call took 8 turns. `total_cost_usd` reported 0.195 — a local list-price estimate including a modelled per-search fee, **not a charge**, and not recorded as one.

**Consequence for design:** a research step that searches freely will exhaust an autonomous Run's 50,000-token Task Instance ceiling in a single question. Searching must be bounded — few queries, a small result budget, and the cheapest tier that can do the job — or reserved for steps that justify it.

## 8. Architecture implications

1. `buildClaudeArgs` must take an allowed-tool list instead of hard-coding `--tools ""`. That changes a documented isolation invariant, so it belongs in the subscription provider design record, not a quiet edit.
2. The isolation assertion changes shape rather than disappearing: the reported tool surface must equal `StructuredOutput` plus exactly the granted tools, checked per call and failed closed on anything unexpected.
3. **The audit gap is the real cost.** A search inside an LLM Invocation produces no Tool Invocation today: Policy never authorized it and no event records it. Before this is exposed as a capability, the searches (queries and result URLs) and the search count must be recorded on the Invocation, or "the agent searched the web" is invisible to governance — which would contradict the brief's own observability requirement.
4. It fits the Capability model as an **LLM-tool grant**, not a Tool Binding: no `direct_api`, `mcp` or `browser` adapter is involved. That is a design decision to record, and it is what lets us have general web search with no credentials at all.

## 9. Failure behaviour

Search can fail as an overload, a rate limit, an invalid query, an organisation-level disable (a 400 saying search is not enabled), or a silent session cap. In every case the model may still answer from memory. So the capability must fail explicitly: no result blocks means `capability_unavailable`, never a quiet answer presented as researched. This is the same rule the deliverable's evidence basis already enforces — a document must never imply research that did not happen.

## 10. D1 recommendation

**D1 stands, with its first clause now answered.** Native web search is viable on the subscription runtime, so it is the preferred path for general web research and no paid search provider is needed. But it is not a drop-in replacement for the credential-free scholarly sources: at ~54,000 tokens for one question it is the expensive option, while Wikipedia, Crossref, arXiv, OpenAlex and PubMed cost only their HTTP call.

The honest division of labour: **structured sources for evidence that exists in them; native search for genuinely current questions, bounded and deliberate.**

## 11. Next implementation step

1. Record the invariant change in the subscription provider design, with the exact flag set.
2. Parameterise the adapter's tool list from the Grant, keeping the per-call assertion that nothing else appeared.
3. Record searches on the Invocation — queries, result URLs, count — so governance can see them.
4. Expose it as `research.search` alongside the structured providers, with a per-step query budget and untrusted-data fencing.
