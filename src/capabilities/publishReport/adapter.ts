/**
 * The internal Tool Adapter function for `publish.report`'s filesystem binding
 * (`../toolAdapters.ts`). `prepare` reads the approved Artifact's bytes in the
 * spec builder's transaction, from the id in the proposed action; `execute`
 * publishes them with no transaction open through `./toolBinding.ts`, which
 * re-proves them against the approved hash.
 *
 * Kept apart from `./toolBinding.ts` so the effect stays a call across a module
 * boundary, where tests can observe it.
 */
import { eq } from "drizzle-orm";
import { artifacts } from "../../db/schema.js";
import type { InternalToolFunction } from "../toolAdapters.js";
import { PUBLISH_REPORT_CAPABILITY } from "./capability.js";
import { publishReport } from "./toolBinding.js";

/** The `config.function` a binding names to be fulfilled by this adapter. */
export const PUBLISH_REPORT_FILESYSTEM = "publish.report.filesystem";

function snapshotString(snapshot: Record<string, unknown>, field: string): string {
  const value = snapshot[field];
  if (typeof value !== "string" || value === "") {
    throw new Error(`${PUBLISH_REPORT_FILESYSTEM}: the proposed action carries no ${field}.`);
  }
  return value;
}

export const publishReportFilesystem: InternalToolFunction = {
  capabilityName: PUBLISH_REPORT_CAPABILITY.id,
  async prepare(tx, { proposedActionSnapshot }) {
    const artifactId = snapshotString(proposedActionSnapshot, "artifactId");
    const expectedHash = snapshotString(proposedActionSnapshot, "artifactHash");
    const destinationRelativePath = snapshotString(proposedActionSnapshot, "destinationRelativePath");
    const row = await tx.query.artifacts.findFirst({ where: eq(artifacts.id, artifactId) });
    if (!row) throw new Error(`${PUBLISH_REPORT_FILESYSTEM}: Artifact "${artifactId}" does not exist.`);
    if (row.inlineContent === null) {
      throw new Error(`${PUBLISH_REPORT_FILESYSTEM}: Artifact "${artifactId}" has no inlineContent to publish.`);
    }
    return {
      inputs: { content: row.inlineContent, expectedHash, destinationRelativePath },
      costClass: "external_side_effect",
      estimatedCost: 0.05,
    };
  },
  execute: async ({ inputs }, { idempotencyKey }) =>
    await publishReport({
      content: inputs.content as string,
      expectedHash: inputs.expectedHash as string,
      destinationRelativePath: inputs.destinationRelativePath as string,
      idempotencyKey,
    }),
};
