"use client";

import { useEffect, useState } from "react";
import { engageAgentStop, liftAgentStop } from "../lib/api";
import { errorText, formatTime } from "../lib/keep";
import { ButtonMark, PixelButton, StatusMark, cx, px } from "./pixel/Pixel";
import s from "./stop.module.css";

export type ShownStop = { id: string; reason: string | null; engagedAt?: string; scope?: string };

/**
 * The agent-scope emergency stop (spec 9.7), the one control on an agent. Stop
 * asks once before engaging; Lift lifts the stop that was shown, by id, and is
 * neutral (recovery, not destruction). A refused action is shown, not swallowed.
 */
export function StopControl({
  agentId,
  name,
  version,
  stop,
  stopsUnreadable = false,
  onChanged,
}: {
  agentId: string;
  name: string;
  version?: number;
  stop: ShownStop | null;
  stopsUnreadable?: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setConfirming(false);
    setReason("");
    setError(null);
  }, [agentId]);

  async function act(action: () => Promise<void>) {
    setActing(true);
    setError(null);
    try {
      await action();
      setConfirming(false);
      setReason("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      // Re-enabled only after the re-read, so a second click can't send a second POST.
      await onChanged();
      setActing(false);
    }
  }

  return (
    <div className={s.stop}>
      {stop?.scope === "global" ? (
        <>
          <div className={cx(px.parchment, s.grow)} data-testid="stop-state">
            <StatusMark state="stopped" surface="parchment" /> A global stop refuses every agent&apos;s next action.
            {stop.reason ? ` Reason: ${stop.reason}` : ""}
          </div>
          <p className={cx(px.detail, s.full)}>This screen lifts only an agent&apos;s own stop.</p>
        </>
      ) : stop ? (
        <>
          <div className={cx(px.parchment, s.grow)} data-testid="stop-state">
            <StatusMark state="stopped" surface="parchment" /> {stop.reason ? `Reason: ${stop.reason}` : "No reason given"}
            {stop.engagedAt && ` · since ${formatTime(stop.engagedAt)}`}
          </div>
          <PixelButton disabled={acting} onClick={() => act(() => liftAgentStop(agentId, stop.id))}>
            Lift stop
          </PixelButton>
          <p className={cx(px.detail, s.full)}>Lifting does not revive work the stop already failed.</p>
        </>
      ) : confirming ? (
        <>
          <label className={s.full}>
            <span className={px.label}>Reason (optional)</span>
            <input className={px.input} value={reason} onChange={(e) => setReason(e.target.value)} disabled={acting} />
          </label>
          <p className={s.full}>
            Stop {name}
            {version !== undefined ? ` v${version}` : ""}? Its next action is refused in every workflow
            {version !== undefined ? "; other versions are not affected" : ""}. A call already running finishes.
          </p>
          <PixelButton kind="danger" disabled={acting} onClick={() => act(() => engageAgentStop(agentId, reason.trim() || undefined))}>
            <ButtonMark tone="fail" />
            Confirm stop
          </PixelButton>
          <PixelButton disabled={acting} onClick={() => setConfirming(false)}>
            Cancel
          </PixelButton>
        </>
      ) : (
        <PixelButton kind="danger" onClick={() => setConfirming(true)}>
          <ButtonMark tone="fail" />
          Stop agent
        </PixelButton>
      )}
      {stopsUnreadable && !stop && <p className={cx(px.detail, s.full)}>Couldn&apos;t read active stops, so a stop already in place may not show.</p>}
      {error && (
        <p role="alert" className={cx(px.detail, s.full)}>
          {error}
        </p>
      )}
    </div>
  );
}
