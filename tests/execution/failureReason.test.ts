/**
 * Failure text written to the immutable, streamed event log must never carry
 * SQL text, host paths or key-shaped strings — see src/execution/failureReason.ts.
 */
import { describe, it, expect } from "vitest";
import { failureCode, redactFailureText } from "../../src/execution/failureReason.js";

describe("redactFailureText", () => {
  it("replaces any database error with a generic reason (drizzle embeds SQL text and parameters)", () => {
    expect(redactFailureText('Failed query: select "secret_col" from "t" where id = $1\nparams: abc')).toBe(
      "database error (details in the server log)"
    );
  });

  it("strips Windows, UNC and POSIX user/system paths, but leaves URLs and ordinary text alone", () => {
    expect(redactFailureText('failed to start the Claude CLI at "C:\\Users\\alice\\bin\\claude.exe"')).toBe(
      'failed to start the Claude CLI at "<path>"'
    );
    expect(redactFailureText("cannot open \\\\fileserver\\share\\report.json")).toBe("cannot open <path>");
    expect(redactFailureText("ENOENT: /Users/alice/.env and /home/bob/x.json")).toBe("ENOENT: <path> and <path>");
    expect(redactFailureText("fetch https://internal.local/research?q=x failed")).toBe(
      "fetch https://internal.local/research?q=x failed"
    );
    expect(redactFailureText("provider boom")).toBe("provider boom");
  });

  it("redacts key-shaped strings and caps length", () => {
    expect(redactFailureText("bad key sk-ant-api03-AbC_123-xyz used")).toBe("bad key [REDACTED-KEY] used");
    const long = redactFailureText("x".repeat(2_000));
    expect(long.length).toBe(501);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("failureCode", () => {
  it("admits snake_case adapter codes only, and names known error classes", () => {
    expect(failureCode(Object.assign(new Error("x"), { code: "auth_expired" }))).toBe("auth_expired");
    expect(failureCode(Object.assign(new Error("x"), { code: "23505" }))).toBeUndefined();
    expect(failureCode(Object.assign(new Error("x"), { code: "ENOENT" }))).toBeUndefined();
    expect(failureCode(Object.assign(new Error("x"), { name: "ContextBudgetError" }))).toBe("context_budget_exceeded");
    expect(failureCode(Object.assign(new Error("x"), { name: "DrizzleQueryError" }))).toBe("database_error");
    expect(failureCode(new Error("plain"))).toBeUndefined();
    expect(failureCode("not an error")).toBeUndefined();
  });
});
