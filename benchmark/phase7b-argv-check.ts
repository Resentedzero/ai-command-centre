/**
 * PHASE 7B CLOSURE CHECK — exactly ONE live subscription invocation.
 *
 * NOT a benchmark: no workload sweep, no concurrency, no repetition.
 *
 * Its single purpose is to confirm that the argv the PRODUCTION adapter now
 * emits — with `--output-format stream-json --verbose` in their production
 * positions — actually works against the real CLI. Everything that shapes the
 * child process comes from the production module itself
 * (`resolveClaudeExecutable`, `buildClaudeArgs`, `buildSanitizedEnv`,
 * `buildStdinPayload`, `parseClaudeStream`), so there is no separate copy of
 * the argv that could drift from what production sends.
 *
 * It spawns directly rather than calling `callClaudeSubscriptionModel` for one
 * reason: the adapter deliberately does not surface the `system/init` tool
 * surface, and this check must assert on it. The spawn options are otherwise
 * identical to the adapter's.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveClaudeExecutable,
  buildClaudeArgs,
  buildSanitizedEnv,
  buildStdinPayload,
  parseClaudeStream,
  extractModelUsage,
  FORBIDDEN_CHILD_ENV_VARS,
  type ClaudeStreamLine,
} from "../src/router/providers/claudeSubscription.js";
import type { CompiledContext } from "../src/context/types.js";

const MODEL = "claude-haiku-4-5-20251001";
const SCHEMA = {
  type: "object",
  properties: {
    sum: { type: "number" },
    word_count: { type: "number" },
  },
  required: ["sum", "word_count"],
  additionalProperties: false,
};

/** Small, deterministic, and checkable against ground truth. */
const context: CompiledContext = {
  layers: {
    instructions: "You are a precise analysis component. Answer only via the structured output schema.",
    constraints: "Do not browse. Do not use tools. Respond with the structured output only.",
    taskState:
      "Compute the sum of these numbers: 17, 25, 8. Then count the words in this sentence:" +
      ' "the quick brown fox jumps" (five words expected).',
    memory: "",
    artifacts: "",
    toolSchemas: [],
  },
  provenance: { included: [], excluded: [] },
  estimatedInputTokens: 120,
};

async function main() {
  const executable = resolveClaudeExecutable();
  const args = buildClaudeArgs(MODEL, SCHEMA);
  const env = buildSanitizedEnv();
  const stdinPayload = buildStdinPayload(context, SCHEMA);
  const cwd = await mkdtemp(path.join(tmpdir(), "acc-7b-check-"));

  // Pre-flight isolation assertions, BEFORE anything is spawned.
  const preflight = {
    argv: args,
    outputFormat: args[args.indexOf("--output-format") + 1],
    verbosePresent: args.includes("--verbose"),
    verboseIndex: args.indexOf("--verbose"),
    outputFormatIndex: args.indexOf("--output-format"),
    shellFalse: true,
    childHasApiKey: env.ANTHROPIC_API_KEY !== undefined,
    forbiddenEnvPresent: FORBIDDEN_CHILD_ENV_VARS.filter((k) => env[k] !== undefined),
    parentHasApiKey: process.env.ANTHROPIC_API_KEY !== undefined,
    stdinContainsKeyPattern: /sk-ant-/.test(stdinPayload),
    cwdOutsideRepo: !cwd.startsWith(process.cwd()),
    model: args[args.indexOf("--model") + 1],
    noBare: !args.includes("--bare"),
    noFallbackModel: !args.includes("--fallback-model"),
  };

  if (preflight.childHasApiKey || preflight.forbiddenEnvPresent.length > 0 || preflight.stdinContainsKeyPattern) {
    await rm(cwd, { recursive: true, force: true });
    throw new Error("PRE-FLIGHT FAILED: credential material would have reached the child. Nothing was spawned.");
  }

  const startedAt = Date.now();
  const lines: ClaudeStreamLine[] = [];
  let stderr = "";
  let pending = "";

  const outcome = await new Promise<{ code: number | null }>((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk) => {
      pending += String(chunk);
      let nl = pending.indexOf("\n");
      while (nl >= 0) {
        const text = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (text.trim() !== "") lines.push({ text, receivedAt: new Date() });
        nl = pending.indexOf("\n");
      }
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (pending.trim() !== "") lines.push({ text: pending, receivedAt: new Date() });
      resolve({ code });
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdinPayload);
  });

  const closedAt = Date.now();
  const stream = parseClaudeStream(lines);

  let usage: { entries: unknown[]; totalTokens: number } | { error: string };
  try {
    usage = stream.result ? extractModelUsage(stream.result) : { error: "no result event" };
  } catch (error) {
    usage = { error: (error as Error).message };
  }

  const structured = stream.result?.structured_output as Record<string, unknown> | undefined;

  const report = {
    phase: "7B closure check",
    at: new Date().toISOString(),
    invocations: 1,
    preflight,
    exitCode: outcome.code,
    wallClockMs: closedAt - startedAt,
    stderrEmpty: stderr.trim() === "",
    streamEventTypes: [
      ...new Set(
        lines
          .map((l) => {
            try {
              return (JSON.parse(l.text) as { type?: string }).type;
            } catch {
              return "<unparsable>";
            }
          })
          .filter(Boolean)
      ),
    ],
    unparsableLines: stream.unparsableLines,
    initSurface: stream.initSurface,
    structuredOutput: structured,
    structuredOutputCorrect: structured?.sum === 50 && structured?.word_count === 5,
    usage,
    rateLimitReadings: stream.rateLimitReadings,
    quotaObservation: stream.quota
      ? {
          ...stream.quota,
          observedAt: stream.quota.observedAt.toISOString(),
          msBeforeClose: closedAt - stream.quota.observedAt.getTime(),
        }
      : null,
  };

  await writeFile("benchmark/raw/phase7b-argv-check.json", JSON.stringify(report, null, 2), "utf8");
  await rm(cwd, { recursive: true, force: true }).catch(() => {});

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error("CHECK FAILED:", error);
  process.exitCode = 1;
});
