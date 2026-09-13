/** PHASE 3 analysis. BENCHMARK ARTIFACT. */
import { readFileSync } from "node:fs";

type Run = Record<string, any>;
const { results } = JSON.parse(readFileSync("benchmark/raw/phase3-results.json", "utf8")) as { results: Run[] };
const ok = results.filter((r) => r.success);

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const cv = (xs: number[]) => {
  const m = mean(xs);
  if (!m) return 0;
  return (Math.sqrt(mean(xs.map((x) => (x - m) ** 2))) / m) * 100;
};

const group = (id: string) => ok.filter((r) => r.id === id);

console.log(`RUNS ${results.length} total / ${ok.length} success / ${results.length - ok.length} failed\n`);

// ---------------------------------------------------------------------------
console.log("=== SIZE SWEEP (Haiku, structured, n=3) ===");
console.log(
  ["id".padEnd(15), "stdinKB".padStart(8), "A".padStart(8), "B:cacheCr".padStart(10), "C:cacheRd".padStart(10), "D".padStart(8), "Bcv%".padStart(6), "turns".padStart(7), "medLat".padStart(8)].join(" ")
);
const sweep: Array<{ id: string; kb: number; A: number; B: number }> = [];
for (const id of ["A-minimal", "B-tiny-1kb", "C-medium-9kb", "D-large-95kb"]) {
  const rs = group(id);
  const B = rs.map((r) => r.accounting.B_cacheCreation as number);
  const A = rs.map((r) => r.accounting.A_adapterTokens as number);
  const C = rs.map((r) => r.accounting.C_cacheRead as number);
  const kb = (rs[0]!.stdinBytes as number) / 1024;
  sweep.push({ id, kb, A: mean(A), B: mean(B) });
  console.log(
    [
      id.padEnd(15),
      kb.toFixed(1).padStart(8),
      Math.round(mean(A)).toString().padStart(8),
      Math.round(mean(B)).toString().padStart(10),
      Math.round(mean(C)).toString().padStart(10),
      Math.round(mean(A) + mean(B) + mean(C)).toString().padStart(8),
      cv(B).toFixed(1).padStart(6),
      [...new Set(rs.map((r) => r.numTurns))].join("/").padStart(7),
      Math.round(median(rs.map((r) => r.wallClockMs as number))).toString().padStart(8),
    ].join(" ")
  );
}

// --- Linear model: B = floor + slope * KB (least squares) -------------------
console.log("\n=== CACHE-CREATION ATTRIBUTION MODEL ===");
const n = sweep.length;
const sx = sweep.reduce((a, s) => a + s.kb, 0);
const sy = sweep.reduce((a, s) => a + s.B, 0);
const sxy = sweep.reduce((a, s) => a + s.kb * s.B, 0);
const sxx = sweep.reduce((a, s) => a + s.kb * s.kb, 0);
const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
const floor = (sy - slope * sx) / n;
console.log(`  least-squares fit:  B ≈ ${Math.round(floor)} + ${slope.toFixed(1)} * KB(stdin)`);
console.log(`  observed zero-context floor (A-minimal): ${Math.round(sweep[0]!.B)}`);
console.log("  marginal cost between adjacent sizes:");
for (let i = 1; i < sweep.length; i++) {
  const dKB = sweep[i]!.kb - sweep[i - 1]!.kb;
  const dB = sweep[i]!.B - sweep[i - 1]!.B;
  console.log(`    ${sweep[i - 1]!.id} -> ${sweep[i]!.id}: +${Math.round(dB)} tokens over +${dKB.toFixed(1)}KB = ${(dB / dKB).toFixed(0)}/KB`);
}
const smallest = sweep[0]!;
const largest = sweep[sweep.length - 1]!;
console.log(`  floor share at 0KB: 100%   at ${largest.kb.toFixed(0)}KB: ${((floor / largest.B) * 100).toFixed(0)}%`);

// ---------------------------------------------------------------------------
console.log("\n=== CACHE REUSE (C: cacheReadInputTokens) ===");
const withRead = ok.filter((r) => (r.accounting.C_cacheRead as number) > 0);
console.log(`  runs with C > 0: ${withRead.length}/${ok.length}`);
for (const r of withRead) {
  console.log(`   - ${r.id} rep${r.rep}: C=${r.accounting.C_cacheRead} B=${r.accounting.B_cacheCreation} turns=${r.numTurns}`);
}
const eRuns = group("E-repeat");
console.log(`  E-repeat (identical stdin, fresh subprocess each): C = [${eRuns.map((r) => r.accounting.C_cacheRead).join(", ")}]`);
console.log(`  E-repeat B = [${eRuns.map((r) => r.accounting.B_cacheCreation).join(", ")}] (CV ${cv(eRuns.map((r) => r.accounting.B_cacheCreation as number)).toFixed(2)}%)`);
console.log(`  turns distribution among C>0 runs: ${[...new Set(withRead.map((r) => r.numTurns))].join(",")}`);

// ---------------------------------------------------------------------------
console.log("\n=== F: STRUCTURED vs PLAIN (same 1KB context, Haiku, n=3) ===");
const fs_ = group("F-structured");
const fp = group("F-plain");
const row = (label: string, rs: Run[]) =>
  console.log(
    [
      label.padEnd(14),
      Math.round(mean(rs.map((r) => r.accounting.A_adapterTokens as number))).toString().padStart(8),
      Math.round(mean(rs.map((r) => r.accounting.B_cacheCreation as number))).toString().padStart(10),
      Math.round(mean(rs.map((r) => r.accounting.D_totalFootprint as number))).toString().padStart(9),
      [...new Set(rs.map((r) => r.numTurns))].join("/").padStart(7),
      Math.round(median(rs.map((r) => r.wallClockMs as number))).toString().padStart(8),
      String(rs[0]!.argvHasJsonSchema).padStart(11),
      [...new Set(rs.map((r) => r.stopReason))].join("/").padStart(10),
    ].join(" ")
  );
console.log(["mode".padEnd(14), "A".padStart(8), "B:cacheCr".padStart(10), "D".padStart(9), "turns".padStart(7), "medLat".padStart(8), "jsonSchema".padStart(11), "stop".padStart(10)].join(" "));
row("F-structured", fs_);
row("F-plain", fp);
const dB = mean(fs_.map((r) => r.accounting.B_cacheCreation as number)) - mean(fp.map((r) => r.accounting.B_cacheCreation as number));
const dA = mean(fs_.map((r) => r.accounting.A_adapterTokens as number)) - mean(fp.map((r) => r.accounting.A_adapterTokens as number));
console.log(`  delta B (structured - plain): ${dB > 0 ? "+" : ""}${Math.round(dB)} tokens (${((dB / mean(fp.map((r) => r.accounting.B_cacheCreation as number))) * 100).toFixed(1)}%)`);
console.log(`  delta A (structured - plain): ${dA > 0 ? "+" : ""}${Math.round(dA)} tokens`);
console.log(`  structured output valid: ${fs_.filter((r) => r.structuredOutputValid).length}/${fs_.length}`);
console.log(`  plain produced structured_output field: ${fp.filter((r) => r.structuredOutputPresent).length}/${fp.length}`);

// ---------------------------------------------------------------------------
console.log("\n=== G: SECURITY / TOOL SURFACE ===");
const g1 = group("G1-init-surface")[0];
if (g1) {
  console.log(`  init event tool surface : ${JSON.stringify(g1.initEventToolSurface?.tools)}`);
  console.log(`  init event mcp_servers  : ${JSON.stringify(g1.initEventToolSurface?.mcp_servers)}`);
  console.log(`  stream event types      : ${JSON.stringify(g1.streamEventTypes)}`);
}
const g2 = group("G2-web-attempt");
console.log(`  G2 runs: ${g2.length}, webSearchRequests total: ${g2.reduce((a, r) => a + (r.webSearchRequests as number), 0)}`);
for (const r of g2) console.log(`   - rep${r.rep}: server_tool_use=${JSON.stringify(r.topLevel.server_tool_use)}`);

// ---------------------------------------------------------------------------
console.log("\n=== INTERNAL SECONDARY CALL (modelUsage vs top-level input) ===");
console.log(["id".padEnd(15), "rep".padStart(4), "top.in".padStart(8), "mu.in".padStart(8), "delta".padStart(8), "entries".padStart(8)].join(" "));
for (const id of ["A-minimal", "B-tiny-1kb", "C-medium-9kb", "D-large-95kb"]) {
  for (const r of group(id)) {
    const muIn = (r.modelUsageEntries as any[]).reduce((a, e) => a + (e.inputTokens ?? 0), 0);
    console.log(
      [id.padEnd(15), String(r.rep).padStart(4), String(r.topLevel.input_tokens).padStart(8), String(muIn).padStart(8), String(muIn - r.topLevel.input_tokens).padStart(8), String(r.modelUsageEntryCount).padStart(8)].join(" ")
    );
  }
}

// ---------------------------------------------------------------------------
console.log("\n=== ACCOUNTING SUMMARY (A/B/C/D/E/F) ===");
const totA = ok.reduce((a, r) => a + (r.accounting.A_adapterTokens as number), 0);
const totB = ok.reduce((a, r) => a + (r.accounting.B_cacheCreation as number), 0);
const totC = ok.reduce((a, r) => a + (r.accounting.C_cacheRead as number), 0);
const totE = ok.reduce((a, r) => a + ((r.costUSDDiagnostic as number) ?? 0), 0);
console.log(`  A adapter-counted tokens      : ${totA.toLocaleString()}`);
console.log(`  B cache-creation tokens       : ${totB.toLocaleString()}`);
console.log(`  C cache-read tokens           : ${totC.toLocaleString()}`);
console.log(`  D total reported footprint    : ${(totA + totB + totC).toLocaleString()}  (D/A = ${((totA + totB + totC) / totA).toFixed(2)}x)`);
console.log(`  E CLI monetary estimate       : $${totE.toFixed(4)}  [diagnostic only, costBasis="list"]`);
console.log(`  F actual Max entitlement      : UNKNOWN / UNOBSERVABLE`);

const apiCost = ok.reduce((a, r) => {
  const muIn = (r.modelUsageEntries as any[]).reduce((s, e) => s + (e.inputTokens ?? 0), 0);
  const muOut = (r.modelUsageEntries as any[]).reduce((s, e) => s + (e.outputTokens ?? 0), 0);
  return a + muIn * 0.000001 + muOut * 0.000005;
}, 0);
console.log(`\n  analytical API equivalent (Haiku list, cacheCreation EXCLUDED): $${apiCost.toFixed(4)}`);
const apiWithCache = apiCost + totB * 0.000001;
console.log(`  sensitivity: if cacheCreation were billed as API input: $${apiWithCache.toFixed(4)}`);

console.log("\n=== ISOLATION (all runs) ===");
const iso = results.map((r) => r.isolation);
console.log(`  cwdOutsideRepo all true : ${iso.every((i: any) => i.cwdOutsideRepo)}`);
console.log(`  childHasApiKey any      : ${iso.some((i: any) => i.childHasApiKey)}`);
console.log(`  forbiddenEnv any        : ${iso.some((i: any) => i.forbiddenEnvPresent.length > 0)}`);
console.log(`  toolsEmpty all true     : ${iso.every((i: any) => i.toolsEmpty)}`);
console.log(`  strictMcp all true      : ${iso.every((i: any) => i.strictMcp)}`);
console.log(`  cwdEmptyAfter all true  : ${ok.every((r) => r.cwdEmptyAfter)}`);
