/**
 * `persistInvocationResultAsArtifact` — persists any Invocation's structured
 * output (tool, llm, deterministic, retrieval alike — kind-agnostic per
 * Ruling 8) as an addressable `artifacts` row, so it becomes a normal
 * ContextCandidate for the NEXT Context Compiler call rather than being
 * passed as a raw in-memory object across Invocation boundaries (Phase 12's
 * inline-content threshold; the brief's stated fix for Unit 8's original
 * shortcut).
 *
 * `type: "invocation_result"` — a reasonable generic MVP value (the brief
 * does not name one); every artifact produced this way carries the same
 * type regardless of which Invocation kind produced it, since nothing
 * downstream in this unit's scope discriminates on it.
 *
 * `hash`/`size`/`version` are NOT NULL columns the brief's own signature
 * doesn't mention — `hash` is the sha256 hex digest of the serialized JSON
 * (content-addressable, deterministic), `size` is its UTF-8 byte length, and
 * `version` is always `1` (no versioning concept exists for these
 * Executor-produced artifacts at MVP scope).
 */
import { createHash } from "node:crypto";
import { artifacts } from "../db/schema.js";
import type { DrizzleTransaction } from "../events/emit.js";

export async function persistInvocationResultAsArtifact(
  tx: DrizzleTransaction,
  invocationId: string,
  structuredOutput: Record<string, unknown>
): Promise<{ artifactId: string }> {
  const json = JSON.stringify(structuredOutput);
  const hash = createHash("sha256").update(json).digest("hex");
  const size = Buffer.byteLength(json, "utf8");

  const [row] = await tx
    .insert(artifacts)
    .values({
      type: "invocation_result",
      version: 1,
      producingInvocationId: invocationId,
      hash,
      size,
      storageReference: null,
      inlineContent: json,
      summary: null,
    })
    .returning();

  return { artifactId: row!.id };
}
