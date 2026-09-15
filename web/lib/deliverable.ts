/**
 * The human presentation of a document-like Artifact. The Artifact (bytes, hash,
 * provenance) stays the machine truth; this only reads its stored content.
 *
 * - `deliverable` / `keeper_answer`: `{ format: "deliverable/v1", title, summary,
 *   body, findings?, recommendations?, sources?, completion?, basis? }`, written
 *   by the runtime (`src/capabilities/shared/deliverable.ts`).
 * - `report` (V1): `{ report: "<markdown>" }`.
 *
 * Anything else, or content that doesn't parse as that shape, is not a document:
 * the Raw view shows it as stored.
 */

export const DOCUMENT_TYPES: ReadonlySet<string> = new Set(["deliverable", "report", "keeper_answer"]);

export type DeliverableSource = { label: string; ref: string | null; artifactId: string | null; origin: string | null };

/** How the evidence behind a document was obtained, as recorded by the runtime (never the model's claim). */
export type EvidenceBasis = {
  externalResearch: boolean;
  evidence: { capability: string; evidenceClass: string; calls: number }[];
  note: string | null;
};

export type Deliverable = {
  title: string | null;
  summary: string | null;
  body: string;
  findings: string[];
  recommendations: string[];
  sources: DeliverableSource[];
  completion: { status: string; reason: string | null } | null;
  basis: EvidenceBasis | null;
};

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const texts = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : []);

function sources(v: unknown): DeliverableSource[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((s) => {
    if (s === null || typeof s !== "object") return [];
    const r = s as Record<string, unknown>;
    const label = text(r.label);
    return label ? [{ label, ref: text(r.ref), artifactId: text(r.artifactId), origin: text(r.origin) }] : [];
  });
}

function basis(v: unknown): EvidenceBasis | null {
  if (v === null || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r.externalResearch !== "boolean") return null;
  const evidence = Array.isArray(r.evidence)
    ? r.evidence.flatMap((e) => {
        if (e === null || typeof e !== "object") return [];
        const x = e as Record<string, unknown>;
        const capability = text(x.capability);
        const evidenceClass = text(x.evidenceClass);
        return capability && evidenceClass ? [{ capability, evidenceClass, calls: typeof x.calls === "number" ? x.calls : 0 }] : [];
      })
    : [];
  return { externalResearch: r.externalResearch, evidence, note: text(r.note) };
}

/** The readable document in an Artifact's stored content, or null when there isn't one. */
export function parseDeliverable(type: string, content: string | null | undefined): Deliverable | null {
  if (!DOCUMENT_TYPES.has(type) || typeof content !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const r = parsed as Record<string, unknown>;

  if (type === "report") {
    const body = text(r.report);
    return body === null ? null : { title: null, summary: null, body, findings: [], recommendations: [], sources: [], completion: null, basis: null };
  }

  const body = text(r.body);
  if (r.format !== "deliverable/v1" || body === null) return null;
  const c = r.completion as Record<string, unknown> | null | undefined;
  return {
    title: text(r.title),
    summary: text(r.summary),
    body,
    findings: texts(r.findings),
    recommendations: texts(r.recommendations),
    sources: sources(r.sources),
    completion: c && typeof c === "object" && text(c.status) ? { status: c.status as string, reason: text(c.reason) } : null,
    basis: basis(r.basis),
  };
}

/** One line saying what the evidence was, so a document never implies research that didn't happen. */
export function basisLine(b: EvidenceBasis): string {
  const kinds = new Set(b.evidence.map((e) => e.evidenceClass));
  const parts: string[] = [];
  if (kinds.has("external")) parts.push("external sources");
  if (kinds.has("local_corpus")) parts.push("local documents already held");
  if (kinds.has("fixture")) parts.push("fixture (test) data, not real research");
  if (parts.length === 0) parts.push("the model's own knowledge only");
  return `${b.externalResearch ? "External research was performed." : "No external research was performed."} Evidence: ${parts.join("; ")}.`;
}
