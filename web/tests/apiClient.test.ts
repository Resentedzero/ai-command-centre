/**
 * The HTTP contract of `lib/api`'s mutating helpers, against a stubbed `fetch`.
 * Every page test mocks `lib/api` wholesale, so without this nothing checked the
 * requests it actually sends — and approve/reject shipped sending a JSON
 * Content-Type with no body, which Fastify refuses with 400.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approveApproval, createGoal, engageAgentStop, liftAgentStop, listGoals, rejectApproval } from "../lib/api";

type Call = { url: string; init: RequestInit };

let calls: Call[];

function respond(status: number, body: string, statusText = "") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return { ok: status >= 200 && status < 300, status, statusText, text: async () => body };
    })
  );
}

function contentType(init: RequestInit): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.["Content-Type"];
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("lib/api request contract", () => {
  it("approve and reject POST with no body and no JSON Content-Type", async () => {
    respond(200, '{"approvalStatus":"approved"}');
    await approveApproval("a-1");
    await rejectApproval("a-2");

    expect(calls.map((c) => [c.url.replace(/^.*?(\/approvals)/, "$1"), c.init.method])).toEqual([
      ["/approvals/a-1/approve", "POST"],
      ["/approvals/a-2/reject", "POST"],
    ]);
    for (const { init } of calls) {
      expect(init.body).toBeUndefined();
      expect(contentType(init)).toBeUndefined();
    }
  });

  it("GETs send no Content-Type", async () => {
    respond(200, '{"projects":[]}');
    await listGoals();
    expect(calls[0].url).toMatch(/\/goals$/);
    expect(contentType(calls[0].init)).toBeUndefined();
  });

  it("requests with a body are JSON-typed and carry the expected fields", async () => {
    respond(200, '{"goalId":"g","workflowRunId":"w","status":"completed"}');
    await createGoal("Title", "Desc");
    await engageAgentStop("agent-1", "why");
    await liftAgentStop("agent-1", "stop-1");

    expect(calls.map((c) => [c.url.replace(/^https?:\/\/[^/]+/, ""), c.init.method, JSON.parse(String(c.init.body))])).toEqual([
      ["/goals", "POST", { title: "Title", description: "Desc" }],
      ["/execution-stops", "POST", { scope: "agent_definition", scopeRefId: "agent-1", reason: "why" }],
      ["/execution-stops/lift", "POST", { scope: "agent_definition", scopeRefId: "agent-1", stopId: "stop-1" }],
    ]);
    for (const { init } of calls) expect(contentType(init)).toBe("application/json");
  });

  it("a refusal surfaces the API's own error message", async () => {
    respond(409, '{"error":"Approval \\"a-1\\" is already resolved (status: \\"expired\\")"}', "Conflict");
    await expect(approveApproval("a-1")).rejects.toThrow(/409 Conflict: Approval "a-1" is already resolved \(status: "expired"\)/);
  });

  it("a body that repeats the status text is not repeated", async () => {
    respond(404, '{"error":"Not Found"}', "Not Found");
    await expect(listGoals()).rejects.toThrow(/-> 404 Not Found$/);
  });

  it("a non-JSON failure falls back to the status line", async () => {
    respond(502, "<html>bad gateway</html>", "Bad Gateway");
    await expect(listGoals()).rejects.toThrow(/-> 502 Bad Gateway$/);
  });
});
