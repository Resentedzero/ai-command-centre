/**
 * `callClaudeSubscriptionModel` — the subscription-backed Claude provider
 * adapter (amended Phase 10.6, 2026-09-13; design in
 * `docs/architecture/SUBSCRIPTION_PROVIDER_DESIGN.md`).
 *
 * THIS IS NOT "CLAUDE CODE AS THE RUNTIME." It is a purpose-built provider
 * adapter that happens to use the supported headless `claude -p` path as its
 * transport, with its own authentication, isolation, accounting and lifecycle.
 * The interactive Claude Code session a human uses to build this system is a
 * separate concern and is never a runtime component (10.6.1): this adapter
 * inherits none of that session's settings, tools, MCP servers, or memory, and
 * the runtime works with no interactive session present.
 *
 * Per 10.6.2 this file — alongside `./anthropic.ts` and `./openai.ts` — is one
 * of the only places permitted to reach a model provider, and the ONLY place
 * permitted to spawn a process to do it. No module outside
 * `src/router/providers/` may import `node:child_process` for this purpose;
 * `tests/router/providers/claudeSubscription.test.ts` asserts that
 * structurally.
 *
 * Deliberately NOT the Agent SDK: the spike verified the CLI, and the SDK's own
 * documentation states `settingSources: []` does not guarantee multi-tenant
 * isolation. Choosing the CLI keeps isolation resting on documented flags we
 * have actually exercised rather than on library options we have not.
 *
 * `--bare` is never used — it is documented to refuse OAuth entirely and
 * require an API key, which would defeat the entire purpose of this adapter.
 *
 * ACCOUNTING (10.6.9): reports `subscription_tokens`, never `usd`, never $0,
 * and never Anthropic's `total_cost_usd` (documented as a client-side estimate
 * that must not drive financial decisions). The amount is the SUM of every
 * model entry the CLI reports — including the internal secondary model call
 * observed on every spike invocation — because counting only the primary would
 * under-report real entitlement consumption.
 *
 * NO AUTOMATIC FALLBACK (10.6.7): this adapter never calls another provider.
 * A quota/auth/timeout failure throws; converting that into a billable API call
 * requires a fresh Policy + Budget decision made above this layer.
 */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CompiledContext } from "../../context/types.js";
// Type-only, and deliberately so: this adapter borrows the observation SHAPE
// the Phase 7A projection accepts, but imports no code from governance and
// writes no state. It has no database handle and takes no quota decision.
import type { QuotaObservation, QuotaWindow } from "../../governance/subscriptionQuotaState.js";
import type { ProviderCallResult, TierAccounting } from "../types.js";
import { buildSystemPrompt, buildUserMessage } from "./promptBuilder.js";

/** Distinguishable failure classes (Step-3 requirement 17). */
export type SubscriptionFailureCode =
  | "misconfigured"
  | "input_too_large"
  | "timeout"
  | "auth_expired"
  | "quota_exhausted"
  /** The CLI could not be located or started at all — an operator/config problem, not a runtime one. */
  | "cli_unavailable"
  /** The CLI genuinely RAN and returned a non-zero exit code. */
  | "nonzero_exit"
  | "parse_error"
  /** The stream parsed, but ended without the terminal `result` event (Phase 7B). */
  | "no_result"
  | "schema_validation"
  | "usage_missing";

export class ClaudeSubscriptionError extends Error {
  /**
   * Quota telemetry received before this failure, when the stream carried any
   * (Phase 8). Attached by `callClaudeSubscriptionModel` on the way out, never
   * invented. Read provider-agnostically via `quotaObservationFrom` in
   * `../types.ts`.
   */
  quotaObservation?: QuotaObservation;

  constructor(
    readonly code: SubscriptionFailureCode,
    message: string
  ) {
    super(message);
    this.name = "ClaudeSubscriptionError";
  }

  /**
   * Whether this failure provably consumed nothing (Phase 9 — read by the
   * Router via `providerConsumptionFrom`). `none` only for failures that
   * happen before the CLI sends a request, or where the service refused it
   * outright; every other code — notably `timeout`, a killed child — is
   * `unknown`, so its reservation is charged rather than released. A code added
   * later defaults to `unknown` until shown otherwise.
   */
  get consumption(): "none" | "unknown" {
    return NO_CONSUMPTION_CODES.has(this.code) ? "none" : "unknown";
  }
}

const NO_CONSUMPTION_CODES: ReadonlySet<SubscriptionFailureCode> = new Set<SubscriptionFailureCode>([
  "cli_unavailable",
  "misconfigured",
  "input_too_large",
  "auth_expired",
  "quota_exhausted",
]);

/**
 * Conservative stdin ceiling. The CLI documents a 10 MB cap; this adapter
 * refuses well before it rather than discovering the limit mid-write, and the
 * Context Compiler's own token budget should keep payloads far below either.
 */
export const MAX_STDIN_BYTES = 4 * 1024 * 1024;

/**
 * The single configuration knob for locating the CLI. It selects the
 * EXECUTABLE PATH ONLY — it can never contribute argv, so configuration cannot
 * inject flags into an invocation.
 */
export const CLAUDE_CLI_PATH_ENV = "CLAUDE_CLI_PATH";

/**
 * Where the npm global install puts the real binary, relative to the directory
 * holding the `claude` shims. Taken from the shim's own documented layout, NOT
 * by parsing the shim script — parsing an arbitrary batch file to decide what
 * to execute would be exactly the kind of command-string handling this adapter
 * exists to avoid.
 */
const NPM_PACKAGE_BIN_SUBPATH = path.join("node_modules", "@anthropic-ai", "claude-code", "bin");

/** On Windows, `spawn` with `shell:false` can only start a real PE executable. */
const WINDOWS_EXECUTABLE = "claude.exe";
const POSIX_EXECUTABLE = "claude";

function isFile(candidate: string): boolean {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolves the Claude CLI to a path that `spawn(..., { shell: false })` can
 * actually start.
 *
 * WHY THIS EXISTS: passing the bare name `"claude"` fails with ENOENT on
 * Windows. `claude` there is an npm *shim set* (`claude`, `claude.cmd`,
 * `claude.ps1`), and `spawn` without a shell performs no PATHEXT resolution —
 * that is shell behaviour. It looks for a PE executable literally named
 * `claude`, finds a shell script, and fails.
 *
 * The obvious workarounds are both rejected:
 *   - `shell: true` would work, but concatenates argv into a command string.
 *     `--json-schema` carries JSON full of quotes and braces, so that is a
 *     quoting/injection surface. Never do this.
 *   - Spawning `claude.cmd` directly throws EINVAL: Node deliberately refuses
 *     to start `.bat`/`.cmd` without a shell (the CVE-2024-27980 mitigation).
 *
 * So resolution must find the real executable. Order:
 *   1. `CLAUDE_CLI_PATH`, if set — validated, and failing closed if unusable.
 *   2. Discovery across PATH, checking for an actually-executable target.
 *
 * Never returns a `.cmd`/`.bat`, and never returns a path that does not exist.
 */
export function resolveClaudeExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[CLAUDE_CLI_PATH_ENV]?.trim();
  if (configured) {
    if (process.platform === "win32" && /\.(cmd|bat)$/i.test(configured)) {
      throw new ClaudeSubscriptionError(
        "cli_unavailable",
        `${CLAUDE_CLI_PATH_ENV} points at "${configured}", a .cmd/.bat shim. Node refuses to spawn those` +
          " without a shell, and this adapter will not use a shell. Point it at claude.exe instead."
      );
    }
    if (!isFile(configured)) {
      throw new ClaudeSubscriptionError(
        "cli_unavailable",
        `${CLAUDE_CLI_PATH_ENV} points at "${configured}", which is not an existing file.`
      );
    }
    return configured;
  }

  const executableName = process.platform === "win32" ? WINDOWS_EXECUTABLE : POSIX_EXECUTABLE;
  const pathValue = env.PATH ?? env.Path ?? "";
  const searchDirs = pathValue.split(path.delimiter).filter(Boolean);

  for (const dir of searchDirs) {
    // The npm global layout: the shims live in the prefix directory, and the
    // real binary sits under that directory's node_modules. Checked FIRST on
    // Windows because the shim directory itself contains no .exe.
    const viaNpmPackage = path.join(dir, NPM_PACKAGE_BIN_SUBPATH, executableName);
    if (isFile(viaNpmPackage)) return viaNpmPackage;

    // A native installer (or a POSIX install) puts a directly-spawnable
    // executable on PATH itself.
    const direct = path.join(dir, executableName);
    if (isFile(direct)) return direct;
  }

  throw new ClaudeSubscriptionError(
    "cli_unavailable",
    `Could not locate a spawnable Claude CLI executable ("${executableName}") on PATH.` +
      ` Set ${CLAUDE_CLI_PATH_ENV} to its absolute path.` +
      (process.platform === "win32"
        ? " On Windows the `claude` entry on PATH is an npm shim, not an executable, so it cannot be used directly."
        : "")
  );
}

export const DEFAULT_TIMEOUT_MS = 180_000;
/** Grace period between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 5_000;

/**
 * Environment variables that must NEVER reach the child.
 *
 * `ANTHROPIC_API_KEY` is the critical one: in `-p` an API key present in the
 * environment ALWAYS wins over OAuth, so a stray key would silently divert a
 * quota-intended invocation onto billed API usage — with no prompt, and no
 * event distinguishing it. That is exactly the silent fallback 10.6.7 forbids.
 *
 * The rest can each redirect the call to a different credential, provider, or
 * model than the one the Model Router chose and recorded on the Event.
 */
export const FORBIDDEN_CHILD_ENV_VARS: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_API_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "OPENAI_API_KEY",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_SERVICE_ACCOUNT_ID",
  "ANTHROPIC_IDENTITY_TOKEN",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_WORKSPACE_ID",
];

/**
 * Variables the child genuinely needs. An ALLOW-list, not a deny-list applied
 * to `process.env`: a deny-list silently passes through anything added to the
 * parent environment later, and the failure mode of missing one is a leaked
 * credential. `USERPROFILE`/`HOME` are required for the CLI to locate its own
 * OAuth credential store — that is the authentication mechanism, not a secret
 * this adapter handles.
 */
const INHERITED_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "Path",
  "SystemRoot",
  "windir",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "LANG",
  "LC_ALL",
];

export function buildSanitizedEnv(parentEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENV_ALLOWLIST) {
    const value = parentEnv[key];
    if (value !== undefined) {
      childEnv[key] = value;
    }
  }
  // Belt and braces: the allow-list already excludes every forbidden name, but
  // delete explicitly so a future edit that widens the allow-list cannot
  // silently reintroduce a credential.
  for (const key of FORBIDDEN_CHILD_ENV_VARS) {
    delete childEnv[key];
  }
  return childEnv;
}

/**
 * The exact, verified isolation flag set. Every entry is load-bearing:
 *   --tools ""              complete tool disable (no Bash/file/web access)
 *   --strict-mcp-config     with no --mcp-config: the allowed MCP set is empty.
 *                           Mandatory, because a subscription credential is
 *                           precisely what pulls claude.ai connectors (Gmail,
 *                           Calendar) into scope — tools the Capability/Policy
 *                           chain never authorized and the Event log would
 *                           never record.
 *   --setting-sources ""    loads no user/project/local settings, so the
 *                           developer's configuration is never inherited.
 *   --permission-mode manual / --permission-prompts none
 *                           anything that would prompt is denied automatically.
 *   --output-format stream-json --verbose
 *                           NDJSON event stream (Phase 7B). A strict SUPERSET
 *                           of the old `json` mode: the terminal `result` event
 *                           carries the identical `structured_output`,
 *                           `modelUsage` and `usage` payloads, and the stream
 *                           ADDITIONALLY exposes `rate_limit_event` (quota
 *                           telemetry) and the `system/init` tool surface.
 *                           `--verbose` is required for stream-json to emit the
 *                           per-event stream rather than a single object.
 *                           Both flags are orthogonal to isolation: across 68
 *                           benchmark invocations the init surface was
 *                           byte-identical to json mode
 *                           (`tools: ["StructuredOutput"]`, `mcp_servers: []`)
 *                           with `--verbose` present.
 *   --no-session-persistence  no on-disk session; the Run/Invocation lifecycle
 *                           is this system's only state model.
 *   --json-schema           bounded, schema-validated structured output.
 *   --model <pinned id>     pinned snapshot, never an alias; no
 *                           --fallback-model, so the model recorded on the
 *                           Event is the model that served the request.
 */
export function buildClaudeArgs(modelId: string, expectedOutputShape: Record<string, unknown>): string[] {
  return [
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
    JSON.stringify(expectedOutputShape),
    "--model",
    modelId,
  ];
}

/** The prompt handed to the child on stdin — compiled context only, no credentials. */
export function buildStdinPayload(compiledContext: CompiledContext): string {
  return `${buildSystemPrompt(compiledContext)}\n\n${buildUserMessage(compiledContext)}`;
}

/**
 * One NDJSON line, stamped with the moment the runtime actually RECEIVED it.
 *
 * The per-line timestamp exists because `rate_limit_event` carries no
 * provider-supplied time. Stamping quota readings at subprocess close would
 * date a reading emitted early in a multi-minute invocation as if it had just
 * arrived — making stale telemetry look fresh, which is the unsafe direction
 * for a freshness signal. This is still a LOCAL RECEIPT time, never a provider
 * emission time; the residual error is now bounded by pipe latency rather than
 * by invocation duration.
 */
export type ClaudeStreamLine = { text: string; receivedAt: Date };

type SpawnOutcome = {
  stdout: string;
  lines: ClaudeStreamLine[];
  stderr: string;
  code: number | null;
  timedOut: boolean;
};

async function runClaudeCli(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  stdinPayload: string,
  timeoutMs: number
): Promise<SpawnOutcome> {
  return await new Promise<SpawnOutcome>((resolve, reject) => {
    // `shell: false` is mandatory and must never be relaxed: argv stays a real
    // array, so the JSON in `--json-schema` can never be reinterpreted as shell
    // syntax. `executable` is a resolved, validated path — see
    // `resolveClaudeExecutable`.
    const child = spawn(executable, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    // Lines are split and stamped AS THEY ARRIVE, not at close — see
    // `ClaudeStreamLine`. `pending` holds the partial trailing line between
    // chunks, since a chunk boundary lands anywhere.
    const lines: ClaudeStreamLine[] = [];
    let pending = "";

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // If SIGTERM is ignored, escalate. Unref'd so a pending escalation timer
      // can never hold the event loop open past the invocation.
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    }, timeoutMs);

    const finish = (outcome: SpawnOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve(outcome);
    };

    // Decode as a STREAM, not chunk by chunk. Without this, chunks arrive as
    // Buffers and `String(buf)` decodes each in isolation, so a multi-byte
    // character split across a chunk boundary becomes two U+FFFD replacement
    // characters. Every structural JSON character is single-byte ASCII, so the
    // line still parses — the corruption lands silently INSIDE a string value
    // and flows on into `structured_output`, the Event payload and any
    // Artifact, with the CLI's own schema validation already behind it.
    // `setEncoding` routes through StringDecoder, which holds an incomplete
    // sequence until the rest of it arrives.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;

      pending += text;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.trim() !== "") lines.push({ text: line, receivedAt: new Date() });
        newline = pending.indexOf("\n");
      }
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      // The process never started, so there IS no exit code — classifying this
      // as `nonzero_exit` would conflate "the CLI is missing or unusable" (an
      // operator/config problem) with "the CLI ran and failed" (a runtime one).
      reject(
        new ClaudeSubscriptionError(
          "cli_unavailable",
          `callClaudeSubscriptionModel: failed to start the Claude CLI at "${executable}" (${error.message}).`
        )
      );
    });

    child.on("close", (code) => {
      // A final line with no trailing newline is still a line.
      if (pending.trim() !== "") {
        lines.push({ text: pending, receivedAt: new Date() });
        pending = "";
      }
      finish({ stdout, lines, stderr, code, timedOut });
    });

    child.stdin?.on("error", () => {
      /* A child that exits before reading stdin produces EPIPE; `close` reports the real outcome. */
    });
    child.stdin?.end(stdinPayload);
  });
}

/** Fails closed unless the CLI reported this token count as a finite number. */
function assertReportedTokenCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ClaudeSubscriptionError(
      "usage_missing",
      `callClaudeSubscriptionModel: the CLI response did not report a finite numeric ${field}` +
        ` (received ${typeof value === "number" ? String(value) : typeof value}).` +
        " Refusing to reconcile budget or record usage from an unusable response."
    );
  }
  return value;
}

type ModelUsageEntry = { modelId: string; tokensIn: number; tokensOut: number };

/**
 * Extracts EVERY model's usage from the CLI's `modelUsage` map.
 *
 * The spike observed a second, unrequested `claude-haiku-4-5` entry on every
 * invocation, attributable to an internal classifier no documented flag
 * disables. Counting only the primary would under-report actual entitlement
 * consumption — a governance gap of exactly the kind the resource-unit work
 * exists to close — so all entries are summed and the non-primary ones are
 * additionally recorded on the Event.
 *
 * Defensive by design: the CLI's JSON is NOT a published contract, so a
 * missing/renamed/malformed field fails closed rather than silently producing
 * a smaller number.
 */
/**
 * Whether any model entry reports cache-read tokens (`modelUsage[*].cacheReadInputTokens`,
 * diagnostic only, SUBSCRIPTION_PROVIDER_DESIGN §usage). Absent or malformed reads as
 * no hit: it never affects the counted amount, so it need not fail closed.
 */
function reportsCacheRead(parsed: Record<string, unknown>): boolean {
  const modelUsage = parsed.modelUsage as Record<string, Record<string, unknown>>;
  return Object.values(modelUsage).some((entry) => {
    const read = entry.cacheReadInputTokens ?? entry.cache_read_input_tokens;
    return typeof read === "number" && read > 0;
  });
}

export function extractModelUsage(parsed: Record<string, unknown>): {
  entries: ModelUsageEntry[];
  totalTokens: number;
} {
  const modelUsage = parsed.modelUsage;
  if (typeof modelUsage !== "object" || modelUsage === null || Array.isArray(modelUsage)) {
    throw new ClaudeSubscriptionError(
      "usage_missing",
      "callClaudeSubscriptionModel: the CLI response carried no `modelUsage` object." +
        " Refusing to record usage without it — a per-model breakdown is the only" +
        " source that includes the internal secondary model call."
    );
  }

  const entries: ModelUsageEntry[] = [];
  for (const [modelId, raw] of Object.entries(modelUsage as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) {
      throw new ClaudeSubscriptionError(
        "usage_missing",
        `callClaudeSubscriptionModel: modelUsage["${modelId}"] is not an object.`
      );
    }
    const entry = raw as Record<string, unknown>;
    entries.push({
      modelId,
      tokensIn: assertReportedTokenCount(entry.inputTokens ?? entry.input_tokens, `modelUsage["${modelId}"].inputTokens`),
      tokensOut: assertReportedTokenCount(
        entry.outputTokens ?? entry.output_tokens,
        `modelUsage["${modelId}"].outputTokens`
      ),
    });
  }

  if (entries.length === 0) {
    throw new ClaudeSubscriptionError(
      "usage_missing",
      "callClaudeSubscriptionModel: the CLI response reported an empty `modelUsage` map."
    );
  }

  const totalTokens = entries.reduce((sum, e) => sum + e.tokensIn + e.tokensOut, 0);
  return { entries, totalTokens };
}

// ---------------------------------------------------------------------------
// stream-json parsing (Phase 7B)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One quota window, converted from the provider's wire shape.
 *
 * `resetsAt` is reported as UNIX SECONDS (verified across every Phase 4/5
 * sample, e.g. `1789331400`). A string is passed through untouched so an ISO
 * value from a future CLI is not mangled; anything else is recorded as absent
 * rather than guessed at.
 */
function toQuotaWindow(raw: unknown): QuotaWindow | null {
  if (!isRecord(raw)) return null;

  const utilization = raw.utilization;
  const resetsAt = raw.resetsAt;

  return {
    utilization: typeof utilization === "number" && Number.isFinite(utilization) ? utilization : null,
    resetsAt:
      typeof resetsAt === "number" && Number.isFinite(resetsAt)
        ? new Date(resetsAt * 1000).toISOString()
        : typeof resetsAt === "string"
          ? resetsAt
          : null,
  };
}

/**
 * Converts a `rate_limit_event` into the observation shape the Phase 7A
 * projection accepts.
 *
 * Returns null — rather than throwing — for a malformed reading. Quota
 * telemetry is ADVISORY (design Part 7: the hard control is the
 * `subscription_tokens` reservation), so a broken gauge must never fail an
 * otherwise-successful model call. Usage extraction, which IS load-bearing for
 * accounting, keeps failing closed; the asymmetry is deliberate.
 */
function toQuotaObservation(
  event: Record<string, unknown>,
  observedAt: Date,
  observationCount: number
): QuotaObservation | null {
  const info = event.rate_limit_info;
  if (!isRecord(info) || typeof info.status !== "string") return null;

  const windows = isRecord(info.unifiedWindows) ? info.unifiedWindows : {};

  return {
    provider: SUBSCRIPTION_PROVIDER_NAME,
    observedAt,
    status: info.status,
    overageStatus: typeof info.overageStatus === "string" ? info.overageStatus : null,
    source: "rate_limit_event",
    fiveHour: toQuotaWindow(windows.five_hour),
    sevenDay: toQuotaWindow(windows.seven_day),
    observationCount,
  };
}

/** The provider identifier quota observations are recorded under. */
export const SUBSCRIPTION_PROVIDER_NAME = "claude_subscription";

export type ClaudeStreamParse = {
  /** The terminal `result` event, or null if the stream never produced one. */
  result: Record<string, unknown> | null;
  /** The `system/init` tool surface, for isolation assertions. */
  initSurface: { tools: unknown; mcpServers: unknown } | null;
  /** The LAST quota reading seen, or null if none was usable. */
  quota: QuotaObservation | null;
  /** How many `rate_limit_event` lines the stream carried. */
  rateLimitReadings: number;
  /** Lines that were not parseable JSON objects (ignored, but counted). */
  unparsableLines: number;
};

/**
 * Parses the CLI's NDJSON stream: one JSON object per line, dispatched by
 * `type`.
 *
 * Unknown event types are IGNORED rather than rejected, so a future CLI adding
 * stream events cannot break this adapter. The three types that matter:
 *
 *   system/init       the tool/MCP surface actually granted to the child
 *   rate_limit_event  quota telemetry; LAST one wins (design Part 4 — the
 *                     projection keeps only the latest, and readings were
 *                     measured going BACKWARDS within one second, so nothing
 *                     may be maxed or accumulated across them)
 *   result            the authoritative terminal object, identical in shape to
 *                     what `--output-format json` used to return whole
 *
 * TIMESTAMPS: the observation is stamped with the RECEIPT time of the specific
 * `rate_limit_event` line it came from — never the time the subprocess closed,
 * and never a provider-supplied time, because the CLI supplies none. Accepts a
 * raw string for convenience (every line then shares `defaultReceivedAt`); the
 * adapter passes per-line timestamps captured as the stream arrived.
 */
export function parseClaudeStream(
  input: string | ClaudeStreamLine[],
  defaultReceivedAt: Date = new Date()
): ClaudeStreamParse {
  const lines: ClaudeStreamLine[] =
    typeof input === "string"
      ? input
          .split("\n")
          .filter((text) => text.trim() !== "")
          .map((text) => ({ text, receivedAt: defaultReceivedAt }))
      : input;

  let result: Record<string, unknown> | null = null;
  let initSurface: { tools: unknown; mcpServers: unknown } | null = null;
  let lastRateLimit: { event: Record<string, unknown>; receivedAt: Date } | null = null;
  let rateLimitReadings = 0;
  let unparsableLines = 0;

  for (const { text, receivedAt } of lines) {
    const trimmed = text.trim();
    if (trimmed === "") continue;

    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      unparsableLines++;
      continue;
    }
    if (!isRecord(event)) {
      unparsableLines++;
      continue;
    }

    if (event.type === "system" && event.subtype === "init") {
      initSurface = { tools: event.tools ?? null, mcpServers: event.mcp_servers ?? null };
    } else if (event.type === "rate_limit_event") {
      rateLimitReadings++;
      lastRateLimit = { event, receivedAt };
    } else if (event.type === "result") {
      // Last result wins; a well-formed stream emits exactly one.
      result = event;
    }
  }

  return {
    result,
    initSurface,
    quota: lastRateLimit
      ? toQuotaObservation(lastRateLimit.event, lastRateLimit.receivedAt, rateLimitReadings)
      : null,
    rateLimitReadings,
    unparsableLines,
  };
}

/**
 * Maps CLI-reported error text to a distinguishable failure class.
 *
 * `result` is searched only when the CLI marked it an error (`is_error: true`).
 * Otherwise it is the MODEL's output, and a report that merely mentions a
 * "quota" or "rate_limit" must not turn a failed run into `quota_exhausted` —
 * a code classified as consuming nothing, which would release a reservation for
 * a call that really ran.
 */
function classifyFailure(parsed: Record<string, unknown>, stderr: string): ClaudeSubscriptionError {
  const errorText = parsed.is_error === true ? String(parsed.result ?? "") : "";
  const haystack = `${errorText} ${String(parsed.subtype ?? "")} ${stderr}`.toLowerCase();

  if (haystack.includes("login expired") || haystack.includes("please run /login") || haystack.includes("authentication_error")) {
    return new ClaudeSubscriptionError(
      "auth_expired",
      "callClaudeSubscriptionModel: the Claude subscription login has expired or is invalid." +
        " An unattended runtime cannot recover from this without a human re-authenticating."
    );
  }
  if (haystack.includes("rate_limit") || haystack.includes("usage limit") || haystack.includes("quota")) {
    return new ClaudeSubscriptionError(
      "quota_exhausted",
      "callClaudeSubscriptionModel: the subscription usage limit was reached." +
        " NOT falling back to a billable API provider — that requires a fresh Policy/Budget decision."
    );
  }
  if (parsed.subtype === "error_max_structured_output_retries") {
    return new ClaudeSubscriptionError(
      "schema_validation",
      "callClaudeSubscriptionModel: structured-output validation failed after the CLI's retry limit."
    );
  }
  return new ClaudeSubscriptionError(
    "nonzero_exit",
    `callClaudeSubscriptionModel: the CLI reported an error (subtype="${String(parsed.subtype)}").`
  );
}

export async function callClaudeSubscriptionModel(
  modelId: string,
  compiledContext: CompiledContext,
  expectedOutputShape: Record<string, unknown>,
  accounting: TierAccounting,
  options: { timeoutMs?: number } = {}
): Promise<ProviderCallResult> {
  if (accounting.unit !== "subscription_tokens") {
    throw new ClaudeSubscriptionError(
      "misconfigured",
      `callClaudeSubscriptionModel: tier for model "${modelId}" is configured with accounting unit` +
        ` "${accounting.unit}", but this adapter consumes a subscription entitlement and can only` +
        ' account in "subscription_tokens".'
    );
  }

  const stdinPayload = buildStdinPayload(compiledContext);
  const payloadBytes = Buffer.byteLength(stdinPayload, "utf8");
  if (payloadBytes > MAX_STDIN_BYTES) {
    throw new ClaudeSubscriptionError(
      "input_too_large",
      `callClaudeSubscriptionModel: compiled context is ${payloadBytes} bytes, over the ${MAX_STDIN_BYTES}-byte` +
        " stdin ceiling. Refusing to start the invocation rather than truncating context."
    );
  }

  // Resolved BEFORE the temp directory is created, so a missing/misconfigured
  // CLI fails fast and leaves nothing behind.
  const executable = resolveClaudeExecutable();
  const args = buildClaudeArgs(modelId, expectedOutputShape);
  const env = buildSanitizedEnv();

  // A fresh empty directory OUTSIDE the repository, per invocation. Defence in
  // depth beyond `--setting-sources ""`: no CLAUDE.md is discoverable if none
  // exists anywhere on the path. Never the repo root, whose own CLAUDE.md would
  // otherwise be a context contaminant and a silent token cost on every call.
  const cwd = await mkdtemp(path.join(tmpdir(), "acc-claude-sub-"));

  // The most recently parsed stream, kept so a failure thrown AFTER parsing can
  // still carry the quota reading that stream contained.
  let observedStream: ClaudeStreamParse | undefined;

  try {
    const { lines, stderr, code, timedOut } = await runClaudeCli(
      executable,
      args,
      env,
      cwd,
      stdinPayload,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );

    // Timeout is checked FIRST and throws: a terminated child records no
    // result, so there is no reported usage. The Executor charges the
    // reservation at its estimate (consumption unknown — the call may well have
    // consumed entitlement; DURABLE_EXECUTION §4.1). Reconciling zero here would
    // under-report consumption that really did occur.
    if (timedOut) {
      // The child was killed, but any rate_limit_event it emitted before the
      // kill was already received, and is still worth recording.
      observedStream = parseClaudeStream(lines);
      throw new ClaudeSubscriptionError(
        "timeout",
        `callClaudeSubscriptionModel: the CLI exceeded its ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms timeout` +
          " and was terminated. No usage was reported; the reservation is charged at its estimate."
      );
    }

    // Per-line receipt timestamps, captured as the stream arrived.
    const stream = parseClaudeStream(lines);
    observedStream = stream;

    if (!stream.result) {
      // A stream that ends without a `result` event is a failure, never an
      // empty success. Classify from stderr FIRST, so an auth or quota failure
      // that kills the CLI before it can emit a result keeps its specific,
      // operator-actionable code instead of collapsing to a generic one.
      const classified = classifyFailure({}, stderr);
      if (classified.code !== "nonzero_exit") throw classified;

      if (code !== 0) {
        throw new ClaudeSubscriptionError(
          "nonzero_exit",
          `callClaudeSubscriptionModel: the CLI exited with code ${String(code)} without emitting a result event.`
        );
      }
      throw new ClaudeSubscriptionError(
        // No line parsed at all means the output was not the expected NDJSON;
        // lines that parsed but contained no `result` is a different fault.
        stream.unparsableLines > 0 && stream.rateLimitReadings === 0 && !stream.initSurface
          ? "parse_error"
          : "no_result",
        `callClaudeSubscriptionModel: the CLI exited with code ${String(code)} but its stdout carried no` +
          ` \`result\` event (${stream.unparsableLines} unparsable line(s)).`
      );
    }

    const parsed = stream.result;

    if (code !== 0 || parsed.is_error === true) {
      throw classifyFailure(parsed, stderr);
    }

    // A `success` result carrying no `structured_output` is documented as a
    // failure case, not a partial success — treat it as one.
    const structured = parsed.structured_output;
    if (typeof structured !== "object" || structured === null) {
      throw new ClaudeSubscriptionError(
        "schema_validation",
        "callClaudeSubscriptionModel: the CLI returned success but no `structured_output` object." +
          " Per Anthropic's own documentation this must be treated as a failure, not a partial result."
      );
    }

    const { entries, totalTokens } = extractModelUsage(parsed);
    const primary = entries.find((e) => e.modelId === modelId) ?? entries[0]!;
    const secondaryUsage = entries.filter((e) => e !== primary);

    return {
      result: structured,
      usage: {
        tokensIn: primary.tokensIn,
        tokensOut: primary.tokensOut,
        // The SUM of every reported model, not just the primary — see
        // `extractModelUsage`. Denominated in tokens because that is the unit;
        // `total_cost_usd` is deliberately never read.
        costAmount: totalTokens,
        costUnit: "subscription_tokens",
        cacheHit: reportsCacheRead(parsed),
        ...(secondaryUsage.length > 0 ? { secondaryUsage } : {}),
      },
      // Surfaced, never acted on here. This adapter takes no quota decision and
      // writes no state: it hands the reading up so a caller with a transaction
      // can record it as an Event (Phase 7A). Absent when the stream carried no
      // usable reading — which is normal, not an error.
      ...(stream.quota ? { quotaObservation: stream.quota } : {}),
    };
  } catch (error) {
    // Attach whatever quota telemetry the stream carried to the failure, so a
    // caller holding the transaction can still record it (design Part 4:
    // emission is tied to the invocation TERMINATING, not to its success). This
    // matters most for quota_exhausted, whose accompanying reading explains it.
    if (error instanceof ClaudeSubscriptionError && !error.quotaObservation && observedStream?.quota) {
      error.quotaObservation = observedStream.quota;
    }
    throw error;
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {
      /* Best-effort cleanup of a temp dir; never mask the real outcome. */
    });
  }
}
