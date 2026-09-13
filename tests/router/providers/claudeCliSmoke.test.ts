/**
 * REAL, NON-MOCKED SMOKE TEST — deliberately separated from every other
 * provider test.
 *
 * WHY THIS FILE EXISTS: every other subscription-provider test replaces
 * `node:child_process` with `vi.mock`. That is the right choice for asserting
 * argv/env/cwd without consuming entitlement, but a mocked `spawn` accepts ANY
 * command string — so no mocked test could discover that
 * `spawn("claude", { shell: false })` is unstartable on Windows. That defect
 * shipped and was only caught when a benchmark tried a live invocation. This
 * file closes that class of gap: it actually starts the resolved executable.
 *
 * WHAT IT COSTS: nothing. `--version` is handled entirely by the CLI locally.
 *   - no model is invoked
 *   - no subscription entitlement is consumed
 *   - no request reaches Anthropic
 *   - no credential is passed (the child gets the sanitized env)
 *   - no repository tool, MCP server, or project setting is involved
 *
 * It is NOT a test of authentication or inference, and must never become one.
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import {
  resolveClaudeExecutable,
  buildSanitizedEnv,
  ClaudeSubscriptionError,
} from "../../../src/router/providers/claudeSubscription.js";

/** True when a Claude CLI is actually installed on this machine. */
function cliIsInstalled(): boolean {
  try {
    resolveClaudeExecutable();
    return true;
  } catch (error) {
    if (error instanceof ClaudeSubscriptionError && error.code === "cli_unavailable") return false;
    throw error;
  }
}

/**
 * OPT-IN, not merely presence-gated (Phase 8). This is the only test in the
 * suite that starts the real Claude CLI binary. `--version` consumes nothing,
 * but a test that runs automatically whenever the CLI happens to be installed
 * is one edit away from a live inference on every `npm test`. Requiring an
 * explicit `CLAUDE_CLI_SMOKE=1` makes starting the real binary a deliberate act.
 */
const smokeEnabled = process.env.CLAUDE_CLI_SMOKE === "1";
const installed = smokeEnabled && cliIsInstalled();

describe("REAL smoke test: the resolved Claude CLI can actually be started", () => {
  // Skipped rather than failed where no CLI exists (CI, a fresh checkout, a
  // non-Windows dev box without Claude Code). The skip reason is explicit so a
  // green run on such a machine is never mistaken for proof the CLI works.
  it.skipIf(!installed)(
    "starts the resolved executable with shell:false and reports a Claude Code version",
    async () => {
      const executable = resolveClaudeExecutable();

      // The resolved target must be directly startable — never an npm shim.
      if (process.platform === "win32") {
        expect(executable.endsWith(".exe")).toBe(true);
        expect(executable.endsWith(".cmd")).toBe(false);
        expect(executable.endsWith(".ps1")).toBe(false);
      }

      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(executable, ["--version"], {
          // Identical process-launch posture to production: no shell, argv as a
          // real array, sanitized environment (so no credential is passed).
          shell: false,
          env: buildSanitizedEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (c) => (stdout += String(c)));
        child.stderr.on("data", (c) => (stderr += String(c)));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/Claude Code/i);
      // A version number, not just the product name.
      expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
    },
    30_000
  );

  it.skipIf(installed)("SKIPPED: set CLAUDE_CLI_SMOKE=1 on a machine with the Claude CLI installed to run", () => {
    // Present so the skip is visible in the report rather than silent.
    expect(installed).toBe(false);
  });
});
