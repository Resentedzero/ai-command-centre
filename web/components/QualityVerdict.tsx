"use client";

import { useCallback, useEffect, useState } from "react";
import { getQualityVerdicts, recordQualityVerdict, type QualityVerdict as Verdict, type QualityVerdictRecord } from "../lib/api";
import { errorText, formatTime } from "../lib/keep";
import { PixelButton, Skeleton, cx, px } from "./pixel/Pixel";

const QUALITY_VERDICTS: readonly Verdict[] = ["POOR", "ACCEPTABLE", "GOOD", "EXCELLENT"];

/**
 * Quality verdict (R2): the operator's judgement of how good an artifact is. Separate from
 * approval (which only lets an action happen), recorded with its history, and only the latest
 * one counts toward the producing agent's XP. It grants the agent nothing.
 */
export function QualityVerdictControl({ artifactId }: { artifactId: string }) {
  const [history, setHistory] = useState<QualityVerdictRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Verdict | null>(null);
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setHistory((await getQualityVerdicts(artifactId)).verdicts);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err));
    }
  }, [artifactId]);
  useEffect(() => {
    setHistory(null);
    setChosen(null);
    setSaved(null);
    void load();
  }, [load]);

  async function save() {
    if (!chosen) return;
    setBusy(true);
    setSaveError(null);
    try {
      const r = await recordQualityVerdict({ artifactId, verdict: chosen, ...(rationale.trim() ? { rationale: rationale.trim() } : {}) });
      setSaved(r.agentName ? `Recorded. ${r.agentName} earns ${r.xp} XP for it (replacing any earlier verdict).` : (r.note ?? "Recorded."));
      setChosen(null);
      setRationale("");
      await load();
    } catch (err) {
      setSaveError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const current = history?.[0];
  return (
    <section className={px.parchment} aria-label="Quality verdict" data-testid="quality-verdict" style={{ display: "flex", flexDirection: "column", gap: "var(--space-sm)" }}>
      <div className={px.label}>Your quality verdict</div>
      <p className={px.detail}>How good is this result? Your judgement only — it is not an approval, and it grants the agent nothing.</p>
      <p style={{ margin: 0 }}>
        {loadError ? (
          <span role="alert">Couldn&apos;t read earlier verdicts. {loadError}</span>
        ) : !history ? (
          <Skeleton />
        ) : current ? (
          `Current: ${current.verdict.toLowerCase()} (${formatTime(current.occurredAt)})${current.rationale ? ` — ${current.rationale}` : ""}${history.length > 1 ? ` · ${history.length - 1} earlier` : ""}`
        ) : (
          "Not judged yet."
        )}
      </p>
      <div role="group" aria-label="Verdict" style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-sm)" }}>
        {QUALITY_VERDICTS.map((v) => (
          <PixelButton key={v} aria-pressed={chosen === v} className={cx(chosen === v && px.selected)} onClick={() => setChosen(v)} disabled={busy}>
            {v.toLowerCase()}
          </PixelButton>
        ))}
      </div>
      {chosen && (
        <>
          <label>
            <span className="visually-hidden">Why (optional)</span>
            <input className={px.input} placeholder="why (optional)" maxLength={1000} value={rationale} onChange={(e) => setRationale(e.target.value)} disabled={busy} />
          </label>
          <PixelButton kind="approve" onClick={() => void save()} disabled={busy}>
            Record {chosen.toLowerCase()}
          </PixelButton>
        </>
      )}
      {busy && <Skeleton label="saving" />}
      {saved && <p role="status">{saved}</p>}
      {saveError && (
        <p role="alert">
          The verdict wasn&apos;t recorded. <span className={px.detail}>{saveError}</span>
        </p>
      )}
    </section>
  );
}
