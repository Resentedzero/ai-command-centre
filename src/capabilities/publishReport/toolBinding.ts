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
 * Runs with NO database transaction (DURABLE_EXECUTION §2.1): the Executor
 * commits the Invocation as `executing` before this is called, so a crash
 * mid-publish leaves a durable claim that the effect may have happened and it
 * is never repeated. It therefore takes the approved content itself — read by
 * `./buildInvocationSpecs.ts` when the spec is built — never a transaction to
 * look it up with.
 *
 * Idempotency (spec §12): the write is atomic (a temporary file renamed into
 * place, so a crash never leaves a partial report), and a destination that
 * already holds exactly the approved bytes is reported as already published
 * rather than written again. A destination holding anything else is refused.
 * The Invocation's idempotency key names the temporary file, so two attempts
 * never share one.
 *
 * Refusals that happen before anything is written carry `consumption: "none"`,
 * so the reservation is released; any other failure is treated as possibly
 * performed.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** An error proving nothing was written (see `providerConsumptionFrom`). */
function refusal(message: string): Error & { consumption: "none" } {
  return Object.assign(new Error(message), { consumption: "none" as const });
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

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
    throw refusal(`publishReport: destinationRelativePath "${destinationRelativePath}" is empty or malformed.`);
  }
  if (path.isAbsolute(destinationRelativePath)) {
    throw refusal(
      `publishReport: destinationRelativePath "${destinationRelativePath}" must be relative, not absolute ` +
        "(fail closed — this binding must never write outside ARTIFACT_ROOT/published/)."
    );
  }
  const segments = destinationRelativePath.split(/[\\/]/);
  if (segments.some((segment) => segment === "..")) {
    throw refusal(
      `publishReport: destinationRelativePath "${destinationRelativePath}" contains a ".." segment ` +
        "(fail closed — path traversal is never permitted)."
    );
  }

  const resolved = path.resolve(publishedRoot, destinationRelativePath);
  if (resolved !== publishedRoot && !resolved.startsWith(publishedRoot + path.sep)) {
    throw refusal(
      `publishReport: destinationRelativePath "${destinationRelativePath}" resolves outside ` +
        `ARTIFACT_ROOT/published/ ("${resolved}" is not under "${publishedRoot}").`
    );
  }
  return resolved;
}

export type PublishReportRequest = {
  /** The report's bytes, as read from its Artifact when the spec was built. */
  content: string;
  /**
   * The sha256 of the content the Approval was granted for, pinned in
   * `proposedActionSnapshot.artifactHash`. REQUIRED: nothing is published
   * without it. Recomputed here from `content`, so the bytes written are proven
   * to be the bytes that were approved.
   */
  expectedHash: string;
  destinationRelativePath: string;
  /** The Invocation's idempotency key (`ToolExecutionContext`). */
  idempotencyKey: string;
};

/**
 * Writes `content` to `${ARTIFACT_ROOT}/published/${destinationRelativePath}` —
 * never anywhere else (see `assertSafeDestination`, and the structural test in
 * `tests/capabilities/publishReport.integration.test.ts`).
 *
 * `publishedPath` is recorded relative to ARTIFACT_ROOT, POSIX-separated (spec
 * §13.3): it is persisted in an invocation_result Artifact that later
 * compilations can inline, and an absolute path would carry the host's
 * directory layout (and user name) into stored data and prompts.
 */
export async function publishReport(request: PublishReportRequest): Promise<{ publishedPath: string; alreadyPublished: boolean }> {
  const artifactRoot = process.env.ARTIFACT_ROOT;
  if (!artifactRoot) {
    throw refusal("publishReport: ARTIFACT_ROOT is not set.");
  }
  const publishedRoot = path.resolve(artifactRoot, "published");
  const destination = assertSafeDestination(publishedRoot, request.destinationRelativePath);
  const publishedPath = path.relative(path.resolve(artifactRoot), destination).split(path.sep).join("/");

  if (sha256(request.content) !== request.expectedHash) {
    throw refusal(
      "publishReport: the content no longer matches the content that was approved " +
        "(content hash mismatch); refusing to publish."
    );
  }

  const existing = await readFile(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing !== null) {
    if (sha256(existing) === request.expectedHash) {
      return { publishedPath, alreadyPublished: true };
    }
    throw refusal(`publishReport: "${publishedPath}" already holds different content; refusing to overwrite it.`);
  }

  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${sha256(request.idempotencyKey).slice(0, 16)}.tmp`;
  await writeFile(temporary, request.content, "utf8");
  await rename(temporary, destination);
  return { publishedPath, alreadyPublished: false };
}
