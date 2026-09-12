import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { resetTestSchema, closeTestDb, withRollback, testDb } from "../testDb.js";
import {
  capabilities,
  agentDefinitions,
  capabilityGrants,
  projects,
  taskDefinitions,
  taskInstances,
  runs,
  invocations,
  approvals,
} from "../../src/db/schema.js";
import { createApproval, resolveApproval, reauthorize } from "../../src/governance/approvals.js";
import type { DrizzleTransaction } from "../../src/events/emit.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

/**
 * Seeds one full FK-valid chain (agentDefinition -> capability -> grant ->
 * project -> taskDefinition -> taskInstance -> run -> invocation), returning
 * the ids `reauthorize`/`createApproval` need. `run.agentDefinitionId`/
 * `agentDefinitionVersion` and `invocation.capabilityId`/`permission` are set
 * so `reauthorize` can find the governing Grant from just the invocationId.
 */
async function seedInvocationChain(
  tx: DrizzleTransaction,
  overrides: {
    permission?: string;
    grantPermissions?: string[];
    autonomyState?: string;
    revoked?: boolean;
    proposedActionSnapshot?: Record<string, unknown>;
  } = {}
) {
  const permission = overrides.permission ?? "SPEND";

  const [capability] = await tx
    .insert(capabilities)
    .values({ name: "test.capability", description: "fixture", staticRiskTag: "low" })
    .returning();

  const [agentDefinition] = await tx
    .insert(agentDefinitions)
    .values({
      name: "test-agent",
      version: 1,
      role: "tester",
      objective: "exercise approvals",
      instructions: "n/a",
    })
    .returning();

  const [grant] = await tx
    .insert(capabilityGrants)
    .values({
      agentDefinitionId: agentDefinition!.id,
      agentDefinitionVersion: agentDefinition!.version,
      capabilityId: capability!.id,
      permissions: overrides.grantPermissions ?? [permission],
      maxTrustLevelRequired: 1,
      autonomyState: overrides.autonomyState ?? "ALWAYS_APPROVE",
      revokedAt: overrides.revoked ? new Date() : null,
    })
    .returning();

  const [project] = await tx.insert(projects).values({ name: "test-project" }).returning();

  const [taskDefinition] = await tx
    .insert(taskDefinitions)
    .values({ name: "test-task", kind: "standalone", version: 1 })
    .returning();

  const [taskInstance] = await tx
    .insert(taskInstances)
    .values({
      taskDefinitionId: taskDefinition!.id,
      taskDefinitionVersion: taskDefinition!.version,
      projectId: project!.id,
      status: "pending",
    })
    .returning();

  const [run] = await tx
    .insert(runs)
    .values({
      taskInstanceId: taskInstance!.id,
      agentDefinitionId: agentDefinition!.id,
      agentDefinitionVersion: agentDefinition!.version,
      status: "active",
    })
    .returning();

  const proposedActionSnapshot = overrides.proposedActionSnapshot ?? { action: "spend", amount: 5 };

  const [invocation] = await tx
    .insert(invocations)
    .values({
      runId: run!.id,
      seqNo: 1,
      kind: "tool",
      costClass: "metered_api",
      status: "pending",
      idempotencyKey: `fixture-${randomUUID()}`,
      capabilityId: capability!.id,
      permission,
      proposedActionSnapshot,
    })
    .returning();

  return { capability: capability!, agentDefinition: agentDefinition!, grant: grant!, run: run!, invocation: invocation! };
}

describe("createApproval", () => {
  it("stores the exact snapshot verbatim", async () => {
    await withRollback(async (tx) => {
      const { invocation } = await seedInvocationChain(tx);
      const snapshot = { action: "spend", amount: 42, nested: { a: [1, 2, 3] } };

      const result = await createApproval(tx, invocation.id, snapshot, "high", 3600);

      expect(result.status).toBe("pending");

      const row = await tx.query.approvals.findFirst({ where: eq(approvals.id, result.id) });
      expect(row?.proposedActionSnapshot).toEqual(snapshot);
      expect(row?.riskTier).toBe("high");
      expect(row?.status).toBe("pending");
      expect(row?.invocationId).toBe(invocation.id);
    });
  });

  it("sets invocations.proposedActionSnapshot to the same value, so reauthorize has a matching baseline", async () => {
    await withRollback(async (tx) => {
      const { invocation } = await seedInvocationChain(tx, { proposedActionSnapshot: { action: "old" } });
      const snapshot = { action: "new" };

      await createApproval(tx, invocation.id, snapshot, "low", 3600);

      const row = await tx.query.invocations.findFirst({ where: eq(invocations.id, invocation.id) });
      expect(row?.proposedActionSnapshot).toEqual(snapshot);
    });
  });

  it("throws when the invocation does not exist", async () => {
    await withRollback(async (tx) => {
      await expect(createApproval(tx, randomUUID(), {}, "low", 3600)).rejects.toThrow();
    });
  });

  it(
    "enforces at most one Approval per invocation (fix-round-1 critical fix): a second createApproval call for " +
      "the same invocationId fails via the DB unique constraint, so reauthorize's lookup can never be ambiguous",
    async () => {
      // Deliberately NOT withRollback: a duplicate-key insert aborts the
      // transaction outright, so it rolls back on its own — calling
      // tx.rollback() on an already-aborted transaction (as withRollback's
      // cleanup would) misbehaves. Mirrors budget.test.ts's identical
      // pattern for the analogous budget_counters unique-index test.
      let caught: unknown;
      try {
        await testDb.transaction(async (tx) => {
          const { invocation } = await seedInvocationChain(tx);
          await createApproval(tx, invocation.id, { action: "first" }, "low", 3600);
          await createApproval(tx, invocation.id, { action: "second" }, "low", 3600);
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      // Asserting the specific index name (not just "duplicate"/"unique")
      // proves it's THIS constraint, not some other one.
      const cause = (caught as { cause?: { message?: string; constraint?: string } }).cause;
      expect(cause?.constraint ?? cause?.message).toMatch(/approvals_invocation_id_idx/);
    }
  );
});

describe("resolveApproval", () => {
  it("resolves a pending approval to approved, recording resolvedBy", async () => {
    await withRollback(async (tx) => {
      const { invocation } = await seedInvocationChain(tx);
      const created = await createApproval(tx, invocation.id, { action: "spend" }, "low", 3600);

      const result = await resolveApproval(tx, created.id, "approved", "reviewer");

      expect(result).toEqual({ id: created.id, status: "approved" });

      const row = await tx.query.approvals.findFirst({ where: eq(approvals.id, created.id) });
      expect(row?.status).toBe("approved");
      expect(row?.resolvedBy).toBe("reviewer");
      expect(row?.resolvedAt).not.toBeNull();
    });
  });

  it("resolves a pending approval to rejected", async () => {
    await withRollback(async (tx) => {
      const { invocation } = await seedInvocationChain(tx);
      const created = await createApproval(tx, invocation.id, { action: "spend" }, "low", 3600);

      const result = await resolveApproval(tx, created.id, "rejected", "reviewer");

      expect(result).toEqual({ id: created.id, status: "rejected" });
    });
  });

  it("throws when the approval does not exist", async () => {
    await withRollback(async (tx) => {
      await expect(resolveApproval(tx, randomUUID(), "approved", "reviewer")).rejects.toThrow();
    });
  });
});

describe("reauthorize", () => {
  it("returns true when the Grant is valid, unrevoked, covers the permission, and the snapshot is unchanged", async () => {
    await withRollback(async (tx) => {
      const { invocation } = await seedInvocationChain(tx);
      const snapshot = { action: "spend", amount: 5 };
      await tx.update(invocations).set({ proposedActionSnapshot: snapshot }).where(eq(invocations.id, invocation.id));
      await createApproval(tx, invocation.id, snapshot, "low", 3600);

      const result = await reauthorize(tx, invocation.id);
      expect(result).toBe(true);
    });
  });

  it("Material-change invalidation: returns false when the invocation's snapshot was mutated after Approval creation", async () => {
    await withRollback(async (tx) => {
      const { invocation } = await seedInvocationChain(tx);
      const originalSnapshot = { action: "spend", amount: 5 };
      await createApproval(tx, invocation.id, originalSnapshot, "low", 3600);

      // Mutate the invocation's CURRENT proposed action after Approval creation.
      await tx
        .update(invocations)
        .set({ proposedActionSnapshot: { action: "spend", amount: 999999 } })
        .where(eq(invocations.id, invocation.id));

      const result = await reauthorize(tx, invocation.id);
      expect(result).toBe(false);
    });
  });

  it("returns false after the backing Grant is revoked, independent of any budget state", async () => {
    await withRollback(async (tx) => {
      const { invocation, grant } = await seedInvocationChain(tx);
      const snapshot = { action: "spend", amount: 5 };
      await tx.update(invocations).set({ proposedActionSnapshot: snapshot }).where(eq(invocations.id, invocation.id));
      await createApproval(tx, invocation.id, snapshot, "low", 3600);

      // Confirm true beforehand, then revoke and confirm it flips to false.
      expect(await reauthorize(tx, invocation.id)).toBe(true);

      await tx.update(capabilityGrants).set({ revokedAt: new Date() }).where(eq(capabilityGrants.id, grant.id));

      const result = await reauthorize(tx, invocation.id);
      expect(result).toBe(false);
    });
  });

  it("returns false when no Grant covers the invocation's permission any more", async () => {
    await withRollback(async (tx) => {
      const { invocation, grant } = await seedInvocationChain(tx, { permission: "SPEND", grantPermissions: ["SPEND"] });
      const snapshot = { action: "spend", amount: 5 };
      await tx.update(invocations).set({ proposedActionSnapshot: snapshot }).where(eq(invocations.id, invocation.id));
      await createApproval(tx, invocation.id, snapshot, "low", 3600);

      await tx.update(capabilityGrants).set({ permissions: ["READ"] }).where(eq(capabilityGrants.id, grant.id));

      const result = await reauthorize(tx, invocation.id);
      expect(result).toBe(false);
    });
  });

  it("throws when the invocation does not exist", async () => {
    await withRollback(async (tx) => {
      await expect(reauthorize(tx, randomUUID())).rejects.toThrow();
    });
  });

  it("throws when no approval exists for the invocation", async () => {
    await withRollback(async (tx) => {
      const { invocation } = await seedInvocationChain(tx);
      await expect(reauthorize(tx, invocation.id)).rejects.toThrow();
    });
  });

  it("returns false when the Approval's ttl has already passed (fix-round-1: passive check, not the background sweep)", async () => {
    await withRollback(async (tx) => {
      const { invocation } = await seedInvocationChain(tx);
      const snapshot = { action: "spend", amount: 5 };
      await tx.update(invocations).set({ proposedActionSnapshot: snapshot }).where(eq(invocations.id, invocation.id));
      // Negative ttlSeconds -> ttl computed as already in the past.
      await createApproval(tx, invocation.id, snapshot, "low", -10);

      const result = await reauthorize(tx, invocation.id);
      expect(result).toBe(false);
    });
  });

  it(
    "returns true even when the Approval is resolved to 'rejected' — reauthorize deliberately does NOT consult " +
      "approval status; status-checking is the caller's (future Executor's) responsibility, documented as a " +
      "contract in approvals.ts's module header, not an oversight",
    async () => {
      await withRollback(async (tx) => {
        const { invocation } = await seedInvocationChain(tx);
        const snapshot = { action: "spend", amount: 5 };
        await tx.update(invocations).set({ proposedActionSnapshot: snapshot }).where(eq(invocations.id, invocation.id));
        const created = await createApproval(tx, invocation.id, snapshot, "low", 3600);
        await resolveApproval(tx, created.id, "rejected", "reviewer");

        const result = await reauthorize(tx, invocation.id);
        expect(result).toBe(true);
      });
    }
  );

  it("returns false (fail-closed, Deviation #4) when the invocation's capabilityId/permission are null — it never went through Policy", async () => {
    await withRollback(async (tx) => {
      const { invocation } = await seedInvocationChain(tx);
      const snapshot = { action: "n/a" };
      await tx
        .update(invocations)
        .set({ capabilityId: null, permission: null, proposedActionSnapshot: snapshot })
        .where(eq(invocations.id, invocation.id));
      await createApproval(tx, invocation.id, snapshot, "low", 3600);

      const result = await reauthorize(tx, invocation.id);
      expect(result).toBe(false);
    });
  });

  it("returns false (fail-closed, Deviation #4) when the run's agentDefinitionId/agentDefinitionVersion are null", async () => {
    await withRollback(async (tx) => {
      const { invocation, run } = await seedInvocationChain(tx);
      await tx.update(runs).set({ agentDefinitionId: null, agentDefinitionVersion: null }).where(eq(runs.id, run.id));

      const snapshot = { action: "spend", amount: 5 };
      await tx.update(invocations).set({ proposedActionSnapshot: snapshot }).where(eq(invocations.id, invocation.id));
      await createApproval(tx, invocation.id, snapshot, "low", 3600);

      const result = await reauthorize(tx, invocation.id);
      expect(result).toBe(false);
    });
  });
});

describe("Zero budget coupling (Phase 20 risk #2)", () => {
  it("approvals.ts source contains no import of budget.ts/costClass.ts", () => {
    const approvalsPath = fileURLToPath(new URL("../../src/governance/approvals.ts", import.meta.url));
    const source = readFileSync(approvalsPath, "utf8");
    // Strip block comments first: prose explaining the deliberate separation
    // (mirroring budget.ts's own header) is expected to name these symbols;
    // only actual code matters for this check.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/from\s+["'].*\/(budget|costClass)\.js["']/);
    expect(code).not.toMatch(/\b(reserveBudget|reconcileBudget|releaseReservation|CostClass)\b/);
    // Broader net: catches any budget-named identifier (e.g. a stray extra
    // parameter) that the specific-symbol check above would miss.
    expect(code).not.toMatch(/\bbudget/i);
  });
});
