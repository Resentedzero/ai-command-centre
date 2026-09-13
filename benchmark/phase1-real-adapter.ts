/** BENCHMARK ARTIFACT — proves whether the SHIPPED adapter can spawn the CLI. */
import { callClaudeSubscriptionModel, ClaudeSubscriptionError } from "../src/router/providers/claudeSubscription.js";
import type { CompiledContext } from "../src/context/types.js";

const ctx: CompiledContext = {
  layers: { instructions: "Synthesize.", constraints: "", taskState: "s", memory: "", artifacts: "a", toolSchemas: [] },
  provenance: { included: [], excluded: [] },
  estimatedInputTokens: 50,
};

const started = Date.now();
try {
  const r = await callClaudeSubscriptionModel("claude-haiku-4-5-20251001", ctx, { summary: "string" }, { unit: "subscription_tokens" });
  console.log("SUCCESS", JSON.stringify(r.usage));
} catch (e) {
  const err = e as ClaudeSubscriptionError;
  console.log("FAILED_AFTER_MS", Date.now() - started);
  console.log("CODE", err.code ?? "(none)");
  console.log("MESSAGE", err.message);
}
