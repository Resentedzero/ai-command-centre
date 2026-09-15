"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { listActiveAgents, listPendingApprovals } from "../../lib/api";
import { useLive, useRefetchOnEvents } from "../live";
import { StatusMark, Skeleton } from "./Pixel";
import s from "./topbar.module.css";

const TABS: [string, string][] = [
  ["Overview", "/"],
  ["Agents", "/agents"],
  ["Workflows", "/workflows"],
  ["Goals", "/goals"],
  ["Approvals", "/approvals"],
  ["Artifacts", "/artifacts"],
  ["Events", "/events"],
];

/** Screens without a slot light the tab they are reached from (screens.md). */
const REACHED_FROM: [string, string][] = [
  ["/registry", "/agents"],
  ["/costs", "/workflows"],
];

function activeHref(path: string): string | undefined {
  if (path === "/") return "/";
  const parent = REACHED_FROM.find(([p]) => path.startsWith(p))?.[1];
  return parent ?? TABS.find(([, href]) => href !== "/" && path.startsWith(href))?.[1];
}

/** How often the chips re-read when no event arrives (an Approval can expire silently). */
const CHIP_REFRESH_MS = 30_000;

type Counts = { agents: number; pending: number } | "error" | null;

/** PixelTopBar (Figma 95:242): seven 120 px PixelTab slots and three chips from real reads. */
export function PixelTopBar() {
  const path = usePathname() ?? "/";
  const active = activeHref(path);
  const { status } = useLive();
  const [counts, setCounts] = useState<Counts>(null);

  const load = useCallback(async () => {
    try {
      const [agents, approvals] = await Promise.all([listActiveAgents(), listPendingApprovals()]);
      // One per Agent Definition (ROADMAP §7); an unbound Run counts on its own.
      const distinct = new Set(agents.map((a) => a.agentDefinitionId ?? `run:${a.runId}`));
      setCounts({ agents: distinct.size, pending: approvals.length });
    } catch {
      setCounts("error");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), CHIP_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);
  useRefetchOnEvents(load);

  const value = (n: number | undefined) =>
    counts === null ? <Skeleton /> : counts === "error" ? <span title="Couldn't read this from the API">n/a</span> : n;
  const num = (key: "agents" | "pending") => (counts !== null && counts !== "error" ? counts[key] : undefined);

  return (
    <header className={s.bar}>
      <Link href="/" className={s.emblem} aria-label="Command Keep overview">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/world/core-crystal-pedestal-2x.png" width={32} height={40} alt="" className="px" />
        <span className={s.title}>Command Keep</span>
      </Link>
      <nav className={s.tabs} aria-label="Screens">
        {TABS.map(([label, href]) => (
          <Link key={href} href={href} className={href === active ? `${s.tab} ${s.tabActive}` : s.tab} aria-current={href === active ? "page" : undefined}>
            {label}
          </Link>
        ))}
      </nav>
      <div className={s.chips}>
        <span className={s.chip}>
          <StatusMark state={num("agents") ? "active" : "none"} tone={num("agents") ? "active" : "neutral"}>
            <span className={s.chipText}>Agents {value(num("agents"))}</span>
          </StatusMark>
        </span>
        <Link href="/approvals" className={s.chip}>
          <StatusMark state={num("pending") ? "pending" : "none"} tone={num("pending") ? "wait" : "neutral"}>
            <span className={s.chipText}>Pending {value(num("pending"))}</span>
          </StatusMark>
        </Link>
        <span className={s.chip} role="status" aria-label={`Live feed: ${status}`}>
          <StatusMark state={status} tone={status === "live" ? "done" : "neutral"}>
            <span className={s.chipText}>{status[0]!.toUpperCase() + status.slice(1)}</span>
          </StatusMark>
        </span>
      </div>
    </header>
  );
}
