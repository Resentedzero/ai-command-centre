/**
 * Keeper proposals are suggestions: they only pre-fill a builder form. They are
 * held in this tab's sessionStorage under a random key and read once by the form;
 * nothing is written anywhere until the operator submits that form.
 */
export type ProposalKind = "agent" | "workflow";

export function storeKeeperProposal(kind: ProposalKind, value: unknown): string {
  const key = `${kind}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    sessionStorage.setItem(`keeper-proposal:${key}`, JSON.stringify({ kind, value }));
  } catch {
    // Storage unavailable: the form simply opens empty.
  }
  return key;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readKeeperProposal(key: string, kind: ProposalKind): any {
  try {
    const raw = sessionStorage.getItem(`keeper-proposal:${key}`);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { kind?: string; value?: unknown };
    return parsed.kind === kind && parsed.value && typeof parsed.value === "object" ? parsed.value : undefined;
  } catch {
    return undefined;
  }
}
