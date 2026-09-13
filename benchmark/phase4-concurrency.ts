/**
 * PHASE 4A (targeted Opus attribution) + 4B (controlled concurrency).
 * BENCHMARK ARTIFACT — no production file is modified or imported-into.
 *
 * Every invocation uses the SHIPPED provider's helpers for the isolation
 * boundary; the only deviation is `--output-format stream-json --verbose`, so
 * `rate_limit_event` and the `system/init` tool surface are OBSERVED rather
 * than inferred. Isolation is re-asserted on every argv before launch.
 *
 * Run: npx tsx benchmark/phase4-concurrency.ts
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
  FORBIDDEN_CHILD_ENV_VARS,
} from "../src/router/providers/claudeSubscription.js";
import type { CompiledContext } from "../src/context/types.js";

const HAIKU = "claude-haiku-4-5-20251001";
const OPUS = "claude-opus-5";
const TIMEOUT_MS = 300_000;

const SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};

const FILLER = [
  "Decoder latency, not physical qubit count, binds logical cycle time.",
  "Surface-code distances beyond 7 show diminishing returns at present error rates.",
  "Below-threshold operation is reported on small logical qubits.",
  "Cryogenic wiring density is a packaging bottleneck above 1000 qubits.",
];

function buildContext(targetBytes: number): string {
  const lines: string[] = [];
  let size = 0;
  let i = 0;
  while (size < targetBytes) {
    const line = `[${String(i).padStart(5, "0")}] ${FILLER[i % FILLER.length]} Observation index ${i}, variance ${(i % 9) + 1}%.`;
    lines.push(line);
    size += line.length + 1;
    i++;
  }
  return lines.join("\n");
}

function ctxFor(artifacts: string): CompiledContext {
  return {
    layers: {
      instructions:
        "You are a structured-output function. Read the context if present and return a single " +
        "short sentence in the `answer` field. Do not take any action and do not use any tool.",
      constraints: "One sentence only.",
      taskState: "",
      memory: "",
      artifacts,
      toolSchemas: [],
    },
    provenance: { included: [], excluded: [] },
    estimatedInputTokens: Math.ceil(artifacts.length / 4),
  };
}

/** Production argv, switched to stream-json so rate_limit_event is observable. */
function streamArgs(model: string): string[] {
  const args = buildClaudeArgs(model, SCHEMA);
  const i = args.indexOf("--output-format");
  args[i + 1] = "stream-json";
  args.push("--verbose");
  return args;
}

const ISOLATION_FLAGS = ["--tools", "--strict-mcp-config", "--setting-sources", "--permission-mode", "--permission-prompts", "--no-session-persistence", "--json-schema"];

function assertIsolation(args: string[], label: string): void {
  for (const f of ISOLATION_FLAGS) if (!args.includes(f)) throw new Error(`${label}: missing ${f}`);
  if (args[args.indexOf("--tools") + 1] !== "") throw new Error(`${label}: --tools not ""`);
  if (args[args.indexOf("--setting-sources") + 1] !== "") throw new Error(`${label}: --setting-sources not ""`);
  if (args.includes("--bare") || args.includes("--fallback-model")) throw new Error(`${label}: forbidden flag`);
}

const redact = (t: string) => t.replace(/sk-ant-[A-Za-z0-9_-]+/g, "[REDACTED]");

type Run = Record<string, any>;

async function invoke(opts: {
  id: string;
  index: number;
  concurrency: number;
  model: string;
  args: string[];
  stdinPayload: string;
  t0: number;
}): Promise<Run> {
  const executable = resolveClaudeExecutable();
  const env = buildSanitizedEnv();
  const cwd = await mkdtemp(path.join(tmpdir(), "acc-bench-p4-"));

  const isolation = {
    cwdOutsideRepo: !path.resolve(cwd).startsWith(path.resolve(process.cwd())),
    cwdEmptyBefore: (await readdir(cwd)).length === 0,
    forbiddenEnvPresent: FORBIDDEN_CHILD_ENV_VARS.filter((k) => k in env),
    childHasApiKey: Boolean(env.ANTHROPIC_API_KEY),
  };

  const launchedAt = Date.now();
  let firstByteAt: number | null = null;

  const out = await new Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }>(
    (resolve, reject) => {
      const child = spawn(executable, opts.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const t = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, TIMEOUT_MS);
      child.stdout.on("data", (c) => {
        if (firstByteAt === null) firstByteAt = Date.now();
        stdout += String(c);
      });
      child.stderr.on("data", (c) => (stderr += String(c)));
      child.on("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(t);
        resolve({ stdout, stderr, code, timedOut });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(opts.stdinPayload);
    }
  );

  const completedAt = Date.now();
  const cwdAfter = await readdir(cwd);
  await rm(cwd, { recursive: true, force: true });

  // --- parse NDJSON stream --------------------------------------------------
  let result: Record<string, any> | null = null;
  let initEvent: Record<string, any> | null = null;
  const rateLimitEvents: Record<string, any>[] = [];
  const eventTypes = new Set<string>();

  for (const line of out.stdout.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      const ev = JSON.parse(s) as Record<string, any>;
      eventTypes.add(`${ev.type}/${ev.subtype ?? ""}`);
      if (ev.type === "system" && ev.subtype === "init") initEvent = ev;
      if (ev.type === "rate_limit_event") rateLimitEvents.push(ev);
      if (ev.type === "result") result = ev;
    } catch {
      /* ignore */
    }
  }

  const base: Run = {
    id: opts.id,
    index: opts.index,
    concurrency: opts.concurrency,
    model: opts.model,
    stdinBytes: Buffer.byteLength(opts.stdinPayload, "utf8"),
    launchOffsetMs: launchedAt - opts.t0,
    firstByteOffsetMs: firstByteAt === null ? null : firstByteAt - opts.t0,
    completionOffsetMs: completedAt - opts.t0,
    wallClockMs: completedAt - launchedAt,
    ttftMs: firstByteAt === null ? null : firstByteAt - launchedAt,
    exitCode: out.code,
    timedOut: out.timedOut,
    isolation,
    cwdEmptyAfter: cwdAfter.length === 0,
    rateLimitEventCount: rateLimitEvents.length,
    rateLimitEvents: rateLimitEvents.slice(0, 4),
    streamEventTypes: [...eventTypes],
    initToolSurface: initEvent ? { tools: initEvent.tools, mcp_servers: initEvent.mcp_servers } : null,
    stderr: redact(out.stderr).slice(0, 400),
  };

  if (out.timedOut) return { ...base, success: false, failureCode: "timeout" };
  if (!result) return { ...base, success: false, failureCode: "no_result_event", rawHead: redact(out.stdout).slice(0, 300) };
  if (out.code !== 0 || result.is_error === true) {
    const text = redact(String(result.result ?? "")).toLowerCase();
    const throttled = /rate|limit|quota|overload|capacity/.test(text);
    return {
      ...base,
      success: false,
      failureCode: throttled ? "throttled" : "cli_error",
      subtype: result.subtype,
      resultText: redact(String(result.result ?? "")).slice(0, 300),
    };
  }

  const mu = (result.modelUsage ?? {}) as Record<string, Record<string, any>>;
  const entries = Object.entries(mu).map(([k, v]) => ({
    model: k,
    inputTokens: v.inputTokens,
    outputTokens: v.outputTokens,
    cacheCreationInputTokens: v.cacheCreationInputTokens,
    cacheReadInputTokens: v.cacheReadInputTokens,
    thinkingTokens: v.thinkingTokens,
    webSearchRequests: v.webSearchRequests,
    costUSD: v.costUSD,
    costBasis: v.costBasis,
  }));
  const sum = (f: string) => entries.reduce((a, e) => a + (typeof (e as any)[f] === "number" ? (e as any)[f] : 0), 0);
  const A = sum("inputTokens") + sum("outputTokens");
  const B = sum("cacheCreationInputTokens");
  const C = sum("cacheReadInputTokens");
  const u = result.usage ?? {};

  const so = result.structured_output;
  return {
    ...base,
    success: true,
    modelUsageEntries: entries,
    modelUsageEntryCount: entries.length,
    accounting: { A_adapterTokens: A, B_cacheCreation: B, C_cacheRead: C, D_totalFootprint: A + B + C },
    thinkingTokens: sum("thinkingTokens"),
    webSearchRequests: sum("webSearchRequests"),
    topLevel: {
      input_tokens: u.input_tokens,
      output_tokens: u.output_tokens,
      cache_creation_input_tokens: u.cache_creation_input_tokens,
      cache_read_input_tokens: u.cache_read_input_tokens,
      thinking_tokens: u.output_tokens_details?.thinking_tokens,
      server_tool_use: u.server_tool_use,
      service_tier: u.service_tier,
    },
    turns: result.num_turns,
    stopReason: result.stop_reason,
    costUSDDiagnostic: result.total_cost_usd,
    structuredValid: typeof so === "object" && so !== null && typeof so.answer === "string" && Object.keys(so).length === 1,
  };
}

/** Halt conditions that must abort the whole benchmark immediately. */
function safetyViolation(r: Run): string | null {
  if (r.isolation?.childHasApiKey) return "API key reached child environment";
  if ((r.isolation?.forbiddenEnvPresent?.length ?? 0) > 0) return "forbidden env var reached child";
  if (r.initToolSurface && Array.isArray(r.initToolSurface.mcp_servers) && r.initToolSurface.mcp_servers.length > 0)
    return "mcp_servers became non-empty";
  if (r.success && (r.webSearchRequests as number) > 0) return "server-side web tool was used";
  if (r.success && r.cwdEmptyAfter === false) return "unexpected filesystem mutation in cwd";
  return null;
}

async function main() {
  const results: Run[] = [];
  let aborted: string | null = null;

  // =========================== PHASE 4A ==================================
  console.log("--- PHASE 4A: targeted Opus attribution ---");
  for (const [label, bytes] of [
    ["4A-opus-1kb", 1024],
    ["4A-opus-10kb", 10 * 1024],
  ] as Array<[string, number]>) {
    const args = streamArgs(OPUS);
    assertIsolation(args, label);
    const stdinPayload = buildStdinPayload(ctxFor(buildContext(bytes)), SCHEMA);
    process.stdout.write(`${label} ... `);
    const r = await invoke({ id: label, index: 0, concurrency: 1, model: OPUS, args, stdinPayload, t0: Date.now() });
    results.push(r);
    console.log(
      r.success
        ? `ok ${r.wallClockMs}ms A=${r.accounting.A_adapterTokens} B=${r.accounting.B_cacheCreation} C=${r.accounting.C_cacheRead} entries=${r.modelUsageEntryCount} turns=${r.turns} rle=${r.rateLimitEventCount}`
        : `FAILED ${r.failureCode}`
    );
    const v = safetyViolation(r);
    if (v) {
      aborted = `SAFETY STOP in ${label}: ${v}`;
      break;
    }
  }

  // =========================== PHASE 4B ==================================
  if (!aborted) {
    console.log("\n--- PHASE 4B: controlled concurrency (Haiku, identical ~1KB W1) ---");
    const args = streamArgs(HAIKU);
    assertIsolation(args, "4B");
    const stdinPayload = buildStdinPayload(ctxFor(buildContext(1024)), SCHEMA);

    for (const N of [1, 2, 4, 8]) {
      process.stdout.write(`N=${N} launching ${N} concurrent ... `);
      const t0 = Date.now();
      const batch = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          invoke({ id: `4B-N${N}`, index: i, concurrency: N, model: HAIKU, args, stdinPayload, t0 })
        )
      );
      results.push(...batch);

      const okRuns = batch.filter((r) => r.success);
      const rle = batch.reduce((a, r) => a + (r.rateLimitEventCount as number), 0);
      const lats = okRuns.map((r) => r.wallClockMs as number).sort((a, b) => a - b);
      console.log(
        `ok=${okRuns.length}/${N} failed=${N - okRuns.length} rateLimitEvents=${rle} ` +
          `medLat=${lats.length ? lats[Math.floor(lats.length / 2)] : "-"}ms maxLat=${lats.length ? lats[lats.length - 1] : "-"}ms`
      );

      for (const r of batch) {
        const v = safetyViolation(r);
        if (v) {
          aborted = `SAFETY STOP at N=${N}: ${v}`;
          break;
        }
      }
      if (aborted) break;

      // Halt on severe throttling or majority failure rather than escalating.
      const throttled = batch.filter((r) => r.failureCode === "throttled").length;
      if (throttled > 0) {
        aborted = `SAFETY STOP at N=${N}: ${throttled} throttled invocation(s)`;
        break;
      }
      if (okRuns.length < N / 2) {
        aborted = `SAFETY STOP at N=${N}: majority failure (${N - okRuns.length}/${N})`;
        break;
      }
    }
  }

  if (aborted) console.log(`\n!! ${aborted}`);

  await writeFile(
    path.resolve("benchmark/raw/phase4-results.json"),
    redact(JSON.stringify({ aborted, results }, null, 2)),
    "utf8"
  );
  console.log(`\nWRITTEN -> benchmark/raw/phase4-results.json`);
}

main().catch((e) => {
  console.error("BENCH_ERROR", e);
  process.exit(1);
});
