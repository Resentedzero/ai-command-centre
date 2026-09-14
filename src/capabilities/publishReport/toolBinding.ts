/**
 * `publishReport` — the concrete implementation backing the `publish.report`
 * Capability's `tool_bindings` row (Unit 9).
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THIS IS A GOVERNANCE-BOUNDARY PROOF/TEST BINDING — NOT A PRODUCTION
 * PUBLISHING INTEGRATION. It exists solely to demonstrate that the real
 * governance chain (Grant -> Policy -> Approval -> re-authorization ->
 * execution, Phase 18.2) gates a REAL side effect end to end. It writes to
 * a local, relative path under `${ARTIFACT_ROOT}/published/` — never a
 * network call, never a third-party API, never anything outside this
 * process's own filesystem. No Phase 14 rubric evaluation was performed for
 * an actual third-party publish target, nor should one be inferred from this
 * file: standing up a real publishing integration (email, a CMS, a social
 * platform, cloud storage, ...) is real future work, explicitly out of MVP
 * scope. A future reader replacing this function's body with a real
 * integration should treat that as adding an entirely new capability, not as
 * "finishing" this one.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Deviation from the brief's literal 2-argument interface listing
 * (`publishReport(artifactId, destinationRelativePath)`), documented here
 * rather than silently applied: this function's actual exported signature
 * takes `tx: DrizzleTransaction` as a LEADING parameter. This is not a
 * stylistic choice — it is forced by Ruling 5's own requirement that this
 * function "looks up the artifact's content by ID at execution time (a real
 * DB query inside toolBinding.ts)". Every test in this codebase runs inside
 * `withRollback` (`tests/testDb.ts`): a Goal/Artifact/etc. row written during
 * a test exists ONLY inside that test's open transaction and is never
 * committed. A lookup through any connection other than that same `tx`
 * (e.g. a fresh pool connection opened here) would see nothing —
 * transaction isolation, not a hypothetical concern. So `tx` must be
 * threaded through, exactly the same class of necessary widening Ruling 1
 * already pre-authorizes for `buildInvocationSpecs` (whose frozen
 * `InvocationSpecBuilder` type also carries no `tx`). The caller obtains this
 * function via a zero-argument `execute: () => Promise<...>` closure (the
 * `ToolInvocationSpec.execute` contract, `src/execution/types.ts`) built by
 * `./buildInvocationSpecs.ts`, which closes over whatever `tx` it already has
 * — so nothing about the frozen Executor/InvocationSpec interfaces changes.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { artifacts } from "../../db/schema.js";
import type { DrizzleTransaction } from "../../events/emit.js";

/**
 * Ruling 6 (filesystem hygiene) — fails closed against path traversal.
 * Layered, not just a single check, because `path.isAbsolute`'s definition
 * of "absolute" is platform-specific (this project runs on win32, where a
 * bare `..`-free but drive-qualified path like `C:\Windows\x`, or a UNC path
 * `\\server\share`, is absolute and must be rejected too) and a naive
 * segment check alone would not catch every bypass:
 *   1. Reject empty/NUL-containing input outright.
 *   2. Reject anything `path.isAbsolute` recognizes (covers `/etc/passwd`,
 *      `C:\Windows\x`, and win32 UNC paths).
 *   3. Reject any `..` path segment (covers `foo/../../bar` even though the
 *      overall string isn't "absolute").
 *   4. Resolve against `publishedRoot` and verify the result is STILL inside
 *      it — the actual, robust containment guarantee; steps 1-3 are
 *      defense-in-depth / clearer error messages, not the sole guard.
 */
function assertSafeDestination(publishedRoot: string, destinationRelativePath: string): string {
  if (!destinationRelativePath || destinationRelativePath.includes("\0")) {
    throw new Error(`publishReport: destinationRelativePath "${destinationRelativePath}" is empty or malformed.`);
  }
  if (path.isAbsolute(destinationRelativePath)) {
    throw new Error(
      `publishReport: destinationRelativePath "${destinationRelativePath}" must be relative, not absolute ` +
        "(fail closed — this binding must never write outside ARTIFACT_ROOT/published/)."
    );
  }
  const segments = destinationRelativePath.split(/[\\/]/);
  if (segments.some((segment) => segment === "..")) {
    throw new Error(
      `publishReport: destinationRelativePath "${destinationRelativePath}" contains a ".." segment ` +
        "(fail closed — path traversal is never permitted)."
    );
  }

  const resolved = path.resolve(publishedRoot, destinationRelativePath);
  if (resolved !== publishedRoot && !resolved.startsWith(publishedRoot + path.sep)) {
    throw new Error(
      `publishReport: destinationRelativePath "${destinationRelativePath}" resolves outside ` +
        `ARTIFACT_ROOT/published/ ("${resolved}" is not under "${publishedRoot}").`
    );
  }
  return resolved;
}

/**
 * Writes the Artifact identified by `artifactId`'s content to
 * `${ARTIFACT_ROOT}/published/${destinationRelativePath}` — never anywhere
 * else (see `assertSafeDestination`, and the structural test in
 * `tests/capabilities/publishReport.integration.test.ts` that pins this
 * "always under ARTIFACT_ROOT/published/, local, relative" invariant per the
 * brief's required "structural test/comment").
 *
 * Looks the Artifact up BY ID at execution time (Ruling 5) — the caller
 * (`./buildInvocationSpecs.ts`) passes only a reference, never the report's
 * full content, so `proposedActionSnapshot`/the Approval's frozen snapshot
 * never duplicates the content itself.
 */
export async function publishReport(
  tx: DrizzleTransaction,
  artifactId: string,
  destinationRelativePath: string,
  /**
   * The sha256 of the content the Approval was granted for (2026-09-14), pinned
   * in `proposedActionSnapshot.artifactHash`. REQUIRED: nothing is published
   * without it. The Approval names the artifact by id; the pin is what proves
   * the bytes written are the bytes that were approved, rather than whatever the
   * id resolves to at execution time.
   */
  expectedHash: string
): Promise<{ publishedPath: string }> {
  const artifactRoot = process.env.ARTIFACT_ROOT;
  if (!artifactRoot) {
    throw new Error("publishReport: ARTIFACT_ROOT is not set.");
  }
  const publishedRoot = path.resolve(artifactRoot, "published");
  const destination = assertSafeDestination(publishedRoot, destinationRelativePath);

  const artifact = await tx.query.artifacts.findFirst({ where: eq(artifacts.id, artifactId) });
  if (!artifact) {
    throw new Error(`publishReport: no artifacts row found for id "${artifactId}"`);
  }
  if (artifact.inlineContent === null) {
    throw new Error(`publishReport: artifact "${artifactId}" has no inlineContent to publish.`);
  }
  // Recomputed from the bytes about to be written — never taken from the stored
  // `hash` column, which would not catch content altered without its hash.
  const actualHash = createHash("sha256").update(artifact.inlineContent).digest("hex");
  if (actualHash !== expectedHash) {
    throw new Error(
      `publishReport: artifact "${artifactId}" no longer matches the content that was approved ` +
        "(content hash mismatch); refusing to publish."
    );
  }

  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, artifact.inlineContent, "utf8");

  return { publishedPath: destination };
}
