"use client";

import { useEffect, useRef, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { STRIPS, type Character, type Pose } from "../../lib/keep";
import s from "./world.module.css";

export { s as world };

/**
 * A bevel-framed world view larger than its frame (D16): pans by drag, scroll
 * or arrow keys. `focus` (world px) centres the view on what needs attention,
 * clamped by the browser at both ends. Pan position is client state.
 */
export function WorldViewport({
  width,
  height,
  focus,
  label,
  className,
  children,
}: {
  width: number;
  height: number;
  focus?: { x: number; y: number } | null;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !focus) return;
    el.scrollLeft = focus.x - el.clientWidth / 2;
    el.scrollTop = focus.y - el.clientHeight / 2;
  }, [focus?.x, focus?.y]); // eslint-disable-line react-hooks/exhaustive-deps

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest("a,button")) return;
    const el = ref.current!;
    drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    el.setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d) return;
    ref.current!.scrollLeft = d.left - (e.clientX - d.x);
    ref.current!.scrollTop = d.top - (e.clientY - d.y);
  }

  return (
    <div
      ref={ref}
      className={`${s.viewport} ${className ?? ""}`}
      tabIndex={0}
      role="region"
      aria-label={label}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
    >
      <div className={s.map} style={{ width, height }}>
        {children}
      </div>
    </div>
  );
}

/**
 * AgentSprite (Figma 20:20): an outlined strip played with CSS steps. Working
 * loops at 100 ms per frame, idle breathes at 2 fps, death plays once and holds
 * its last frame. `frozen` holds frame 1 (an execution stop). Reduced motion
 * stops every animation globally. Feet sit at (footX, footY).
 */
export function AgentSprite({
  character,
  pose,
  footX,
  footY,
  frozen = false,
  scale = 1,
}: {
  character: Character;
  pose: Pose;
  footX: number;
  footY: number;
  frozen?: boolean;
  scale?: 1 | 2;
}) {
  const strip = STRIPS[character][pose];
  const style = {
    backgroundImage: `url(${strip.src})`,
    width: strip.w,
    height: strip.h,
    left: footX - strip.w / 2,
    top: footY - strip.h,
    transform: scale === 2 ? "scale(2)" : undefined,
    transformOrigin: "50% 100%",
    "--w": strip.w,
    "--n": strip.n,
    "--n1": Math.max(strip.n - 1, 0),
    "--ms": `${strip.ms}ms`,
  } as CSSProperties;
  const cls = frozen ? s.frozen : strip.once ? s.once : "";
  return <div className={`${s.sprite} ${cls}`} style={style} data-pose={frozen ? "frozen" : pose} aria-hidden />;
}
