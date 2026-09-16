/**
 * Every field a loop call or a deliverable write produces is bounded. The runtime has no
 * output-cap flag, so a schema `maxLength` is the only lever — and output was 57% of the
 * V1.1 dogfood's tokens. A field that loses its bound silently costs tokens on every run.
 */
import { describe, expect, it } from "vitest";
import { DELIVERABLE_CAPS, DELIVERABLE_OUTPUT_SCHEMA } from "../../src/capabilities/shared/deliverable.js";
import { OUTPUT_CAPS, WORK_RESULT_SCHEMA, decisionSchema } from "../../src/capabilities/agentObjective/buildInvocationSpecs.js";

type Schema = { properties: Record<string, Schema>; items?: Schema; maxLength?: number; maxItems?: number; type?: string };

/** Every string leaf of a JSON Schema, by dotted path — enums excluded (they bound themselves). */
function stringLeaves(schema: unknown, path = ""): { path: string; maxLength?: number; hasEnum: boolean }[] {
  const s = schema as Schema & { enum?: unknown[] };
  if (!s || typeof s !== "object") return [];
  if (s.type === "string") return [{ path, maxLength: s.maxLength, hasEnum: Array.isArray(s.enum) }];
  const out: { path: string; maxLength?: number; hasEnum: boolean }[] = [];
  if (s.items) out.push(...stringLeaves(s.items, `${path}[]`));
  for (const [key, child] of Object.entries(s.properties ?? {})) out.push(...stringLeaves(child, path ? `${path}.${key}` : key));
  return out;
}

describe("model output is bounded by schema", () => {
  it("bounds every free-text field of a decision, a work result and a deliverable", () => {
    for (const [name, schema] of [
      ["decision", decisionSchema({ intents: ["brainstorm"], tools: ["research.retrieve"] })],
      ["work result", WORK_RESULT_SCHEMA],
      ["deliverable", DELIVERABLE_OUTPUT_SCHEMA],
    ] as const) {
      const unbounded = stringLeaves(schema).filter((leaf) => !leaf.hasEnum && leaf.maxLength === undefined);
      expect(unbounded, `${name} has unbounded text: ${unbounded.map((u) => u.path).join(", ")}`).toEqual([]);
    }
  });

  it("bounds every list, so a capped field cannot be defeated by more items", () => {
    const arrays = (schema: unknown, path = ""): { path: string; maxItems?: number }[] => {
      const s = schema as Schema;
      if (!s || typeof s !== "object") return [];
      const out: { path: string; maxItems?: number }[] = [];
      if (s.type === "array") out.push({ path, maxItems: s.maxItems });
      if (s.items) out.push(...arrays(s.items, `${path}[]`));
      for (const [key, child] of Object.entries(s.properties ?? {})) out.push(...arrays(child, path ? `${path}.${key}` : key));
      return out;
    };
    for (const schema of [decisionSchema(), WORK_RESULT_SCHEMA, DELIVERABLE_OUTPUT_SCHEMA]) {
      expect(arrays(schema).filter((a) => a.maxItems === undefined)).toEqual([]);
    }
  });

  it("keeps intermediate work smaller than the document it feeds, and never pays for text the ledger discards", () => {
    // Working material exists only to reach the final write; the document is the product.
    expect(OUTPUT_CAPS.workContent).toBeLessThan(DELIVERABLE_CAPS.body);
    // The ledger truncates a note at 280 characters, so a longer one is bought and thrown away.
    expect(OUTPUT_CAPS.ledgerNote).toBe(280);
    expect(OUTPUT_CAPS.workSummary).toBeLessThanOrEqual(400);
    // A decision may request no more artifacts than the compiler will carry.
    expect(OUTPUT_CAPS.requestedArtifacts).toBeLessThanOrEqual(4);
  });
});
