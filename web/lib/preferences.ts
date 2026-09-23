/**
 * Operator preferences (Settings → General, Agents, System). Presentation only, per browser: how the
 * screens move and what they show by default. Nothing here reaches the API, and none of it can change
 * what an agent may do, spend or use. Stored in localStorage; any read or write that fails (private
 * window, blocked storage, SSR) falls back to the defaults, so the screens always work without it.
 */

export type Preferences = {
  /** system: follow the OS reduced-motion setting; reduced: always still; full: always animate. */
  motion: "system" | "reduced" | "full";
  /** Name tags over characters in the world: real work only (default), every agent, or none. */
  nameTags: "real" | "all" | "none";
  /** Idle agents walk between living areas; off, they stay where they are until real work moves them. */
  ambient: boolean;
  /** Current work = unfinished, or active within this many hours; 0 = show all non-archived work. */
  currentWindowHours: number;
  /** The catalogue preset a new recruit starts from; "" = the catalogue defaults. */
  recruitPreset: string;
};

export const DEFAULT_PREFERENCES: Preferences = { motion: "system", nameTags: "real", ambient: true, currentWindowHours: 24, recruitPreset: "" };
export const WINDOW_CHOICES = [6, 24, 72, 168, 720, 0] as const;
const KEY = "command-centre.preferences.v1";

/** A stored value made safe: anything unknown or malformed becomes its default. */
export function parsePreferences(raw: unknown): Preferences {
  const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_PREFERENCES;
  return {
    motion: v.motion === "reduced" || v.motion === "full" || v.motion === "system" ? v.motion : d.motion,
    nameTags: v.nameTags === "all" || v.nameTags === "none" || v.nameTags === "real" ? v.nameTags : d.nameTags,
    ambient: typeof v.ambient === "boolean" ? v.ambient : d.ambient,
    currentWindowHours: (WINDOW_CHOICES as readonly unknown[]).includes(v.currentWindowHours) ? (v.currentWindowHours as number) : d.currentWindowHours,
    recruitPreset: typeof v.recruitPreset === "string" && v.recruitPreset.length <= 60 ? v.recruitPreset : d.recruitPreset,
  };
}

export function readPreferences(): Preferences {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? parsePreferences(JSON.parse(raw)) : DEFAULT_PREFERENCES;
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function writePreferences(p: Preferences): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
}

/** The window as the list reads take it: undefined when every non-archived item is current. */
export const windowParam = (p: Preferences): number | undefined => (p.currentWindowHours > 0 ? p.currentWindowHours : undefined);

export function windowWords(hours: number): string {
  if (hours === 0) return "all unarchived work";
  if (hours === 24) return "the last day";
  return hours % 24 === 0 ? `the last ${hours / 24} days` : `the last ${hours} hours`;
}
