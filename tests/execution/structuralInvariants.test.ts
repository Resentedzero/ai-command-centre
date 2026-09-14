/**
 * Architecture invariants checked against the source itself, so a change that
 * breaks one fails here even on a code path no behavioural test drives.
 *
 *   1. No provider call inside a database transaction (Phase 9, DURABLE_EXECUTION
 *      §2): outside the Model Router, `dispatchModelCall` is called only by the
 *      workflow driver's `dispatchAndRecord`, and never from within a
 *      transaction callback there.
 *   2. The single chokepoint (spec Phase 4): only the Model Router imports a
 *      provider adapter module. (`modelRouter.test.ts` separately checks that
 *      only the adapters import a provider SDK.)
 *   3. Status changes are recorded (spec §8.2 implementation note): every
 *      function that updates the `status` of a Run, Task Instance or Workflow
 *      Run also writes an event. The allowlist names the transitions that
 *      deliberately do not, so adding one is a visible decision.
 *
 * Parsed with the TypeScript compiler API rather than regex, so comments and
 * formatting cannot produce false passes.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

function sourceFiles(dir: string = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

function rel(file: string): string {
  return path.relative(SRC, file).split(path.sep).join("/");
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

function visit(node: ts.Node, fn: (n: ts.Node) => void): void {
  fn(node);
  node.forEachChild((child) => visit(child, fn));
}

function calleeName(call: ts.CallExpression): string | null {
  const expr = call.expression;
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

/** The nearest enclosing NAMED function (declaration, or a const bound to an arrow/function expression). */
function enclosingNamedFunction(node: ts.Node): { name: string; node: ts.Node } | null {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return { name: current.name.text, node: current };
    if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name)) return { name: current.name.text, node: current };
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return { name: current.parent.name.text, node: current };
    }
  }
  return null;
}

function callsWithin(node: ts.Node): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  visit(node, (n) => {
    if (ts.isCallExpression(n)) calls.push(n);
  });
  return calls;
}

describe("no provider call inside a transaction", () => {
  it("outside src/router, only dispatchAndRecord calls dispatchModelCall, and not inside a transaction callback", () => {
    const callSites: string[] = [];
    for (const file of sourceFiles()) {
      if (rel(file).startsWith("router/")) continue;
      visit(parse(file), (n) => {
        if (!ts.isCallExpression(n) || calleeName(n) !== "dispatchModelCall") return;
        callSites.push(`${rel(file)}#${enclosingNamedFunction(n)?.name ?? "<top level>"}`);

        // No enclosing call may be a transaction runner: its callback would hold
        // a transaction open for the whole provider call.
        for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
          if (ts.isCallExpression(p)) {
            expect(calleeName(p), `dispatchModelCall nested inside ${calleeName(p)}(...)`).not.toMatch(/^(runInTx|transaction)$/);
          }
        }
      });
    }
    expect(callSites).toEqual(["workflow/advanceWorkflowRunUntilBlocked.ts#dispatchAndRecord"]);
  });
});

describe("no tool side effect inside a transaction", () => {
  it("the Executor never runs a tool's execute; only the driver's performToolDispatch does, outside any transaction callback", () => {
    const executeCallers: string[] = [];
    for (const file of sourceFiles()) {
      visit(parse(file), (n) => {
        if (!ts.isCallExpression(n) || calleeName(n) !== "execute" || !ts.isPropertyAccessExpression(n.expression)) return;
        // `tx.execute(sql)` is a database call, not a spec's execute.
        const receiver = n.expression.expression.getText();
        if (/^(tx|db|this|probe|sp)$/.test(receiver)) return;
        executeCallers.push(`${rel(file)}#${enclosingNamedFunction(n)?.name ?? "<top level>"}:${receiver}`);
        for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
          if (ts.isCallExpression(p)) {
            expect(calleeName(p), `execute nested inside ${calleeName(p)}(...)`).not.toMatch(/^(runInTx|transaction)$/);
          }
        }
      });
    }
    // Deterministic and retrieval specs are internal and still run in the
    // Executor's transaction; every tool spec's execute is dispatched.
    expect(executeCallers.sort()).toEqual([
      // The adapter call inside a Tool Invocation spec's `execute` closure: it
      // runs only when that closure does, i.e. from performToolDispatch.
      "capabilities/toolAdapters.ts#resolveToolInvocation:fn",
      "execution/executor.ts#processGenericSpec:spec",
      "workflow/advanceWorkflowRunUntilBlocked.ts#performToolDispatch:dispatch",
    ]);
  });
});

describe("core names no capability (spec 18.3)", () => {
  // Capability code and the seed are where capabilities and seeded Definitions
  // are named. Everything else — Interpreter, Executor, governance, routing,
  // context, events, API — must work for any capability, so it may neither
  // import a capability's modules nor name one in code.
  const CAPABILITY_SPECIFIC = /research\.retrieve|publish\.report|Research-Report|Review-and-Publish|Research-and-Publish|^Researcher$|^Publisher$/;
  const allowed = (file: string) => file.startsWith("capabilities/") || file === "definitions/seed.ts" || file === "definitions/lookupSeed.ts";

  it("outside capability code and the seed, no string literal names a capability or seeded Definition, and no capability module is imported", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (allowed(rel(file))) continue;
      visit(parse(file), (n) => {
        if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
          const target = n.moduleSpecifier.text;
          if (/capabilities\/(researchRetrieve|publishReport)\//.test(target)) offenders.push(`${rel(file)} imports ${target}`);
          return;
        }
        if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && CAPABILITY_SPECIFIC.test(n.text)) {
          offenders.push(`${rel(file)}: "${n.text}"`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe("agent_performance reaches decisions only through its sample criterion (spec Phase 19 V2/V4, 16.2)", () => {
  // Only its schema, its projector, the startup loop that runs it, the read APIs and
  // the eligibility gate (governance/performanceEligibility.ts) may reference the
  // projection. Decisions read it only through the gate, and only the Model Router's
  // tier preference does: Policy's CONDITIONAL rule is undecided (ROADMAP_STATUS §6).
  // Also a tripwire: the snapshot recorded on `invocation_started` (§10.7) is readable
  // from `events`, and re-exports or dynamic imports would pass the importer check.
  // A tripwire, not a guarantee: a table name assembled at run time, iteration over
  // the schema object, or an HTTP call to the read API would pass. Migrations are
  // checked in tests/projections/agentPerformance.test.ts.
  // api/routes/costs.ts joined 2026-09-14: the screen 7 cost-vs-success display.
  const ALLOWED = [
    "api/routes/agents.ts",
    "api/routes/costs.ts",
    "api/start.ts",
    "db/schema.ts",
    "governance/performanceEligibility.ts",
    "projections/agentPerformance.ts",
  ];

  it("only the Model Router imports the eligibility gate (never Policy, Approvals or the Executor)", () => {
    const importers = sourceFiles()
      .filter((file) =>
        parse(file).statements.some(
          (s) => ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && /\/performanceEligibility\.js$/.test(s.moduleSpecifier.text)
        )
      )
      .map(rel);
    expect(importers).toEqual(["router/modelRouter.ts"]);
  });

  it("only the schema, projector, startup loop and read APIs reference agent_performance", () => {
    const referencing = new Set<string>();
    for (const file of sourceFiles()) {
      visit(parse(file), (n) => {
        const named =
          (ts.isIdentifier(n) && n.text === "agentPerformance") ||
          (ts.isIdentifier(n) && n.text === "refreshAgentPerformance") ||
          ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && /agent_performance|agentPerformance/.test(n.text)) ||
          (ts.isTemplateExpression(n) && /agent_performance/.test(n.getText()));
        if (named) referencing.add(rel(file));
      });
    }
    expect([...referencing].sort()).toEqual(ALLOWED);
  });
});

describe("single chokepoint", () => {
  it("only the Model Router imports a provider adapter module", () => {
    const importers = new Set<string>();
    for (const file of sourceFiles()) {
      if (rel(file).startsWith("router/providers/")) continue;
      for (const statement of parse(file).statements) {
        if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
        const specifier = statement.moduleSpecifier;
        if (specifier && ts.isStringLiteral(specifier) && /(^|\/)providers\//.test(specifier.text)) {
          importers.add(rel(file));
        }
      }
    }
    expect([...importers]).toEqual(["router/modelRouter.ts"]);
  });
});

describe("status changes are recorded as events", () => {
  const STATUS_TABLES = new Set(["runs", "taskInstances", "workflowRuns"]);
  const EVENT_WRITERS = new Set(["emitEvent", "emitLifecycleEvent", "recordTaskInstanceTransition"]);

  /**
   * Transitions that deliberately write no event of their own. Keyed
   * `file#function`; each entry is a known, documented gap, not an oversight.
   */
  const NO_EVENT_ALLOWLIST: Record<string, string> = {
    // Operator pause/resume: spec §8.2 lists no event for them; recorded only in
    // workflow_runs.status. Adding events is a spec decision.
    "workflow/interpreter.ts#pauseWorkflowRun": "no spec'd event",
    "workflow/interpreter.ts#resumeWorkflowRun": "no spec'd event",
    // A Run returning to `active` from `awaiting_approval` when its approved tool
    // is claimed: recorded by `approval_granted` and the Invocation's own events.
    "execution/executor.ts#yieldToolDispatch": "recorded by approval and invocation events",
  };

  /** `tx.update(<table>).set({ status: ... })` calls in `sourceFile`, with the table name. */
  function statusUpdates(sourceFile: ts.SourceFile): { table: string; node: ts.CallExpression }[] {
    const found: { table: string; node: ts.CallExpression }[] = [];
    visit(sourceFile, (n) => {
      if (!ts.isCallExpression(n) || calleeName(n) !== "set") return;
      const arg = n.arguments[0];
      const setsStatus =
        arg !== undefined &&
        ts.isObjectLiteralExpression(arg) &&
        arg.properties.some((p) => p.name !== undefined && ts.isIdentifier(p.name) && p.name.text === "status");
      if (!setsStatus || !ts.isPropertyAccessExpression(n.expression)) return;
      const receiver = n.expression.expression;
      if (!ts.isCallExpression(receiver) || calleeName(receiver) !== "update") return;
      const table = receiver.arguments[0];
      if (table && ts.isIdentifier(table) && STATUS_TABLES.has(table.text)) found.push({ table: table.text, node: n });
    });
    return found;
  }

  it("every function that updates a Run, Task Instance or Workflow Run status also writes an event", () => {
    const sites: string[] = [];
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const sourceFile = parse(file);
      for (const { table, node } of statusUpdates(sourceFile)) {
        const fn = enclosingNamedFunction(node);
        const key = `${rel(file)}#${fn?.name ?? "<top level>"}`;
        sites.push(key);
        const writesEvent = fn !== null && callsWithin(fn.node).some((c) => EVENT_WRITERS.has(calleeName(c) ?? ""));
        if (!writesEvent && !(key in NO_EVENT_ALLOWLIST)) offenders.push(`${key} (updates ${table}.status)`);
      }
    }

    // The scan must actually find the transitions, or it proves nothing.
    expect(sites.length).toBeGreaterThanOrEqual(8);
    expect(offenders).toEqual([]);
    // A stale allowlist entry hides nothing and should be removed.
    for (const key of Object.keys(NO_EVENT_ALLOWLIST)) expect(sites, `stale allowlist entry ${key}`).toContain(key);
  });
});
