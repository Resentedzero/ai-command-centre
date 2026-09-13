/**
 * PHASE 2 — representative workload benchmark. BENCHMARK ARTIFACT.
 *
 * Every component of each invocation comes from the SHIPPED provider
 * (`resolveClaudeExecutable`, `buildClaudeArgs`, `buildSanitizedEnv`,
 * `buildStdinPayload`, `extractModelUsage`) — imported, never retyped. The only
 * additions are raw capture and measurement, which the adapter does not expose.
 *
 * STRICTLY SEQUENTIAL — one subprocess per invocation, never reused, no
 * concurrency (that is Phase 4). No retries: a failure is recorded and the
 * suite moves to the next independently-planned run.
 *
 * Run: npx tsx benchmark/phase2-run.ts
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
import { WORKLOADS, type Workload } from "./workloads.js";

const CHEAP_MODEL = "claude-haiku-4-5-20251001";
const STRONG_MODEL = "claude-opus-5";
const CHEAP_REPS = 3;
const TIMEOUT_MS = 300_000;

type RunResult = Record<string, unknown>;

function redact(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[REDACTED-API-KEY]")
    .replace(/"(access_token|refresh_token|apiKey|token)"\s*:\s*"[^"]*"/gi, '"$1":"[REDACTED]"');
}

async function runOnce(
  workload: Workload,
  modelId: string,
  tier: "CHEAP" | "STRONG",
  repIndex: number,
  isCold: boolean
): Promise<RunResult> {
  const executable = resolveClaudeExecutable();
  const args = buildClaudeArgs(modelId, workload.schema);
  const env = buildSanitizedEnv();
  const stdinPayload = buildStdinPayload(workload.context, workload.schema);
  const cwd = await mkdtemp(path.join(tmpdir(), "acc-bench-p2-"));

  const isolation = {
    cwdOutsideRepo: !path.resolve(cwd).startsWith(path.resolve(process.cwd())),
    cwdEmptyBefore: (await readdir(cwd)).length === 0,
    forbiddenEnvPresent: FORBIDDEN_CHILD_ENV_VARS.filter((k) => k in env),
    childHasApiKey: Boolean(env.ANTHROPIC_API_KEY),
    toolsDisabled: args[args.indexOf("--tools") + 1] === "",
    strictMcp: args.includes("--strict-mcp-config"),
    settingSourcesEmpty: args[args.indexOf("--setting-sources") + 1] === "",
    noBare: !args.includes("--bare"),
    noFallbackModel: !args.includes("--fallback-model"),
    shell: false,
  };

  const startedAt = Date.now();
  let firstByteAt: number | null = null;

  let outcome: { stdout: string; stderr: string; code: number | null; timedOut: boolean };
  try {
    outcome = await new Promise((resolve, reject) => {
      const child = spawn(executable, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, TIMEOUT_MS);
      child.stdout.on("data", (c) => {
        if (firstByteAt === null) firstByteAt = Date.now();
        stdout += String(c);
      });
      child.stderr.on("data", (c) => (stderr += String(c)));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code, timedOut });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(stdinPayload);
    });
  } catch (e) {
    await rm(cwd, { recursive: true, force: true });
    return {
      workloadId: workload.id,
      tier,
      requestedModel: modelId,
      repIndex,
      cold: isCold,
      success: false,
      failureCode: "spawn_failed",
      failureDetail: (e as Error).message,
      isolation,
    };
  }

  const wallClockMs = Date.now() - startedAt;
  const cwdContentsAfter = await readdir(cwd);
  await rm(cwd, { recursive: true, force: true });

  const base: RunResult = {
    workloadId: workload.id,
    tier,
    requestedModel: modelId,
    repIndex,
    cold: isCold,
    stdinBytes: Buffer.byteLength(stdinPayload, "utf8"),
    wallClockMs,
    timeToFirstByteMs: firstByteAt === null ? null : firstByteAt - startedAt,
    exitCode: outcome.code,
    timedOut: outcome.timedOut,
    isolation,
    cwdEmptyAfter: cwdContentsAfter.length === 0,
    stderr: redact(outcome.stderr).slice(0, 500),
  };

  if (outcome.timedOut) return { ...base, success: false, failureCode: "timeout" };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(outcome.stdout) as Record<string, unknown>;
  } catch (e) {
    return { ...base, success: false, failureCode: "parse_error", failureDetail: (e as Error).message };
  }

  if (outcome.code !== 0 || parsed.is_error === true) {
    return {
      ...base,
      success: false,
      failureCode: "cli_error",
      subtype: parsed.subtype,
      resultText: redact(String(parsed.result ?? "")).slice(0, 400),
    };
  }

  // --- usage, via the SHIPPED parser ---------------------------------------
  let adapterEntries: Array<{ modelId: string; tokensIn: number; tokensOut: number }> = [];
  let adapterTotalTokens: number | null = null;
  let adapterError: string | null = null;
  try {
    const r = extractModelUsage(parsed);
    adapterEntries = r.entries;
    adapterTotalTokens = r.totalTokens;
  } catch (e) {
    adapterError = `${(e as { code?: string }).code ?? "?"}: ${(e as Error).message}`;
  }

  // --- full reported footprint, kept in SEPARATE categories -----------------
  const modelUsage = (parsed.modelUsage ?? {}) as Record<string, Record<string, unknown>>;
  const modelUsageDetail = Object.entries(modelUsage).map(([key, v]) => ({
    key,
    modelId: key,
    canonicalModel: v.canonicalModel,
    provider: v.provider,
    inputTokens: v.inputTokens,
    outputTokens: v.outputTokens,
    cacheCreationInputTokens: v.cacheCreationInputTokens,
    cacheReadInputTokens: v.cacheReadInputTokens,
    thinkingTokens: v.thinkingTokens,
    webSearchRequests: v.webSearchRequests,
    costUSD: v.costUSD,
    costBasis: v.costBasis,
  }));

  const sum = (field: string) =>
    modelUsageDetail.reduce((acc, e) => acc + (typeof e[field as keyof typeof e] === "number" ? (e[field as keyof typeof e] as number) : 0), 0);

  const reported = {
    A_adapterAccounting_inPlusOut: adapterTotalTokens,
    B_cacheCreationInputTokens: sum("cacheCreationInputTokens"),
    C_cacheReadInputTokens: sum("cacheReadInputTokens"),
    D_totalReportedFootprint:
      (adapterTotalTokens ?? 0) + sum("cacheCreationInputTokens") + sum("cacheReadInputTokens"),
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    thinkingTokens: sum("thinkingTokens"),
    webSearchRequests: sum("webSearchRequests"),
  };

  const structured = parsed.structured_output;
  const schemaErrors = structured === undefined ? ["structured_output absent"] : workload.validate(structured);

  return {
    ...base,
    success: true,
    adapterError,
    adapterEntries,
    modelUsageEntryCount: modelUsageDetail.length,
    modelUsageDetail,
    reported,
    topLevelUsage: parsed.usage,
    structuredOutputValid: schemaErrors.length === 0,
    structuredOutputErrors: schemaErrors,
    structuredOutput: structured,
    stopReason: parsed.stop_reason,
    numTurns: parsed.num_turns,
    subtype: parsed.subtype,
    durationMs: parsed.duration_ms,
    durationApiMs: parsed.duration_api_ms,
    ttftMs: parsed.ttft_ms,
    totalCostUsdDiagnostic: parsed.total_cost_usd,
    sessionId: parsed.session_id,
    permissionDenials: parsed.permission_denials,
    apiErrorStatus: parsed.api_error_status,
  };
}

async function main() {
  const results: RunResult[] = [];
  let runIndex = 0;

  // --- CHEAP tier: every workload, 3 reps, strictly sequential -------------
  for (const workload of WORKLOADS) {
    for (let rep = 1; rep <= CHEAP_REPS; rep++) {
      const isCold = runIndex === 0;
      process.stdout.write(`RUN ${++runIndex}: ${workload.id} CHEAP rep${rep} ... `);
      const r = await runOnce(workload, CHEAP_MODEL, "CHEAP", rep, isCold);
      results.push(r);
      console.log(
        r.success
          ? `ok ${r.wallClockMs}ms adapter=${(r.reported as Record<string, unknown>).A_adapterAccounting_inPlusOut} ` +
            `cacheCreate=${(r.reported as Record<string, unknown>).B_cacheCreationInputTokens} ` +
            `schemaValid=${r.structuredOutputValid} entries=${r.modelUsageEntryCount}`
          : `FAILED ${r.failureCode}`
      );

      // Account-safety gate: stop the whole suite on any sign of throttling.
      if (!r.success && (r.failureCode === "cli_error" || r.failureCode === "timeout")) {
        const text = String(r.resultText ?? "").toLowerCase();
        if (text.includes("rate") || text.includes("limit") || text.includes("quota")) {
          console.log("\n!! THROTTLING/EXHAUSTION SIGNAL — HALTING BENCHMARK");
          await writeFile(
            path.resolve("benchmark/raw/phase2-results.json"),
            redact(JSON.stringify({ haltedEarly: true, results }, null, 2)),
            "utf8"
          );
          return;
        }
      }
    }
  }

  // --- STRONG tier: one run, to see whether a non-Haiku primary separates
  //     the internal secondary call into its own modelUsage entry.
  process.stdout.write(`RUN ${++runIndex}: W1-small-synthesis STRONG rep1 ... `);
  const strong = await runOnce(WORKLOADS[0]!, STRONG_MODEL, "STRONG", 1, false);
  results.push(strong);
  console.log(
    strong.success
      ? `ok ${strong.wallClockMs}ms entries=${strong.modelUsageEntryCount} ` +
        `adapter=${(strong.reported as Record<string, unknown>).A_adapterAccounting_inPlusOut}`
      : `FAILED ${strong.failureCode}`
  );

  await writeFile(
    path.resolve("benchmark/raw/phase2-results.json"),
    redact(JSON.stringify({ haltedEarly: false, results }, null, 2)),
    "utf8"
  );
  console.log("\nRESULTS WRITTEN -> benchmark/raw/phase2-results.json");
}

main().catch((e) => {
  console.error("BENCH_ERROR", e);
  process.exit(1);
});
