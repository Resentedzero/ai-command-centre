/**
 * V1.1: an Agent's execution profile may restrict routing to one configured provider.
 * The Router then serves the call from that provider's candidates or refuses it; it
 * never switches provider (spec §10.6.7, no silent API fallback).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { resetTestSchema, withRollback } from "../testDb.js";

vi.mock("../../src/router/providers/anthropic.js", () => ({ callAnthropicModel: vi.fn() }));
vi.mock("../../src/router/providers/openai.js", () => ({ callOpenAiModel: vi.fn() }));
vi.mock("../../src/router/providers/claudeSubscription.js", () => ({ callClaudeSubscriptionModel: vi.fn() }));

import { selectCandidates } from "../../src/router/modelRouter.js";
import { providerCandidates } from "../../src/router/tierConfig.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

describe("requiredProvider", () => {
  it("keeps only the required provider's candidates, in configured order", async () => {
    await withRollback(async (tx) => {
      const routing = await selectCandidates(tx, { tier: "CHEAP", requiredProvider: "claude_subscription" }, providerCandidates);
      expect(routing.status).toBe("routed");
      if (routing.status !== "routed") return;
      expect(routing.candidates.map((c) => c.provider)).toEqual(["claude_subscription"]);
      expect(routing.excluded).toEqual(expect.arrayContaining([{ provider: "anthropic", modelId: "claude-haiku-4-5-20251001", reason: "provider_mismatch" }]));
    });
  });

  it("refuses rather than serving another provider when the required one has no candidate", async () => {
    await withRollback(async (tx) => {
      const routing = await selectCandidates(tx, { tier: "CHEAP", requiredProvider: "openai" }, providerCandidates);
      expect(routing).toMatchObject({ status: "no_eligible_candidate", reason: "provider_mismatch" });
    });
  });

  it("changes nothing when absent", async () => {
    await withRollback(async (tx) => {
      const routing = await selectCandidates(tx, { tier: "CHEAP" }, providerCandidates);
      expect(routing.status === "routed" && routing.candidates[0]!.provider).toBe("claude_subscription");
    });
  });
});
