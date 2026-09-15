/** A deliverable whose model output JSON-encodes the whole document inside `body` is unwrapped once, deterministically. */
import { describe, expect, it } from "vitest";
import { normalizeDeliverableOutput } from "../../src/capabilities/shared/deliverable.js";

describe("normalizeDeliverableOutput", () => {
  it("unwraps a deliverable JSON-encoded inside body", () => {
    const inner = { title: "Real title", summary: "## Summary", body: "## Body\n\ntext", findings: ["f"], recommendations: [], sources: [] };
    const out = normalizeDeliverableOutput({ title: "Outer", summary: "outer summary", body: JSON.stringify(inner), findings: [], recommendations: [], sources: [] });
    expect(out).toMatchObject({ title: "Real title", summary: "## Summary", body: "## Body\n\ntext", findings: ["f"] });
  });

  it("keeps ordinary Markdown, and JSON that is not a deliverable, as written", () => {
    const md = { title: "t", body: "## Heading\n\n{ braces in prose }" };
    expect(normalizeDeliverableOutput(md)).toBe(md);
    const other = { title: "t", body: JSON.stringify({ data: [1, 2, 3] }) };
    expect(normalizeDeliverableOutput(other)).toBe(other);
  });
});
