"use client";

import { useEffect, useRef, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { KIT, STRIPS, kitLayers, type AgentLook, type Facing, type KitPose, type Pose } from "../../lib/keep";
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
    if ((e.target as HTMLElement).closest("a,button,input,textarea,select,label")) return;
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
 *
 * An agent with a kit look (chosen, or derived from its name) is drawn from the
 * character kit instead: its layer strips stacked as one element's backgrounds,
 * stepping together, in the pose and facing given (left mirrors the side strip).
 * The kit has no death strip, so a failed agent holds its idle frame. The runtime
 * state still chooses the pose; the appearance only chooses the clothes.
 */
export function AgentSprite({
  look,
  pose,
  footX,
  footY,
  frozen = false,
  scale = 1,
  kitPose,
  facing = "down",
}: {
  look: AgentLook;
  pose: Pose;
  footX: number;
  footY: number;
  frozen?: boolean;
  scale?: 1 | 2;
  /** The kit pose, when not the runtime pose's own (run → work, otherwise idle): e.g. walk. */
  kitPose?: KitPose;
  facing?: Facing;
}) {
  const kp: KitPose = kitPose ?? (pose === "run" ? "work" : "idle");
  const strip = look.appearance
    ? { ...KIT[kp], once: false, src: kitLayers(look.appearance, kp, facing).reverse().map((src) => `url(${src})`).join(", ") }
    : { ...STRIPS[look.character][pose], src: `url(${STRIPS[look.character][pose].src})` };
  const held = frozen || (look.appearance !== null && pose === "death");
  const style = {
    backgroundImage: strip.src,
    width: strip.w,
    height: strip.h,
    left: footX - strip.w / 2,
    top: footY - strip.h,
    transform: [scale === 2 ? "scale(2)" : "", look.appearance && facing === "left" ? "scaleX(-1)" : ""].join(" ").trim() || undefined,
    transformOrigin: "50% 100%",
    "--w": strip.w,
    "--n": strip.n,
    "--n1": Math.max(strip.n - 1, 0),
    "--ms": `${strip.ms}ms`,
  } as CSSProperties;
  const cls = held ? s.frozen : strip.once ? s.once : "";
  return <div className={`${s.sprite} ${cls}`} style={style} data-pose={frozen ? "frozen" : pose} data-look={look.appearance ? "kit" : look.character} data-facing={look.appearance ? facing : undefined} aria-hidden />;
}
