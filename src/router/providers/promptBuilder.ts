/**
 * Shared prompt-assembly helpers for the provider wrapper files
 * (`./anthropic.ts`, `./openai.ts`). Pulled out in fix round 1 (independent
 * review, Important #2): both files had byte-for-byte identical
 * `buildSystemPrompt`/`buildUserMessage` implementations with nothing
 * coupling them if one changed.
 *
 * This file imports NO provider SDK — it is plain string assembly over
 * `CompiledContext`, so it does not affect the "only anthropic.ts/openai.ts
 * import a provider SDK" isolation rule (that rule is about SDK imports
 * specifically, not about banning a shared, SDK-free helper).
 */
import type { CompiledContext } from "../../context/types.js";

/** Concatenates the instruction/constraint layers into the system prompt. */
export function buildSystemPrompt(compiledContext: CompiledContext): string {
  return [compiledContext.layers.instructions, compiledContext.layers.constraints]
    .filter((layer) => layer.length > 0)
    .join("\n\n");
}

/**
 * Concatenates the task-state/memory/artifact layers, then the invocation
 * instruction (spec §5.14 layer 7), into the user message body. The instruction
 * text is the Compiler's, so what is sent is exactly what was budgeted.
 */
export function buildUserMessage(compiledContext: CompiledContext): string {
  const { taskState, memory, artifacts, invocationInstruction } = compiledContext.layers;
  return [taskState, memory, artifacts, invocationInstruction].filter((layer) => layer.length > 0).join("\n\n");
}
