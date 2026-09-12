/**
 * Fix round 1 (independent review, Important #2): `buildSystemPrompt`/
 * `buildUserMessage` used to be byte-for-byte duplicated in both
 * `src/router/providers/anthropic.ts` and `.../openai.ts`, with nothing
 * coupling them if one changed. They were extracted into
 * `src/router/providers/promptBuilder.ts`, imported by both.
 *
 * These tests cannot exercise `callAnthropicModel`/`callOpenAiModel`
 * end-to-end (that would require a live provider SDK call, which this
 * project's tests never make — see the brief). Instead, this file:
 *   1. Unit-tests the shared builder's behavior directly.
 *   2. Statically confirms (source-grep) that BOTH provider files import
 *      `buildSystemPrompt`/`buildUserMessage` from `./promptBuilder.js` and
 *      that NEITHER file re-declares its own local copy — i.e. the sharing
 *      is real, not just a coincidence of identical code.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSystemPrompt, buildUserMessage } from "../../../src/router/providers/promptBuilder.js";
import type { CompiledContext } from "../../../src/context/types.js";

function buildCompiledContext(overrides: Partial<CompiledContext["layers"]> = {}): CompiledContext {
  return {
    layers: {
      instructions: "instructions-layer",
      constraints: "constraints-layer",
      taskState: "task-state-layer",
      memory: "memory-layer",
      artifacts: "artifacts-layer",
      toolSchemas: [],
      ...overrides,
    },
    provenance: { included: [], excluded: [] },
    estimatedInputTokens: 10,
  };
}

describe("promptBuilder", () => {
  it("buildSystemPrompt joins instructions + constraints, skipping empty layers", () => {
    expect(buildSystemPrompt(buildCompiledContext())).toBe("instructions-layer\n\nconstraints-layer");
    expect(buildSystemPrompt(buildCompiledContext({ constraints: "" }))).toBe("instructions-layer");
  });

  it("buildUserMessage joins taskState + memory + artifacts and appends the expected-output-shape instruction", () => {
    const message = buildUserMessage(buildCompiledContext(), { foo: "bar" });
    expect(message).toBe(
      'task-state-layer\n\nmemory-layer\n\nartifacts-layer\n\nRespond with JSON matching this shape: {"foo":"bar"}'
    );
  });

  it("buildUserMessage skips empty layers", () => {
    const message = buildUserMessage(buildCompiledContext({ memory: "", artifacts: "" }), {});
    expect(message).toBe('task-state-layer\n\nRespond with JSON matching this shape: {}');
  });
});

describe("both provider files use the shared builder, not their own copy (structural check)", () => {
  it.each(["anthropic.ts", "openai.ts"])("%s imports buildSystemPrompt/buildUserMessage from ./promptBuilder.js", (fileName) => {
    const filePath = fileURLToPath(new URL(`../../../src/router/providers/${fileName}`, import.meta.url));
    const source = readFileSync(filePath, "utf8");
    expect(source).toMatch(/import\s*\{\s*buildSystemPrompt,\s*buildUserMessage\s*\}\s*from\s*["']\.\/promptBuilder\.js["']/);
  });

  it.each(["anthropic.ts", "openai.ts"])("%s does NOT re-declare its own buildSystemPrompt/buildUserMessage", (fileName) => {
    const filePath = fileURLToPath(new URL(`../../../src/router/providers/${fileName}`, import.meta.url));
    const source = readFileSync(filePath, "utf8");
    expect(source).not.toMatch(/function\s+buildSystemPrompt/);
    expect(source).not.toMatch(/function\s+buildUserMessage/);
  });
});
