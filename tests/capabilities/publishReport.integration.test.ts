/**
 * Unit 9 integration test — "the single most important integration test in
 * the entire MVP" (task-9-brief.md): proves the full governance chain
 * (Grant -> Policy -> Approval -> re-authorization -> execution) end to end,
 * plus pause/resume, inside a real 2-step Workflow Run driven by Unit 7's
 * Workflow Interpreter (`startWorkflowRun`/`advanceWorkflowRun`/
 * `pauseWorkflowRun`/`resumeWorkflowRun`) — unlike Unit 8's standalone Task
 * Instance test, this workflow IS workflow-created.
 *
 * Provider mocking (same convention as Unit 8's own integration test): only
 * the provider-call layer (`callAnthropicModel`/`callOpenAiModel`) is
 * mocked. `authorizeRoute`, `callModel`, `compileContext`, `reserveBudget`,
 * `evaluatePolicy`, `createApproval`, `reauthorize`, and `executeRun` all run
 * for real against the real test database — nothing about the orchestration
 * itself is faked.
 *
 * Filesystem hygiene (Ruling 6, "your call, document it"): BOTH mitigations
 * are used, not just one. `.artifacts/` is added to the repo's `.gitignore`
 * (defense against accidental commits), AND every file this suite actually
 * writes to disk is tracked in `PUBLISHED_FILES` and removed in `afterEach`
 * — required because `withRollback` only rolls back the DATABASE
 * transaction; a real `writeFile` to `ARTIFACT_ROOT/published/...` is a
 * filesystem side effect with no transactional undo.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { resetTestSchema, closeTestDb, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";

// ---------------------------------------------------------------------------
// Mock BOTH provider wrapper modules — same pattern as Unit 8's own
// integration test (no ANTHROPIC_API_KEY/OPENAI_API_KEY set, by design).
// ---------------------------------------------------------------------------
vi.mock("../../src/router/providers/anthropic.js", () => ({
  callAnthropicModel: vi.fn(),
}));
vi.mock("../../src/router/providers/openai.js", () => ({
  callOpenAiModel: vi.fn(),
}));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({
  // MANDATORY since Phase 7F made Claude Max the routed default: without this
  // mock these tests would dispatch to the REAL adapter, spawn the Claude CLI,
  // and consume subscription entitlement on every `npm test`.
  callClaudeSubscriptionModel: vi.fn(),
}));

import {
  startWorkflowRun,
  pauseWorkflowRun,
  resumeWorkflowRun,
  type InvocationSpecBuilder,
} from "../../src/workflow/interpreter.js";
// Phase 9: advanceWorkflowRun yields at each LLM Invocation; this drives it to
// the next real boundary exactly as the production driver does.
import { advanceWorkflowRunToBoundary as advanceWorkflowRun } from "../helpers/driveToBoundary.js";
import { createHash as sha256Hash } from "node:crypto";
import { seedPublishWorkflow, DEFAULT_RESEARCH_REPORT_CONTEXT_BUDGET } from "../../src/definitions/seed.js";
import { buildResearchReportInvocationSpecs } from "../../src/capabilities/researchRetrieve/buildInvocationSpecs.js";
import { buildPublishReportInvocationSpecs } from "../../src/capabilities/publishReport/buildInvocationSpecs.js";
import { PUBLISH_REPORT_CAPABILITY } from "../../src/capabilities/publishReport/capability.js";
import { publishReport } from "../../src/capabilities/publishReport/toolBinding.js";
import * as toolBindingModule from "../../src/capabilities/publishReport/toolBinding.js";
import { validateCapabilityGrant } from "../../src/governance/policy.js";
import type { CapabilityGrant, CapabilityPermission } from "../../src/governance/policy.js";
import { resolveApproval, reauthorize } from "../../src/governance/approvals.js";
import * as approvalsModule from "../../src/governance/approvals.js";
import * as policyModule from "../../src/governance/policy.js";
import * as budgetModule from "../../src/governance/budget.js";
import * as invocationLifecycleModule from "../../src/execution/invocationLifecycle.js";
import { callClaudeSubscriptionModel } from "../../src/router/providers/claudeSubscription.js";
import { callOpenAiModel } from "../../src/router/providers/openai.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

const PUBLISHED_FILES: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const filePath of PUBLISHED_FILES.splice(0)) {
    try {
      rmSync(filePath, { force: true });
    } catch {
      // best-effort cleanup only
    }
  }
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

type Seed = Awaited<ReturnType<typeof seedPublishWorkflow>>;
type PublishSnapshot = { artifactId: string; destinationRelativePath: string };

function mockLlmOnce(reportText: string): void {
  vi.mocked(callClaudeSubscriptionModel).mockResolvedValueOnce({
    result: { report: reportText },
    usage: { tokensIn: 100, tokensOut: 50, costAmount: 150, costUnit: "subscription_tokens" },
  });
}

/**
 * The single combined `InvocationSpecBuilder` `advanceWorkflowRun` needs —
 * dispatches by `taskDefinitionId` to whichever real per-Task builder
 * applies, exactly the composition pattern `interpreter.test.ts`'s own
 * `makeApprovalGatedBuilder` demonstrates (a per-workflow closure, not a
 * third `src/`-level module — nothing in the brief asks for a standalone
 * dispatcher, and Unit 7's own test keeps this exact kind of glue local to
 * the caller).
 *
 * `destinationRelativePath` accepts either a plain string (the common case —
 * every call rebuilds the identical value, satisfying Ruling 3's determinism
 * requirement) OR a zero-arg function, resolved FRESH on every invocation of
 * the returned builder. The function form is a test-local knob (fix round 1,
 * independent review): it lets a test flip what the RESUMING call's builder
 * produces, independently of what the ORIGINAL creating call produced —
 * needed to construct a scenario where `executor.ts`'s resume-time
 * spec-vs-stored pre-check (which would otherwise fire first and mask
 * `reauthorize`'s own material-change check — see "Material-change
 * invalidation" below) is made to PASS on purpose, so `reauthorize` itself is
 * the guard exercised end-to-end.
 */
function buildCombinedBuilder(
  tx: DrizzleTransaction,
  seed: Seed,
  destinationRelativePath: string | (() => string),
  calls?: string[]
): InvocationSpecBuilder {
  return async (params) => {
    calls?.push(params.taskDefinitionId);
    if (params.taskDefinitionId === seed.taskDefinitionId) {
      return buildResearchReportInvocationSpecs(
        tx,
        {
          agentDefinitionId: seed.agentDefinitionId,
          agentDefinitionVersion: seed.agentDefinitionVersion,
          capabilityId: seed.capabilityId,
          toolBindingId: seed.toolBindingId,
          query: "unit 9 capstone integration query",
          contextBudget: DEFAULT_RESEARCH_REPORT_CONTEXT_BUDGET,
        },
        params
      );
    }
    if (params.taskDefinitionId === seed.reviewAndPublishTaskDefinitionId) {
      return buildPublishReportInvocationSpecs(
        tx,
        {
          agentDefinitionId: seed.publisherAgentDefinitionId,
          agentDefinitionVersion: seed.publisherAgentDefinitionVersion,
          capabilityId: seed.publishCapabilityId,
          toolBindingId: seed.publishToolBindingId,
          researchReportTaskDefinitionId: seed.taskDefinitionId,
          destinationRelativePath: typeof destinationRelativePath === "function" ? destinationRelativePath() : destinationRelativePath,
        },
        params
      );
    }
    throw new Error(`buildCombinedBuilder: unexpected taskDefinitionId "${params.taskDefinitionId}"`);
  };
}

/** Reads back Task A's and Task B's current DB state for a workflow run — used across many tests below. */
async function getWorkflowState(tx: DrizzleTransaction, seed: Seed, workflowRunId: string) {
  const taskAInstance = await tx.query.taskInstances.findFirst({
    where: and(eq(schema.taskInstances.workflowRunId, workflowRunId), eq(schema.taskInstances.taskDefinitionId, seed.taskDefinitionId)),
  });
  const taskARun = taskAInstance
    ? await tx.query.runs.findFirst({ where: eq(schema.runs.taskInstanceId, taskAInstance.id) })
    : undefined;

  let reportArtifactId: string | undefined;
  if (taskARun) {
    const rows = await tx
      .select({ id: schema.artifacts.id })
      .from(schema.artifacts)
      .innerJoin(schema.invocations, eq(schema.artifacts.producingInvocationId, schema.invocations.id))
      .where(and(eq(schema.invocations.runId, taskARun.id), eq(schema.artifacts.type, "report")));
    reportArtifactId = rows[0]?.id;
  }

  const taskBInstance = await tx.query.taskInstances.findFirst({
    where: and(
      eq(schema.taskInstances.workflowRunId, workflowRunId),
      eq(schema.taskInstances.taskDefinitionId, seed.reviewAndPublishTaskDefinitionId)
    ),
  });
  const taskBRun = taskBInstance
    ? await tx.query.runs.findFirst({ where: eq(schema.runs.taskInstanceId, taskBInstance.id) })
    : undefined;
  const invocation = taskBRun ? await tx.query.invocations.findFirst({ where: eq(schema.invocations.runId, taskBRun.id) }) : undefined;
  const approval = invocation ? await tx.query.approvals.findFirst({ where: eq(schema.approvals.invocationId, invocation.id) }) : undefined;

  return { taskAInstance, taskARun, reportArtifactId, taskBInstance, taskBRun, invocation, approval };
}

/** Drives the workflow from nothing through Task A's completion and Task B's creation (halting at awaiting_approval, per its ALWAYS_APPROVE Grant). */
async function driveToTaskBAwaitingApproval(
  tx: DrizzleTransaction,
  seed: Seed,
  destinationRelativePath: string | (() => string),
  reportText: string,
  calls?: string[]
): Promise<{ workflowRunId: string; builder: InvocationSpecBuilder }> {
  const builder = buildCombinedBuilder(tx, seed, destinationRelativePath, calls);
  const { workflowRunId } = await startWorkflowRun(tx, seed.workflowDefinitionId, seed.goalId);

  mockLlmOnce(reportText);
  await advanceWorkflowRun(tx, workflowRunId, builder); // Task A: tool -> artifact -> llm -> report artifact
  await advanceWorkflowRun(tx, workflowRunId, builder); // Task B created, halts at awaiting_approval

  return { workflowRunId, builder };
}

function publishedPathFor(destinationRelativePath: string): string {
  return path.resolve(process.env.ARTIFACT_ROOT!, "published", destinationRelativePath);
}

// ---------------------------------------------------------------------------
// 1. seedPublishWorkflow
// ---------------------------------------------------------------------------

describe("seedPublishWorkflow", () => {
  it("creates the publish.report Capability/ToolBinding/Publisher Agent/Grant/Task Definition/Workflow Definition rows, and reuses Unit 8's Research-Report Task Definition as step 0", async () => {
    await withRollback(async (tx) => {
      const seed = await seedPublishWorkflow(tx);

      const capability = await tx.query.capabilities.findFirst({ where: eq(schema.capabilities.id, seed.publishCapabilityId) });
      expect(capability?.name).toBe(PUBLISH_REPORT_CAPABILITY.id);
      expect(capability?.staticRiskTag).toBe("highest");
      expect(capability?.costProfile).toEqual({ costClass: "external_side_effect" });

      const toolBinding = await tx.query.toolBindings.findFirst({ where: eq(schema.toolBindings.id, seed.publishToolBindingId) });
      expect(toolBinding?.capabilityId).toBe(seed.publishCapabilityId);

      const agent = await tx.query.agentDefinitions.findFirst({ where: eq(schema.agentDefinitions.id, seed.publisherAgentDefinitionId) });
      expect(agent?.name).toBe("Publisher");

      const grant = await tx.query.capabilityGrants.findFirst({ where: eq(schema.capabilityGrants.id, seed.publishCapabilityGrantId) });
      expect(grant?.permissions).toEqual(["PUBLISH"]);
      expect(grant?.autonomyState).toBe("ALWAYS_APPROVE");
      expect(grant?.revokedAt).toBeNull();

      const taskDefinition = await tx.query.taskDefinitions.findFirst({ where: eq(schema.taskDefinitions.id, seed.reviewAndPublishTaskDefinitionId) });
      expect(taskDefinition?.name).toBe("Review-and-Publish");

      const workflowDefinition = await tx.query.workflowDefinitions.findFirst({ where: eq(schema.workflowDefinitions.id, seed.workflowDefinitionId) });
      expect(workflowDefinition?.graphDefinition).toEqual({
        kind: "linear",
        steps: [
          { taskDefinitionId: seed.taskDefinitionId, taskDefinitionVersion: seed.taskDefinitionVersion },
          { taskDefinitionId: seed.reviewAndPublishTaskDefinitionId, taskDefinitionVersion: seed.reviewAndPublishTaskDefinitionVersion },
        ],
      });

      // Reuse, not a parallel copy: step 0 references the EXACT same
      // Research-Report Task Definition id seedResearchWorkflow produced.
      const researchTaskDefinitionRows = await tx.query.taskDefinitions.findMany({ where: eq(schema.taskDefinitions.name, "Research-Report") });
      expect(researchTaskDefinitionRows).toHaveLength(1);
    });
  });

  it("validateCapabilityGrant accepts the seeded PUBLISH+ALWAYS_APPROVE Grant, and rejects a hypothetical PUBLISH+AUTONOMOUS Grant (Ruling 7, both directions)", async () => {
    await withRollback(async (tx) => {
      const seed = await seedPublishWorkflow(tx);
      const grantRow = await tx.query.capabilityGrants.findFirst({ where: eq(schema.capabilityGrants.id, seed.publishCapabilityGrantId) });
      const grant: CapabilityGrant = {
        agentDefinitionId: grantRow!.agentDefinitionId,
        agentDefinitionVersion: grantRow!.agentDefinitionVersion,
        capabilityId: grantRow!.capabilityId,
        permissions: grantRow!.permissions as CapabilityPermission[],
        maxTrustLevelRequired: grantRow!.maxTrustLevelRequired,
        autonomyState: grantRow!.autonomyState as CapabilityGrant["autonomyState"],
      };
      expect(validateCapabilityGrant(grant)).toEqual({ valid: true });

      const hypotheticalAutonomous: CapabilityGrant = { ...grant, autonomyState: "AUTONOMOUS" };
      const result = validateCapabilityGrant(hypotheticalAutonomous);
      expect(result.valid).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Task A -> Task B artifact hand-off BY REFERENCE (Ruling 5)
// ---------------------------------------------------------------------------

describe("Task A -> Task B artifact hand-off (by reference)", () => {
  it("Task A completes and produces a report Artifact; Task B's proposedActionSnapshot references it by id, never duplicating its content", async () => {
    await withRollback(async (tx) => {
      const seed = await seedPublishWorkflow(tx);
      const destinationRelativePath = "hand-off/report.json";
      const builder = buildCombinedBuilder(tx, seed, destinationRelativePath);
      const { workflowRunId } = await startWorkflowRun(tx, seed.workflowDefinitionId, seed.goalId);

      mockLlmOnce("Hand-off test report content, long enough to prove it is not duplicated inline.");
      const afterTaskA = await advanceWorkflowRun(tx, workflowRunId, builder);
      expect(afterTaskA).toEqual({ status: "in_progress" });

      const midState = await getWorkflowState(tx, seed, workflowRunId);
      expect(midState.taskAInstance?.status).toBe("completed");
      expect(midState.reportArtifactId).toBeDefined();
      const reportArtifactRow = await tx.query.artifacts.findFirst({ where: eq(schema.artifacts.id, midState.reportArtifactId!) });

      const afterTaskBCreate = await advanceWorkflowRun(tx, workflowRunId, builder);
      expect(afterTaskBCreate).toEqual({ status: "in_progress" }); // REQUIRE_APPROVAL halts it

      const finalState = await getWorkflowState(tx, seed, workflowRunId);
      const snapshot = finalState.invocation!.proposedActionSnapshot as PublishSnapshot;
      expect(snapshot.artifactId).toBe(midState.reportArtifactId); // BY REFERENCE, same id
      expect(snapshot.destinationRelativePath).toBe(destinationRelativePath);
      // Never duplicated inline: the snapshot is exactly {artifactId, artifactHash,
      // destinationRelativePath}. The hash pins WHICH content was approved without
      // carrying the content itself — it is the report's own sha256 digest.
      expect(Object.keys(snapshot).sort()).toEqual(["artifactHash", "artifactId", "destinationRelativePath"]);
      expect((snapshot as Record<string, unknown>).artifactHash).toBe(reportArtifactRow!.hash);
      expect(JSON.stringify(snapshot)).not.toContain(reportArtifactRow!.inlineContent!);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Policy order-of-operations: REQUIRE_APPROVAL reached before any budget check
// ---------------------------------------------------------------------------

describe("Task B Policy order-of-operations (per Unit 6)", () => {
  it("evaluatePolicy returns REQUIRE_APPROVAL (ALWAYS_APPROVE Grant), reached strictly before reserveBudget is ever called", async () => {
    await withRollback(async (tx) => {
      const seed = await seedPublishWorkflow(tx);
      const destinationRelativePath = "order/report.json";
      const builder = buildCombinedBuilder(tx, seed, destinationRelativePath);
      const { workflowRunId } = await startWorkflowRun(tx, seed.workflowDefinitionId, seed.goalId);

      mockLlmOnce("order-of-operations report");
      await advanceWorkflowRun(tx, workflowRunId, builder); // Task A only — spies installed AFTER this, so its own reserveBudget calls never pollute callOrder below.

      const callOrder: string[] = [];
      const originalResolveGrant = invocationLifecycleModule.resolveCapabilityGrant;
      const originalResolveTrust = invocationLifecycleModule.resolveToolBindingTrustLevel;
      const originalEvaluatePolicy = policyModule.evaluatePolicy;
      const originalReserveBudget = budgetModule.reserveBudget;
      const originalCreateApproval = approvalsModule.createApproval;

      const grantSpy = vi
        .spyOn(invocationLifecycleModule, "resolveCapabilityGrant")
        .mockImplementation(async (...args: Parameters<typeof originalResolveGrant>) => {
          callOrder.push("grant");
          return originalResolveGrant(...args);
        });
      const trustSpy = vi
        .spyOn(invocationLifecycleModule, "resolveToolBindingTrustLevel")
        .mockImplementation(async (...args: Parameters<typeof originalResolveTrust>) => {
          callOrder.push("trust");
          return originalResolveTrust(...args);
        });
      const policySpy = vi
        .spyOn(policyModule, "evaluatePolicy")
        .mockImplementation(async (...args: Parameters<typeof originalEvaluatePolicy>) => {
          const result = await originalEvaluatePolicy(...args);
          callOrder.push(`policy:${result.decision}`);
          return result;
        });
      const budgetSpy = vi
        .spyOn(budgetModule, "reserveBudget")
        .mockImplementation(async (...args: Parameters<typeof originalReserveBudget>) => {
          callOrder.push("budget");
          return originalReserveBudget(...args);
        });
      const approvalSpy = vi
        .spyOn(approvalsModule, "createApproval")
        .mockImplementation(async (...args: Parameters<typeof originalCreateApproval>) => {
          callOrder.push("approval");
          return originalCreateApproval(...args);
        });

      try {
        const outcome = await advanceWorkflowRun(tx, workflowRunId, builder); // creates + halts Task B
        expect(outcome).toEqual({ status: "in_progress" });
      } finally {
        grantSpy.mockRestore();
        trustSpy.mockRestore();
        policySpy.mockRestore();
        budgetSpy.mockRestore();
        approvalSpy.mockRestore();
      }

      expect(callOrder).toEqual(["grant", "trust", "policy:REQUIRE_APPROVAL", "budget", "approval"]);

      // The literal, load-bearing assertion the brief asks for.
      const policyIndex = callOrder.indexOf("policy:REQUIRE_APPROVAL");
      const budgetIndex = callOrder.indexOf("budget");
      expect(policyIndex).toBeGreaterThanOrEqual(0);
      expect(budgetIndex).toBeGreaterThan(policyIndex);
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Approval created with the exact snapshot
// ---------------------------------------------------------------------------

describe("Approval creation carries the exact snapshot", () => {
  it("creates an approvals row whose proposedActionSnapshot is exactly {artifactId, destinationRelativePath}", async () => {
    await withRollback(async (tx) => {
      const seed = await seedPublishWorkflow(tx);
      const destinationRelativePath = "snapshot/report.json";
      const { workflowRunId } = await driveToTaskBAwaitingApproval(tx, seed, destinationRelativePath, "snapshot test report");

      const { invocation, approval, reportArtifactId } = await getWorkflowState(tx, seed, workflowRunId);
      expect(approval?.status).toBe("pending");
      // The Approval pins the report's content hash, so it is for these exact bytes.
      const report = await tx.query.artifacts.findFirst({ where: eq(schema.artifacts.id, reportArtifactId!) });
      expect(approval?.proposedActionSnapshot).toEqual({
        artifactId: reportArtifactId,
        artifactHash: report!.hash,
        destinationRelativePath,
      });
      expect(invocation?.proposedActionSnapshot).toEqual(approval?.proposedActionSnapshot);
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Material-change invalidation, end-to-end
// ---------------------------------------------------------------------------

describe("Material-change invalidation, end-to-end", () => {
  it("[guard: resume_spec_mismatch] mutating the invocation's proposedActionSnapshot after Approval creation makes reauthorize return false, and blocks the resumed execution", async () => {
    const publishSpy = vi.spyOn(toolBindingModule, "publishReport");
    try {
      await withRollback(async (tx) => {
        const seed = await seedPublishWorkflow(tx);
        const destinationRelativePath = "material-change/report.json";
        const { workflowRunId, builder } = await driveToTaskBAwaitingApproval(tx, seed, destinationRelativePath, "material-change report");

        const { invocation, approval } = await getWorkflowState(tx, seed, workflowRunId);
        expect(approval?.status).toBe("pending");
        await resolveApproval(tx, approval!.id, "approved", "reviewer");

        // Simulate post-approval tampering with the invocation's MUTABLE
        // proposed action (same convention as
        // tests/governance/approvals.test.ts's own "Material-change
        // invalidation" test).
        const original = invocation!.proposedActionSnapshot as PublishSnapshot;
        await tx
          .update(schema.invocations)
          .set({ proposedActionSnapshot: { artifactId: original.artifactId, destinationRelativePath: "material-change/TAMPERED.json" } })
          .where(eq(schema.invocations.id, invocation!.id));

        // Unit-level proof: reauthorize itself detects the mismatch against
        // the Approval's FROZEN snapshot.
        const reauthorized = await reauthorize(tx, invocation!.id);
        expect(reauthorized).toBe(false);

        // End-to-end proof: resuming the workflow blocks execution.
        // DOCUMENTED (per design review): executor.ts's resumeToolSpec
        // validates the RESUMING spec against the STORED invocation BEFORE
        // ever calling reauthorize ("resume_spec_mismatch", executor.ts).
        // Since Task B's builder deterministically reconstructs the
        // ORIGINAL (untampered) snapshot on this resume call, THAT guard
        // fires here — not reauthorize's own "reauthorization_failed" path.
        // Both guards exist for the identical threat (post-approval
        // tampering); this assertion proves the chain is blocked end-to-end
        // and names precisely which guard fired, rather than assuming it.
        const outcome = await advanceWorkflowRun(tx, workflowRunId, builder);
        expect(outcome).toEqual({ status: "failed" });

        const { taskBInstance } = await getWorkflowState(tx, seed, workflowRunId);
        expect(taskBInstance?.status).toBe("failed");

        const failedEvent = await tx.query.events.findFirst({
          where: and(eq(schema.events.invocationId, invocation!.id), eq(schema.events.eventType, "invocation_failed")),
        });
        expect(failedEvent?.payload).toMatchObject({ reason: "resume_spec_mismatch" });

        expect(publishSpy).not.toHaveBeenCalled();
      });
    } finally {
      publishSpy.mockRestore();
    }
  });

  // Fix round 1 (independent review, "Important" finding): the test above
  // proves the CHAIN is blocked end-to-end, but never actually reaches
  // `reauthorize` — executor.ts's own spec-vs-stored pre-check
  // ("resume_spec_mismatch") fires first and masks it, because the builder
  // deterministically REBUILDS the original (untampered) snapshot on resume,
  // so the resuming spec never matches the tampered stored value in the
  // first place. `reauthorize`'s own material-change comparison (the
  // specific mechanism Phase 9.5 exists for) was therefore only proven at
  // the unit level (the direct `reauthorize(...)` call above), never through
  // the real executor end-to-end.
  //
  // This test closes that gap by tampering BOTH sides consistently: the
  // STORED invocation snapshot is mutated to a new `destinationRelativePath`
  // (simulating tampering), AND the builder's own `destinationRelativePath`
  // knob (the `() => string` form `buildCombinedBuilder` accepts — see its
  // header) is flipped to that SAME new value before the resuming
  // `advanceWorkflowRun` call. So the resuming spec now DOES match what's
  // stored (`executor.ts`'s pre-check passes, unlike the test above) — the
  // only remaining check standing between approval and execution is
  // `reauthorize`'s own comparison against the Approval's ORIGINAL frozen
  // snapshot, which still differs. That is the guard this test proves fires.
  it("[guard: reauthorization_failed] tampering the stored snapshot AND the resuming spec identically (but differently from the Approval's frozen snapshot) forces reauthorize itself to block execution", async () => {
    const publishSpy = vi.spyOn(toolBindingModule, "publishReport");
    try {
      await withRollback(async (tx) => {
        const seed = await seedPublishWorkflow(tx);
        const originalDestination = "reauth-guard/original.json";
        const tamperedDestination = "reauth-guard/tampered.json";
        let currentDestination = originalDestination; // the test-local knob buildCombinedBuilder's header describes

        const { workflowRunId, builder } = await driveToTaskBAwaitingApproval(
          tx,
          seed,
          () => currentDestination,
          "reauthorize-guard report"
        );

        const { invocation, approval } = await getWorkflowState(tx, seed, workflowRunId);
        expect(approval?.status).toBe("pending");
        expect(approval?.proposedActionSnapshot).toMatchObject({ destinationRelativePath: originalDestination });
        await resolveApproval(tx, approval!.id, "approved", "reviewer");

        // Tamper the STORED invocation snapshot to the NEW (tampered) value...
        // Only the destination changes: the id and the pinned content hash are
        // kept, so the stored snapshot still equals what the builder rebuilds
        // below and the spec-vs-stored pre-check passes — leaving reauthorize's
        // comparison against the Approval's frozen snapshot as the guard that fires.
        const original = invocation!.proposedActionSnapshot as PublishSnapshot;
        await tx
          .update(schema.invocations)
          .set({
            proposedActionSnapshot: {
              artifactId: original.artifactId,
              artifactHash: (original as Record<string, unknown>).artifactHash,
              destinationRelativePath: tamperedDestination,
            },
          })
          .where(eq(schema.invocations.id, invocation!.id));

        // ...and flip the builder's own knob to that SAME tampered value, so
        // the RESUMING call's rebuilt spec matches what is now stored
        // (passing executor.ts's spec-vs-stored pre-check on purpose).
        currentDestination = tamperedDestination;

        const outcome = await advanceWorkflowRun(tx, workflowRunId, builder);
        expect(outcome).toEqual({ status: "failed" });

        const { taskBInstance } = await getWorkflowState(tx, seed, workflowRunId);
        expect(taskBInstance?.status).toBe("failed");

        // The distinguishing assertion: THIS guard is "reauthorization_failed",
        // not "resume_spec_mismatch" — proving reauthorize's own
        // material-change comparison (Phase 9.5) is what actually fired.
        const failedEvent = await tx.query.events.findFirst({
          where: and(eq(schema.events.invocationId, invocation!.id), eq(schema.events.eventType, "invocation_failed")),
        });
        expect(failedEvent?.payload).toMatchObject({ reason: "reauthorization_failed" });

        expect(publishSpy).not.toHaveBeenCalled();

        const finalWorkflowRun = await tx.query.workflowRuns.findFirst({ where: eq(schema.workflowRuns.id, workflowRunId) });
        expect(finalWorkflowRun?.status).toBe("failed");
      });
    } finally {
      publishSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Full chain integration test — every named step, in order
// ---------------------------------------------------------------------------

describe("Full governance chain integration", () => {
  it("Grant -> Tool Binding -> Policy=REQUIRE_APPROVAL -> Approval(exact snapshot) -> resolve(approved) -> fresh reauthorize + fresh reserveBudget (independent) -> publishReport executes -> outcome Events recorded", async () => {
    const publishSpy = vi.spyOn(toolBindingModule, "publishReport");
    try {
      await withRollback(async (tx) => {
        const seed = await seedPublishWorkflow(tx);
        const destinationRelativePath = "full-chain/report.json";
        const { workflowRunId, builder } = await driveToTaskBAwaitingApproval(
          tx,
          seed,
          destinationRelativePath,
          "full chain report content"
        );

        // Steps 1-4: Grant/Tool Binding resolved, Policy = REQUIRE_APPROVAL, Approval created with the exact snapshot.
        const initial = await getWorkflowState(tx, seed, workflowRunId);
        expect(initial.invocation?.capabilityId).toBe(seed.publishCapabilityId);
        expect(initial.invocation?.permission).toBe("PUBLISH");
        expect(initial.invocation?.status).toBe("awaiting_approval");
        expect(initial.approval?.status).toBe("pending");
        const initialReport = await tx.query.artifacts.findFirst({
          where: eq(schema.artifacts.id, initial.reportArtifactId!),
        });
        expect(initial.approval?.proposedActionSnapshot).toEqual({
          artifactId: initial.reportArtifactId,
          artifactHash: initialReport!.hash,
          destinationRelativePath,
        });
        expect(initial.approval?.riskTier).toBe("highest"); // staticRiskTag "highest" floors it; no escalators fire.

        // Step 5: resolveApproval("approved").
        await resolveApproval(tx, initial.approval!.id, "approved", "reviewer");

        // Steps 6-7: fresh reauthorize + fresh reserveBudget, both
        // independently (Ruling per Unit 6 step 9) -> publishReport executes.
        const originalReauthorize = approvalsModule.reauthorize;
        const originalReserveBudget = budgetModule.reserveBudget;
        const callOrder: string[] = [];
        const reauthSpy = vi
          .spyOn(approvalsModule, "reauthorize")
          .mockImplementation(async (...args: Parameters<typeof originalReauthorize>) => {
            const result = await originalReauthorize(...args);
            callOrder.push(`reauthorize:${result}`);
            return result;
          });
        const budgetSpy = vi
          .spyOn(budgetModule, "reserveBudget")
          .mockImplementation(async (...args: Parameters<typeof originalReserveBudget>) => {
            const result = await originalReserveBudget(...args);
            callOrder.push(`reserveBudget:${result.authorized}`);
            return result;
          });

        let outcome;
        try {
          outcome = await advanceWorkflowRun(tx, workflowRunId, builder);
        } finally {
          reauthSpy.mockRestore();
          budgetSpy.mockRestore();
        }

        expect(outcome).toEqual({ status: "completed" });
        // Independent, in this order: reauthorize succeeds, THEN a fresh
        // reserveBudget is made — not reused from the original hold.
        expect(callOrder).toEqual(["reauthorize:true", "reserveBudget:true"]);

        expect(publishSpy).toHaveBeenCalledTimes(1);
        // Called with the hash pinned in the Approval — the content it was approved for.
        expect(publishSpy).toHaveBeenCalledWith(tx, initial.reportArtifactId, destinationRelativePath, initialReport!.hash);

        // The real side effect actually happened.
        const publishedPath = publishedPathFor(destinationRelativePath);
        PUBLISHED_FILES.push(publishedPath);
        expect(existsSync(publishedPath)).toBe(true);
        const written = readFileSync(publishedPath, "utf8");
        const reportArtifactRow = await tx.query.artifacts.findFirst({ where: eq(schema.artifacts.id, initial.reportArtifactId!) });
        expect(written).toBe(reportArtifactRow!.inlineContent);

        // Step 8: outcome Events recorded.
        const finalState = await getWorkflowState(tx, seed, workflowRunId);
        expect(finalState.invocation?.status).toBe("completed");
        expect(finalState.taskBInstance?.status).toBe("completed");
        const completedEvent = await tx.query.events.findFirst({
          where: and(eq(schema.events.invocationId, initial.invocation!.id), eq(schema.events.eventType, "invocation_completed")),
        });
        expect(completedEvent).toBeDefined();

        const finalWorkflowRun = await tx.query.workflowRuns.findFirst({ where: eq(schema.workflowRuns.id, workflowRunId) });
        expect(finalWorkflowRun?.status).toBe("completed");

        // Task A's llm step used the mocked Anthropic provider exactly once;
        // the OpenAI provider (tierConfig never routes here) was never touched.
        expect(callClaudeSubscriptionModel).toHaveBeenCalledTimes(1);
        expect(callOpenAiModel).not.toHaveBeenCalled();

        // Nothing leaked in Task B's own budget counter.
        const finalCounter = await tx.query.budgetCounters.findFirst({
        where: and(
          eq(schema.budgetCounters.scopeRefId, finalState.taskBRun!.id),
          eq(schema.budgetCounters.resourceUnit, "usd")
        ),
      });
        expect(Number(finalCounter!.reservedAmount)).toBeCloseTo(0, 10);
        expect(Number(finalCounter!.consumedAmount)).toBeCloseTo(0.05, 10);
      });
    } finally {
      publishSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Rejected Approval
// ---------------------------------------------------------------------------

describe("Rejected Approval", () => {
  it("resolveApproval('rejected') results in the Task Instance reaching failed; publishReport is never called", async () => {
    const publishSpy = vi.spyOn(toolBindingModule, "publishReport");
    try {
      await withRollback(async (tx) => {
        const seed = await seedPublishWorkflow(tx);
        const destinationRelativePath = "rejected/report.json";
        const { workflowRunId, builder } = await driveToTaskBAwaitingApproval(tx, seed, destinationRelativePath, "rejected report");

        const { invocation, approval } = await getWorkflowState(tx, seed, workflowRunId);
        await resolveApproval(tx, approval!.id, "rejected", "reviewer");

        const outcome = await advanceWorkflowRun(tx, workflowRunId, builder);
        expect(outcome).toEqual({ status: "failed" });

        const { taskBInstance } = await getWorkflowState(tx, seed, workflowRunId);
        expect(taskBInstance?.status).toBe("failed");

        const finalInvocation = await tx.query.invocations.findFirst({ where: eq(schema.invocations.id, invocation!.id) });
        expect(finalInvocation?.status).toBe("failed");
        const failedEvent = await tx.query.events.findFirst({
          where: and(eq(schema.events.invocationId, invocation!.id), eq(schema.events.eventType, "invocation_failed")),
        });
        expect(failedEvent?.payload).toMatchObject({ reason: "approval_rejected" });

        expect(publishSpy).not.toHaveBeenCalled();

        const finalWorkflowRun = await tx.query.workflowRuns.findFirst({ where: eq(schema.workflowRuns.id, workflowRunId) });
        expect(finalWorkflowRun?.status).toBe("failed");
      });
    } finally {
      publishSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Pause/resume scenario A — between Task A completion and Task B start
// ---------------------------------------------------------------------------

describe("Pause/resume scenario A (between Task A completion and Task B start)", () => {
  it("pausing after Task A completes prevents Task B's builder from ever being invoked until resumed", async () => {
    await withRollback(async (tx) => {
      const seed = await seedPublishWorkflow(tx);
      const destinationRelativePath = "pause-a/report.json";
      const calls: string[] = [];
      const builder = buildCombinedBuilder(tx, seed, destinationRelativePath, calls);
      const { workflowRunId } = await startWorkflowRun(tx, seed.workflowDefinitionId, seed.goalId);

      mockLlmOnce("pause scenario A report");
      const afterTaskA = await advanceWorkflowRun(tx, workflowRunId, builder);
      expect(afterTaskA).toEqual({ status: "in_progress" });
      // Only Task A's builder ran so far — twice, since Phase 9: once creating
      // the step, and once resuming it after its LLM Invocation's dispatch
      // yield (the builder contract requires it to be safe to call repeatedly).
      const taskAOnly = [seed.taskDefinitionId, seed.taskDefinitionId];
      expect(calls).toEqual(taskAOnly);

      await pauseWorkflowRun(tx, workflowRunId);

      const whilePaused = await advanceWorkflowRun(tx, workflowRunId, builder);
      expect(whilePaused).toEqual({ status: "paused" });
      // The paused short-circuit precedes the builder entirely (interpreter.ts's
      // own top-of-function check) — proves Task B's builder never ran.
      expect(calls).toEqual(taskAOnly);

      let taskInstances = await tx.query.taskInstances.findMany({ where: eq(schema.taskInstances.workflowRunId, workflowRunId) });
      expect(taskInstances).toHaveLength(1);

      await resumeWorkflowRun(tx, workflowRunId);

      const afterResume = await advanceWorkflowRun(tx, workflowRunId, builder); // creates Task B, halts awaiting_approval
      expect(afterResume).toEqual({ status: "in_progress" });
      expect(calls).toEqual([...taskAOnly, seed.reviewAndPublishTaskDefinitionId]);

      taskInstances = await tx.query.taskInstances.findMany({ where: eq(schema.taskInstances.workflowRunId, workflowRunId) });
      expect(taskInstances).toHaveLength(2);
      const taskBInstance = taskInstances.find((t) => t.taskDefinitionId === seed.reviewAndPublishTaskDefinitionId);
      expect(taskBInstance?.status).toBe("awaiting_approval");
    });
  });
});

// ---------------------------------------------------------------------------
// 9. Pause/resume scenario B — during Task B's awaiting_approval
// ---------------------------------------------------------------------------

describe("Pause/resume scenario B (during Task B's awaiting_approval)", () => {
  it("pausing while Task B is awaiting_approval halts advancement; the Approval remains resolvable; resuming proceeds to execution after approval", async () => {
    const publishSpy = vi.spyOn(toolBindingModule, "publishReport");
    try {
      await withRollback(async (tx) => {
        const seed = await seedPublishWorkflow(tx);
        const destinationRelativePath = "pause-b/report.json";
        const { workflowRunId, builder } = await driveToTaskBAwaitingApproval(tx, seed, destinationRelativePath, "pause scenario B report");

        // The Workflow Run itself is still "in_progress" here (only Task B's
        // own Run is waiting) — pause is valid from "in_progress".
        await pauseWorkflowRun(tx, workflowRunId);

        const whilePaused = await advanceWorkflowRun(tx, workflowRunId, builder);
        expect(whilePaused).toEqual({ status: "paused" });

        const stillWaiting = await getWorkflowState(tx, seed, workflowRunId);
        expect(stillWaiting.invocation?.status).toBe("awaiting_approval");
        expect(stillWaiting.approval?.status).toBe("pending");

        // Approvals are independent of workflow_run status — resolve while paused.
        await resolveApproval(tx, stillWaiting.approval!.id, "approved", "reviewer");

        await resumeWorkflowRun(tx, workflowRunId);

        const afterResume = await advanceWorkflowRun(tx, workflowRunId, builder);
        expect(afterResume).toEqual({ status: "completed" });

        const finalState = await getWorkflowState(tx, seed, workflowRunId);
        expect(finalState.taskBInstance?.status).toBe("completed");
        expect(publishSpy).toHaveBeenCalledTimes(1);

        const publishedPath = publishedPathFor(destinationRelativePath);
        PUBLISHED_FILES.push(publishedPath);
        expect(existsSync(publishedPath)).toBe(true);
      });
    } finally {
      publishSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Structural: destination is always under ARTIFACT_ROOT/published/ (Ruling 6)
// ---------------------------------------------------------------------------

describe("Structural: publishReport's destination is always local, relative, under ARTIFACT_ROOT/published/", () => {
  it("toolBinding.ts contains no networked/remote-call logic (governance-boundary proof, not a networked integration)", () => {
    const toolBindingPath = fileURLToPath(new URL("../../src/capabilities/publishReport/toolBinding.ts", import.meta.url));
    const source = readFileSync(toolBindingPath, "utf8");
    expect(source).toMatch(/published/); // writes under .../published/
    expect(source).not.toMatch(/https?:\/\//);
    expect(source).not.toMatch(/fetch\(|axios|http\.request|net\.connect|WebSocket/);
  });

  it("rejects a destinationRelativePath containing a '..' segment (path traversal)", async () => {
    await withRollback(async (tx) => {
      const [artifact] = await tx
        .insert(schema.artifacts)
        .values({ type: "report", version: 1, hash: "x", size: 1, inlineContent: "{}" })
        .returning();
      await expect(publishReport(tx, artifact!.id, "../../escape.json", artifact!.hash)).rejects.toThrow(/\.\.|traversal/i);
    });
  });

  it("rejects an absolute destinationRelativePath", async () => {
    await withRollback(async (tx) => {
      const [artifact] = await tx
        .insert(schema.artifacts)
        .values({ type: "report", version: 1, hash: "x", size: 1, inlineContent: "{}" })
        .returning();
      await expect(publishReport(tx, artifact!.id, "C:\\Windows\\escape.json", artifact!.hash)).rejects.toThrow(/absolute|traversal/i);
      await expect(publishReport(tx, artifact!.id, "/etc/escape.json", artifact!.hash)).rejects.toThrow(/absolute|traversal/i);
    });
  });

  it("actually writes under ARTIFACT_ROOT/published/ for a well-formed relative path", async () => {
    await withRollback(async (tx) => {
      const [artifact] = await tx
        .insert(schema.artifacts)
        .values({ type: "report", version: 1, hash: "x", size: Buffer.byteLength("hello"), inlineContent: "hello" })
        .returning();
      // The expected hash is recomputed from content by publishReport, so it must be the real one.
      const { publishedPath } = await publishReport(
        tx,
        artifact!.id,
        "structural/hello.txt",
        sha256Hash("sha256").update("hello").digest("hex")
      );
      PUBLISHED_FILES.push(publishedPath);
      const expectedRoot = path.resolve(process.env.ARTIFACT_ROOT!, "published");
      expect(publishedPath.startsWith(expectedRoot + path.sep)).toBe(true);
      expect(readFileSync(publishedPath, "utf8")).toBe("hello");
    });
  });
});

// ---------------------------------------------------------------------------
// 11. Structural: capability.ts stays implementation-agnostic
// ---------------------------------------------------------------------------

describe("publishReport publishes only the approved content", () => {
  it("refuses content whose hash does not match the one pinned at approval, and writes nothing", async () => {
    await withRollback(async (tx) => {
      const [artifact] = await tx
        .insert(schema.artifacts)
        .values({ type: "report", version: 1, hash: "stale", size: 5, inlineContent: "later" })
        .returning();
      const destinationRelativePath = "hash-pin/refused.txt";
      const approvedHash = sha256Hash("sha256").update("originally approved content").digest("hex");

      await expect(publishReport(tx, artifact!.id, destinationRelativePath, approvedHash)).rejects.toThrow(/hash mismatch/);
      expect(existsSync(publishedPathFor(destinationRelativePath))).toBe(false);
    });
  });
});

describe("structural: capability.ts contains no reference to the concrete implementation in toolBinding.ts", () => {
  it("has no import of toolBinding.ts and no mention of its function name or implementation details", () => {
    const capabilityPath = fileURLToPath(new URL("../../src/capabilities/publishReport/capability.ts", import.meta.url));
    const source = readFileSync(capabilityPath, "utf8");
    expect(source).not.toMatch(/from\s+["'].*toolBinding.*["']/);
    expect(source).not.toMatch(/toolBinding/i);
    expect(source).not.toMatch(/publishReport\s*\(/);
    expect(source).not.toMatch(/writeFile|mkdir|fs\/promises|node:fs/);
  });
});
