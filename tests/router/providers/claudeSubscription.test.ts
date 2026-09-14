/**
 * `callClaudeSubscriptionModel` tests.
 *
 * NO TEST HERE EVER SPAWNS THE REAL `claude` BINARY, contacts Anthropic, or
 * consumes a single subscription token. `node:child_process` is replaced
 * wholesale with `vi.mock`, so every test inspects the subprocess
 * CONFIGURATION the adapter constructs — argv, env, cwd, stdin — and feeds it
 * controlled stdout. That is deliberately the stronger check for the security
 * properties: asserting on what WOULD be passed to the child catches an env
 * leak or a dropped isolation flag directly, where an end-to-end run would only
 * catch it by observing the damage.
 *
 * NO DATABASE either: the adapter takes no transaction and touches no schema.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { CompiledContext } from "../../../src/context/types.js";

/** Captures every spawn invocation so tests can assert on the child's configuration. */
const { spawnMock, spawnCalls } = vi.hoisted(() => {
  const spawnCalls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const spawnMock = vi.fn();
  return { spawnMock, spawnCalls };
});

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import {
  callClaudeSubscriptionModel,
  buildSanitizedEnv,
  buildClaudeArgs,
  extractModelUsage,
  resolveClaudeExecutable,
  ClaudeSubscriptionError,
  FORBIDDEN_CHILD_ENV_VARS,
  MAX_STDIN_BYTES,
  parseClaudeStream,
} from "../../../src/router/providers/claudeSubscription.js";

const SUBSCRIPTION_ACCOUNTING = { unit: "subscription_tokens" } as const;
const USD_ACCOUNTING = { unit: "usd", pricing: { inputPerToken: 0.000001, outputPerToken: 0.000005 } } as const;

/**
 * A fake child process. `stdout` emits `stdoutText`, then `close` fires with
 * `exitCode` — unless `hang` is set, in which case nothing settles and the
 * adapter's own timeout must fire.
 */
function installFakeChild(opts: {
  stdoutText?: string;
  /** Raw chunks, to reproduce real Buffer delivery (including mid-character splits). */
  stdoutChunks?: Array<string | Buffer>;
  /** Chunks delivered later, so receipt time can be distinguished from close time. */
  delayedStdoutChunks?: Array<{ afterMs: number; chunk: string | Buffer }>;
  stderrText?: string;
  exitCode?: number;
  hang?: boolean;
  failToStart?: string;
}) {
  const killed: string[] = [];
  const stdinChunks: string[] = [];

  /**
   * A stream faithful enough to catch an encoding bug: it honours
   * `setEncoding` the way Node does, decoding Buffers through a StringDecoder
   * that holds incomplete multi-byte sequences across chunks. A plain
   * EventEmitter would both lack `setEncoding` and hide the very defect the
   * chunk-boundary test exists to catch.
   */
  const makeStream = () => {
    const stream = new EventEmitter() as EventEmitter & {
      setEncoding: (encoding: string) => void;
      push: (chunk: string | Buffer) => void;
    };
    let decoder: StringDecoder | null = null;
    stream.setEncoding = (encoding: string) => {
      decoder = new StringDecoder(encoding as BufferEncoding);
    };
    stream.push = (chunk: string | Buffer) => {
      stream.emit("data", decoder && Buffer.isBuffer(chunk) ? decoder.write(chunk) : chunk);
    };
    return stream;
  };

  spawnMock.mockImplementation((command: string, args: string[], options: Record<string, unknown>) => {
    spawnCalls.push({ command, args, options });

    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdout = makeStream();
    const stderr = makeStream();
    const stdin = Object.assign(new EventEmitter(), {
      end: (payload?: string) => {
        if (payload !== undefined) stdinChunks.push(payload);
      },
    });
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = stdin;
    child.kill = (signal: string) => {
      killed.push(signal);
      // A well-behaved child exits on SIGTERM; `close` still fires, and the
      // adapter must report the timeout rather than the exit code.
      setImmediate(() => child.emit("close", null));
      return true;
    };

    if (opts.failToStart) {
      setImmediate(() => child.emit("error", new Error(opts.failToStart!)));
      return child;
    }
    if (opts.hang) {
      // Lines the child emitted before it stopped responding (e.g. a
      // rate_limit_event before a hang) are delivered; then nothing settles.
      setImmediate(() => {
        for (const chunk of opts.stdoutChunks ?? []) stdout.push(chunk);
      });
      return child;
    }

    setImmediate(() => {
      for (const chunk of opts.stdoutChunks ?? []) stdout.push(chunk);
      if (opts.stdoutText) stdout.push(opts.stdoutText);
      if (opts.stderrText) stderr.push(opts.stderrText);

      const delayed = opts.delayedStdoutChunks ?? [];
      if (delayed.length === 0) {
        child.emit("close", opts.exitCode ?? 0);
        return;
      }
      // Deliver late chunks on a real timer, then close — so a close-time
      // stamp and a receipt-time stamp are measurably different.
      let elapsed = 0;
      for (const { afterMs, chunk } of delayed) {
        elapsed += afterMs;
        setTimeout(() => stdout.push(chunk), elapsed);
      }
      setTimeout(() => child.emit("close", opts.exitCode ?? 0), elapsed + 5);
    });
    return child;
  });

  return { killed, stdinChunks };
}

function buildCompiledContext(overrides: Partial<CompiledContext["layers"]> = {}): CompiledContext {
  return {
    layers: {
      instructions: "INSTRUCTIONS_LAYER",
      constraints: "CONSTRAINTS_LAYER",
      taskState: "TASK_STATE_LAYER",
      memory: "MEMORY_LAYER",
      artifacts: "ARTIFACTS_LAYER",
      toolSchemas: [],
      ...overrides,
    },
    provenance: { included: [], excluded: [] },
    estimatedInputTokens: 100,
  };
}

/** A realistic success payload, shaped on the two verified spike observations. */
function successStdout(
  modelUsage: Record<string, unknown> = {
    "claude-opus-5": { inputTokens: 2, outputTokens: 80 },
    "claude-haiku-4-5-20251001": { inputTokens: 899, outputTokens: 9 },
  },
  structured: unknown = { sentiment: "positive", confidence: 0.95 },
  options: { rateLimit?: unknown[]; init?: boolean } = {}
): string {
  // An NDJSON stream, as `--output-format stream-json --verbose` produces
  // (Phase 7B). The `result` event carries exactly the fields the old single
  // JSON object did; the init and rate_limit_event lines are what stream-json
  // adds. Shapes copied from the Phase 4/5 raw benchmark captures.
  const lines: string[] = [];
  if (options.init !== false) {
    lines.push(JSON.stringify({ type: "system", subtype: "init", tools: ["StructuredOutput"], mcp_servers: [] }));
  }
  for (const event of options.rateLimit ?? []) {
    lines.push(JSON.stringify(event));
  }
  lines.push(
    JSON.stringify({
      type: "result",
      is_error: false,
      subtype: "success",
      terminal_reason: "completed",
      result: JSON.stringify(structured),
      structured_output: structured,
      permission_denials: [],
      usage: { input_tokens: 2, output_tokens: 80 },
      modelUsage,
      total_cost_usd: 0.0411,
    })
  );
  return lines.join("\n") + "\n";
}

/** A one-line NDJSON stream carrying just the terminal `result` event. */
function resultStdout(result: Record<string, unknown>): string {
  return JSON.stringify({ type: "result", ...result }) + "\n";
}

/** A `rate_limit_event` line, shaped exactly as captured in Phase 4/5. */
function rateLimitEvent(
  fiveHour: number | null = 0.45,
  sevenDay: number | null = 0.17,
  overrides: Record<string, unknown> = {}
) {
  return {
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      resetsAt: 1789331400,
      rateLimitType: "five_hour",
      overageStatus: "rejected",
      overageDisabledReason: "org_level_disabled",
      isUsingOverage: false,
      unifiedWindows: {
        five_hour: { utilization: fiveHour, resetsAt: 1789331400 },
        seven_day: { utilization: sevenDay, resetsAt: 1789448400 },
      },
      ...overrides,
    },
    uuid: "4b50a79c-d16a-4aed-8857-c97674f17e61",
    session_id: "366c8ec5-9b5a-4c3e-9eb8-df0ae991862b",
  };
}

/**
 * Point resolution at a file guaranteed to exist on every platform (the running
 * Node binary). The mocked suite is about the adapter's BEHAVIOUR, so it must
 * not depend on a Claude CLI being installed on the machine running it — and
 * `spawn` is mocked anyway, so nothing is ever actually started. Real
 * resolution is covered by its own suite below and by the smoke test.
 */
beforeEach(() => {
  spawnCalls.length = 0;
  vi.stubEnv("CLAUDE_CLI_PATH", process.execPath);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Executable resolution (Step 4A)
// ---------------------------------------------------------------------------

/**
 * `spawn("claude", { shell: false })` fails with ENOENT on Windows, because
 * `claude` there is an npm shim set and `spawn` without a shell does no PATHEXT
 * resolution. These tests pin the resolution that replaced it.
 *
 * Fixtures are REAL directories on disk rather than a mocked fs: resolution's
 * whole job is deciding whether a path is a startable file, and mocking the
 * filesystem would mock away the thing under test.
 */
describe("executable resolution", () => {
  const tempRoots: string[] = [];

  function makeDir(...segments: string[]): string {
    const root = mkdtempSync(path.join(os.tmpdir(), "acc-resolve-"));
    tempRoots.push(root);
    const full = path.join(root, ...segments);
    mkdirSync(full, { recursive: true });
    return root;
  }

  afterEach(() => {
    while (tempRoots.length) rmSync(tempRoots.pop()!, { recursive: true, force: true });
  });

  it("respects an explicit CLAUDE_CLI_PATH", () => {
    expect(resolveClaudeExecutable({ CLAUDE_CLI_PATH: process.execPath })).toBe(process.execPath);
  });

  it("fails closed on a configured path that does not exist", () => {
    const missing = path.join(os.tmpdir(), "definitely-not-here-" + Date.now(), "claude.exe");
    try {
      resolveClaudeExecutable({ CLAUDE_CLI_PATH: missing });
      throw new Error("expected resolution to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ClaudeSubscriptionError);
      expect((e as ClaudeSubscriptionError).code).toBe("cli_unavailable");
      expect((e as Error).message).toMatch(/not an existing file/);
    }
  });

  it("fails closed on a configured path that is a directory, not a file", () => {
    const dir = makeDir("somewhere");
    expect(() => resolveClaudeExecutable({ CLAUDE_CLI_PATH: dir })).toThrow(/not an existing file/);
  });

  it("fails closed when nothing is discoverable on PATH", () => {
    const empty = makeDir("empty");
    try {
      resolveClaudeExecutable({ PATH: path.join(empty, "empty") });
      throw new Error("expected resolution to throw");
    } catch (e) {
      expect((e as ClaudeSubscriptionError).code).toBe("cli_unavailable");
      expect((e as Error).message).toMatch(/CLAUDE_CLI_PATH/);
    }
  });

  it.runIf(process.platform === "win32")(
    "on Windows: does NOT return claude.cmd, and finds the real claude.exe behind the npm shim",
    () => {
      // A faithful reproduction of the npm global layout: shims in the prefix
      // dir, the real binary under its node_modules.
      const root = makeDir("node_modules", "@anthropic-ai", "claude-code", "bin");
      writeFileSync(path.join(root, "claude.cmd"), "@ECHO off\r\n");
      writeFileSync(path.join(root, "claude"), "#!/bin/sh\n");
      const exe = path.join(root, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
      writeFileSync(exe, "MZ");

      const resolved = resolveClaudeExecutable({ PATH: root });

      expect(resolved).toBe(exe);
      expect(resolved.endsWith(".cmd")).toBe(false);
      expect(resolved.endsWith(".exe")).toBe(true);
    }
  );

  it.runIf(process.platform === "win32")("on Windows: refuses a configured .cmd shim with an explanatory error", () => {
    const root = makeDir("shims");
    const cmd = path.join(root, "claude.cmd");
    writeFileSync(cmd, "@ECHO off\r\n");

    try {
      resolveClaudeExecutable({ CLAUDE_CLI_PATH: cmd });
      throw new Error("expected resolution to throw");
    } catch (e) {
      expect((e as ClaudeSubscriptionError).code).toBe("cli_unavailable");
      // Names the actual reason — Node refuses .cmd without a shell, and this
      // adapter will not use one.
      expect((e as Error).message).toMatch(/without a shell/);
    }
  });

  it.runIf(process.platform === "win32")("on Windows: a PATH dir containing only shims is skipped, not returned", () => {
    const shimOnly = makeDir("shimonly");
    writeFileSync(path.join(shimOnly, "claude.cmd"), "@ECHO off\r\n");
    writeFileSync(path.join(shimOnly, "claude.ps1"), "# ps\n");

    // No .exe anywhere -> must fail closed rather than fall back to the shim.
    expect(() => resolveClaudeExecutable({ PATH: shimOnly })).toThrow(/Could not locate/);
  });

  it.runIf(process.platform !== "win32")("on POSIX: finds a directly-spawnable `claude` on PATH", () => {
    const root = makeDir("bin");
    const exe = path.join(root, "claude");
    writeFileSync(exe, "#!/bin/sh\n");
    expect(resolveClaudeExecutable({ PATH: root })).toBe(exe);
  });

  it("passes the RESOLVED executable as argv[0] to spawn, with shell:false", async () => {
    installFakeChild({ stdoutText: successStdout() });

    await callClaudeSubscriptionModel("claude-opus-5", buildCompiledContext(), {}, SUBSCRIPTION_ACCOUNTING);

    // `CLAUDE_CLI_PATH` is stubbed to process.execPath for this suite.
    expect(spawnCalls[0]!.command).toBe(process.execPath);
    expect(spawnCalls[0]!.command).not.toBe("claude");
    expect(spawnCalls[0]!.options.shell).toBe(false);
  });

  it("surfaces an unresolvable CLI as cli_unavailable, before creating a temp directory", async () => {
    vi.stubEnv("CLAUDE_CLI_PATH", path.join(os.tmpdir(), "nope-" + Date.now(), "claude.exe"));
    installFakeChild({ stdoutText: successStdout() });

    await expect(
      callClaudeSubscriptionModel("claude-opus-5", buildCompiledContext(), {}, SUBSCRIPTION_ACCOUNTING)
    ).rejects.toMatchObject({ code: "cli_unavailable" });

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("classifies a spawn-start failure as cli_unavailable, NOT nonzero_exit", async () => {
    installFakeChild({ failToStart: "spawn ENOENT" });

    const error = await callClaudeSubscriptionModel(
      "claude-opus-5",
      buildCompiledContext(),
      {},
      SUBSCRIPTION_ACCOUNTING
    ).catch((e: unknown) => e);

    // The process never ran, so there was no exit code to be non-zero.
    expect((error as ClaudeSubscriptionError).code).toBe("cli_unavailable");
  });

  it("reserves nonzero_exit for a process that actually started and returned non-zero", async () => {
    installFakeChild({
      stdoutText: resultStdout({ is_error: true, subtype: "error", result: "something went wrong" }),
      exitCode: 3,
    });

    const error = await callClaudeSubscriptionModel(
      "claude-opus-5",
      buildCompiledContext(),
      {},
      SUBSCRIPTION_ACCOUNTING
    ).catch((e: unknown) => e);

    expect((error as ClaudeSubscriptionError).code).toBe("nonzero_exit");
  });

  it("never uses shell:true anywhere in the provider (structural)", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../../src/router/providers/claudeSubscription.ts", import.meta.url)),
      "utf8"
    ).replace(/\/\*[\s\S]*?\*\//g, "");

    expect(source).not.toMatch(/shell\s*:\s*true/);
    // And the one spawn call it makes is explicitly shell:false.
    expect(source).toMatch(/shell\s*:\s*false/);
  });
});

// ---------------------------------------------------------------------------
// 9-10. Environment sanitization
// ---------------------------------------------------------------------------

describe("environment sanitization", () => {
  it("strips ANTHROPIC_API_KEY even when the parent process has one set", () => {
    const env = buildSanitizedEnv({
      ANTHROPIC_API_KEY: "sk-ant-should-never-reach-the-child",
      PATH: "/usr/bin",
    });

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(Object.values(env)).not.toContain("sk-ant-should-never-reach-the-child");
    // The child still gets what it needs to run.
    expect(env.PATH).toBe("/usr/bin");
  });

  it("strips EVERY credential and provider-redirecting variable", () => {
    const parent: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    for (const key of FORBIDDEN_CHILD_ENV_VARS) {
      parent[key] = `leaked-${key}`;
    }

    const env = buildSanitizedEnv(parent);

    for (const key of FORBIDDEN_CHILD_ENV_VARS) {
      expect(env[key], `${key} must not reach the child`).toBeUndefined();
    }
    expect(JSON.stringify(env)).not.toContain("leaked-");
  });

  it("is an ALLOW-list: an unknown parent variable is not inherited", () => {
    // A deny-list would silently pass through anything added to the parent
    // environment later — and the failure mode of missing one is a leaked
    // credential, so the default must be "drop".
    const env = buildSanitizedEnv({ PATH: "/usr/bin", SOME_FUTURE_SECRET: "nope" });
    expect(env.SOME_FUTURE_SECRET).toBeUndefined();
  });

  it("passes the sanitized env to the actual spawn call", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-live-key");
    installFakeChild({ stdoutText: successStdout() });

    await callClaudeSubscriptionModel("claude-opus-5", buildCompiledContext(), {}, SUBSCRIPTION_ACCOUNTING);

    const spawnedEnv = spawnCalls[0]!.options.env as NodeJS.ProcessEnv;
    expect(spawnedEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(JSON.stringify(spawnedEnv)).not.toContain("sk-ant-live-key");
  });
});

// ---------------------------------------------------------------------------
// 11-13. Flags, model pinning, cwd
// ---------------------------------------------------------------------------

describe("subprocess configuration", () => {
  it("constructs the exact required isolation flag set", () => {
    const args = buildClaudeArgs("claude-opus-5", { report: "string" });

    expect(args).toEqual([
      "-p",
      "--tools",
      "",
      "--strict-mcp-config",
      "--setting-sources",
      "",
      "--permission-mode",
      "manual",
      "--permission-prompts",
      "none",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--json-schema",
      JSON.stringify({ report: "string" }),
      "--model",
      "claude-opus-5",
    ]);
  });

  it("never passes --bare (which would refuse OAuth) or --fallback-model", () => {
    const args = buildClaudeArgs("claude-opus-5", {});
    expect(args).not.toContain("--bare");
    expect(args).not.toContain("--fallback-model");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("passes the pinned model id through unmodified", async () => {
    installFakeChild({ stdoutText: successStdout() });

    await callClaudeSubscriptionModel(
      "claude-haiku-4-5-20251001",
      buildCompiledContext(),
      {},
      SUBSCRIPTION_ACCOUNTING
    );

    const args = spawnCalls[0]!.args;
    expect(args[args.indexOf("--model") + 1]).toBe("claude-haiku-4-5-20251001");
    // Never silently shortened to the floating alias.
    expect(args).not.toContain("claude-haiku-4-5");
  });

  it("runs in a fresh empty directory outside the repository, and cleans it up afterwards", async () => {
    // Emptiness must be observed WHILE the child is notionally running — the
    // adapter deletes the directory in its `finally`, so inspecting after the
    // call would find nothing either way and prove neither property.
    let contentsDuringRun: string[] | undefined;
    let cwdDuringRun: string | undefined;
    installFakeChild({ stdoutText: successStdout() });
    spawnMock.mockImplementation(((original) => (command: string, args: string[], options: Record<string, unknown>) => {
      cwdDuringRun = options.cwd as string;
      contentsDuringRun = readdirSync(cwdDuringRun).map(String);
      return original(command, args, options);
    })(spawnMock.getMockImplementation()!));

    await callClaudeSubscriptionModel("claude-opus-5", buildCompiledContext(), {}, SUBSCRIPTION_ACCOUNTING);

    const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
    expect(cwdDuringRun).toBeTruthy();
    // Outside the repo, so no CLAUDE.md (this project has one at its root) is
    // discoverable — defence in depth beyond `--setting-sources ""`.
    expect(path.resolve(cwdDuringRun!).startsWith(repoRoot)).toBe(false);
    expect(contentsDuringRun).toEqual([]);
    // And it does not outlive the invocation.
    expect(() => statSync(cwdDuringRun!)).toThrow();
  });

  it("supplies the compiled context on stdin, and no credential", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-live-key");
    const { stdinChunks } = installFakeChild({ stdoutText: successStdout() });

    await callClaudeSubscriptionModel("claude-opus-5", buildCompiledContext(), {}, SUBSCRIPTION_ACCOUNTING);

    const payload = stdinChunks.join("");
    expect(payload).toContain("INSTRUCTIONS_LAYER");
    expect(payload).toContain("TASK_STATE_LAYER");
    expect(payload).not.toContain("sk-ant-live-key");
  });

  it("refuses an over-large context instead of truncating it", async () => {
    installFakeChild({ stdoutText: successStdout() });
    const huge = "x".repeat(MAX_STDIN_BYTES + 1);

    await expect(
      callClaudeSubscriptionModel("claude-opus-5", buildCompiledContext({ artifacts: huge }), {}, SUBSCRIPTION_ACCOUNTING)
    ).rejects.toMatchObject({ code: "input_too_large" });

    expect(spawnMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 14-15. Usage extraction
// ---------------------------------------------------------------------------

describe("usage extraction", () => {
  it("sums ALL modelUsage entries, including the internal secondary model call", async () => {
    installFakeChild({ stdoutText: successStdout() });

    const { usage } = await callClaudeSubscriptionModel(
      "claude-opus-5",
      buildCompiledContext(),
      {},
      SUBSCRIPTION_ACCOUNTING
    );

    // 2 + 80 (primary) + 899 + 9 (secondary) = 990. Counting only the primary
    // would give 82 — an 88% under-report of real entitlement consumption.
    expect(usage.costAmount).toBe(990);
    expect(usage.costAmount).not.toBe(82);
    expect(usage.costUnit).toBe("subscription_tokens");

    // The primary's own tokens are still reported separately...
    expect(usage.tokensIn).toBe(2);
    expect(usage.tokensOut).toBe(80);
    // ...and the secondary is visible on the event, not merely folded into a total.
    expect(usage.secondaryUsage).toEqual([{ modelId: "claude-haiku-4-5-20251001", tokensIn: 899, tokensOut: 9 }]);
  });

  it("never derives cost from total_cost_usd", async () => {
    // total_cost_usd is 0.0411 in the fixture; a token count must come back
    // instead. Anthropic documents that field as a client-side estimate that
    // must not drive financial decisions.
    installFakeChild({ stdoutText: successStdout() });

    const { usage } = await callClaudeSubscriptionModel(
      "claude-opus-5",
      buildCompiledContext(),
      {},
      SUBSCRIPTION_ACCOUNTING
    );

    expect(usage.costAmount).toBe(990);
    expect(usage.costAmount).not.toBeCloseTo(0.0411, 6);
  });

  it("accepts snake_case token fields too (the CLI schema is not a published contract)", () => {
    const { totalTokens } = extractModelUsage({
      modelUsage: { "m-1": { input_tokens: 10, output_tokens: 5 } },
    });
    expect(totalTokens).toBe(15);
  });

  it.each([
    ["no modelUsage at all", {}],
    ["modelUsage that is not an object", { modelUsage: "nope" }],
    ["an empty modelUsage map", { modelUsage: {} }],
    ["a non-object entry", { modelUsage: { "m-1": 5 } }],
    ["a missing output count", { modelUsage: { "m-1": { inputTokens: 10 } } }],
    ["a null token count", { modelUsage: { "m-1": { inputTokens: 10, outputTokens: null } } }],
    ["a string token count", { modelUsage: { "m-1": { inputTokens: "10", outputTokens: 5 } } }],
    ["a NaN token count", { modelUsage: { "m-1": { inputTokens: Number.NaN, outputTokens: 5 } } }],
    ["an Infinite token count", { modelUsage: { "m-1": { inputTokens: Number.POSITIVE_INFINITY, outputTokens: 5 } } }],
  ])("fails closed on %s rather than inventing usage", (_label, parsed) => {
    expect(() => extractModelUsage(parsed as Record<string, unknown>)).toThrow(ClaudeSubscriptionError);
  });
});

// ---------------------------------------------------------------------------
// 16-17. Timeout and failure classification
// ---------------------------------------------------------------------------

describe("timeout and failure semantics", () => {
  it("terminates the child on timeout and throws WITHOUT reporting usage", async () => {
    const { killed } = installFakeChild({ hang: true });

    const error = await callClaudeSubscriptionModel(
      "claude-opus-5",
      buildCompiledContext(),
      {},
      SUBSCRIPTION_ACCOUNTING,
      { timeoutMs: 30 }
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ClaudeSubscriptionError);
    expect((error as ClaudeSubscriptionError).code).toBe("timeout");
    expect(killed).toContain("SIGTERM");

    // Critical: it THROWS rather than returning usage. A terminated child
    // records no result, so the Executor releases the reservation — reconciling
    // zero would under-report consumption that really did occur.
    expect(error).not.toHaveProperty("usage");
  });

  it.each([
    ["auth_expired", "Login expired · Please run /login"],
    ["quota_exhausted", "rate_limit exceeded"],
  ])("classifies %s distinguishably", async (code, resultText) => {
    installFakeChild({
      stdoutText: resultStdout({ is_error: true, subtype: "error", result: resultText }),
      exitCode: 1,
    });

    const error = await callClaudeSubscriptionModel(
      "claude-opus-5",
      buildCompiledContext(),
      {},
      SUBSCRIPTION_ACCOUNTING
    ).catch((e: unknown) => e);

    expect((error as ClaudeSubscriptionError).code).toBe(code);
  });

  it("does not read the MODEL's output as an error message: a non-zero exit whose report mentions quotas is not quota_exhausted", async () => {
    // quota_exhausted is classified as consuming nothing (the reservation is
    // released); a call that ran and produced output must not be misread as one.
    installFakeChild({
      stdoutText: resultStdout({ is_error: false, subtype: "success", result: "The rate_limit and quota policy were compared." }),
      exitCode: 1,
    });

    const error = await callClaudeSubscriptionModel(
      "claude-opus-5",
      buildCompiledContext(),
      {},
      SUBSCRIPTION_ACCOUNTING
    ).catch((e: unknown) => e);

    expect((error as ClaudeSubscriptionError).code).toBe("nonzero_exit");
  });

  it("treats success-with-no-structured_output as a FAILURE, not a partial result", async () => {
    installFakeChild({
      stdoutText: resultStdout({ is_error: false, subtype: "success", result: "some prose", modelUsage: {} }),
    });

    const error = await callClaudeSubscriptionModel(
      "claude-opus-5",
      buildCompiledContext(),
      {},
      SUBSCRIPTION_ACCOUNTING
    ).catch((e: unknown) => e);

    expect((error as ClaudeSubscriptionError).code).toBe("schema_validation");
  });

  it("reports schema-retry exhaustion distinguishably", async () => {
    installFakeChild({
      stdoutText: resultStdout({ is_error: true, subtype: "error_max_structured_output_retries" }),
      exitCode: 1,
    });

    const error = await callClaudeSubscriptionModel(
      "claude-opus-5",
      buildCompiledContext(),
      {},
      SUBSCRIPTION_ACCOUNTING
    ).catch((e: unknown) => e);

    expect((error as ClaudeSubscriptionError).code).toBe("schema_validation");
  });

  it("reports non-JSON stdout as a parse error", async () => {
    installFakeChild({ stdoutText: "not json at all", exitCode: 0 });

    const error = await callClaudeSubscriptionModel(
      "claude-opus-5",
      buildCompiledContext(),
      {},
      SUBSCRIPTION_ACCOUNTING
    ).catch((e: unknown) => e);

    expect((error as ClaudeSubscriptionError).code).toBe("parse_error");
  });

  it("reports a failure to start the CLI rather than hanging", async () => {
    installFakeChild({ failToStart: "spawn claude ENOENT" });

    await expect(
      callClaudeSubscriptionModel("claude-opus-5", buildCompiledContext(), {}, SUBSCRIPTION_ACCOUNTING)
    ).rejects.toThrow(/failed to start/);
  });

  it("refuses a monetary accounting unit (fail-closed misconfiguration guard)", async () => {
    await expect(
      callClaudeSubscriptionModel("claude-opus-5", buildCompiledContext(), {}, USD_ACCOUNTING)
    ).rejects.toMatchObject({ code: "misconfigured" });

    expect(spawnMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 18, 20. No fallback; structural containment
// ---------------------------------------------------------------------------

describe("no automatic fallback to a billable provider", () => {
  it("a quota failure never reaches another provider — this module imports none", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../../src/router/providers/claudeSubscription.ts", import.meta.url)),
      "utf8"
    ).replace(/\/\*[\s\S]*?\*\//g, "");

    // Structural, because the behavioural version can only prove the paths a
    // test happens to exercise. The adapter cannot fall back to a billable
    // provider if it cannot reach one at all.
    //
    // The provider-SDK package names are ASSEMBLED here rather than written as
    // literals: modelRouter.test.ts's "Provider SDK import isolation" suite
    // greps BOTH src/ and tests/ for those exact strings and asserts only the
    // two provider wrappers contain them. Writing them plainly would add this
    // file to that set and fail the very guarantee it protects.
    const anthropicPkg = ["@anthropic-ai", "sdk"].join("/");
    const openaiImport = `from "${"open" + "ai"}"`;
    expect(source).not.toContain(anthropicPkg);
    expect(source).not.toContain(openaiImport);
    expect(source).not.toMatch(/callAnthropicModel|callOpenAiModel/);
  });
});

describe("only provider adapters may spawn the Claude CLI (structural)", () => {
  it("no module outside src/router/providers/ imports child_process or names the claude binary", () => {
    const srcRoot = path.resolve(fileURLToPath(new URL("../../../src", import.meta.url)));
    const providersDir = path.join(srcRoot, "router", "providers");

    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        if (full.startsWith(providersDir)) continue; // the sanctioned location

        const code = readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
        if (/from "node:child_process"|require\("node:child_process"\)|\bspawn\s*\(/.test(code)) {
          offenders.push(path.relative(srcRoot, full));
        }
      }
    };
    walk(srcRoot);

    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase 7B — stream-json parsing
// ---------------------------------------------------------------------------

describe("stream-json parsing", () => {
  it("extracts the terminal result, the init surface and the quota reading from one stream", () => {
    const stdout = successStdout(undefined, { ok: true }, { rateLimit: [rateLimitEvent()] });
    const parsed = parseClaudeStream(stdout, new Date("2026-09-13T19:38:32.000Z"));

    expect((parsed.result as Record<string, unknown>).subtype).toBe("success");
    expect(parsed.initSurface).toEqual({ tools: ["StructuredOutput"], mcpServers: [] });
    expect(parsed.rateLimitReadings).toBe(1);
    expect(parsed.quota).toMatchObject({
      provider: "claude_subscription",
      status: "allowed",
      overageStatus: "rejected",
      source: "rate_limit_event",
      observationCount: 1,
    });
    expect(parsed.quota!.fiveHour).toEqual({
      utilization: 0.45,
      resetsAt: new Date(1789331400 * 1000).toISOString(),
    });
    expect(parsed.quota!.sevenDay!.utilization).toBe(0.17);
    expect(parsed.quota!.observedAt.toISOString()).toBe("2026-09-13T19:38:32.000Z");
  });

  it("keeps the LAST quota reading, never the maximum", () => {
    // The measured Phase 5 sequence: utilization went UP then back DOWN inside
    // one second. Taking a max would report 0.48; the correct answer is 0.47.
    const stdout = successStdout(undefined, { ok: true }, {
      rateLimit: [rateLimitEvent(0.47), rateLimitEvent(0.48), rateLimitEvent(0.47)],
    });
    const parsed = parseClaudeStream(stdout);

    expect(parsed.quota!.fiveHour!.utilization).toBe(0.47);
    expect(parsed.rateLimitReadings).toBe(3);
    // The count says how many readings were collapsed — it is not a quantity
    // of anything consumed.
    expect(parsed.quota!.observationCount).toBe(3);
  });

  it("ignores unknown event types so a future CLI cannot break the adapter", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", tools: [], mcp_servers: [] }),
      JSON.stringify({ type: "assistant", message: { content: "thinking out loud" } }),
      JSON.stringify({ type: "some_future_event", whatever: true }),
      JSON.stringify({
        type: "result",
        is_error: false,
        subtype: "success",
        structured_output: { a: 1 },
        modelUsage: {},
      }),
    ].join("\n");

    const parsed = parseClaudeStream(stdout);
    expect(parsed.result).not.toBeNull();
    expect(parsed.unparsableLines).toBe(0);
  });

  it("ignores non-JSON lines but still counts them", () => {
    const stdout = [
      "warning: something on stdout",
      JSON.stringify({ type: "result", subtype: "success" }),
      "",
    ].join("\n");
    const parsed = parseClaudeStream(stdout);

    expect(parsed.result).not.toBeNull();
    expect(parsed.unparsableLines).toBe(1);
  });

  it("records an absent or malformed quota reading as absent, never as a fabricated value", () => {
    expect(parseClaudeStream(successStdout()).quota).toBeNull();

    // A reading with no status is unusable — but must not fail the invocation,
    // because quota telemetry is advisory while usage is load-bearing.
    const noStatus = successStdout(undefined, { ok: true }, {
      rateLimit: [{ type: "rate_limit_event", rate_limit_info: { unifiedWindows: {} } }],
    });
    const parsed = parseClaudeStream(noStatus);
    expect(parsed.quota).toBeNull();
    expect(parsed.rateLimitReadings).toBe(1);
    expect(parsed.result).not.toBeNull();
  });

  it("records a window reported without a utilization as absent rather than zero", () => {
    const stdout = successStdout(undefined, { ok: true }, { rateLimit: [rateLimitEvent(null, 0.17)] });
    const parsed = parseClaudeStream(stdout);

    expect(parsed.quota!.fiveHour!.utilization).toBeNull();
    expect(parsed.quota!.sevenDay!.utilization).toBe(0.17);
  });
});

describe("stream-json end to end through the adapter", () => {
  it("returns the structured result and subscription usage unchanged by the format switch", async () => {
    installFakeChild({
      stdoutText: successStdout(undefined, { sentiment: "positive" }, { rateLimit: [rateLimitEvent()] }),
    });

    const result = await callClaudeSubscriptionModel(
      "claude-opus-5",
      buildCompiledContext(),
      {},
      SUBSCRIPTION_ACCOUNTING
    );

    expect(result.result).toEqual({ sentiment: "positive" });
    // 2 + 80 + 899 + 9 — every reported model, exactly as before Phase 7B.
    expect(result.usage.costAmount).toBe(990);
    expect(result.usage.costUnit).toBe("subscription_tokens");
    expect(result.usage.secondaryUsage).toEqual([
      { modelId: "claude-haiku-4-5-20251001", tokensIn: 899, tokensOut: 9 },
    ]);
  });

  it("surfaces the quota observation without acting on it or folding it into usage", async () => {
    installFakeChild({
      stdoutText: successStdout(undefined, { ok: true }, { rateLimit: [rateLimitEvent(0.45)] }),
    });

    const result = await callClaudeSubscriptionModel(
      "claude-opus-5",
      buildCompiledContext(),
      {},
      SUBSCRIPTION_ACCOUNTING
    );

    expect(result.quotaObservation).toMatchObject({ provider: "claude_subscription", status: "allowed" });
    // The gauge must not have leaked into the accounted amount.
    expect(result.usage.costAmount).toBe(990);
    expect(result.usage.costUnit).toBe("subscription_tokens");
  });

  it("omits the quota observation entirely when the stream carried none", async () => {
    installFakeChild({ stdoutText: successStdout() });

    const result = await callClaudeSubscriptionModel(
      "claude-opus-5",
      buildCompiledContext(),
      {},
      SUBSCRIPTION_ACCOUNTING
    );

    expect(result.quotaObservation).toBeUndefined();
    expect(result.usage.costAmount).toBe(990);
  });

  it("fails closed when the stream ends without a result event", async () => {
    installFakeChild({
      stdoutText: JSON.stringify({ type: "system", subtype: "init", tools: [], mcp_servers: [] }) + "\n",
      exitCode: 0,
    });

    const error = await callClaudeSubscriptionModel(
      "claude-opus-5",
      buildCompiledContext(),
      {},
      SUBSCRIPTION_ACCOUNTING
    ).catch((e: unknown) => e);

    expect((error as ClaudeSubscriptionError).code).toBe("no_result");
  });

  it("keeps the specific failure code when the CLI dies before emitting a result", async () => {
    installFakeChild({ stdoutText: "", stderrText: "Invalid API key - Please run /login", exitCode: 1 });

    const error = await callClaudeSubscriptionModel(
      "claude-opus-5",
      buildCompiledContext(),
      {},
      SUBSCRIPTION_ACCOUNTING
    ).catch((e: unknown) => e);

    // Not collapsed to a generic nonzero_exit: an expired login is
    // operator-actionable and must stay distinguishable.
    expect((error as ClaudeSubscriptionError).code).toBe("auth_expired");
  });

  it("still reports non-NDJSON stdout as a parse error", async () => {
    installFakeChild({ stdoutText: "not json at all\nstill not json", exitCode: 0 });

    const error = await callClaudeSubscriptionModel(
      "claude-opus-5",
      buildCompiledContext(),
      {},
      SUBSCRIPTION_ACCOUNTING
    ).catch((e: unknown) => e);

    expect((error as ClaudeSubscriptionError).code).toBe("parse_error");
  });

  it("stamps the quota observation at RECEIPT time, not subprocess-close time", async () => {
    // The CLI supplies no timestamp on rate_limit_event. Stamping at close
    // would date a reading emitted early in a long invocation as if it had just
    // arrived — making stale telemetry look fresh, the unsafe direction for a
    // freshness signal. Here the reading arrives ~60ms before the stream ends.
    const gapMs = 60;
    installFakeChild({
      stdoutChunks: [JSON.stringify(rateLimitEvent(0.45)) + "\n"],
      delayedStdoutChunks: [{ afterMs: gapMs, chunk: successStdout(undefined, { ok: true }, { init: false }) }],
    });

    const result = await callClaudeSubscriptionModel(
      "claude-opus-5",
      buildCompiledContext(),
      {},
      SUBSCRIPTION_ACCOUNTING
    );

    const observedAt = result.quotaObservation!.observedAt.getTime();
    // Close-time stamping would put this within a millisecond or two of now.
    expect(Date.now() - observedAt).toBeGreaterThanOrEqual(gapMs - 15);
  });

  it("reassembles a multi-byte character split across two stdout chunks", async () => {
    // Real stdout arrives as Buffers at arbitrary boundaries, and stream-json
    // guarantees multiple chunks. Decoding each Buffer independently turns a
    // character straddling the boundary into replacement characters — which
    // still parses as JSON, so the corruption reaches the caller silently.
    const structured = { note: "café ☕ résumé" };
    const full = Buffer.from(successStdout(undefined, structured, { rateLimit: [rateLimitEvent()] }), "utf8");

    // Split INSIDE the 3-byte ☕, so neither half is valid UTF-8 alone.
    // `lastIndexOf`, not `indexOf`: the payload carries the text twice (once in
    // `result` as an encoded string, once in `structured_output`), and the
    // adapter returns the SECOND. Splitting the first copy would corrupt a field
    // nobody reads and the test would pass with the bug present.
    const splitAt = full.lastIndexOf(Buffer.from("☕", "utf8")) + 1;
    expect(splitAt).toBeGreaterThan(0);

    installFakeChild({ stdoutChunks: [full.subarray(0, splitAt), full.subarray(splitAt)] });

    const result = await callClaudeSubscriptionModel(
      "claude-opus-5",
      buildCompiledContext(),
      {},
      SUBSCRIPTION_ACCOUNTING
    );

    expect(result.result).toEqual(structured);
    expect(JSON.stringify(result.result)).not.toContain("�");
  });

  it("asserts stream-json changed nothing about isolation", async () => {
    installFakeChild({
      stdoutText: successStdout(undefined, { ok: true }, { rateLimit: [rateLimitEvent()] }),
    });

    await callClaudeSubscriptionModel("claude-opus-5", buildCompiledContext(), {}, SUBSCRIPTION_ACCOUNTING);

    const { args, options } = spawnCalls[0]!;
    expect(options.shell).toBe(false);
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--verbose");
    // Every isolation flag survives the format switch.
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).toContain("--no-session-persistence");
    expect(args).not.toContain("--bare");
    expect(args).not.toContain("--fallback-model");
    expect((options.env as Record<string, string>).ANTHROPIC_API_KEY).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 8 — quota telemetry survives a failure
// ---------------------------------------------------------------------------

describe("failures carry the quota telemetry they received", () => {
  it("attaches the reading to a failure thrown after the stream was parsed (quota_exhausted)", async () => {
    const stdout =
      JSON.stringify(rateLimitEvent(0.97)) +
      "\n" +
      resultStdout({ is_error: true, subtype: "error", result: "usage limit reached" });
    installFakeChild({ stdoutText: stdout, exitCode: 1 });

    const error = await callClaudeSubscriptionModel(
      "claude-opus-5",
      buildCompiledContext(),
      {},
      SUBSCRIPTION_ACCOUNTING
    ).catch((e: unknown) => e);

    expect((error as ClaudeSubscriptionError).code).toBe("quota_exhausted");
    expect((error as ClaudeSubscriptionError).quotaObservation?.fiveHour?.utilization).toBe(0.97);
  });

  it("attaches a reading received before a timeout to the timeout error", async () => {
    installFakeChild({ hang: true, stdoutChunks: [JSON.stringify(rateLimitEvent(0.61)) + "\n"] });

    const error = await callClaudeSubscriptionModel(
      "claude-opus-5",
      buildCompiledContext(),
      {},
      SUBSCRIPTION_ACCOUNTING,
      { timeoutMs: 50 }
    ).catch((e: unknown) => e);

    expect((error as ClaudeSubscriptionError).code).toBe("timeout");
    expect((error as ClaudeSubscriptionError).quotaObservation?.fiveHour?.utilization).toBe(0.61);
  });

  it("attaches nothing when the failing stream carried no quota telemetry", async () => {
    installFakeChild({ stdoutText: resultStdout({ is_error: true, subtype: "error", result: "boom" }), exitCode: 1 });

    const error = await callClaudeSubscriptionModel(
      "claude-opus-5",
      buildCompiledContext(),
      {},
      SUBSCRIPTION_ACCOUNTING
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ClaudeSubscriptionError);
    expect((error as ClaudeSubscriptionError).quotaObservation).toBeUndefined();
  });
});
