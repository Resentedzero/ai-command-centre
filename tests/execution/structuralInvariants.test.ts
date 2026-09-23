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

/**
 * Whether the node's nearest enclosing function is a callback passed to a call, e.g.
 * `refusalBeforeDispatch(runInTx, async (tx) => dispatchModelCall(...))`: whatever
 * that call is, it may run the callback inside a transaction.
 */
function insideCallback(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) return ts.isCallExpression(current.parent);
    if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) return false;
  }
  return false;
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
        expect(insideCallback(n), `dispatchModelCall inside a callback in ${rel(file)}`).toBe(false);

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
        expect(insideCallback(n), `execute inside a callback in ${rel(file)}`).toBe(false);
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

describe("Definitions, Tool Bindings, Capabilities and Grants are created only through the Registry (spec 3e, 8.2, 9.4)", () => {
  // registryWrites.ts validates each write and emits definition_version_created or
  // capability_granted in the same transaction. An insert anywhere else would create
  // authorization or a Definition the event log never records. The seed uses the
  // Registry too. Tests may insert fixtures directly; this checks src/ only.
  // A tripwire: import aliases, namespace imports and raw INSERT SQL are resolved, but
  // a table bound to a local variable first would pass.
  const TABLES = new Set(["agentDefinitions", "capabilities", "capabilityGrants", "taskDefinitions", "toolBindings", "workflowDefinitions"]);
  const RAW_INSERT = /insert\s+into\s+"?(agent_definitions|capabilities|capability_grants|task_definitions|tool_bindings|workflow_definitions)\b/i;

  function insertsIntoRegistryTables(source: ts.SourceFile): boolean {
    const named = new Map<string, string>();
    const namespaces = new Set<string>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !/db\/schema\.js$/.test(statement.moduleSpecifier.text)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) named.set(element.name.text, (element.propertyName ?? element.name).text);
      }
    }
    let found = false;
    visit(source, (n) => {
      if (ts.isCallExpression(n) && calleeName(n) === "insert" && n.arguments.length === 1) {
        const arg = n.arguments[0]!;
        if (ts.isIdentifier(arg) && TABLES.has(named.get(arg.text) ?? "")) found = true;
        if (ts.isPropertyAccessExpression(arg) && ts.isIdentifier(arg.expression) && namespaces.has(arg.expression.text) && TABLES.has(arg.name.text)) found = true;
      }
      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) && RAW_INSERT.test(n.getText())) found = true;
    });
    return found;
  }

  it("in src/, only definitions/registryWrites.ts inserts into those tables", () => {
    const inserters = sourceFiles()
      .filter((file) => insertsIntoRegistryTables(parse(file)))
      .map(rel);
    expect(inserters).toEqual(["definitions/registryWrites.ts"]);
  });

  it("the check sees through import aliases, namespace imports and raw SQL", () => {
    const probe = (code: string) => insertsIntoRegistryTables(ts.createSourceFile("probe.ts", code, ts.ScriptTarget.Latest, true));
    expect(probe(`import { capabilityGrants as g } from "../db/schema.js"; tx.insert(g);`)).toBe(true);
    expect(probe(`import * as s from "../db/schema.js"; tx.insert(s.capabilityGrants);`)).toBe(true);
    expect(probe("tx.execute(sql`INSERT INTO capability_grants (id) VALUES (1)`);")).toBe(true);
    expect(probe(`import { runs } from "../db/schema.js"; tx.insert(runs);`)).toBe(false);
  });
});

describe("the Manager holds no authority beyond its Capabilities (R2 management layer)", () => {
  // The Manager's code may read the workforce and create Workflow Definitions and Runs through the Registry
  // and Interpreter. It may not reach anything that grants, revokes, approves, budgets, routes, stops, scores
  // or calls a model provider, and it may not write authority or progression tables.
  const FORBIDDEN_IMPORT = /governance\/(budget|policy|approvals|executionStop|performanceEligibility|runBudgetPolicy|dailyBudgetPolicy|autonomyLimits)|router\/|providers\/|projections\/|api\/|world\//;
  const FORBIDDEN_CALL = /\b(createCapabilityGrant|createAgentDefinition|createCapability|createToolBinding|createTaskDefinition|revokeCapabilityGrant|resolveApproval|reserveBudget|reconcileBudget|engageExecutionStop|liftExecutionStop|dispatchModelCall|routeModel)\b/;
  const FORBIDDEN_WRITE = /\.(insert|update|delete)\(\s*(capabilities|capabilityGrants|toolBindings|agentDefinitions|taskDefinitions|approvals|budgetCounters|executionStops|agentXpAwards|agentAchievements|agentDomainWork|agentEndorsements|agentPerformance|agentAppearances|agentRoleIcons|artifacts|events|runs|taskInstances|workflowRuns|workflowDefinitions|invocations|goals)\b/;

  it("capabilities/manager imports no governance, routing, provider, projection, API or world module, and calls or writes none of their authority", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles().filter((f) => rel(f).startsWith("capabilities/manager/"))) {
      const text = readFileSync(file, "utf8");
      visit(parse(file), (n) => {
        if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && FORBIDDEN_IMPORT.test(n.moduleSpecifier.text)) offenders.push(`${rel(file)} imports ${n.moduleSpecifier.text}`);
        if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && FORBIDDEN_IMPORT.test(n.arguments[0].text)) offenders.push(`${rel(file)} dynamically imports ${n.arguments[0].text}`);
      });
      const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      if (FORBIDDEN_CALL.test(code)) offenders.push(`${rel(file)} calls ${code.match(FORBIDDEN_CALL)![0]}`);
      if (FORBIDDEN_WRITE.test(code)) offenders.push(`${rel(file)} writes ${code.match(FORBIDDEN_WRITE)![0]}`);
    }
    expect(offenders).toEqual([]);
    expect(sourceFiles().filter((f) => rel(f).startsWith("capabilities/manager/")).length).toBeGreaterThanOrEqual(3);
  });

  it("the probe catches what it forbids", () => {
    expect(FORBIDDEN_CALL.test("await createCapabilityGrant(tx, body)")).toBe(true);
    expect(FORBIDDEN_WRITE.test("tx.update(capabilityGrants).set({})")).toBe(true);
    // The Manager starts work through the Interpreter and the Registry; it never writes the runtime's own rows.
    expect(FORBIDDEN_WRITE.test("tx.insert(workflowRuns).values({})")).toBe(true);
    expect(FORBIDDEN_WRITE.test("tx.update(runs).set({ status: 'completed' })")).toBe(true);
    expect(FORBIDDEN_IMPORT.test("../../governance/budget.js")).toBe(true);
    expect(FORBIDDEN_CALL.test("createWorkflowDefinition(tx, body)")).toBe(false);
  });
});

describe("core names no capability (spec 18.3)", () => {
  // Capability code and the seed are where capabilities and seeded Definitions
  // are named. Everything else — Interpreter, Executor, governance, routing,
  // context, events, API — must work for any capability, so it may neither
  // import a capability's modules nor name one in code.
  const CAPABILITY_SPECIFIC =
    /research\.retrieve|research\.search|research\.web|research\.open|publish\.report|peer\.endorse|review\.checkpoint|Research-Report|Review-and-Publish|Research-and-Publish|^Researcher$|^Publisher$|^Agent Talk$|^Direct requests$|manager\.inspect_workforce|manager\.delegate|^Manager Plan$|^Manager Review$|^Manager Recovery$|^Meeting Contribution$|^Meeting Outcome$|workplace\.record_outcome|^Missions$|system\.keep_stats|workplace\.inspect_calendar|workplace\.schedule_meeting/;
  const allowed = (file: string) => file.startsWith("capabilities/") || file === "definitions/seed.ts" || file === "definitions/lookupSeed.ts";

  it("outside capability code and the seed, no string literal names a capability or seeded Definition, and no capability module is imported", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (allowed(rel(file))) continue;
      visit(parse(file), (n) => {
        if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
          const target = n.moduleSpecifier.text;
          if (/capabilities\/(researchRetrieve|researchSearch|researchWeb|publishReport)\//.test(target)) offenders.push(`${rel(file)} imports ${target}`);
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
    // R2 Stage 6: the Keeper explains measured performance, read-only; it decides nothing.
    "keeper/explainIntent.ts",
    "keeper/intents.ts", // names it as an intent's authority; reads nothing
    "projections/agentPerformance.ts",
  ];

  // 2026-09-15: the read APIs display each row's eligibility from the gate itself (so no UI
  // compares sampleCount with N), through one display helper that decides nothing.
  const importersOf = (pattern: RegExp) =>
    sourceFiles()
      .filter((file) =>
        parse(file).statements.some(
          (s) =>
            (ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) &&
            s.moduleSpecifier !== undefined &&
            ts.isStringLiteral(s.moduleSpecifier) &&
            pattern.test(s.moduleSpecifier.text)
        )
      )
      .map(rel)
      .sort();

  // 2026-09-15: the Conditional Autonomy rule (§9.4). The Invocation lifecycle resolves a
  // CONDITIONAL Grant's evidence through the gate and hands it to Policy; Policy itself,
  // Approvals and the Executor still never import the gate.
  it("only the Model Router, the Invocation lifecycle (Conditional Autonomy evidence) and the read APIs' display helper import the eligibility gate", () => {
    expect(importersOf(/\/performanceEligibility\.js$/)).toEqual([
      "api/performanceEligibilityFields.ts",
      "execution/invocationLifecycle.ts",
      "router/modelRouter.ts",
    ]);
  });

  it("only the two performance read routes import the eligibility display helper", () => {
    expect(importersOf(/\/performanceEligibilityFields\.js$/)).toEqual(["api/routes/agents.ts", "api/routes/costs.ts"]);
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

describe("agent appearance is presentation only (R2 visual identity)", () => {
  // How an agent looks must never reach what it may do, what it costs, which model serves it,
  // what enters its context or how it is scored. Only its schema, its module, and the read and
  // write routes that show and set it reference the table or the module. A tripwire like the one above.
  it("only the schema, the appearance module and the API routes reference agent appearance", () => {
    const referencing = new Set<string>();
    for (const file of sourceFiles()) {
      const source = parse(file);
      visit(source, (n) => {
        const named =
          (ts.isIdentifier(n) && n.text === "agentAppearances") ||
          ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && /agent_appearances|agentAppearances|\/appearance(Catalogue)?\.js(on)?$/.test(n.text));
        if (named) referencing.add(rel(file));
      });
    }
    expect([...referencing].sort()).toEqual([
      "api/routes/agents.ts",
      "api/routes/appearances.ts",
      "api/routes/keeper.ts", // R2 Stage 6: the Keeper is drawn with its own appearance
      "api/routes/registry.ts",
      "db/schema.ts",
      "definitions/appearance.ts",
    ]);
  });
});

describe("progression is never authority (R2 agent progression)", () => {
  // XP, levels, achievements, specialisation, endorsements and quality verdicts are interpretation and
  // evidence. Only their schema, projector, startup loop and read/verdict routes touch the tables and
  // the verdict event; nothing that authorizes, routes, budgets, executes or compiles context imports
  // any progression module, so progression can neither grant anything nor enter an agent's context.
  it("only the schema, projector, startup loop and progression routes reference progression tables or the verdict event", () => {
    const referencing = new Set<string>();
    for (const file of sourceFiles()) {
      visit(parse(file), (n) => {
        const named =
          (ts.isIdentifier(n) && /^(agentXpAwards|agentAchievements|agentDomainWork|agentEndorsements|refreshAgentProgression)$/.test(n.text)) ||
          ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && /agent_xp_awards|agent_achievements|agent_domain_work|agent_endorsements|quality_verdict_recorded/.test(n.text)) ||
          (ts.isTemplateExpression(n) && /agent_xp_awards|agent_achievements|agent_domain_work|agent_endorsements|quality_verdict_recorded/.test(n.getText()));
        if (named) referencing.add(rel(file));
      });
    }
    // keeper/explainIntent.ts (R2 Stage 6): the Keeper's read-only explanations, run in a READ ONLY transaction.
    expect([...referencing].sort()).toEqual(["api/routes/progression.ts", "api/start.ts", "db/schema.ts", "keeper/explainIntent.ts", "keeper/intents.ts", "projections/agentProgression.ts"]);
  });

  it("governance, the Model Router, execution, workflow and context never import a progression module", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (!/^(governance|router|execution|workflow|context)\//.test(rel(file))) continue;
      for (const s of parse(file).statements) {
        if ((ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) && s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier) &&
          /agentProgression|progressionRules|progressionFacts|peerEndorse|routes\/progression|keeper\/explainIntent|keeper\/intents/.test(s.moduleSpecifier.text)) {
          offenders.push(`${rel(file)} imports ${s.moduleSpecifier.text}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("a role icon is identity, never authority (workplace identity)", () => {
  // Who an agent is pictured as must never reach what it may do, what it costs, which model serves it,
  // what enters its context or how it is scored — and no model may choose one.
  it("only the schema, the role icon module and its API routes reference role icons", () => {
    const referencing = new Set<string>();
    for (const file of sourceFiles()) {
      visit(parse(file), (n) => {
        const named =
          (ts.isIdentifier(n) && /^agentRoleIcons$/.test(n.text)) ||
          ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && /agent_role_icons|roleIconCatalogue\.json|\/roleIcon\.js$/.test(n.text));
        if (named) referencing.add(rel(file));
      });
      for (const st of parse(file).statements) {
        if ((ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) && /roleIcon\.js|routes\/roleIcons/.test(st.moduleSpecifier.text)) {
          referencing.add(rel(file));
        }
      }
    }
    expect([...referencing].sort()).toEqual(["api/routes/roleIcons.ts", "api/server.ts", "db/schema.ts", "definitions/roleIcon.ts"]);
  });

  it("the role icon module reaches no authority, and its catalogue ids are all distinct in shape and colour", () => {
    // Comments say what the module must not do; the code is what is checked.
    const code = readFileSync(sourceFiles().find((f) => rel(f) === "definitions/roleIcon.ts")!, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    for (const forbidden of [/capabilityGrants/, /governance\//, /registryWrites/, /policy/i, /budget/i, /executionStop/, /agentXpAwards/, /router\//]) expect(code).not.toMatch(forbidden);
    const catalogue = JSON.parse(readFileSync(new URL("../../src/definitions/roleIconCatalogue.json", import.meta.url), "utf8")) as { icons: { id: string; colorToken: string; pixels: string[] }[] };
    expect(new Set(catalogue.icons.map((i) => i.id)).size).toBe(catalogue.icons.length);
    expect(new Set(catalogue.icons.map((i) => i.colorToken)).size).toBe(catalogue.icons.length);
    expect(new Set(catalogue.icons.map((i) => i.pixels.join("|"))).size).toBe(catalogue.icons.length);
    // Identity colours are their own tokens: never a runtime state colour.
    const tokens = readFileSync(new URL("../../web/app/tokens.css", import.meta.url), "utf8");
    for (const icon of catalogue.icons) {
      expect(icon.colorToken.startsWith("--role-")).toBe(true);
      expect(tokens).toContain(`${icon.colorToken}:`);
    }
  });
});

describe("the workplace is office records, never authority (workplace)", () => {
  // Calendars, meetings, rooms and notifications are written only by the workplace module (which the operator
  // routes and the Manager's governed capability positions call), and that module can reach no authority:
  // no Registry writer, Grant, Policy, approval, budget, stop, router, provider, projection, world or API code.
  it("only the schema and the workplace module reference the workplace tables", () => {
    const referencing = new Set<string>();
    for (const file of sourceFiles()) {
      visit(parse(file), (n) => {
        const named =
          (ts.isIdentifier(n) && /^workplace(Settings|AgentSettings|Rooms|Meetings|MeetingParticipants|CalendarEvents|Notifications)$/.test(n.text)) ||
          // Raw SQL naming a table (a label such as "workplace_meetings" in an explanation's sources is not access).
          ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) &&
            /(from|join|into|update|table)\s+"?workplace_(settings|agent_settings|rooms|meetings|meeting_participants|calendar_events|notifications)/i.test(n.text));
        if (named) referencing.add(rel(file));
      });
    }
    expect([...referencing].sort()).toEqual(["db/schema.ts", "workplace/workplace.ts"]);
  });

  it("the workplace module imports no authority, routing, provider, projection, world or API code", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles().filter((f) => rel(f).startsWith("workplace/"))) {
      for (const s of parse(file).statements) {
        if ((ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) && s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier) && /governance\/|registryWrites|router\/|providers\/|projections\/|world\/|api\/|capabilities\//.test(s.moduleSpecifier.text)) {
          offenders.push(`${rel(file)} imports ${s.moduleSpecifier.text}`);
        }
      }
      const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      if (/\.(insert|update|delete)\(\s*(capabilities|capabilityGrants|toolBindings|agentDefinitions|taskDefinitions|workflowDefinitions|approvals|budgetCounters|executionStops|runs|goals|workflowRuns|taskInstances|invocations|artifacts|events)\b/.test(code)) offenders.push(`${rel(file)} writes runtime or authority tables`);
    }
    expect(offenders).toEqual([]);
    expect(sourceFiles().filter((f) => rel(f).startsWith("workplace/")).length).toBeGreaterThanOrEqual(3);
  });
});

describe("the workspace is space, never authority (living workplace)", () => {
  // Buildings, areas and workstations say where agents are drawn. Nothing that authorizes, routes,
  // budgets, executes, compiles context, scores or explains authority reads them.
  it("only the schema, the world module and its routes reference the world tables", () => {
    const referencing = new Set<string>();
    for (const file of sourceFiles()) {
      visit(parse(file), (n) => {
        const named =
          (ts.isIdentifier(n) && /^(worldWorkspaces|worldBuildings|worldAreas|worldWorkstations)$/.test(n.text)) ||
          ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && /world_(workspaces|buildings|areas|workstations)/.test(n.text));
        if (named) referencing.add(rel(file));
      });
    }
    expect([...referencing].sort()).toEqual(["db/schema.ts", "world/worldConfig.ts"]);
  });

  it("governance, the Model Router, execution, workflow, context, projections and capabilities never import the world module", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (!/^(governance|router|execution|workflow|context|projections|capabilities|keeper)\//.test(rel(file))) continue;
      for (const s of parse(file).statements) {
        if ((ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) && s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier) && /world\/|routes\/world|routes\/history/.test(s.moduleSpecifier.text)) {
          offenders.push(`${rel(file)} imports ${s.moduleSpecifier.text}`);
        }
      }
    }
    expect(offenders).toEqual([]);
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
  // Goals joined 2026-09-15 (R-GOAL1): a Goal's derived status is recorded as events too.
  const STATUS_TABLES = new Set(["runs", "taskInstances", "workflowRuns", "goals"]);
  const EVENT_WRITERS = new Set(["emitEvent", "emitLifecycleEvent", "recordTaskInstanceTransition", "recordPauseTransition"]);

  /**
   * Transitions that deliberately write no event of their own. Keyed
   * `file#function`; each entry is a known, documented gap, not an oversight.
   * Operator pause/resume left this list 2026-09-15 (R-EV1): they now record
   * `workflow_run_paused` / `workflow_run_resumed`.
   */
  const NO_EVENT_ALLOWLIST: Record<string, string> = {
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
      // `runs` or `schema.runs`.
      const tableName = table && (ts.isIdentifier(table) ? table.text : ts.isPropertyAccessExpression(table) ? table.name.text : null);
      if (tableName && STATUS_TABLES.has(tableName)) found.push({ table: tableName, node: n });
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

  /**
   * R2 Task 42. Usage is an OBSERVATION of a provider response, never a claim anyone else may make.
   * `buildUsageAccounting` is therefore callable only from a provider adapter — the one place that
   * holds a real response. If capability code, the Executor, a projection or an API route could build
   * one, a value that reads as "provider-measured" could be manufactured from model output.
   */
  it("only a provider adapter may build a usage accounting record", () => {
    const callers: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(file, "utf8");
      if (/\bbuildUsageAccounting\b/.test(text) && rel(file) !== "router/usageAccounting.ts") callers.push(rel(file));
    }
    expect(callers.sort()).toEqual(["router/providers/anthropic.ts", "router/providers/claudeSubscription.ts", "router/providers/openai.ts"]);
  });

  /**
   * The counted amount and its unit come from the adapter and are reconciled against a budget. The
   * accounting record explains them and must never become them: nothing outside the Router may read
   * `usageAccounting` back into a cost, a counter or a route.
   */
  it("no governance, projection or routing module reads the usage accounting record", () => {
    const readers: string[] = [];
    for (const file of sourceFiles()) {
      const dir = rel(file).split("/")[0]!;
      if (!["governance", "projections", "workflow", "execution", "context"].includes(dir)) continue;
      if (/\busageAccounting\b/.test(readFileSync(file, "utf8"))) readers.push(rel(file));
    }
    expect(readers).toEqual([]);
  });

  /**
   * R2 Stage 14. A deliverable's `basis` and `completion` are what `carriesRecordedEvidence` and
   * `evidenceBasisFor` treat as code-written truth. `persistDeliverableArtifact` also takes a caller
   * `extra` bag — and one caller (`keeperAnswer`) puts sanitized MODEL OUTPUT in it. If that bag were
   * spread last it could overwrite the very fields the runtime vouches for. No caller collides today,
   * so the property that makes it safe is the spread ORDER, which nothing else would catch.
   */
  it("a deliverable's caller-supplied extras can never overwrite its code-written basis or completion", () => {
    const source = readFileSync(path.join(SRC, "capabilities", "shared", "deliverable.ts"), "utf8");
    const extraSpread = source.indexOf("...(extras.extra ?? {})");
    const basisKey = source.indexOf("basis: extras.basis");
    const completionKey = source.indexOf("...(extras.completion ?");
    const formatKey = source.indexOf("format: DELIVERABLE_FORMAT");
    expect(extraSpread, "the extras.extra spread should still exist").toBeGreaterThan(-1);
    expect(basisKey, "the code-written basis should still exist").toBeGreaterThan(-1);
    for (const [name, at] of [["format", formatKey], ["completion", completionKey], ["basis", basisKey]] as const) {
      expect(at, `${name} must be written AFTER the extras.extra spread, or a caller could overwrite it`).toBeGreaterThan(extraSpread);
    }
  });
});
