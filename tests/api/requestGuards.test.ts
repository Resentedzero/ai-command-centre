/**
 * Request guards (DNS rebinding / cross-site state changes) and error hygiene
 * for the localhost API. See `src/api/requestGuards.ts` for the threat model.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { hostnameOf, isUiOrigin, isUuid, refuseRequest } from "../../src/api/requestGuards.js";
import { resetTestSchema, closeTestDb, testDb } from "../testDb.js";
import { buildServer } from "../../src/api/server.js";
import { randomUUID } from "node:crypto";
import * as schema from "../../src/db/schema.js";
import { engageStop, liftStop, listActiveStops } from "../../src/governance/executionStop.js";

const UI = "http://localhost:3100";

describe("refuseRequest (pure)", () => {
  it("accepts loopback hosts on any port, and refuses every other name", () => {
    for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000", "LOCALHOST"]) {
      expect(refuseRequest({ method: "GET", host, origin: undefined }, { uiOrigin: UI }), host).toBeNull();
    }
    for (const host of ["attacker.example:3000", "127.0.0.1.attacker.example", "localhost.evil:3000"]) {
      expect(refuseRequest({ method: "GET", host, origin: undefined }, { uiOrigin: UI }), host).toMatch(/not an allowed name/);
    }
    expect(refuseRequest({ method: "GET", host: undefined, origin: undefined }, { uiOrigin: UI })).toMatch(/missing Host/);
  });

  it("allows an operator-configured extra host name", () => {
    expect(
      refuseRequest({ method: "POST", host: "cc.lan:3000", origin: undefined }, { uiOrigin: UI, extraAllowedHosts: ["cc.lan"] })
    ).toBeNull();
  });

  it("refuses a state-changing request from any browser origin but the UI's; reads are not origin-gated", () => {
    const host = "127.0.0.1:3000";
    expect(refuseRequest({ method: "POST", host, origin: "https://evil.example" }, { uiOrigin: UI })).toMatch(/may not change state/);
    expect(refuseRequest({ method: "POST", host, origin: "null" }, { uiOrigin: UI })).toMatch(/may not change state/);
    expect(refuseRequest({ method: "POST", host, origin: UI }, { uiOrigin: UI })).toBeNull();
    expect(refuseRequest({ method: "POST", host, origin: undefined }, { uiOrigin: UI })).toBeNull();
    expect(refuseRequest({ method: "GET", host, origin: "https://evil.example" }, { uiOrigin: UI })).toBeNull();
  });

  it("refuses cross-site and same-site requests of any method unless they carry the UI's origin", () => {
    const host = "127.0.0.1:3000";
    // A no-cors GET from another site carries no Origin, only Sec-Fetch-Site.
    expect(refuseRequest({ method: "GET", host, origin: undefined, secFetchSite: "cross-site" }, { uiOrigin: UI })).toMatch(/cross-site/);
    expect(refuseRequest({ method: "GET", host, origin: "https://evil.example", secFetchSite: "cross-site" }, { uiOrigin: UI })).toMatch(/cross-site/);
    // Every localhost port is the same site: another local dev server's page is `same-site`.
    expect(refuseRequest({ method: "GET", host, origin: undefined, secFetchSite: "same-site" }, { uiOrigin: UI })).toMatch(/same-site/);
    expect(refuseRequest({ method: "GET", host, origin: "http://localhost:5173", secFetchSite: "same-site" }, { uiOrigin: UI })).toMatch(/same-site/);
    // The UI calls with CORS, so it carries its Origin; same-origin and non-browser requests pass.
    expect(refuseRequest({ method: "GET", host, origin: UI, secFetchSite: "same-site" }, { uiOrigin: UI })).toBeNull();
    expect(refuseRequest({ method: "GET", host, origin: UI, secFetchSite: "cross-site" }, { uiOrigin: UI })).toBeNull();
    expect(refuseRequest({ method: "GET", host, origin: undefined, secFetchSite: "same-origin" }, { uiOrigin: UI })).toBeNull();
    expect(refuseRequest({ method: "GET", host, origin: undefined, secFetchSite: "none" }, { uiOrigin: UI })).toBeNull();
  });

  it("treats the UI opened under another loopback name, same scheme and port, as the UI; nothing else", () => {
    const host = "127.0.0.1:3000";
    for (const origin of ["http://127.0.0.1:3100", "http://[::1]:3100"]) {
      expect(isUiOrigin(origin, UI), origin).toBe(true);
      expect(refuseRequest({ method: "GET", host, origin, secFetchSite: "same-site" }, { uiOrigin: UI }), origin).toBeNull();
      expect(refuseRequest({ method: "POST", host, origin }, { uiOrigin: UI }), origin).toBeNull();
    }
    for (const origin of ["http://127.0.0.1:3101", "https://localhost:3100", "http://localhost.evil:3100", "null", "not a url"]) {
      expect(isUiOrigin(origin, UI), origin).toBe(false);
      expect(refuseRequest({ method: "POST", host, origin }, { uiOrigin: UI }), origin).toMatch(/may not change state/);
    }
  });

  it("parses hostnames and UUIDs strictly", () => {
    expect(hostnameOf("[::1]:3000")).toBe("::1");
    expect(hostnameOf("Example.COM:80")).toBe("example.com");
    expect(isUuid("00000000-0000-0000-0000-000000000000")).toBe(true);
    expect(isUuid("abc")).toBe(false);
    expect(isUuid("00000000-0000-0000-0000-000000000000' OR 1=1")).toBe(false);
  });
});

describe("through the server", () => {
  const app = buildServer({ db: testDb });

  beforeAll(async () => {
    await resetTestSchema();
  }, 30000);

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it("a DNS-rebinding request (foreign Host) cannot approve, even with a real-looking id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/approvals/00000000-0000-0000-0000-000000000000/approve",
      headers: { host: "attacker.example:3000" },
    });
    // Refused by the guard itself — not a 404 from a route that ran.
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/^Forbidden: Host "attacker\.example"/);
  });

  it("a cross-site POST cannot lift the global emergency stop — the stop stays engaged", async () => {
    await testDb.transaction((tx) => engageStop(tx, { scope: "global" }));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/execution-stops/lift",
        headers: { host: "127.0.0.1:3000", origin: "https://evil.example" },
        payload: { scope: "global" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatch(/^Forbidden: Origin/);
      const active = await testDb.transaction((tx) => listActiveStops(tx));
      expect(active.some((s) => s.scope === "global")).toBe(true);
    } finally {
      await testDb.transaction((tx) => liftStop(tx, { scope: "global" }));
    }
  });

  it("another site cannot hold an event stream open: cross-site GET is refused and HEAD is not routed", async () => {
    const crossSite = await app.inject({
      method: "GET",
      url: "/events/stream?sinceEventCursor=foo",
      headers: { host: "127.0.0.1:3000", "sec-fetch-site": "cross-site" },
    });
    // Refused by the guard before the route validates anything.
    expect(crossSite.statusCode).toBe(403);
    expect(crossSite.json().error).toMatch(/cross-site/);

    const head = await app.inject({ method: "HEAD", url: "/events/stream?sinceEventCursor=foo", headers: { host: "127.0.0.1:3000" } });
    expect(head.statusCode).toBe(404);
  });

  it("another local page cannot hold an event stream open either: same-site GET without the UI's origin is refused", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/events/stream?sinceEventCursor=foo",
      headers: { host: "127.0.0.1:3000", "sec-fetch-site": "same-site" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/same-site/);
  });

  it("free-text fields are bounded: an oversized Goal title or description, or stop reason, is a 400 and writes nothing", async () => {
    const huge = "x".repeat(10_001);
    for (const payload of [{ title: huge }, { title: "ok", description: huge }, { title: "ok", description: 42 }]) {
      const res = await app.inject({ method: "POST", url: "/goals", headers: { host: "127.0.0.1:3000" }, payload });
      expect(res.statusCode, JSON.stringify(payload).slice(0, 40)).toBe(400);
    }
    expect(await testDb.query.goals.findMany()).toEqual([]);

    const stop = await app.inject({
      method: "POST",
      url: "/execution-stops",
      headers: { host: "127.0.0.1:3000" },
      payload: { scope: "run", scopeRefId: randomUUID(), reason: huge },
    });
    expect(stop.statusCode).toBe(400);
    expect(await testDb.transaction((tx) => listActiveStops(tx))).toEqual([]);
  });

  it("malformed ids are 400s, never 500s", async () => {
    for (const url of ["/approvals/abc/approve", "/workflow-runs/abc/pause", "/workflow-runs/abc/resume"]) {
      const res = await app.inject({ method: "POST", url, headers: { host: "127.0.0.1:3000" } });
      expect(res.statusCode, url).toBe(400);
    }
    const stream = await app.inject({ method: "GET", url: "/events/stream?sinceEventCursor=foo", headers: { host: "127.0.0.1:3000" } });
    expect(stream.statusCode).toBe(400);
  });

  it("an unknown Workflow Run is 404 and a wrong-state one 409", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/workflow-runs/00000000-0000-0000-0000-000000000000/pause",
      headers: { host: "127.0.0.1:3000" },
    });
    expect(res.statusCode).toBe(404);

    // A finished Workflow Run cannot be paused: a client conflict, not a server fault.
    const workflowRunId = await testDb.transaction(async (tx) => {
      const [project] = await tx.insert(schema.projects).values({ name: "p-" + randomUUID() }).returning();
      const [definition] = await tx
        .insert(schema.workflowDefinitions)
        .values({ name: "wf-" + randomUUID(), version: 1, graphDefinition: {} })
        .returning();
      const [goal] = await tx.insert(schema.goals).values({ projectId: project!.id, title: "g", status: "active" }).returning();
      const [workflowRun] = await tx
        .insert(schema.workflowRuns)
        .values({ workflowDefinitionId: definition!.id, workflowDefinitionVersion: 1, goalId: goal!.id, status: "completed" })
        .returning();
      return workflowRun!.id;
    });
    const conflict = await app.inject({
      method: "POST",
      url: `/workflow-runs/${workflowRunId}/pause`,
      headers: { host: "127.0.0.1:3000" },
    });
    expect(conflict.statusCode).toBe(409);
  });

  it("a 5xx response never carries the underlying error message (no SQL text, no paths)", async () => {
    const probe = buildServer({ db: testDb });
    probe.get("/__boom", async () => {
      throw new Error('Failed query: select "secret_column" from "internal_table"');
    });
    const res = await probe.inject({ method: "GET", url: "/__boom", headers: { host: "127.0.0.1:3000" } });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toMatch(/secret_column|internal_table|Failed query/);
    expect(res.json()).toEqual({ error: "Internal server error" });
    await probe.close();
  });
});
