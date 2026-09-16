/**
 * A decision's action input is validated against the action it chose — but the decision
 * schema offers one shared object covering every registered action's fields, so the model
 * can fill a neighbouring action's field while choosing this one.
 *
 * That must not cost an iteration (it did, live, the first time two actions had different
 * fields), and it must not become a hole: a field no action declares is still refused, which
 * is what keeps Policy's risk inputs unreachable from model output.
 */
import { describe, expect, it } from "vitest";
import { loopActionFor, loopActions, loopInputFieldNames, parseLoopActionInput } from "../../src/capabilities/shared/loopActions.js";
import "../../src/capabilities/taskPlans.js"; // registers the actions

describe("a decision's input is read against the action it chose", () => {
  it("accepts the action's own fields", () => {
    const search = loopActionFor("research.search")!;
    expect(parseLoopActionInput(search, { query: "rag hallucination", source: "arxiv" })).toEqual({
      ok: true,
      input: { query: "rag hallucination", source: "arxiv" },
    });
  });

  it("ignores a field that belongs to a different registered action", () => {
    const web = loopActionFor("research.web")!;
    // `source` is `research.search`'s field; the shared schema offers it here too.
    expect(parseLoopActionInput(web, { query: "latest release", source: "arxiv" })).toEqual({ ok: true, input: { query: "latest release" } });
  });

  it("still refuses a field no action declares — Policy's risk inputs stay unreachable", () => {
    const web = loopActionFor("research.web")!;
    expect(parseLoopActionInput(web, { query: "x", amountOrScope: 1000 })).toMatchObject({ ok: false });
    expect(parseLoopActionInput(web, { query: "x", isNovelAction: false })).toMatchObject({ ok: false });
    expect(loopInputFieldNames()).not.toContain("amountOrScope");
    expect(loopInputFieldNames()).not.toContain("isNovelAction");
  });

  it("still requires the action's own fields", () => {
    const search = loopActionFor("research.search")!;
    expect(parseLoopActionInput(search, { source: "arxiv" })).toMatchObject({ ok: false, reason: expect.stringContaining("query") });
    expect(parseLoopActionInput(search, { query: "x" })).toMatchObject({ ok: false, reason: expect.stringContaining("source") });
  });

  it("registers every action with at least one bounded field", () => {
    for (const action of loopActions()) {
      const fields = Object.entries(action.inputFields);
      expect(fields.length, action.capabilityName).toBeGreaterThan(0);
      for (const [, spec] of fields) expect(spec.maxLength).toBeGreaterThan(0);
    }
  });
});
