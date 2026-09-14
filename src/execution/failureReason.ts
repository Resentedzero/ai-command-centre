/**
 * What an `invocation_failed` event may say about WHY (hardening, 2026-09-14).
 *
 * Failure reasons are written into the immutable event log and streamed to
 * every SSE subscriber, so a raw `error.message` is the wrong thing to store:
 *   - database errors (drizzle's `DrizzleQueryError`) embed the full SQL text
 *     and its parameters — schema detail with no operator value;
 *   - filesystem and subprocess errors embed absolute host paths, including
 *     the operator's user-profile path;
 *   - a key-shaped string in any message would be persisted forever.
 * Once written, none of that can be removed: events are immutable.
 *
 * `redactFailureText` keeps a reason human-readable (operators need "provider
 * boom", not a bare code) while stripping those three classes and capping
 * length. It is applied at the single write point, `failInvocation`, so every
 * present and future caller is covered. The full original text goes to the
 * server log only. `failureCode` adds a stable, machine-readable classification
 * when the error carries one (e.g. the Claude adapter's `auth_expired`).
 */

const MAX_REASON_LENGTH = 500;
const DATABASE_ERROR_REASON = "database error (details in the server log)";

export function redactFailureText(text: string): string {
  if (/\bFailed query:/i.test(text)) return DATABASE_ERROR_REASON;

  let out = text
    // Any sk- key (Anthropic, OpenAI project/service-account/admin/legacy) and bearer tokens.
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[REDACTED-KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED-KEY]")
    // UNC paths: \\server\share\...
    .replace(/\\\\[^\s"'`]+/g, "<path>")
    // Drive-letter paths: C:\... or C:/...
    .replace(/\b[A-Za-z]:[\\/][^\s"'`]*/g, "<path>")
    // POSIX absolute paths under the usual user/system roots (not URLs).
    .replace(/(?<![A-Za-z0-9:/])\/(?:Users|home|root|tmp|var|etc|opt|private|mnt)\/[^\s"'`]*/g, "<path>");

  if (out.length > MAX_REASON_LENGTH) out = `${out.slice(0, MAX_REASON_LENGTH)}…`;
  return out;
}

/** A stable code for the failure, when the error carries a recognizable one. Never guessed. */
export function failureCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { name?: unknown; code?: unknown };
  // snake_case codes only: this admits adapter codes like `auth_expired` and
  // excludes Postgres SQLSTATEs ("23505") and Node errno names ("ENOENT").
  if (typeof candidate.code === "string" && /^[a-z][a-z0-9_]*$/.test(candidate.code)) return candidate.code;
  if (candidate.name === "ContextBudgetError") return "context_budget_exceeded";
  if (candidate.name === "DrizzleQueryError") return "database_error";
  return undefined;
}
