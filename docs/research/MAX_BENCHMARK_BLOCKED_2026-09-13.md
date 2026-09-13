# Max Subscription Benchmark — BLOCKED by a provider defect

**Status:** Benchmark HALTED at Phase 1. Per the Step-4 instruction
("If a provider implementation defect is discovered, STOP and report it rather
than silently fixing production code"), no production source was modified.

**Date:** 2026-09-13 · **Host:** native Windows 11 · **CLI:** 2.1.270
**Account:** `subscriptionType: "max"`, `authMethod: "claude.ai"`, `apiProvider: "firstParty"`

**Entitlement consumed: ZERO.** No model call was ever made. Every diagnostic
below used `--version` or failed before process start.

---

## 1. The defect

`src/router/providers/claudeSubscription.ts` spawns the CLI as:

```ts
spawn("claude", args, { cwd, env, stdio: [...], shell: false })
```

On native Windows this **always** fails with `ENOENT`. The shipped adapter
cannot start the CLI at all, so no subscription-backed invocation can succeed on
this project's target platform.

Verified against the shipped adapter itself (not a lookalike harness):

```
FAILED_AFTER_MS 7
CODE            nonzero_exit
MESSAGE         callClaudeSubscriptionModel: failed to start the `claude` CLI (spawn claude ENOENT).
```

## 2. Root cause

`claude` on Windows is an **npm shim set**, not an executable:

| Path | Type |
|---|---|
| `…\Roaming\npm\claude` | shell script, no extension (for Git Bash) |
| `…\Roaming\npm\claude.cmd` | DOS batch file |
| `…\Roaming\npm\claude.ps1` | PowerShell script |

`child_process.spawn` with `shell: false` does **not** perform `PATHEXT`
resolution — that is a shell behaviour. It searches for a file literally named
`claude` that is a PE executable. The extension-less file exists but is a shell
script, so `CreateProcess` fails → `ENOENT`.

The real binary is reached only through the `.cmd` shim's body:

```
"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*
```

## 3. Measured spawn matrix

| # | Form | Result |
|---|---|---|
| A | `spawn("claude", shell:false)` — **what production does** | `ERROR ENOENT: spawn claude ENOENT` |
| B | `spawn("<…>/bin/claude.exe", shell:false)` — candidate fix | `exit=0 stdout="2.1.270 (Claude Code)"` |
| C | `spawn("<…>/claude.cmd", shell:false)` | `THREW EINVAL` |

C is Node's deliberate refusal to spawn `.bat`/`.cmd` without `shell: true`
(the CVE-2024-27980 mitigation). It is **not** a viable fix.

`where claude` resolves only to the shim paths — never to the `.exe`. So a naive
"resolve via `where`" fix would land on the `.cmd` and hit case C.

## 4. Why the test suite did not catch this

`tests/router/providers/claudeSubscription.test.ts` replaces `node:child_process`
wholesale with `vi.mock`. That was a deliberate and still-correct choice — it is
what lets the suite assert the security properties (argv, sanitized env, cwd)
without consuming entitlement. But a mocked `spawn` accepts **any** command
string, so no mocked test can discover that the command name is unspawnable on
this platform.

This is a genuine coverage gap, not a flawed test: the missing check is
*"can the configured command actually be started on this host"*, which is a
host-dependent integration concern the unit suite structurally cannot cover.

## 5. Fix direction (NOT implemented)

Resolve the real `.exe` and spawn that with `shell: false`.

This keeps every existing security property intact — argv stays a proper array,
so there is no shell quoting or injection surface. That matters here: the
`--json-schema` argument carries JSON with quotes and braces, and a
`shell: true` fix would concatenate it into a command string. **`shell: true` is
the wrong fix and should be rejected on security grounds**, even though it would
make the ENOENT go away.

Design questions the fix must answer (architecture decisions, not mechanics):

1. **How is the executable located?** Hard-coding an absolute npm path is not
   portable across machines or install methods (npm global, native installer,
   WSL). Options: a configured path, `process.env.CLAUDE_CLI_PATH` with
   discovery fallback, or parsing the shim. This is a real config-surface
   decision — Phase 10.6.3 says the provider must be explicitly configured, and
   an executable path is arguably part of that configuration.
2. **Platform branching?** POSIX hosts can spawn `claude` by name today. A fix
   must not regress that.
3. **Fail-fast on misconfiguration** — a missing/unresolvable CLI should be a
   distinct, actionable startup error, not a per-invocation failure.

## 6. Secondary finding (minor)

A failure to *start* the process is classified as `nonzero_exit`. There was no
exit code — the process never ran. This conflates "CLI is not installed or not
resolvable" (an operator/config problem) with "CLI ran and returned non-zero"
(a runtime problem). A distinct code (e.g. `cli_unavailable`) would let an
operator tell those apart. Not fixed.

## 7. Benchmark status per phase

| Phase | Status |
|---|---|
| 1 — live CLI contract | **BLOCKED** — no invocation possible |
| 2 — representative workloads | Not started |
| 3 — context scaling | Not started |
| 4 — concurrency | Not started |
| 5 — failure/timeout | Not started (live path); timeout logic remains covered by mocked unit tests only |
| 6 — isolation | **Partially evidenced** — see below |
| 7 — interactive Max impact | Not measurable (no consumption occurred) |
| 8 — repeatability | Not started |

### Phase 6 partial result (genuine, from the real constructed configuration)

The pre-flight capture used the production `buildClaudeArgs` / `buildSanitizedEnv`
and recorded what *would* have been passed. All isolation properties held:

```
cwdIsOutsideRepo:            true
cwdContentsBefore:           []
argvContainsBare:            false
argvContainsFallbackModel:   false
forbiddenPresentInChildEnv:  []      (all 24 forbidden vars absent)
parentHadApiKey:             false
stdinContainsSkAnt:          false
childEnvKeys:                APPDATA, COMSPEC, HOME, LOCALAPPDATA, PATH,
                             PATHEXT, Path, SystemRoot, TEMP, TMP,
                             USERPROFILE, windir
```

argv was byte-exact against the required flag set, including `--tools ""`,
`--strict-mcp-config`, `--setting-sources ""`, `--permission-mode manual`,
`--permission-prompts none`, `--output-format json`,
`--no-session-persistence`, `--json-schema`, and the pinned
`--model claude-haiku-4-5-20251001`.

**UNVERIFIED and still open:** whether `--tools ""` forecloses server-side
web search/fetch. This requires a live invocation and cannot be inferred from
configuration alone. It remains exactly as unresolved as before this session.

## 8. What must happen before the benchmark can run

1. Decide the executable-resolution approach (§5) — an architecture/config
   decision, and explicitly yours to make.
2. Implement and test it, including a non-mocked smoke test that actually starts
   the CLI (`--version` is sufficient and free) so this class of defect cannot
   recur silently.
3. Re-run Step 4 from Phase 1.

No viability conclusion about subscription-backed inference can be drawn from
this session. The earlier spike's two Pro-era measurements remain the only live
data, and they are explicitly not a basis for capacity planning under Max.
