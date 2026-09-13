/**
 * PHASE 3 — attribution + security experiment. BENCHMARK ARTIFACT.
 *
 * Nothing in `src/` imports this, and NO production file is modified. Every
 * invocation is built from the SHIPPED provider's own helpers
 * (`resolveClaudeExecutable`, `buildClaudeArgs`, `buildSanitizedEnv`,
 * `buildStdinPayload`), so the isolation boundary is identical to production.
 *
 * Two variants deliberately DERIVE from production argv rather than
 * hand-rolling it:
 *   - F-plain     : production argv minus the `--json-schema <value>` PAIR ONLY.
 *   - G-security  : production argv with `--output-format stream-json --verbose`
 *                   to expose the session's init event.
 * Both assert afterwards that every isolation flag survived the edit, so an
 * experiment can never silently weaken the boundary it is measuring.
 *
 * Strictly sequential. Haiku only. No retries.
 *
 * Run: npx tsx benchmark/phase3-attribution.ts
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
const REPS = 3;

/** One schema for every attribution workload, so schema size never confounds. */
const SHARED_SCHEMA = {
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

/** Deterministic context of approximately `targetBytes`. */
function buildContext(targetBytes: number): string {
  if (targetBytes <= 0) return "";
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

/** Removes exactly the `--json-schema <value>` pair; touches nothing else. */
function stripJsonSchema(args: string[]): string[] {
  const i = args.indexOf("--json-schema");
  if (i === -1) return [...args];
  const out = [...args];
  out.splice(i, 2);
  return out;
}

const ISOLATION_FLAGS = [
  "--tools",
  "--strict-mcp-config",
  "--setting-sources",
  "--permission-mode",
  "--permission-prompts",
  "--no-session-persistence",
];

/** Fails loudly if an experiment variant lost any isolation guarantee. */
function assertIsolationIntact(args: string[], label: string): void {
  for (const flag of ISOLATION_FLAGS) {
    if (!args.includes(flag)) throw new Error(`${label}: isolation flag ${flag} missing from argv`);
  }
  if (args[args.indexOf("--tools") + 1] !== "") throw new Error(`${label}: --tools is not ""`);
  if (args[args.indexOf("--setting-sources") + 1] !== "") throw new Error(`${label}: --setting-sources is not ""`);
  if (args.includes("--bare")) throw new Error(`${label}: --bare present`);
  if (args.includes("--fallback-model")) throw new Error(`${label}: --fallback-model present`);
  if (args.includes("--dangerously-skip-permissions")) throw new Error(`${label}: permission bypass present`);
}

function redact(t: string): string {
  return t.replace(/sk-ant-[A-Za-z0-9_-]+/g, "[REDACTED]");
}

type Run = Record<string, any>;

async function invoke(opts: {
  id: string;
  rep: number;
  args: string[];
  stdinPayload: string;
  expectStructured: boolean;
}): Promise<Run> {
  const executable = resolveClaudeExecutable();
  const env = buildSanitizedEnv();
  const cwd = await mkdtemp(path.join(tmpdir(), "acc-bench-p3-"));

  const isolation = {
    cwdOutsideRepo: !path.resolve(cwd).startsWith(path.resolve(process.cwd())),
    cwdEmptyBefore: (await readdir(cwd)).length === 0,
    forbiddenEnvPresent: FORBIDDEN_CHILD_ENV_VARS.filter((k) => k in env),
    childHasApiKey: Boolean(env.ANTHROPIC_API_KEY),
    toolsEmpty: opts.args[opts.args.indexOf("--tools") + 1] === "",
    strictMcp: opts.args.includes("--strict-mcp-config"),
    settingSourcesEmpty: opts.args[opts.args.indexOf("--setting-sources") + 1] === "",
    noBare: !opts.args.includes("--bare"),
    shell: false,
  };

  const started = Date.now();
  let firstByte: number | null = null;

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
        if (firstByte === null) firstByte = Date.now();
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

  const wallClockMs = Date.now() - started;
  const cwdAfter = await readdir(cwd);
  await rm(cwd, { recursive: true, force: true });

  const base: Run = {
    id: opts.id,
    rep: opts.rep,
    stdinBytes: Buffer.byteLength(opts.stdinPayload, "utf8"),
    wallClockMs,
    timeToFirstByteMs: firstByte === null ? null : firstByte - started,
    exitCode: out.code,
    timedOut: out.timedOut,
    isolation,
    cwdEmptyAfter: cwdAfter.length === 0,
    argvHasJsonSchema: opts.args.includes("--json-schema"),
  };

  if (out.timedOut) return { ...base, success: false, failureCode: "timeout" };

  // stream-json emits NDJSON; the final `result` object is what carries usage.
  let parsed: Record<string, any> | null = null;
  let initEvent: Record<string, any> | null = null;
  const streamEvents: Record<string, any>[] = [];

  const trimmed = out.stdout.trim();
  if (trimmed.startsWith("{") && !trimmed.includes("\n{")) {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      /* fall through */
    }
  }
  if (!parsed) {
    for (const line of trimmed.split(/\r?\n/)) {
      if (!line.trim().startsWith("{")) continue;
      try {
        const ev = JSON.parse(line) as Record<string, any>;
        streamEvents.push(ev);
        if (ev.type === "system" && ev.subtype === "init") initEvent = ev;
        if (ev.type === "result") parsed = ev;
      } catch {
        /* ignore non-JSON lines */
      }
    }
  }

  if (!parsed) {
    return { ...base, success: false, failureCode: "parse_error", rawHead: redact(out.stdout).slice(0, 400) };
  }
  if (out.code !== 0 || parsed.is_error === true) {
    return {
      ...base,
      success: false,
      failureCode: "cli_error",
      subtype: parsed.subtype,
      resultText: redact(String(parsed.result ?? "")).slice(0, 400),
    };
  }

  const mu = (parsed.modelUsage ?? {}) as Record<string, Record<string, any>>;
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

  const usage = parsed.usage ?? {};
  const A = sum("inputTokens") + sum("outputTokens");
  const B = sum("cacheCreationInputTokens");
  const C = sum("cacheReadInputTokens");

  return {
    ...base,
    success: true,
    topLevel: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
      thinking_tokens: usage.output_tokens_details?.thinking_tokens,
      server_tool_use: usage.server_tool_use,
      service_tier: usage.service_tier,
    },
    modelUsageEntries: entries,
    modelUsageEntryCount: entries.length,
    accounting: { A_adapterTokens: A, B_cacheCreation: B, C_cacheRead: C, D_totalFootprint: A + B + C },
    thinkingTokens: sum("thinkingTokens"),
    webSearchRequests: sum("webSearchRequests"),
    stopReason: parsed.stop_reason,
    numTurns: parsed.num_turns,
    costUSDDiagnostic: parsed.total_cost_usd,
    structuredOutputPresent: parsed.structured_output !== undefined,
    structuredOutputValid:
      opts.expectStructured &&
      typeof parsed.structured_output === "object" &&
      parsed.structured_output !== null &&
      typeof parsed.structured_output.answer === "string" &&
      Object.keys(parsed.structured_output).length === 1,
    resultTextLen: String(parsed.result ?? "").length,
    initEventToolSurface: initEvent
      ? { tools: initEvent.tools, mcp_servers: initEvent.mcp_servers, slash_commands: initEvent.slash_commands?.length }
      : null,
    streamEventTypes: streamEvents.length ? [...new Set(streamEvents.map((e) => `${e.type}/${e.subtype ?? ""}`))] : null,
  };
}

async function main() {
  const results: Run[] = [];

  const workloads: Array<{ id: string; bytes: number }> = [
    { id: "A-minimal", bytes: 0 },
    { id: "B-tiny-1kb", bytes: 1024 },
    { id: "C-medium-9kb", bytes: 9 * 1024 },
    { id: "D-large-95kb", bytes: 95 * 1024 },
  ];

  // --- A-D: size sweep -----------------------------------------------------
  for (const w of workloads) {
    const context = ctxFor(buildContext(w.bytes));
    const args = buildClaudeArgs(MODEL, SHARED_SCHEMA);
    assertIsolationIntact(args, w.id);
    const stdinPayload = buildStdinPayload(context, SHARED_SCHEMA);
    for (let rep = 1; rep <= REPS; rep++) {
      process.stdout.write(`${w.id} rep${rep} ... `);
      const r = await invoke({ id: w.id, rep, args, stdinPayload, expectStructured: true });
      results.push(r);
      console.log(
        r.success
          ? `ok ${r.wallClockMs}ms A=${r.accounting.A_adapterTokens} B=${r.accounting.B_cacheCreation} C=${r.accounting.C_cacheRead} turns=${r.numTurns}`
          : `FAILED ${r.failureCode}`
      );
    }
  }

  // --- E: repeated identical input, back-to-back, fresh subprocess each ----
  {
    const context = ctxFor(buildContext(1024));
    const args = buildClaudeArgs(MODEL, SHARED_SCHEMA);
    const stdinPayload = buildStdinPayload(context, SHARED_SCHEMA);
    for (let rep = 1; rep <= REPS; rep++) {
      process.stdout.write(`E-repeat rep${rep} ... `);
      const r = await invoke({ id: "E-repeat", rep, args, stdinPayload, expectStructured: true });
      results.push(r);
      console.log(r.success ? `ok B=${r.accounting.B_cacheCreation} C=${r.accounting.C_cacheRead}` : `FAILED ${r.failureCode}`);
    }
  }

  // --- F: structured vs plain (schema pair removed; isolation asserted) ----
  {
    const context = ctxFor(buildContext(1024));
    const structuredArgs = buildClaudeArgs(MODEL, SHARED_SCHEMA);
    const plainArgs = stripJsonSchema(structuredArgs);
    assertIsolationIntact(structuredArgs, "F-structured");
    assertIsolationIntact(plainArgs, "F-plain");
    if (plainArgs.includes("--json-schema")) throw new Error("F-plain still has --json-schema");

    const structuredStdin = buildStdinPayload(context, SHARED_SCHEMA);
    // Plain mode gets the same context; the schema instruction is unavailable,
    // so the prompt asks for the same one-sentence answer in prose.
    const plainStdin = buildStdinPayload(context, {});

    for (let rep = 1; rep <= REPS; rep++) {
      process.stdout.write(`F-structured rep${rep} ... `);
      const r = await invoke({ id: "F-structured", rep, args: structuredArgs, stdinPayload: structuredStdin, expectStructured: true });
      results.push(r);
      console.log(r.success ? `ok A=${r.accounting.A_adapterTokens} B=${r.accounting.B_cacheCreation} turns=${r.numTurns} ${r.wallClockMs}ms` : `FAILED ${r.failureCode}`);
    }
    for (let rep = 1; rep <= REPS; rep++) {
      process.stdout.write(`F-plain rep${rep} ... `);
      const r = await invoke({ id: "F-plain", rep, args: plainArgs, stdinPayload: plainStdin, expectStructured: false });
      results.push(r);
      console.log(r.success ? `ok A=${r.accounting.A_adapterTokens} B=${r.accounting.B_cacheCreation} turns=${r.numTurns} ${r.wallClockMs}ms` : `FAILED ${r.failureCode}`);
    }
  }

  // --- G: security probe ---------------------------------------------------
  // Two observable angles, neither an undocumented mechanism:
  //  G1: stream-json + --verbose exposes the session `init` event, which
  //      enumerates the tool surface the session was actually given.
  //  G2: a prompt that can ONLY be answered with live web data. If
  //      server_tool_use counters increment, that is DIRECT proof --tools ""
  //      does not foreclose server-side tools. If they stay zero, it proves
  //      nothing (the model may simply decline) — asymmetric by design.
  {
    const base = buildClaudeArgs(MODEL, SHARED_SCHEMA);
    const g1 = [...base];
    const fmt = g1.indexOf("--output-format");
    g1[fmt + 1] = "stream-json";
    g1.push("--verbose");
    assertIsolationIntact(g1, "G1-init-surface");

    process.stdout.write("G1-init-surface rep1 ... ");
    const r1 = await invoke({
      id: "G1-init-surface",
      rep: 1,
      args: g1,
      stdinPayload: buildStdinPayload(ctxFor(""), SHARED_SCHEMA),
      expectStructured: true,
    });
    results.push(r1);
    console.log(r1.success ? `ok init=${JSON.stringify(r1.initEventToolSurface)}` : `FAILED ${r1.failureCode}`);

    const webCtx: CompiledContext = {
      layers: {
        instructions:
          "Report today's date and the current top headline from any news website, by looking it up. " +
          "Put what you find in the `answer` field.",
        constraints: "If you cannot look anything up, say exactly why in the answer field.",
        taskState: "",
        memory: "",
        artifacts: "",
        toolSchemas: [],
      },
      provenance: { included: [], excluded: [] },
      estimatedInputTokens: 40,
    };
    const g2args = buildClaudeArgs(MODEL, SHARED_SCHEMA);
    assertIsolationIntact(g2args, "G2-web-attempt");
    for (let rep = 1; rep <= REPS; rep++) {
      process.stdout.write(`G2-web-attempt rep${rep} ... `);
      const r = await invoke({
        id: "G2-web-attempt",
        rep,
        args: g2args,
        stdinPayload: buildStdinPayload(webCtx, SHARED_SCHEMA),
        expectStructured: true,
      });
      results.push(r);
      console.log(
        r.success
          ? `ok webSearchRequests=${r.webSearchRequests} server_tool_use=${JSON.stringify(r.topLevel.server_tool_use)}`
          : `FAILED ${r.failureCode}`
      );
    }
  }

  await writeFile(path.resolve("benchmark/raw/phase3-results.json"), redact(JSON.stringify({ results }, null, 2)), "utf8");
  console.log("\nWRITTEN -> benchmark/raw/phase3-results.json");
}

main().catch((e) => {
  console.error("BENCH_ERROR", e);
  process.exit(1);
});
