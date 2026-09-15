/**
 * Loop actions (V1.1): how an autonomous agent's decision may use a Capability.
 *
 * A Capability can be chosen by an `agent_objective` loop only if its module registers
 * a loop action here. The action names the permission it acts under, the few string
 * fields a decision may fill, and how those fields become the proposed action. The
 * resulting Tool Invocation then goes through the unchanged chain: Grant, Policy,
 * budget, Approval where required, stops, events.
 *
 * MODEL-REACHABLE INPUT. A decision is model output. `toSnapshot` receives only the
 * action's own declared fields, each a bounded string, and returns the proposed action.
 * Policy's risk inputs (`amountOrScope`, `isNovelAction`) are never among them, so a
 * model cannot lower (or set) an action's computed risk.
 *
 * `research.search` / `research.open` (external discovery and reading) are future
 * Capabilities: they register here with their own evidence class, and the loop needs
 * no change.
 */
import type { CapabilityPermission } from "../../governance/policy.js";

export type LoopAction = {
  capabilityName: string;
  permission: CapabilityPermission;
  /** One line shown in the agent's action menu (trusted plan text). */
  describe: string;
  /** The string fields a decision may set for this action; all required, each bounded. */
  inputFields: Record<string, { maxLength: number; description: string }>;
  toSnapshot(input: Record<string, string>): Record<string, unknown>;
};

const actions = new Map<string, LoopAction>();

export function registerLoopAction(action: LoopAction): void {
  if (actions.has(action.capabilityName)) throw new Error(`registerLoopAction: "${action.capabilityName}" is already registered.`);
  actions.set(action.capabilityName, action);
}

export function loopActionFor(capabilityName: string): LoopAction | undefined {
  return actions.get(capabilityName);
}

export function loopActions(): LoopAction[] {
  return [...actions.values()].sort((a, b) => a.capabilityName.localeCompare(b.capabilityName));
}

/** Every registered action's fields, for the decision's JSON Schema (all strings; unused ones empty). */
export function loopInputFieldNames(): string[] {
  return [...new Set(loopActions().flatMap((a) => Object.keys(a.inputFields)))].sort();
}

/** Validates a decision's `input` for `action`: its fields present and bounded, no other field set. */
export function parseLoopActionInput(action: LoopAction, input: unknown): { ok: true; input: Record<string, string> } | { ok: false; reason: string } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { ok: false, reason: "the action input is not an object" };
  const given = input as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [field, spec] of Object.entries(action.inputFields)) {
    const value = given[field];
    if (typeof value !== "string" || value.trim() === "") return { ok: false, reason: `"${field}" is required for ${action.capabilityName}` };
    if (value.length > spec.maxLength) return { ok: false, reason: `"${field}" is longer than ${spec.maxLength} characters` };
    out[field] = value.trim();
  }
  for (const [field, value] of Object.entries(given)) {
    if (!(field in action.inputFields) && !(value === "" || value === null || value === undefined)) {
      return { ok: false, reason: `"${field}" is not an input of ${action.capabilityName}` };
    }
  }
  return { ok: true, input: out };
}
