/** PHASE 4 analysis. BENCHMARK ARTIFACT. */
import { readFileSync } from "node:fs";

type Run = Record<string, any>;
const { results, aborted } = JSON.parse(readFileSync("benchmark/raw/phase4-results.json", "utf8")) as {
  aborted: string | null;
  results: Run[];
};

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sortNum = (xs: number[]) => [...xs].sort((a, b) => a - b);
const median = (xs: number[]) => {
  const s = sortNum(xs);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const p95 = (xs: number[]) => {
  const s = sortNum(xs);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]!;
};

console.log(`ABORTED: ${aborted ?? "no"}`);
console.log(`RUNS: ${results.length}, success ${results.filter((r) => r.success).length}\n`);

// ---------------------------------------------------------------------------
console.log("=== PHASE 4A — OPUS ATTRIBUTION (n=1 each; do not overgeneralize) ===");
const opus = results.filter((r) => r.model === "claude-opus-5" && r.success);
console.log(["id".padEnd(14), "stdinKB".padStart(8), "A".padStart(7), "B".padStart(7), "C".padStart(7), "D".padStart(8), "entries".padStart(8), "turns".padStart(6), "lat".padStart(7), "TTFT".padStart(7)].join(" "));
for (const r of opus) {
  console.log(
    [
      r.id.padEnd(14),
      (r.stdinBytes / 1024).toFixed(1).padStart(8),
      String(r.accounting.A_adapterTokens).padStart(7),
      String(r.accounting.B_cacheCreation).padStart(7),
      String(r.accounting.C_cacheRead).padStart(7),
      String(r.accounting.D_totalFootprint).padStart(8),
      String(r.modelUsageEntryCount).padStart(8),
      String(r.turns).padStart(6),
      String(r.wallClockMs).padStart(7),
      String(r.ttftMs).padStart(7),
    ].join(" ")
  );
}
console.log("\n  per-entry breakdown:");
for (const r of opus) {
  console.log(`   ${r.id}:`);
  for (const e of r.modelUsageEntries as any[]) {
    console.log(
      `     ${e.model.padEnd(28)} in=${String(e.inputTokens).padStart(6)} out=${String(e.outputTokens).padStart(5)}` +
        ` cacheCr=${String(e.cacheCreationInputTokens).padStart(6)} cacheRd=${String(e.cacheReadInputTokens).padStart(6)} think=${e.thinkingTokens}`
    );
  }
}
if (opus.length === 2) {
  const [a, b] = opus as [Run, Run];
  const dKB = (b.stdinBytes - a.stdinBytes) / 1024;
  const dB = b.accounting.B_cacheCreation - a.accounting.B_cacheCreation;
  const slope = dB / dKB;
  const floor = a.accounting.B_cacheCreation - slope * (a.stdinBytes / 1024);
  console.log(`\n  Opus 2-point fit:  slope=${slope.toFixed(0)}/KB  implied floor=${Math.round(floor)}`);
  console.log(`  Haiku (Phase 3, n=12): slope=287/KB  floor≈7333`);
  console.log(`  -> slope comparable; floor materially LOWER for Opus (${Math.round(floor)} vs ~7333).`);
}

// ---------------------------------------------------------------------------
console.log("\n=== PHASE 4B — CONCURRENCY (Haiku, identical ~1KB input) ===");
console.log(
  ["N".padStart(3), "ok".padStart(4), "fail".padStart(5), "throttled".padStart(10), "rateLimEv".padStart(10), "medLat".padStart(8), "p95Lat".padStart(8), "maxLat".padStart(8), "medTTFT".padStart(8), "maxTTFT".padStart(8), "aggD".padStart(9), "valid".padStart(6)].join(" ")
);
const batches: Array<{ N: number; runs: Run[] }> = [];
for (const N of [1, 2, 4, 8]) {
  const runs = results.filter((r) => r.concurrency === N && r.id === `4B-N${N}`);
  if (!runs.length) continue;
  batches.push({ N, runs });
  const ok = runs.filter((r) => r.success);
  const lat = ok.map((r) => r.wallClockMs as number);
  const ttft = ok.map((r) => r.ttftMs as number).filter((x) => typeof x === "number");
  console.log(
    [
      String(N).padStart(3),
      String(ok.length).padStart(4),
      String(runs.length - ok.length).padStart(5),
      String(runs.filter((r) => r.failureCode === "throttled").length).padStart(10),
      String(runs.reduce((a, r) => a + (r.rateLimitEventCount as number), 0)).padStart(10),
      Math.round(median(lat)).toString().padStart(8),
      Math.round(p95(lat)).toString().padStart(8),
      Math.max(...lat).toString().padStart(8),
      Math.round(median(ttft)).toString().padStart(8),
      Math.max(...ttft).toString().padStart(8),
      ok.reduce((a, r) => a + (r.accounting.D_totalFootprint as number), 0).toString().padStart(9),
      `${ok.filter((r) => r.structuredValid).length}/${ok.length}`.padStart(6),
    ].join(" ")
  );
}

console.log("\n  latency degradation vs N=1:");
const base = batches.find((b) => b.N === 1)!;
const baseMed = median(base.runs.filter((r) => r.success).map((r) => r.wallClockMs as number));
for (const b of batches) {
  const m = median(b.runs.filter((r) => r.success).map((r) => r.wallClockMs as number));
  console.log(`    N=${String(b.N).padStart(2)}: medLat ${Math.round(m)}ms  (${(m / baseMed).toFixed(2)}x baseline)`);
}

console.log("\n  OBSERVATIONAL throughput (wall time for the whole batch):");
for (const b of batches) {
  const ok = b.runs.filter((r) => r.success);
  const batchWall = Math.max(...ok.map((r) => r.completionOffsetMs as number));
  console.log(
    `    N=${String(b.N).padStart(2)}: batch wall ${String(batchWall).padStart(6)}ms for ${ok.length} invocation(s)` +
      ` = ${(ok.length / (batchWall / 1000)).toFixed(2)} completed/sec`
  );
}
console.log("  (observational only: single trial per level, one workload, one machine)");

// ---------------------------------------------------------------------------
console.log("\n=== RATE LIMIT / ENTITLEMENT UTILIZATION (observed, not inferred) ===");
type U = { t: number; five: number; seven: number; id: string };
const points: U[] = [];
for (const r of results) {
  for (const ev of (r.rateLimitEvents ?? []) as any[]) {
    const w = ev.rate_limit_info?.unifiedWindows;
    if (!w) continue;
    points.push({
      t: r.completionOffsetMs as number,
      five: w.five_hour?.utilization,
      seven: w.seven_day?.utilization,
      id: r.id,
    });
  }
}
const fiveVals = points.map((p) => p.five).filter((x) => typeof x === "number");
const sevenVals = points.map((p) => p.seven).filter((x) => typeof x === "number");
console.log(`  rate_limit_event observations: ${points.length}`);
console.log(`  status values: ${[...new Set(results.flatMap((r) => (r.rateLimitEvents ?? []).map((e: any) => e.rate_limit_info?.status)))].join(", ")}`);
console.log(`  rateLimitType: ${[...new Set(results.flatMap((r) => (r.rateLimitEvents ?? []).map((e: any) => e.rate_limit_info?.rateLimitType)))].join(", ")}`);
console.log(`  overageStatus: ${[...new Set(results.flatMap((r) => (r.rateLimitEvents ?? []).map((e: any) => e.rate_limit_info?.overageStatus)))].join(", ")}`);
console.log(`  five_hour utilization : min=${Math.min(...fiveVals)} max=${Math.max(...fiveVals)}`);
console.log(`  seven_day utilization : min=${Math.min(...sevenVals)} max=${Math.max(...sevenVals)}`);
const resets = [...new Set(results.flatMap((r) => (r.rateLimitEvents ?? []).map((e: any) => e.rate_limit_info?.unifiedWindows?.five_hour?.resetsAt)))].filter(Boolean);
for (const rs of resets) console.log(`  five_hour resetsAt: ${rs} -> ${new Date((rs as number) * 1000).toISOString()}`);
const resets7 = [...new Set(results.flatMap((r) => (r.rateLimitEvents ?? []).map((e: any) => e.rate_limit_info?.unifiedWindows?.seven_day?.resetsAt)))].filter(Boolean);
for (const rs of resets7) console.log(`  seven_day resetsAt: ${rs} -> ${new Date((rs as number) * 1000).toISOString()}`);

// ---------------------------------------------------------------------------
console.log("\n=== ACCOUNTING (A/B/C/D/E/F) — Phase 4 runs ===");
const ok = results.filter((r) => r.success);
const tA = ok.reduce((a, r) => a + (r.accounting.A_adapterTokens as number), 0);
const tB = ok.reduce((a, r) => a + (r.accounting.B_cacheCreation as number), 0);
const tC = ok.reduce((a, r) => a + (r.accounting.C_cacheRead as number), 0);
const tE = ok.reduce((a, r) => a + ((r.costUSDDiagnostic as number) ?? 0), 0);
console.log(`  A adapter-counted   : ${tA.toLocaleString()}`);
console.log(`  B cacheCreation     : ${tB.toLocaleString()}`);
console.log(`  C cacheRead         : ${tC.toLocaleString()}`);
console.log(`  D total footprint   : ${(tA + tB + tC).toLocaleString()} (D/A = ${((tA + tB + tC) / tA).toFixed(2)}x)`);
console.log(`  E CLI estimate      : $${tE.toFixed(4)}  [diagnostic only]`);
console.log(`  F Max entitlement   : see utilization section — now OBSERVABLE as a fraction, not a token count`);

console.log("\n=== ISOLATION / SAFETY (all runs) ===");
console.log(`  childHasApiKey any     : ${results.some((r) => r.isolation?.childHasApiKey)}`);
console.log(`  forbiddenEnv any       : ${results.some((r) => (r.isolation?.forbiddenEnvPresent?.length ?? 0) > 0)}`);
console.log(`  cwdOutsideRepo all     : ${results.every((r) => r.isolation?.cwdOutsideRepo)}`);
console.log(`  cwdEmptyAfter all      : ${ok.every((r) => r.cwdEmptyAfter)}`);
console.log(`  webSearchRequests total: ${ok.reduce((a, r) => a + (r.webSearchRequests as number), 0)}`);
const surfaces = results.map((r) => JSON.stringify(r.initToolSurface)).filter((s) => s !== "null");
console.log(`  init tool surfaces observed: ${[...new Set(surfaces)].join(" | ")}`);
console.log(`  structured valid       : ${ok.filter((r) => r.structuredValid).length}/${ok.length}`);
console.log(`  turns distribution     : ${[...new Set(ok.map((r) => r.turns))].sort().join(",")}`);
