/**
 * PHASE 5 — quota-delta measurement. BENCHMARK ARTIFACT.
 *
 * Measures OBSERVED WINDOW UTILIZATION DELTA around controlled bursts. It does
 * NOT measure tokens consumed, and derives no conversion factor.
 *
 * Unavoidable methodological facts, recorded rather than hidden:
 *  - Reading `rate_limit_event` REQUIRES an invocation, so every probe itself
 *    consumes entitlement. Probes are counted explicitly.
 *  - This Claude Code session shares the same Max pool, so utilization can move
 *    for reasons unrelated to the benchmark. Attribution is confounded by
 *    construction.
 *  - Utilization is reported to 2 decimals (1% granularity). A delta smaller
 *    than that is "below observable resolution", not "zero".
 *
 * Production isolation boundary is used verbatim; isolation is asserted before
 * every launch. Nothing in `src/` is modified.
 *
 * Run: npx tsx benchmark/phase5-quota.ts
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

const MODEL = "claude-haiku-4-5-20251001";
const TIMEOUT_MS = 300_000;
/** Halt well clear of exhaustion. */
const FIVE_HOUR_SAFETY_CEILING = 0.8;

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

const CONTEXT: CompiledContext = {
  layers: {
    instructions:
      "You are a structured-output function. Read the context and return a single short sentence " +
      "in the `answer` field. Do not take any action and do not use any tool.",
    constraints: "One sentence only.",
    taskState: "",
    memory: "",
    artifacts: buildContext(1024),
    toolSchemas: [],
  },
  provenance: { included: [], excluded: [] },
  estimatedInputTokens: 256,
};

function streamArgs(): string[] {
  const args = buildClaudeArgs(MODEL, SCHEMA);
  args[args.indexOf("--output-format") + 1] = "stream-json";
  args.push("--verbose");
  return args;
}

const FLAGS = ["--tools", "--strict-mcp-config", "--setting-sources", "--permission-mode", "--permission-prompts", "--no-session-persistence", "--json-schema"];
function assertIsolation(args: string[]): void {
  for (const f of FLAGS) if (!args.includes(f)) throw new Error(`isolation: missing ${f}`);
  if (args[args.indexOf("--tools") + 1] !== "") throw new Error('isolation: --tools not ""');
  if (args[args.indexOf("--setting-sources") + 1] !== "") throw new Error('isolation: --setting-sources not ""');
  if (args.includes("--bare") || args.includes("--fallback-model")) throw new Error("isolation: forbidden flag");
}

const redact = (t: string) => t.replace(/sk-ant-[A-Za-z0-9_-]+/g, "[REDACTED]");

type Util = {
  observedAt: number;
  status: string;
  overageStatus: string;
  rateLimitType: string;
  fiveHourUtilization: number;
  fiveHourResetsAt: number;
  sevenDayUtilization: number;
  sevenDayResetsAt: number;
};

type Run = Record<string, any>;

const ARGS = streamArgs();
assertIsolation(ARGS);
const STDIN = buildStdinPayload(CONTEXT, SCHEMA);

async function invoke(label: string, index: number): Promise<Run> {
  const executable = resolveClaudeExecutable();
  const env = buildSanitizedEnv();
  const cwd = await mkdtemp(path.join(tmpdir(), "acc-bench-p5-"));

  const isolation = {
    cwdOutsideRepo: !path.resolve(cwd).startsWith(path.resolve(process.cwd())),
    cwdEmptyBefore: (await readdir(cwd)).length === 0,
    forbiddenEnvPresent: FORBIDDEN_CHILD_ENV_VARS.filter((k) => k in env),
    childHasApiKey: Boolean(env.ANTHROPIC_API_KEY),
  };

  const launchedAt = Date.now();
  let firstByteAt: number | null = null;

  const out = await new Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }>((resolve, reject) => {
    const child = spawn(executable, ARGS, { cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false });
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
    child.stdin.end(STDIN);
  });

  const completedAt = Date.now();
  const cwdAfter = await readdir(cwd);
  await rm(cwd, { recursive: true, force: true });

  let result: Record<string, any> | null = null;
  let initEvent: Record<string, any> | null = null;
  const utils: Util[] = [];

  for (const line of out.stdout.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      const ev = JSON.parse(s) as Record<string, any>;
      if (ev.type === "system" && ev.subtype === "init") initEvent = ev;
      if (ev.type === "result") result = ev;
      if (ev.type === "rate_limit_event") {
        const i = ev.rate_limit_info ?? {};
        const w = i.unifiedWindows ?? {};
        utils.push({
          observedAt: Date.now(),
          status: i.status,
          overageStatus: i.overageStatus,
          rateLimitType: i.rateLimitType,
          fiveHourUtilization: w.five_hour?.utilization,
          fiveHourResetsAt: w.five_hour?.resetsAt,
          sevenDayUtilization: w.seven_day?.utilization,
          sevenDayResetsAt: w.seven_day?.resetsAt,
        });
      }
    } catch {
      /* ignore */
    }
  }

  const base: Run = {
    label,
    index,
    launchedAt,
    completedAt,
    wallClockMs: completedAt - launchedAt,
    ttftMs: firstByteAt === null ? null : firstByteAt - launchedAt,
    exitCode: out.code,
    timedOut: out.timedOut,
    isolation,
    cwdEmptyAfter: cwdAfter.length === 0,
    utilObservations: utils,
    initToolSurface: initEvent ? { tools: initEvent.tools, mcp_servers: initEvent.mcp_servers } : null,
  };

  if (out.timedOut) return { ...base, success: false, failureCode: "timeout" };
  if (!result) return { ...base, success: false, failureCode: "no_result" };
  if (out.code !== 0 || result.is_error === true) {
    return { ...base, success: false, failureCode: "cli_error", subtype: result.subtype, resultText: redact(String(result.result ?? "")).slice(0, 300) };
  }

  const mu = (result.modelUsage ?? {}) as Record<string, Record<string, any>>;
  const entries = Object.entries(mu).map(([k, v]) => ({
    model: k,
    inputTokens: v.inputTokens,
    outputTokens: v.outputTokens,
    cacheCreationInputTokens: v.cacheCreationInputTokens,
    cacheReadInputTokens: v.cacheReadInputTokens,
    thinkingTokens: v.thinkingTokens,
  }));
  const sum = (f: string) => entries.reduce((a, e) => a + (typeof (e as any)[f] === "number" ? (e as any)[f] : 0), 0);
  const A = sum("inputTokens") + sum("outputTokens");
  const B = sum("cacheCreationInputTokens");
  const C = sum("cacheReadInputTokens");
  const so = result.structured_output;

  return {
    ...base,
    success: true,
    modelUsageEntries: entries,
    accounting: { A, B, C, D: A + B + C },
    turns: result.num_turns,
    stopReason: result.stop_reason,
    costUSDDiagnostic: result.total_cost_usd,
    structuredValid: typeof so === "object" && so !== null && typeof so.answer === "string",
  };
}

function latestUtil(runs: Run[]): Util | null {
  const all = runs.flatMap((r) => (r.utilObservations ?? []) as Util[]).filter((u) => typeof u.fiveHourUtilization === "number");
  return all.length ? all[all.length - 1]! : null;
}

function safetyCheck(runs: Run[]): string | null {
  for (const r of runs) {
    if (r.isolation?.childHasApiKey) return "API key reached child";
    if ((r.isolation?.forbiddenEnvPresent?.length ?? 0) > 0) return "forbidden env reached child";
    if (r.initToolSurface && (r.initToolSurface.mcp_servers ?? []).length > 0) return "mcp_servers non-empty";
    if (r.success && r.cwdEmptyAfter === false) return "filesystem mutation in cwd";
    for (const u of (r.utilObservations ?? []) as Util[]) {
      if (u.status && u.status !== "allowed") return `rate limit status="${u.status}"`;
      if (u.overageStatus && u.overageStatus !== "rejected") return `overageStatus changed to "${u.overageStatus}"`;
      if (typeof u.fiveHourUtilization === "number" && u.fiveHourUtilization > FIVE_HOUR_SAFETY_CEILING)
        return `five_hour utilization ${u.fiveHourUtilization} exceeds ceiling ${FIVE_HOUR_SAFETY_CEILING}`;
    }
    if (!r.success && r.failureCode === "cli_error" && /rate|limit|quota/i.test(String(r.resultText ?? "")))
      return "throttling indicated in CLI error";
  }
  return null;
}

const allRuns: Run[] = [];
const bursts: Record<string, any>[] = [];
let aborted: string | null = null;

async function probe(label: string): Promise<Util | null> {
  process.stdout.write(`  ${label} probe ... `);
  const r = await invoke(label, 0);
  allRuns.push(r);
  const u = latestUtil([r]);
  console.log(u ? `5h=${u.fiveHourUtilization} 7d=${u.sevenDayUtilization} status=${u.status}` : `no util (${r.failureCode ?? "ok"})`);
  const v = safetyCheck([r]);
  if (v) aborted = `SAFETY STOP during ${label}: ${v}`;
  return u;
}

async function burst(label: string, n: number, concurrent: boolean): Promise<Run[]> {
  process.stdout.write(`  ${label}: ${n} ${concurrent ? "concurrent" : "sequential"} ... `);
  let runs: Run[];
  if (concurrent) {
    runs = await Promise.all(Array.from({ length: n }, (_, i) => invoke(label, i)));
  } else {
    runs = [];
    for (let i = 0; i < n; i++) runs.push(await invoke(label, i));
  }
  allRuns.push(...runs);
  const ok = runs.filter((r) => r.success);
  console.log(`ok=${ok.length}/${n}`);
  const v = safetyCheck(runs);
  if (v) aborted = `SAFETY STOP during ${label}: ${v}`;
  return runs;
}

function recordBurst(name: string, n: number, before: Util | null, after: Util | null, runs: Run[]): void {
  const ok = runs.filter((r) => r.success);
  const agg = (k: string) => ok.reduce((a, r) => a + (r.accounting?.[k] ?? 0), 0);
  const d5 = before && after ? Number((after.fiveHourUtilization - before.fiveHourUtilization).toFixed(4)) : null;
  const d7 = before && after ? Number((after.sevenDayUtilization - before.sevenDayUtilization).toFixed(4)) : null;
  const windowReset = before && after ? before.fiveHourResetsAt !== after.fiveHourResetsAt : false;
  bursts.push({
    name,
    n,
    successful: ok.length,
    before,
    after,
    deltaFiveHour: d5,
    deltaSevenDay: d7,
    fiveHourWindowResetDuringBurst: windowReset,
    deltaFiveHourPerInvocation: d5 !== null && ok.length ? Number((d5 / ok.length).toFixed(5)) : null,
    aggregate: { A: agg("A"), B: agg("B"), C: agg("C"), D: agg("D") },
    turns: [...new Set(ok.map((r) => r.turns))],
    medianLatencyMs: ok.length ? [...ok.map((r) => r.wallClockMs as number)].sort((a, b) => a - b)[Math.floor(ok.length / 2)] : null,
    structuredValid: `${ok.filter((r) => r.structuredValid).length}/${ok.length}`,
  });
  console.log(
    `    -> ${name}: Δ5h=${d5 === null ? "n/a" : d5.toFixed(4)} Δ7d=${d7 === null ? "n/a" : d7.toFixed(4)}` +
      ` aggD=${agg("D")} windowReset=${windowReset}`
  );
}

async function round(tag: string): Promise<void> {
  const u0 = await probe(`${tag}-probe0`);
  if (aborted) return;

  const a = await burst(`${tag}-burstA`, 2, false);
  if (aborted) return;
  const u1 = await probe(`${tag}-probe1`);
  recordBurst(`${tag}-BurstA(2 sequential)`, 2, u0, u1, a);
  if (aborted) return;

  if (u1 && u1.fiveHourUtilization > FIVE_HOUR_SAFETY_CEILING) {
    aborted = `SAFETY STOP: utilization ${u1.fiveHourUtilization} above ceiling before Burst B`;
    return;
  }

  const b = await burst(`${tag}-burstB`, 8, true);
  if (aborted) return;
  const u2 = await probe(`${tag}-probe2`);
  recordBurst(`${tag}-BurstB(8 concurrent)`, 8, u1, u2, b);
}

async function main() {
  console.log("PHASE 5 — quota-delta measurement (Haiku, ~1KB W1, stream-json)\n");
  console.log("ROUND 1");
  await round("R1");

  if (!aborted) {
    const u = latestUtil(allRuns);
    if (u && u.fiveHourUtilization < FIVE_HOUR_SAFETY_CEILING - 0.1) {
      console.log("\nROUND 2 (repeat for linearity/repeatability)");
      await round("R2");
    } else {
      console.log("\nROUND 2 skipped: utilization not comfortably below safety ceiling.");
    }
  }

  if (aborted) console.log(`\n!! ${aborted}`);

  await writeFile(
    path.resolve("benchmark/raw/phase5-results.json"),
    redact(JSON.stringify({ aborted, safetyCeiling: FIVE_HOUR_SAFETY_CEILING, bursts, runs: allRuns }, null, 2)),
    "utf8"
  );
  console.log(`\nInvocations: ${allRuns.length} (${allRuns.filter((r) => r.success).length} ok)`);
  console.log("WRITTEN -> benchmark/raw/phase5-results.json");
}

main().catch((e) => {
  console.error("BENCH_ERROR", e);
  process.exit(1);
});
