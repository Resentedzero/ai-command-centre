/**
 * PHASE 2 workload definitions. BENCHMARK ARTIFACT — nothing in `src/` imports it.
 *
 * Every context is DETERMINISTIC: generated from fixed literals and index
 * arithmetic, never randomness or a clock. Re-running the suite produces
 * byte-identical stdin, so repeated measurements differ only because the
 * provider differs — which is the entire point of the repeatability pass.
 *
 * No workload provides tools, permits an external action, or can alter workflow
 * topology. Each asks only for a bounded structured result.
 */
import type { CompiledContext } from "../src/context/types.js";

export type Workload = {
  id: string;
  label: string;
  schema: Record<string, unknown>;
  context: CompiledContext;
  /** Strict validator — returns [] when the payload matches exactly. */
  validate: (value: unknown) => string[];
};

// ---------------------------------------------------------------------------
// Minimal strict validation helpers (no new dependency — a few lines suffice)
// ---------------------------------------------------------------------------

function expectObject(value: unknown, required: string[]): { errors: string[]; obj: Record<string, unknown> } {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { errors: ["not a JSON object"], obj: {} };
  }
  const obj = value as Record<string, unknown>;
  for (const key of required) if (!(key in obj)) errors.push(`missing required key "${key}"`);
  for (const key of Object.keys(obj)) if (!required.includes(key)) errors.push(`unexpected key "${key}"`);
  return { errors, obj };
}

function expectStringArray(obj: Record<string, unknown>, key: string, errors: string[]): void {
  const v = obj[key];
  if (!Array.isArray(v)) {
    errors.push(`"${key}" is not an array`);
    return;
  }
  v.forEach((item, i) => {
    if (typeof item !== "string") errors.push(`"${key}[${i}]" is not a string`);
  });
}

function expectString(obj: Record<string, unknown>, key: string, errors: string[]): void {
  if (typeof obj[key] !== "string") errors.push(`"${key}" is not a string`);
}

// ---------------------------------------------------------------------------
// Deterministic synthetic corpora
// ---------------------------------------------------------------------------

const FINDING_TEMPLATES = [
  "Decoder latency, not physical qubit count, is the binding constraint on logical cycle time.",
  "Surface-code distances beyond 7 show diminishing returns at present physical error rates.",
  "Below-threshold operation has been reported on small logical qubits by several groups.",
  "Cryogenic control wiring density is emerging as a packaging bottleneck above 1000 qubits.",
  "Real-time decoding requires sustained classical throughput measured in Gb/s per logical qubit.",
  "Error-correction overhead currently dominates the physical-to-logical qubit ratio.",
  "Leakage errors outside the computational subspace degrade code performance disproportionately.",
  "Calibration drift over multi-hour runs is under-reported in published benchmarks.",
];

/** Builds a deterministic document set of a requested size. */
function buildDocuments(count: number, paragraphsPerDoc: number): string {
  const docs: string[] = [];
  for (let d = 0; d < count; d++) {
    const paras: string[] = [];
    for (let p = 0; p < paragraphsPerDoc; p++) {
      const base = FINDING_TEMPLATES[(d + p) % FINDING_TEMPLATES.length];
      paras.push(
        `Paragraph ${p + 1}. ${base} Measurements in this section were taken on apparatus ` +
          `configuration ${d}-${p}, over ${(d + 1) * (p + 2)} runs, with reported variance of ` +
          `${((d + p) % 9) + 1}%. The authors note that configuration ${d}-${p} differs from the ` +
          `preceding section principally in readout integration time.`
      );
    }
    docs.push(`--- DOCUMENT ${d + 1} (source: synthetic-corpus/doc-${d + 1}) ---\n${paras.join("\n")}`);
  }
  return docs.join("\n\n");
}

function ctx(instructions: string, constraints: string, artifacts: string, taskState = ""): CompiledContext {
  return {
    layers: { instructions, constraints, taskState, memory: "", artifacts, toolSchemas: [] },
    provenance: { included: [], excluded: [] },
    estimatedInputTokens: Math.ceil(artifacts.length / 4),
  };
}

// ---------------------------------------------------------------------------
// W1 — small structured research synthesis
// ---------------------------------------------------------------------------

const W1_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    key_findings: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    recommendation: { type: "string" },
  },
  required: ["summary", "key_findings", "risks", "recommendation"],
  additionalProperties: false,
};

const W1_REQUIRED = ["summary", "key_findings", "risks", "recommendation"];

// ---------------------------------------------------------------------------
// W4 — structured transformation
// ---------------------------------------------------------------------------

const W4_RECORDS = [
  { id: "r-001", raw: "Jane Okafor | jane.okafor@example.invalid | Engineering | 2024-03-11 | active" },
  { id: "r-002", raw: "Luis Martins | luis.martins@example.invalid | Research | 2023-11-02 | inactive" },
  { id: "r-003", raw: "Priya Raman | priya.raman@example.invalid | Engineering | 2025-01-27 | active" },
  { id: "r-004", raw: "Tomas Novak | tomas.novak@example.invalid | Operations | 2022-07-19 | active" },
];

const W4_SCHEMA = {
  type: "object",
  properties: {
    records: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          department: { type: "string" },
          start_date: { type: "string" },
          active: { type: "boolean" },
        },
        required: ["id", "name", "department", "start_date", "active"],
        additionalProperties: false,
      },
    },
    active_count: { type: "number" },
  },
  required: ["records", "active_count"],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// W5 — bounded multi-step reasoning
// ---------------------------------------------------------------------------

const W5_SCHEMA = {
  type: "object",
  properties: {
    ordered_steps: { type: "array", items: { type: "string" } },
    blocked_by: { type: "array", items: { type: "string" } },
    critical_path_length: { type: "number" },
    rationale: { type: "string" },
  },
  required: ["ordered_steps", "blocked_by", "critical_path_length", "rationale"],
  additionalProperties: false,
};

export const WORKLOADS: Workload[] = [
  {
    id: "W1-small-synthesis",
    label: "Small structured research synthesis",
    schema: W1_SCHEMA,
    context: ctx(
      "You are a research synthesis function inside an automated orchestration runtime. " +
        "Synthesize the retrieved findings below into a bounded structured report. " +
        "Do not take any action and do not use any tool.",
      "At most 4 key_findings and at most 3 risks. Each entry is one sentence.",
      "RETRIEVED FINDINGS:\n" + FINDING_TEMPLATES.slice(0, 4).map((f, i) => `${i + 1}. ${f}`).join("\n"),
      'TASK: {"taskInstanceId":"bench-w1","intent":"synthesize_research"}'
    ),
    validate: (value) => {
      const { errors, obj } = expectObject(value, W1_REQUIRED);
      if (errors.length && errors[0] === "not a JSON object") return errors;
      expectString(obj, "summary", errors);
      expectString(obj, "recommendation", errors);
      expectStringArray(obj, "key_findings", errors);
      expectStringArray(obj, "risks", errors);
      return errors;
    },
  },
  {
    id: "W2-medium-synthesis",
    label: "Medium context research synthesis (dedup, contradictions, grouping)",
    schema: W1_SCHEMA,
    context: ctx(
      "You are a research synthesis function inside an automated orchestration runtime. " +
        "The retrieved documents below overlap and in places contradict each other. " +
        "Deduplicate repeated claims, group evidence by theme, surface contradictions, " +
        "and give one concise recommendation. Do not take any action and do not use any tool.",
      "At most 5 key_findings. Contradictions belong in risks. Each entry is one sentence.",
      "RETRIEVED DOCUMENTS:\n" + buildDocuments(6, 4),
      'TASK: {"taskInstanceId":"bench-w2","intent":"synthesize_research"}'
    ),
    validate: (value) => {
      const { errors, obj } = expectObject(value, W1_REQUIRED);
      if (errors.length && errors[0] === "not a JSON object") return errors;
      expectString(obj, "summary", errors);
      expectString(obj, "recommendation", errors);
      expectStringArray(obj, "key_findings", errors);
      expectStringArray(obj, "risks", errors);
      return errors;
    },
  },
  {
    id: "W3-large-synthesis",
    label: "Large context research synthesis",
    schema: W1_SCHEMA,
    context: ctx(
      "You are a research synthesis function inside an automated orchestration runtime. " +
        "Synthesize the large retrieved corpus below. Deduplicate, group by theme, surface " +
        "contradictions, and give one concise recommendation. Do not take any action and do not use any tool.",
      "At most 5 key_findings. Each entry is one sentence.",
      "RETRIEVED DOCUMENTS:\n" + buildDocuments(28, 10),
      'TASK: {"taskInstanceId":"bench-w3","intent":"synthesize_research"}'
    ),
    validate: (value) => {
      const { errors, obj } = expectObject(value, W1_REQUIRED);
      if (errors.length && errors[0] === "not a JSON object") return errors;
      expectString(obj, "summary", errors);
      expectString(obj, "recommendation", errors);
      expectStringArray(obj, "key_findings", errors);
      expectStringArray(obj, "risks", errors);
      return errors;
    },
  },
  {
    id: "W4-transformation",
    label: "Structured transformation (minimal reasoning, strict schema)",
    schema: W4_SCHEMA,
    context: ctx(
      "You are a deterministic record-transformation function. Parse each pipe-delimited raw " +
        "record into the required structured shape. Do not take any action and do not use any tool.",
      'Fields are: name | email | department | start_date | status. Map status "active" to ' +
        "active=true and anything else to false. Drop the email. active_count is the number of active records.",
      "RECORDS:\n" + W4_RECORDS.map((r) => `${r.id}: ${r.raw}`).join("\n"),
      'TASK: {"taskInstanceId":"bench-w4","intent":"transform_records"}'
    ),
    validate: (value) => {
      const { errors, obj } = expectObject(value, ["records", "active_count"]);
      if (errors.length && errors[0] === "not a JSON object") return errors;
      if (typeof obj.active_count !== "number") errors.push('"active_count" is not a number');
      if (!Array.isArray(obj.records)) {
        errors.push('"records" is not an array');
        return errors;
      }
      obj.records.forEach((rec, i) => {
        const r = expectObject(rec, ["id", "name", "department", "start_date", "active"]);
        r.errors.forEach((e) => errors.push(`records[${i}]: ${e}`));
        if (r.errors[0] === "not a JSON object") return;
        if (typeof r.obj.active !== "boolean") errors.push(`records[${i}]: "active" is not a boolean`);
        for (const k of ["id", "name", "department", "start_date"]) {
          if (typeof r.obj[k] !== "string") errors.push(`records[${i}]: "${k}" is not a string`);
        }
      });
      // Ground truth: 3 of the 4 fixture records are active.
      if (obj.records.length !== 4) errors.push(`expected 4 records, got ${obj.records.length}`);
      if (obj.active_count !== 3) errors.push(`expected active_count 3, got ${String(obj.active_count)}`);
      return errors;
    },
  },
  {
    id: "W5-bounded-reasoning",
    label: "Bounded multi-step reasoning (dependency ordering)",
    schema: W5_SCHEMA,
    context: ctx(
      "You are a planning function inside an automated orchestration runtime. Given the task " +
        "dependency list below, produce a valid execution order and identify which tasks are " +
        "blocked. Do not take any action, do not use any tool, and do not propose changes to the " +
        "workflow structure itself.",
      "ordered_steps must be a topological order of all task ids. blocked_by lists task ids that " +
        "have at least one unmet dependency at the start. critical_path_length is the number of " +
        "tasks on the longest dependency chain.",
      [
        "TASKS (id: depends_on):",
        "T1: (none)",
        "T2: T1",
        "T3: T1",
        "T4: T2, T3",
        "T5: T4",
        "T6: (none)",
        "T7: T6",
        "T8: T5, T7",
      ].join("\n"),
      'TASK: {"taskInstanceId":"bench-w5","intent":"plan_execution"}'
    ),
    validate: (value) => {
      const { errors, obj } = expectObject(value, [
        "ordered_steps",
        "blocked_by",
        "critical_path_length",
        "rationale",
      ]);
      if (errors.length && errors[0] === "not a JSON object") return errors;
      expectStringArray(obj, "ordered_steps", errors);
      expectStringArray(obj, "blocked_by", errors);
      expectString(obj, "rationale", errors);
      if (typeof obj.critical_path_length !== "number") errors.push('"critical_path_length" is not a number');
      if (Array.isArray(obj.ordered_steps) && obj.ordered_steps.length !== 8) {
        errors.push(`expected 8 ordered_steps, got ${obj.ordered_steps.length}`);
      }
      return errors;
    },
  },
];
