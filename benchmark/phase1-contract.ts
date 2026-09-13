/**
 * PHASE 1 — live CLI contract capture. ONE real model invocation.
 *
 * BENCHMARK ARTIFACT. Not production code; nothing in `src/` imports it.
 *
 * Every component of the invocation comes from the SHIPPED provider —
 * `resolveClaudeExecutable`, `buildClaudeArgs`, `buildSanitizedEnv`,
 * `buildStdinPayload` — imported, never retyped. The only thing this script
 * adds is raw-stdout capture, which `callClaudeSubscriptionModel` does not
 * expose (it parses and discards). After capture, the response is fed through
 * the SHIPPED parser (`extractModelUsage`) so the contract check exercises the
 * real code, not a reimplementation.
 *
 * Run: npx tsx benchmark/phase1-contract.ts
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveClaudeExecutable,
  buildClaudeArgs,
  buildSanitizedEnv,
  buildStdinPayload,
  extractModelUsage,
  FORBIDDEN_CHILD_ENV_VARS,
} from "../src/router/providers/claudeSubscription.js";
import type { CompiledContext } from "../src/context/types.js";

// CHEAP tier's pinned snapshot — the smallest model, to minimise entitlement draw.
const MODEL_ID = "claude-haiku-4-5-20251001";

const EXPECTED_SHAPE = {
  type: "object",
  properties: { status: { type: "string" }, value: { type: "number" } },
  required: ["status", "value"],
  additionalProperties: false,
};

/** Minimal, deterministic, genuinely model-invoking. Not a --version check. */
const compiledContext: CompiledContext = {
  layers: {
    instructions:
      "You are a structured-output function. Return a JSON object containing exactly " +
      '{"status": "ok", "value": 42}. Do not include any other fields.',
    constraints: "Return only the JSON object.",
    taskState: "",
    memory: "",
    artifacts: "",
    toolSchemas: [],
  },
  provenance: { included: [], excluded: [] },
  estimatedInputTokens: 60,
};

/** Redacts anything credential-shaped before anything is written to disk. */
function redact(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[REDACTED-API-KEY]")
    .replace(/"(access_token|refresh_token|apiKey|token)"\s*:\s*"[^"]*"/gi, '"$1":"[REDACTED]"');
}

async function main() {
  const executable = resolveClaudeExecutable();
  const args = buildClaudeArgs(MODEL_ID, EXPECTED_SHAPE);
  const env = buildSanitizedEnv();
  const stdinPayload = buildStdinPayload(compiledContext, EXPECTED_SHAPE);
  const cwd = await mkdtemp(path.join(tmpdir(), "acc-bench-p1-"));

  const preflight = {
    executable,
    executableIsExe: /\.exe$/i.test(executable),
    executableIsCmdOrBat: /\.(cmd|bat)$/i.test(executable),
    shell: false,
    cwd,
    cwdIsOutsideRepo: !path.resolve(cwd).startsWith(path.resolve(process.cwd())),
    cwdContentsBefore: await readdir(cwd),
    argv: args,
    argvContainsBare: args.includes("--bare"),
    argvContainsFallbackModel: args.includes("--fallback-model"),
    pinnedModelPassed: args[args.indexOf("--model") + 1],
    jsonSchemaPassed: args.includes("--json-schema"),
    noSessionPersistence: args.includes("--no-session-persistence"),
    toolsDisabled: args[args.indexOf("--tools") + 1] === "",
    strictMcpConfig: args.includes("--strict-mcp-config"),
    settingSourcesEmpty: args[args.indexOf("--setting-sources") + 1] === "",
    childEnvKeys: Object.keys(env).sort(),
    forbiddenPresentInChildEnv: FORBIDDEN_CHILD_ENV_VARS.filter((k) => k in env),
    parentHasApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
    childHasApiKey: Boolean(env.ANTHROPIC_API_KEY),
    stdinBytes: Buffer.byteLength(stdinPayload, "utf8"),
    stdinContainsCredentialPattern: /sk-ant-/.test(stdinPayload),
  };
  console.log("PREFLIGHT", JSON.stringify(preflight, null, 2));

  const startedAt = Date.now();
  let firstByteAt: number | null = null;

  const outcome = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      if (firstByteAt === null) firstByteAt = Date.now();
      stdout += String(c);
    });
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    child.stdin.on("error", () => {});
    child.stdin.end(stdinPayload);
  });

  const wallClockMs = Date.now() - startedAt;
  const cwdContentsAfter = await readdir(cwd);

  console.log("EXIT_CODE", outcome.code);
  console.log("WALL_CLOCK_MS", wallClockMs);
  console.log("TIME_TO_FIRST_STDOUT_BYTE_MS", firstByteAt === null ? null : firstByteAt - startedAt);
  console.log("CWD_CONTENTS_AFTER", JSON.stringify(cwdContentsAfter));
  console.log("STDERR", redact(outcome.stderr).slice(0, 1500));

  let parsed: Record<string, unknown> | null = null;
  let parseError: string | null = null;
  try {
    parsed = JSON.parse(outcome.stdout) as Record<string, unknown>;
  } catch (e) {
    parseError = (e as Error).message;
  }

  // --- Contract check against the SHIPPED parser -----------------------------
  let parserResult: unknown = null;
  let parserError: string | null = null;
  if (parsed) {
    try {
      parserResult = extractModelUsage(parsed);
    } catch (e) {
      parserError = `${(e as { code?: string }).code ?? "?"}: ${(e as Error).message}`;
    }
  }

  console.log("\n=== TOP-LEVEL FIELDS ===");
  console.log(parsed ? JSON.stringify(Object.keys(parsed).sort(), null, 2) : `PARSE FAILED: ${parseError}`);

  if (parsed) {
    console.log("\n=== usage ===");
    console.log(JSON.stringify(parsed.usage, null, 2));
    console.log("\n=== modelUsage ===");
    console.log(JSON.stringify(parsed.modelUsage, null, 2));
    console.log("\n=== structured_output ===");
    console.log(JSON.stringify(parsed.structured_output, null, 2));
    console.log("\n=== selected scalars ===");
    for (const k of [
      "is_error",
      "subtype",
      "type",
      "stop_reason",
      "terminal_reason",
      "result",
      "total_cost_usd",
      "duration_ms",
      "duration_api_ms",
      "ttft_ms",
      "num_turns",
      "session_id",
      "permission_denials",
      "api_error_status",
      "uuid",
    ]) {
      if (k in parsed) console.log(`  ${k}:`, JSON.stringify(parsed[k]));
    }
  }

  console.log("\n=== SHIPPED PARSER (extractModelUsage) ===");
  console.log(parserError ? `THREW -> ${parserError}` : JSON.stringify(parserResult, null, 2));

  await writeFile(
    path.resolve("benchmark/raw/phase1-raw.json"),
    redact(
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          preflight,
          wallClockMs,
          timeToFirstStdoutByteMs: firstByteAt === null ? null : firstByteAt - startedAt,
          exitCode: outcome.code,
          stderr: outcome.stderr,
          cwdContentsAfter,
          parseError,
          shippedParserResult: parserResult,
          shippedParserError: parserError,
          rawStdoutParsed: parsed,
          rawStdoutText: outcome.stdout,
        },
        null,
        2
      )
    ),
    "utf8"
  );
  console.log("\nRAW ARTIFACT WRITTEN -> benchmark/raw/phase1-raw.json");

  await rm(cwd, { recursive: true, force: true });
}

main().catch((e) => {
  console.error("BENCH_ERROR", e);
  process.exit(1);
});
