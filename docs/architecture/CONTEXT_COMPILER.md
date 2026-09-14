# Context Compiler

**Implements:** spec Phase 5 (§5.2–§5.18). **Code:** `src/context/compiler.ts`, `src/context/types.ts`; rendered by `src/router/providers/promptBuilder.ts`. **Tests:** `tests/context/compiler.test.ts`.

The Compiler turns a Task Instance, the Run's bound Agent Definition, the Invocation's intent and budget, and explicit candidate ids into one `CompiledContext`. Nothing else reaches a model: provider adapters take no transaction and cannot fetch anything themselves.

## 1. Invariants

| Invariant | How it holds | Test |
|---|---|---|
| **No implicit history.** | Only the Task Instance's input (plus the Goal of a workflow step), the bound Agent Definition, and the caller's explicit candidate ids are read. There is no transcript. | Adapter structural tests (no `tx`, no data access) |
| **Every candidate is a persisted row.** | Unresolvable artifact, capability, task instance ids throw before packing. A `runId` that is not a Run of the Task Instance throws. | `persisted-record validation`, `tool-schema authorization` |
| **Context never widens authorization.** | A tool schema is eligible only if the Run's Agent Definition version holds an unrevoked Grant for its capability with at least one permission. No Run or no bound Agent → every tool schema is excluded `unauthorized` (fail closed). Execution still authorizes each use through Policy. | `tool-schema authorization` (mutation-checked: fail-open mutant fails 3 tests) |
| **Credentials and adapter configuration never enter context.** | Tool schemas use the minimal variant `{capabilityId, capabilityName, description, toolBindingId, kind}`. Binding `config` is never read into a layer. API keys live only in the Model Router adapters. | `never places a Tool Binding's config…` (mutation-checked) |
| **Trusted and untrusted data are separated.** | Artifacts produced by a prior Invocation are fenced in an unguessable per-compilation tag; the constraints layer carries the policy naming that tag exactly when a fence is present. Instructions come only from the Agent Definition. | `untrusted-candidate handling` |
| **Budgets are enforced on the real prompt.** | Tier 1 (task state + instructions) over `maxInputTokens` throws `ContextBudgetError`. Tiers 2 and 3 pack greedily; framing, fences and the policy all count. Per-artifact, item-count and tool-schema sub-budgets apply. | `tier-1 task state`, `greedy packing order`, `estimatedInputTokens` |
| **Minimal, deduplicated context.** | Duplicates by id and by content hash (§5.10) are excluded `duplicate`; the caller's first occurrence wins. Stale artifacts are excluded `stale`. | `deduplication`, `freshness / staleness` |
| **Every decision is recorded.** | Every candidate occurrence is either included or excluded with a reason. Included entries record kind, trust, the tokens they added (framing included), and for artifacts the version and content hash. The Executor emits these as `context_compiled`; content is never recorded. | `provenance completeness`, `estimatedInputTokens` |
| **Deterministic apart from the fence tag.** | Same rows and inputs produce the same layers and provenance, except the random fence tag (and the policy text naming it) when untrusted data is present. | — |

## 2. Layers

Fixed order (§5.14): `instructions` (Agent Definition) → `constraints` (untrusted-data policy, when present) → `taskState` → `memory` (always empty; memory is not built) → `artifacts` → `toolSchemas`.

`toolSchemas` is compiled, budgeted and recorded, but no adapter sends it: tool execution belongs to the Tool Adapter + Capability/Policy chain, never to model-native tool calling. No current spec passes tool candidates (`candidateToolCapabilityIds` is `[]` everywhere), so the Grant check guards a latent path.

## 3. Open questions and residuals

1. **Stable cacheable prefix vs. the random fence tag.** §5.14 says layers 1–2 are what get prompt-cached, but the policy in layer 2 names a per-compilation tag, so the prefix changes on every call that fences data. Caching is not built (§5.11). Decide when it is: generic policy wording plus a per-fence tag in layer 5, or a tag derived per Run. The unguessable tag is a security property and is not changed unilaterally.
2. **Reference mode without a summary.** Reference text is `summary ?? inlineContent`. With the seeded budgets (`compressionThreshold` = `maxArtifactTokens`) a summary-less artifact too large for content mode is excluded for budget. With a lower threshold it would be inlined under a `mode=ref` label. An honest reference needs on-demand retrieval (§5.5), which does not exist.
3. **Binding eligibility by trust.** §5.7 says "eligible Tool bindings". All bindings of a granted capability are listed; the Grant's trust bar is enforced by Policy at execution, not at compilation.
4. **Not built:** compression (§5.9), caching (§5.11), relevance scoring (§5.3), memory (§5.6), model-window negotiation (§5.17), tokenizer-accurate estimates (`estimateTokens` is `ceil(chars / 4)`).
5. **No separate system channel on the Claude CLI** — see the spec §5.15 implementation note.
