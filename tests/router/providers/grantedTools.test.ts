/**
 * R2: a provider-side tool is reachable only when a Capability Grant authorized it, and
 * the child's reported surface must match that authorization exactly.
 *
 * These are the security properties of widening V1's `--tools ""` posture:
 *   - no tools authorized  -> the V1 flag set, byte for byte;
 *   - tools authorized     -> named in `--tools` AND `--allowedTools` (without the second,
 *     the permission mode denies the tool silently and the model answers from memory);
 *   - the child reports anything else -> the result is refused, not used.
 */
import { describe, expect, it } from "vitest";
import { assertIsolationSurface, buildClaudeArgs, parseClaudeStream } from "../../../src/router/providers/claudeSubscription.js";

const surface = (tools: unknown, mcpServers: unknown = []) => ({ tools, mcpServers });

describe("granted tools reach the child only through the flag set", () => {
  it("keeps the V1 posture when nothing was authorized", () => {
    const args = buildClaudeArgs("claude-opus-5", { report: "string" });
    expect(args.slice(0, 3)).toEqual(["-p", "--tools", ""]);
    expect(args).not.toContain("--allowedTools");
  });

  it("names an authorized tool in both --tools and --allowedTools, keeping every isolation flag", () => {
    const args = buildClaudeArgs("claude-sonnet-5", {}, ["WebSearch"]);
    expect(args.slice(0, 5)).toEqual(["-p", "--tools", "WebSearch", "--allowedTools", "WebSearch"]);
    for (const flag of ["--strict-mcp-config", "--setting-sources", "--permission-mode", "--no-session-persistence"]) {
      expect(args).toContain(flag);
    }
    expect(args).not.toContain("--bare");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("WebFetch");
    expect(args).not.toContain("Bash");
  });
});

describe("the child's reported surface must equal what was authorized", () => {
  it("accepts exactly the authorized surface", () => {
    expect(() => assertIsolationSurface(surface(["StructuredOutput"]), [])).not.toThrow();
    expect(() => assertIsolationSurface(surface(["StructuredOutput", "WebSearch"]), ["WebSearch"])).not.toThrow();
  });

  it("refuses a tool nobody granted", () => {
    expect(() => assertIsolationSurface(surface(["StructuredOutput", "Bash"]), [])).toThrow(/not what was authorized/);
    expect(() => assertIsolationSurface(surface(["StructuredOutput", "WebSearch", "WebFetch"]), ["WebSearch"])).toThrow(/not what was authorized/);
  });

  it("refuses when an authorized tool is missing — the model would answer from memory as if it had searched", () => {
    expect(() => assertIsolationSurface(surface(["StructuredOutput"]), ["WebSearch"])).toThrow(/not what was authorized/);
  });

  it("refuses any MCP server, which a subscription credential would otherwise pull in", () => {
    expect(() => assertIsolationSurface(surface(["StructuredOutput"], ["some-connector"]), [])).toThrow(/not what was authorized/);
  });

  it("refuses an unverifiable surface only when something was authorized", () => {
    expect(() => assertIsolationSurface(null, [])).not.toThrow();
    expect(() => assertIsolationSurface(null, ["WebSearch"])).toThrow(/could not be verified/);
  });
});

describe("search provenance is read from the tool exchange, not from a counter", () => {
  const stream = [
    JSON.stringify({ type: "system", subtype: "init", tools: ["StructuredOutput", "WebSearch"], mcp_servers: [] }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "WebSearch", input: { query: "npm claude code latest version" } }] } }),
    JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            content: 'Web search results for query: "npm"\n\nLinks: [{"title":"@anthropic-ai/claude-code - npm","url":"https://www.npmjs.com/package/@anthropic-ai/claude-code"},{"title":"dup","url":"https://www.npmjs.com/package/@anthropic-ai/claude-code"}]',
          },
        ],
      },
    }),
    JSON.stringify({ type: "result", subtype: "success", structured_output: { ok: true }, modelUsage: {} }),
  ].join("\n");

  it("records the queries asked and the sources returned, without duplicates", () => {
    const parsed = parseClaudeStream(stream);
    expect(parsed.webSearch.queries).toEqual(["npm claude code latest version"]);
    expect(parsed.webSearch.sources).toEqual([{ url: "https://www.npmjs.com/package/@anthropic-ai/claude-code", title: "@anthropic-ai/claude-code - npm" }]);
  });

  it("records nothing when no search happened, and never invents a source", () => {
    const quiet = parseClaudeStream(JSON.stringify({ type: "result", subtype: "success", structured_output: {}, modelUsage: {} }));
    expect(quiet.webSearch).toEqual({ queries: [], sources: [] });
  });
});
