/**
 * Provider candidate routing (Phase 7D).
 *
 * The properties under test:
 *
 *  1. DEFAULTS ARE WHAT THEY CLAIM. Every tier resolves to Claude Max in
 *     `subscription_tokens` (Phase 7F/7H). `tierConfig` is DERIVED from the
 *     candidate list, so this is mechanically true rather than asserted.
 *  2. ROUTING IS DATA. Ordering and eligibility come from the configuration
 *     array; the router contains no provider-name branch, asserted structurally.
 *  3. ROUTING ONLY NARROWS. Nothing here can make a candidate eligible that the
 *     configuration did not already permit — routing is subordinate to
 *     authorization and can never widen it.
 *  4. NO FALLBACK. A multi-candidate list is not permission to try the second
 *     one; `authorizeRoute` still dispatches exactly once.
 *
 * Fixtures only; no live invocation.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { resetTestSchema, closeTestDb, withRollback } from "../testDb.js";
import * as schema from "../../src/db/schema.js";
import {
  providerCandidates,
  tierConfig,
  validateProviderCandidates,
  type ProviderCandidate,
} from "../../src/router/tierConfig.js";
import { MODEL_TIERS } from "../../src/router/types.js";
import * as quotaGuardrailModule from "../../src/governance/quotaGuardrail.js";
import { selectCandidates } from "../../src/router/modelRouter.js";

beforeAll(async () => {
  await resetTestSchema();
}, 30000);

afterAll(async () => {
  await closeTestDb();
});

const usd = { unit: "usd" as const, pricing: { inputPerToken: 0.000001, outputPerToken: 0.000005 } };

function candidate(overrides: Partial<ProviderCandidate> = {}): ProviderCandidate {
  return {
    provider: "anthropic",
    modelId: "model-a",
    tiers: ["CHEAP"],
    accounting: usd,
    capabilities: ["structured_output"],
    enabled: true,
    ...overrides,
  };
}

/** Forces a guardrail decision without touching real quota state. */
function stubGuardrail(decision: quotaGuardrailModule.QuotaGuardrailDecision) {
  return vi
    .spyOn(quotaGuardrailModule, "evaluateQuotaGuardrail")
    .mockResolvedValue({ decision, state: "OPEN", changed: false });
}

// ---------------------------------------------------------------------------

describe("shipped configuration (Claude Max primary, three-tier ladder)", () => {
  it("makes subscription-backed Claude the primary candidate for every tier", () => {
    expect(tierConfig.CHEAP).toMatchObject({
      provider: "claude_subscription",
      modelId: "claude-haiku-4-5-20251001",
    });
    expect(tierConfig.CHEAP.accounting.unit).toBe("subscription_tokens");

    expect(tierConfig.STRONG).toMatchObject({
      provider: "claude_subscription",
      modelId: "claude-opus-5",
    });
    expect(tierConfig.STRONG.accounting.unit).toBe("subscription_tokens");
  });

  it("ranks the subscription candidate first for EVERY tier, with any API alternative below it", () => {
    for (const tier of MODEL_TIERS) {
      const forTier = providerCandidates.filter((c) => c.enabled && c.tiers.includes(tier));
      expect(forTier.length).toBeGreaterThan(0);

      // Order is the ONLY thing that makes it primary — no branch decides this.
      expect(forTier[0]!.provider).toBe("claude_subscription");

      // MID deliberately ships with no API alternative: there is no VERIFIED
      // USD price for Sonnet 5 in this repository, and a fabricated rate would
      // land in budget_counters as if it were real money. Where an alternative
      // DOES exist it must rank below the subscription candidate.
      const apiIndex = forTier.findIndex((c) => c.provider === "anthropic");
      if (apiIndex !== -1) {
        expect(forTier.findIndex((c) => c.provider === "claude_subscription")).toBeLessThan(apiIndex);
      }
    }
  });

  it("keeps the API candidates configured and USD-accounted, as alternatives rather than fallbacks", () => {
    // CHEAP and STRONG only — MID has no API alternative (see the ordering test).
    const api = providerCandidates.filter((c) => c.provider === "anthropic");
    expect(api).toHaveLength(2);
    expect(api.flatMap((c) => c.tiers).sort()).toEqual(["CHEAP", "STRONG"]);
    for (const c of api) {
      expect(c.enabled).toBe(true);
      expect(c.accounting.unit).toBe("usd");
    }
    // Being present and enabled is NOT being a fallback: the router takes the
    // first eligible candidate and stops (asserted in the no-fallback suite).
  });

  it("resolves the full three-tier ladder to distinct Claude Max models", () => {
    // CHEAP -> Haiku, MID -> Sonnet, STRONG -> Opus. One provider, one resource
    // unit, three quality floors. The tier names a capability floor only — not
    // a price band and not a share of any provider's quota.
    expect(tierConfig.CHEAP).toMatchObject({
      provider: "claude_subscription",
      modelId: "claude-haiku-4-5-20251001",
    });
    expect(tierConfig.MID).toMatchObject({
      provider: "claude_subscription",
      modelId: "claude-sonnet-5",
    });
    expect(tierConfig.STRONG).toMatchObject({
      provider: "claude_subscription",
      modelId: "claude-opus-5",
    });

    for (const tier of ["CHEAP", "MID", "STRONG"] as const) {
      expect(tierConfig[tier].accounting.unit).toBe("subscription_tokens");
    }

    // Every tier resolves to a DIFFERENT model — a copy-paste in the candidate
    // list that pointed two tiers at one model would pass every other
    // assertion here.
    const models = (["CHEAP", "MID", "STRONG"] as const).map((t) => tierConfig[t].modelId);
    expect(new Set(models).size).toBe(3);
  });

  it("routes MID to Sonnet and nothing else, without disturbing CHEAP or STRONG", async () => {
    await withRollback(async (tx) => {
      const expected = {
        CHEAP: "claude-haiku-4-5-20251001",
        MID: "claude-sonnet-5",
        STRONG: "claude-opus-5",
      } as const;

      for (const tier of ["CHEAP", "MID", "STRONG"] as const) {
        const routing = await selectCandidates(tx, { tier }, providerCandidates);
        if (routing.status !== "routed") throw new Error(`expected ${tier} to route`);

        expect(routing.candidates[0]).toMatchObject({
          provider: "claude_subscription",
          modelId: expected[tier],
        });
        expect(routing.candidates[0]!.accounting.unit).toBe("subscription_tokens");

        // The other tiers' models are not merely ranked lower — they are not
        // eligible for this tier at all.
        const eligibleModels = routing.candidates.map((c) => c.modelId);
        for (const [otherTier, otherModel] of Object.entries(expected)) {
          if (otherTier !== tier) expect(eligibleModels).not.toContain(otherModel);
        }
      }
    });
  });

  it("stops the scan on a runtime refusal for MID too, exactly as for the other tiers", async () => {
    // The new tier inherits the Phase 7G rule rather than re-implementing it.
    const spy = vi
      .spyOn(quotaGuardrailModule, "evaluateQuotaGuardrail")
      .mockImplementation(async (_tx, input) =>
        input.provider === "claude_subscription"
          ? { decision: { decision: "REFUSE_QUOTA", reason: "five_hour_upper" }, state: "CLOSED", changed: false }
          : { decision: { decision: "ALLOW", reason: "not_configured" }, state: "OPEN", changed: false }
      );

    try {
      await withRollback(async (tx) => {
        const routing = await selectCandidates(tx, { tier: "MID" }, providerCandidates);
        expect(routing.status).toBe("no_eligible_candidate");
        if (routing.status !== "no_eligible_candidate") return;
        expect(routing.reason).toBe("quota_refused");
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("activates no local provider", () => {
    expect(providerCandidates.some((c) => (c.provider as string) === "local")).toBe(false);
    expect(providerCandidates.some((c) => c.accounting.unit === "local_tokens")).toBe(false);
  });

  it("leaves the quota guardrail DISABLED — Phase 7F activates no threshold behaviour", () => {
    expect(quotaGuardrailModule.quotaGuardrailConfig.claude_subscription!.enabled).toBe(false);
    expect(quotaGuardrailModule.quotaGuardrailConfig.claude_subscription!.fiveHour).toBeUndefined();
    expect(quotaGuardrailModule.quotaGuardrailConfig.claude_subscription!.sevenDay).toBeUndefined();
  });

  it("routes a real request to the subscription candidate first, ahead of the API one", async () => {
    await withRollback(async (tx) => {
      for (const tier of MODEL_TIERS) {
        const routing = await selectCandidates(tx, { tier }, providerCandidates);
        if (routing.status !== "routed") throw new Error("expected routed");

        expect(routing.candidates[0]!.provider).toBe("claude_subscription");
        expect(routing.candidates[0]!.accounting.unit).toBe("subscription_tokens");
        // Where an API alternative is configured (CHEAP/STRONG, not MID) it is
        // still eligible and still ranked — just second, never promoted.
        const api = routing.candidates.find((c) => c.provider === "anthropic");
        if (api) {
          expect(routing.candidates.indexOf(api)).toBeGreaterThan(0);
          expect(api.accounting.unit).toBe("usd");
        }
      }
    });
  });

  it("keeps usd and subscription_tokens as separate accounting dimensions", () => {
    for (const c of providerCandidates) {
      if (c.provider === "claude_subscription") expect(c.accounting.unit).toBe("subscription_tokens");
      if (c.provider === "anthropic") expect(c.accounting.unit).toBe("usd");
    }
  });

  it("passes its own validation", () => {
    expect(() => validateProviderCandidates()).not.toThrow();
  });
});

describe("candidate ordering and eligibility", () => {
  const list = [
    candidate({ provider: "claude_subscription", modelId: "first", accounting: { unit: "subscription_tokens" } }),
    candidate({ provider: "anthropic", modelId: "second" }),
    candidate({ provider: "openai", modelId: "third" }),
  ];

  it("returns candidates in configured order, not by provider name", async () => {
    await withRollback(async (tx) => {
      const routing = await selectCandidates(tx, { tier: "CHEAP" }, list);
      expect(routing.status).toBe("routed");
      if (routing.status !== "routed") return;
      expect(routing.candidates.map((c) => c.modelId)).toEqual(["first", "second", "third"]);
    });
  });

  it("re-ordering the configuration re-orders the result, with no code change", async () => {
    await withRollback(async (tx) => {
      const reversed = [...list].reverse();
      const routing = await selectCandidates(tx, { tier: "CHEAP" }, reversed);
      if (routing.status !== "routed") throw new Error("expected routed");
      expect(routing.candidates.map((c) => c.modelId)).toEqual(["third", "second", "first"]);
    });
  });

  it("excludes a disabled candidate", async () => {
    await withRollback(async (tx) => {
      const routing = await selectCandidates(
        tx,
        { tier: "CHEAP" },
        [candidate({ modelId: "off", enabled: false }), candidate({ modelId: "on" })]
      );
      if (routing.status !== "routed") throw new Error("expected routed");
      expect(routing.candidates.map((c) => c.modelId)).toEqual(["on"]);
      expect(routing.excluded).toEqual([{ provider: "anthropic", modelId: "off", reason: "disabled" }]);
    });
  });

  it("excludes a candidate that does not serve the requested tier", async () => {
    await withRollback(async (tx) => {
      const routing = await selectCandidates(
        tx,
        { tier: "STRONG" },
        [candidate({ modelId: "cheap-only", tiers: ["CHEAP"] }), candidate({ modelId: "strong", tiers: ["STRONG"] })]
      );
      if (routing.status !== "routed") throw new Error("expected routed");
      expect(routing.candidates.map((c) => c.modelId)).toEqual(["strong"]);
      expect(routing.excluded[0]!.reason).toBe("tier_mismatch");
    });
  });

  it("excludes a candidate missing a required capability", async () => {
    await withRollback(async (tx) => {
      const routing = await selectCandidates(
        tx,
        { tier: "CHEAP", requiredCapabilities: ["structured_output"] },
        [candidate({ modelId: "no-structured", capabilities: [] }), candidate({ modelId: "ok" })]
      );
      if (routing.status !== "routed") throw new Error("expected routed");
      expect(routing.candidates.map((c) => c.modelId)).toEqual(["ok"]);
      expect(routing.excluded[0]!.reason).toBe("capability_mismatch");
    });
  });

  it("excludes a candidate accounted in a unit the request does not permit", async () => {
    await withRollback(async (tx) => {
      const routing = await selectCandidates(
        tx,
        { tier: "CHEAP", allowedResourceUnits: ["usd"] },
        [
          candidate({ modelId: "tokens", accounting: { unit: "subscription_tokens" } }),
          candidate({ modelId: "dollars" }),
        ]
      );
      if (routing.status !== "routed") throw new Error("expected routed");
      expect(routing.candidates.map((c) => c.modelId)).toEqual(["dollars"]);
      expect(routing.excluded[0]!.reason).toBe("resource_mismatch");
    });
  });

  it("applies no resource restriction when the request states none", async () => {
    await withRollback(async (tx) => {
      const routing = await selectCandidates(
        tx,
        { tier: "CHEAP" },
        [candidate({ modelId: "tokens", accounting: { unit: "subscription_tokens" } })]
      );
      if (routing.status !== "routed") throw new Error("expected routed");
      expect(routing.candidates).toHaveLength(1);
    });
  });

  it("reports a deterministic reason when a candidate fails several checks at once", async () => {
    await withRollback(async (tx) => {
      // Disabled AND wrong tier AND wrong unit: `disabled` wins, every time.
      const doomed = candidate({
        modelId: "doomed",
        enabled: false,
        tiers: ["STRONG"],
        accounting: { unit: "subscription_tokens" },
      });
      for (let i = 0; i < 3; i++) {
        const routing = await selectCandidates(tx, { tier: "CHEAP", allowedResourceUnits: ["usd"] }, [doomed]);
        if (routing.status !== "no_eligible_candidate") throw new Error("expected failure");
        expect(routing.excluded[0]!.reason).toBe("disabled");
      }
    });
  });
});

describe("quota interaction", () => {
  const subscriptionOnly = [
    candidate({ provider: "claude_subscription", modelId: "sub", accounting: { unit: "subscription_tokens" } }),
  ];

  it.each([
    ["ALLOW", { decision: "ALLOW", reason: "below_threshold" }],
    ["UNKNOWN_ALLOWED", { decision: "UNKNOWN_ALLOWED", reason: "no_observation" }],
  ] as const)("keeps the candidate eligible on %s", async (_label, decision) => {
    const spy = stubGuardrail(decision as quotaGuardrailModule.QuotaGuardrailDecision);
    try {
      await withRollback(async (tx) => {
        const routing = await selectCandidates(tx, { tier: "CHEAP" }, subscriptionOnly);
        expect(routing.status).toBe("routed");
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("excludes the candidate on REFUSE_QUOTA", async () => {
    const spy = stubGuardrail({ decision: "REFUSE_QUOTA", reason: "five_hour_upper" });
    try {
      await withRollback(async (tx) => {
        const routing = await selectCandidates(tx, { tier: "CHEAP" }, subscriptionOnly);
        expect(routing.status).toBe("no_eligible_candidate");
        if (routing.status !== "no_eligible_candidate") return;
        expect(routing.reason).toBe("quota_refused");
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("excludes the candidate on PROVIDER_REJECTED", async () => {
    const spy = stubGuardrail({ decision: "PROVIDER_REJECTED", reason: "status_not_allowed" });
    try {
      await withRollback(async (tx) => {
        const routing = await selectCandidates(tx, { tier: "CHEAP" }, subscriptionOnly);
        if (routing.status !== "no_eligible_candidate") throw new Error("expected failure");
        expect(routing.reason).toBe("provider_unavailable");
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("never asks the guardrail about a statically excluded candidate", async () => {
    const spy = stubGuardrail({ decision: "ALLOW", reason: "below_threshold" });
    try {
      await withRollback(async (tx) => {
        await selectCandidates(tx, { tier: "CHEAP" }, [candidate({ enabled: false })]);
        expect(spy).not.toHaveBeenCalled();
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("a runtime refusal never promotes a lower-ranked provider (no silent fallback)", () => {
  /**
   * THE case Phase 7F created and Phase 7G must close. With Claude Max primary
   * and the billable API ranked behind it, a quota refusal on Max must NOT let
   * the scan fall through to the API candidate — that would convert a quota
   * refusal into unbudgeted spend, with no Policy decision and no record, which
   * amended Phase 10.6.7 forbids outright.
   *
   * Unreachable while the guardrail is disabled; armed the moment it is enabled.
   */
  it("refuses outright when the PRIMARY candidate is quota-refused, instead of routing to the API", async () => {
    const spy = vi
      .spyOn(quotaGuardrailModule, "evaluateQuotaGuardrail")
      .mockImplementation(async (_tx, input) =>
        input.provider === "claude_subscription"
          ? { decision: { decision: "REFUSE_QUOTA", reason: "five_hour_upper" }, state: "CLOSED", changed: false }
          : { decision: { decision: "ALLOW", reason: "not_configured" }, state: "OPEN", changed: false }
      );

    try {
      await withRollback(async (tx) => {
        const routing = await selectCandidates(tx, { tier: "CHEAP" }, providerCandidates);

        expect(routing.status).toBe("no_eligible_candidate");
        if (routing.status !== "no_eligible_candidate") return;
        expect(routing.reason).toBe("quota_refused");
        // The API candidate must not have been promoted into eligibility.
        expect(routing.excluded[0]).toMatchObject({
          provider: "claude_subscription",
          reason: "quota_refused",
        });
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses outright when the PRIMARY candidate's provider is rejected", async () => {
    const spy = vi
      .spyOn(quotaGuardrailModule, "evaluateQuotaGuardrail")
      .mockImplementation(async (_tx, input) =>
        input.provider === "claude_subscription"
          ? { decision: { decision: "PROVIDER_REJECTED", reason: "status_not_allowed" }, state: "OPEN", changed: false }
          : { decision: { decision: "ALLOW", reason: "not_configured" }, state: "OPEN", changed: false }
      );

    try {
      await withRollback(async (tx) => {
        const routing = await selectCandidates(tx, { tier: "STRONG" }, providerCandidates);
        expect(routing.status).toBe("no_eligible_candidate");
        if (routing.status !== "no_eligible_candidate") return;
        expect(routing.reason).toBe("provider_unavailable");
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("still skips CONFIGURATION mismatches and keeps scanning — only runtime refusals stop the scan", async () => {
    // A disabled or tier-mismatched candidate is a configuration fact about
    // which candidates apply at all, not a provider refusing work. Those must
    // continue to be skipped, or disabling a candidate would break routing.
    await withRollback(async (tx) => {
      const routing = await selectCandidates(
        tx,
        { tier: "CHEAP" },
        [
          candidate({ provider: "claude_subscription", modelId: "off", enabled: false }),
          candidate({ provider: "anthropic", modelId: "on" }),
        ]
      );
      if (routing.status !== "routed") throw new Error("expected routed");
      expect(routing.candidates.map((c) => c.modelId)).toEqual(["on"]);
    });
  });
});

describe("explicit routing failure", () => {
  it("returns an explicit failure with a reason, never an empty list", async () => {
    await withRollback(async (tx) => {
      const routing = await selectCandidates(tx, { tier: "CHEAP" }, [candidate({ enabled: false })]);
      expect(routing.status).toBe("no_eligible_candidate");
      if (routing.status !== "no_eligible_candidate") return;
      expect(routing.reason).toBe("disabled");
      expect(routing.excluded).toHaveLength(1);
    });
  });

  it("reports none_configured when there are no candidates at all", async () => {
    await withRollback(async (tx) => {
      const routing = await selectCandidates(tx, { tier: "CHEAP" }, []);
      if (routing.status !== "no_eligible_candidate") throw new Error("expected failure");
      expect(routing.reason).toBe("none_configured");
    });
  });

  it("does not satisfy a STRONG request with a CHEAP-only candidate", async () => {
    await withRollback(async (tx) => {
      const routing = await selectCandidates(tx, { tier: "STRONG" }, [candidate({ tiers: ["CHEAP"] })]);
      // No silent downgrade or upgrade — an explicit failure instead.
      expect(routing.status).toBe("no_eligible_candidate");
    });
  });
});

describe("boundaries", () => {
  it("creates no budget reservation while ranking", async () => {
    await withRollback(async (tx) => {
      const runId = randomUUID();
      await selectCandidates(tx, { tier: "CHEAP", runId }, providerCandidates);

      const counters = await tx.select().from(schema.budgetCounters);
      expect(counters).toHaveLength(0);
    });
  });

  it("executes no provider adapter, and contains no provider-name branch", () => {
    const source = readFileSync(path.join(process.cwd(), "src/router/modelRouter.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    // Isolate selectCandidates + its static helper from callModel, which
    // legitimately DOES dispatch.
    const start = code.indexOf("function staticExclusion");
    const end = code.indexOf("export async function authorizeRoute");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const routingCode = code.slice(start, end);

    // No adapter invocation inside the routing path.
    expect(routingCode).not.toMatch(/PROVIDERS\[/);
    expect(routingCode).not.toMatch(/callAnthropicModel|callOpenAiModel|callClaudeSubscriptionModel/);
    // And no hard-coded provider comparison driving the ordering.
    expect(routingCode).not.toMatch(/provider\s*===\s*["']/);
    expect(routingCode).not.toMatch(/["']anthropic["']|["']openai["']|["']claude_subscription["']/);
  });

  it("reads no raw utilization: quota is consumed as a policy result only", () => {
    const source = readFileSync(path.join(process.cwd(), "src/router/modelRouter.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    expect(code).not.toMatch(/utilization|fiveHour|sevenDay|observedAt|resetsAt/);
    expect(code).not.toMatch(/subscriptionQuotaState/);
  });

  it("carries no credential material in routing structures", async () => {
    await withRollback(async (tx) => {
      const routing = await selectCandidates(tx, { tier: "CHEAP" }, providerCandidates);
      const serialized = JSON.stringify(routing);
      expect(serialized).not.toMatch(/sk-ant-|api[_-]?key|secret|token"\s*:\s*"/i);
    });
  });
});

describe("configuration validation", () => {
  it("rejects a candidate with no tiers", () => {
    expect(() => validateProviderCandidates([candidate({ tiers: [] })])).toThrow(/at least one tier/);
  });

  it("rejects a duplicated tier", () => {
    expect(() => validateProviderCandidates([candidate({ tiers: ["CHEAP", "CHEAP"] })])).toThrow(/more than once/);
  });

  it("rejects an empty model id", () => {
    expect(() => validateProviderCandidates([candidate({ modelId: "  " })])).toThrow(/non-empty pinned model id/);
  });

  it("rejects a zero or negative price on a metered candidate", () => {
    // A zero rate would make billable work look free to the Budget Governor.
    expect(() =>
      validateProviderCandidates([
        candidate({ accounting: { unit: "usd", pricing: { inputPerToken: 0, outputPerToken: 0.000005 } } }),
      ])
    ).toThrow(/finite positive rate/);
    expect(() =>
      validateProviderCandidates([
        candidate({ accounting: { unit: "usd", pricing: { inputPerToken: 0.000001, outputPerToken: -1 } } }),
      ])
    ).toThrow(/finite positive rate/);
  });
});
