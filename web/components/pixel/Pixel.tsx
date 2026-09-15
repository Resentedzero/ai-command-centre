import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import { stateWord, toneFor, type Tone } from "../../lib/keep";
import s from "./pixel.module.css";

export { s as px };

export const TONE_VAR: Record<Tone, string> = {
  active: "var(--state-active)",
  done: "var(--state-done)",
  wait: "var(--state-wait)",
  fail: "var(--state-fail)",
  idle: "var(--state-idle)",
  neutral: "var(--pixel-label-dim)",
};

export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

/** "· · ·": a value not loaded yet. Never a bar (it would read as a partly filled gauge). */
export function Skeleton({ label = "loading" }: { label?: string }) {
  return (
    <span className={s.skeleton}>
      <span aria-hidden>· · ·</span>
      <span className="visually-hidden">{label}</span>
    </span>
  );
}

/**
 * The outlined state marker plus the runtime word (never hue alone). On
 * parchment the word is ink (contrast rule). `state` null = not loaded.
 */
export function StatusMark({
  state,
  tone,
  surface = "wood",
  children,
}: {
  state: string | null;
  tone?: Tone;
  surface?: "wood" | "parchment";
  children?: ReactNode;
}) {
  const t = state === null ? "neutral" : (tone ?? toneFor(state));
  return (
    <span
      className={cx(s.status, surface === "parchment" && s.onParchment, t === "neutral" && s.neutral)}
      style={{ "--tone": TONE_VAR[t] } as CSSProperties}
      data-tone={t}
    >
      <span className={s.mark} aria-hidden />
      {state === null ? <Skeleton /> : (children ?? stateWord(state))}
    </span>
  );
}

export function PixelButton({
  kind = "neutral",
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: "neutral" | "danger" | "approve" }) {
  return <button type="button" className={cx(s.button, kind === "danger" && s.danger, kind === "approve" && s.approve, className)} {...rest} />;
}

export function buttonClass(kind: "neutral" | "danger" | "approve" = "neutral"): string {
  return cx(s.button, kind === "danger" && s.danger, kind === "approve" && s.approve);
}

/** A marker inside a control (e.g. Stop). Dimmed with the button when disabled. */
export function ButtonMark({ tone }: { tone: Tone }) {
  return <span className={s.mark} style={{ "--tone": TONE_VAR[tone] } as CSSProperties} aria-hidden />;
}

/** Loading, empty, error and offline states: a message for the operator, then a dim detail line (routes, status codes), then a neutral recovery control. */
export function StateNotice({
  message,
  detail,
  action,
  role,
  className,
}: {
  message: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
  role?: "alert" | "status";
  className?: string;
}) {
  return (
    <div className={cx(s.notice, className)} role={role}>
      <p className={s.message} style={{ margin: 0 }}>
        {message}
      </p>
      {detail && <p className={s.detail} style={{ margin: 0 }}>{detail}</p>}
      {action}
    </div>
  );
}

/** One gauge per resource unit, drawn only from loaded values; never summed or converted. */
export function UnitGauge({ consumed, reserved, limit }: { consumed: string; reserved: string; limit: string }) {
  const lim = Number(limit);
  const pct = (v: string) => (lim > 0 ? Math.min(100, (Number(v) / lim) * 100) : 0);
  return (
    <div className={s.gauge} aria-hidden>
      <div className={s.gaugeReserved} style={{ width: `${pct(String(Number(consumed) + Number(reserved)))}%` }} />
      <div className={s.gaugeFill} style={{ width: `${pct(consumed)}%` }} />
    </div>
  );
}
