/**
 * `persistReportArtifact` — creates a `"report"`-type Artifact row for an
 * Invocation's final output (Unit 8 addition, fix-round-1).
 *
 * This is a small, additive SIBLING to Unit 6's
 * `persistInvocationResultAsArtifact` (`./invocationResults.ts`) — NOT a
 * modification of it. That function is frozen and hardcodes
 * `type: "invocation_result"` for every Invocation kind alike (see its own
 * header for why); it has no type-override parameter, and this module does
 * not add one to it. Instead, this is a genuinely new, separate function for
 * the one case Unit 6 never needed to handle: marking a specific piece of
 * already-produced output as the workflow's final, addressable `"report"`
 * artifact — the shape Phase 18.2's workflow 1 (Unit 8) requires.
 *
 * Deliberately NOT a Capability, and carries no Policy/Approval/Budget
 * governance of its own — it is pure persistence, exactly like
 * `persistInvocationResultAsArtifact`. Any governance around "publishing" a
 * report (if Unit 9 needs it) is that unit's concern, layered on top of this
 * primitive, not baked into it.
 *
 * Uses the identical hash/size/version conventions as
 * `persistInvocationResultAsArtifact` for consistency: the sha256 hex digest
 * of the serialized JSON as `hash`, its UTF-8 byte length as `size`, and a
 * fixed `version: 1` (no versioning concept exists for these
 * Executor-produced artifacts at MVP scope, same rationale as Unit 6's).
 */
import { createHash } from "node:crypto";
import { artifacts } from "../db/schema.js";
import type { DrizzleTransaction } from "../events/emit.js";
import { emitArtifactCreated } from "../events/lifecycle.js";

export async function persistReportArtifact(
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
      type: "report",
      version: 1,
      producingInvocationId: invocationId,
      hash,
      size,
      storageReference: null,
      inlineContent: json,
      summary: null,
    })
    .returning();

  // Spec §8.2 `artifact_created`, in the same transaction as the row.
  await emitArtifactCreated(tx, row!);
  return { artifactId: row!.id };
}
