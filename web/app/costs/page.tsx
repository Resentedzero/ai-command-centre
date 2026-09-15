"use client";

import { useCallback, useEffect, useState } from "react";
import { BUDGET_SCOPES, getCosts, type CostsData } from "../../lib/api";
import { useRefetchOnEvents } from "../../components/live";
import { RefreshNotice, PixelButton, Skeleton, StateNotice, UnitGauge, cx, px } from "../../components/pixel/Pixel";
import { world } from "../../components/world/World";
import { errorText, formatTime, stateWord } from "../../lib/keep";
import c from "./costs.module.css";

type Counter = CostsData["counters"][number];

function counterLabel(ct: Counter): string {
  if (ct.scope === "run" && ct.run) {
    const agent = ct.run.agent ? `${ct.run.agent.name} v${ct.run.agent.version}` : "no agent bound";
    return `${agent} · ${ct.run.taskDefinitionName ?? "task definition not found"}`;
  }
  // A day key is echoed verbatim: its timezone is an open decision.
  return ct.scopeRefId;
}

/**
 * Cost (spec 15.1 screen 7; Figma "Cost — pixel ledger"): what is being
 * consumed, by unit? Reached from Workflows (no top-bar slot). The engine room
 * burns fuel as a frame, claiming no value. Every amount is an exact decimal
 * string from `GET /costs`: counters one per scope key per unit, totals summed
 * by the API per (scope, unit) and never added across units or scopes, and
 * `agent_performance` rows shown as a measurement only.
 */
export default function CostsPage() {
  const [scope, setScope] = useState<string | undefined>(undefined);
  const [data, setData] = useState<CostsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await getCosts(scope));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [scope]);

  useEffect(() => {
    setData(null);
    setError(null);
    void load();
  }, [load]);
  useRefetchOnEvents(load);

  return (
    <main className={c.screen}>
      <aside className={cx(px.board, c.side)}>
        <div className={c.engine} role="img" aria-label="Engine room">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/world/room-v5-engine-2x.png" width={352} height={256} alt="" className={world.base} draggable={false} />
          <div className={world.night} />
        </div>
        <h1 className={px.heading}>Cost ledger</h1>
        <div role="group" aria-label="Scope" className={c.scopes}>
          {[undefined, ...BUDGET_SCOPES].map((s) => (
            <button
              key={s ?? "all"}
              type="button"
              className={cx(px.plaque, c.scope, scope === s && px.selected)}
              aria-pressed={scope === s}
              onClick={() => setScope(s)}
            >
              {s ? stateWord(s) : "all scopes"}
            </button>
          ))}
        </div>

        <section className={c.section} aria-label="Totals">
          <span className={px.tab}>Totals</span>
          {!data ? (
            error ? null : <Skeleton />
          ) : data.totals.length === 0 ? (
            <p className={px.dim}>No counters in this scope.</p>
          ) : (
            <ul className={c.cards}>
              {data.totals.map((t) => (
                <li key={`${t.scope}-${t.resourceUnit}`} className={px.parchment} data-testid="total">
                  <div className={px.label}>
                    {stateWord(t.scope)} · {t.resourceUnit}
                  </div>
                  <div>
                    {t.consumed} consumed · {t.reserved} reserved
                  </div>
                  <div>
                    across {t.counters} counter{t.counters === 1 ? "" : "s"}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className={px.detail}>
            Summed by the API per scope and unit. Units are never combined, and scopes are never added together: the same spend can sit in a run
            counter and a day counter.
          </p>
        </section>
      </aside>

      <section className={cx(px.board, c.main)} aria-label="Counters">
        {!data && error ? (
          <StateNotice role="alert" message="Couldn't load the cost ledger." detail={error} action={<PixelButton onClick={() => void load()}>Retry</PixelButton>} />
        ) : !data ? (
          <StateNotice role="status" message={<>Loading the cost ledger <Skeleton /></>} />
        ) : (
          <>
            {error && (
              <RefreshNotice error={error} />
            )}
            <span className={px.tab}>Counters</span>
            {data.counters.length === 0 ? (
              <p className={px.dim}>No budget counters yet.</p>
            ) : (
              <ul className={c.counters}>
                {data.counters.map((ct) => (
                  <li key={`${ct.scope}-${ct.scopeRefId}-${ct.resourceUnit}`} className={cx(px.vellum, c.counter)} data-testid="counter">
                    <div className={c.counterHead}>
                      <span>{stateWord(ct.scope)}</span>
                      <span className={px.dim}>{ct.resourceUnit}</span>
                    </div>
                    <div className={c.ellipsis}>{counterLabel(ct)}</div>
                    {ct.scope === "run" && <UnitGauge consumed={ct.consumedAmount} reserved={ct.reservedAmount} limit={ct.limitAmount} />}
                    <div>
                      {ct.consumedAmount} consumed · {ct.reservedAmount} reserved · limit {ct.limitAmount}
                    </div>
                    <div className={px.dim}>updated {formatTime(ct.updatedAt)}</div>
                  </li>
                ))}
              </ul>
            )}
            <p className={px.detail}>
              Gauges are drawn for run counters, whose limit is enforced. Other limits are shown as stored when the counter was created.
              {data.countersTruncated && " Showing the 500 most recently updated counters; the totals cover every counter."}
            </p>

            <span className={px.tab}>Cost and success</span>
            {data.costVsSuccess.length === 0 ? (
              <p className={px.dim}>No performance measured yet.</p>
            ) : (
              <div className={cx(px.vellum, c.scrollX)}>
                <table className={c.table} data-testid="cost-vs-success">
                  <thead>
                    <tr>
                      <th>agent</th>
                      <th>task</th>
                      <th>model tier</th>
                      <th>samples</th>
                      <th>success rate</th>
                      <th>avg retries</th>
                      <th>avg cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.costVsSuccess.map((p) => (
                      <tr key={`${p.agentDefinitionId}-${p.taskDefinitionId}-${p.modelTier}`}>
                        <td>
                          {p.agentName} v{p.agentVersion}
                        </td>
                        <td>{p.taskDefinitionName}</td>
                        <td>{p.modelTier}</td>
                        <td>{p.sampleCount}</td>
                        <td>{p.successRate}</td>
                        <td>{p.avgRetries}</td>
                        <td>
                          {Object.entries(p.avgCost)
                            .map(([unit, v]) => `${v} ${unit}`)
                            .join(" · ") || "none recorded"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className={px.detail}>A measurement, not a recommendation: it ranks nothing and suggests no change.</p>
          </>
        )}
      </section>
    </main>
  );
}
