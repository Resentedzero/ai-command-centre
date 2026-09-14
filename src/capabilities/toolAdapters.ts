/**
 * Tool Adapter registry (spec Phase 4 "TOOL ADAPTERS", §3c, §18.3).
 *
 * A Tool Invocation's executable code is resolved from its persisted
 * `tool_bindings` row, not imported by the capability's spec builder. A
 * builder names a Capability and proposes an action; `resolveToolInvocation`
 * picks the binding and the adapter that implements it. Replacing how a
 * Capability is fulfilled is therefore a data change (a new binding row) plus,
 * for new code, one registered adapter, with no change to the Executor,
 * Interpreter, governance or API.
 *
 * SELECTION. The Capability's binding with the highest `version` (ties: lowest
 * id) is THE binding. If that binding cannot be executed here (a kind with no
 * adapter, or an unregistered internal function), resolution throws. It never
 * falls back to an older binding: that would be a silent fallback to something
 * the operator replaced. Selection is not Policy (§3c): a selected binding
 * below a Grant's trust bar is still selected, and Policy then DENYs it.
 *
 * DETERMINISM. Selection and `prepare` read only persisted rows, so a builder
 * called again on resume produces the same `toolBindingId`, `costClass`,
 * estimate and snapshot, which `resumeToolSpec` requires. A binding added while
 * an Approval is pending changes the selection, and the resume fails closed as
 * `resume_spec_mismatch` (a new Run is the recovery).
 *
 * BINDING ROWS ARE IMMUTABLE. `execute` closes over the row's `config`; the
 * persisted `toolBindingId` only pins what was authorized if that row never
 * changes. A changed binding is a new row with a higher version.
 *
 * KINDS. Only `internal` has an adapter: `config.function` names an
 * `InternalToolFunction` registered below. `direct_api`, `mcp`, `browser`,
 * `process` and `webhook` have none yet (spec Phase 6), so a binding of those
 * kinds fails closed.
 *
 * CONFIG. A binding's `config` reaches only its adapter. The Context Compiler
 * never places it in context and it is never written to an event.
 */
import { eq } from "drizzle-orm";
import { capabilities, toolBindings } from "../db/schema.js";
import type { DrizzleTransaction } from "../events/emit.js";
import type { ToolExecutionContext, ToolInvocationSpec } from "../execution/types.js";
import type { CostClass } from "../governance/costClass.js";
import type { CapabilityPermission } from "../governance/policy.js";
import { PUBLISH_REPORT_FILESYSTEM, publishReportFilesystem } from "./publishReport/adapter.js";
import {
  RESEARCH_RETRIEVE_LOCAL_CORPUS,
  RESEARCH_RETRIEVE_SYNTHETIC,
  researchRetrieveLocalCorpus,
  researchRetrieveSynthetic,
} from "./researchRetrieve/adapter.js";

type ToolBindingRow = typeof toolBindings.$inferSelect;

export type ToolBindingConfig = Record<string, unknown>;

/** What `prepare` hands to `execute`, plus the Invocation's cost declaration. */
export type PreparedToolCall = {
  inputs: Record<string, unknown>;
  /** The binding, not the Capability, knows whether fulfilling it is metered. */
  costClass: CostClass;
  estimatedCost: number;
};

export type InternalToolFunction = {
  /**
   * The one Capability this function fulfils. A binding that names it under any
   * other Capability fails closed: otherwise a READ Capability's binding could
   * name a PUBLISH function and run that effect under the READ Grant.
   */
  capabilityName: string;
  /**
   * Runs in the spec builder's transaction. Validates the proposed action and
   * reads what `execute` will need. MUST be a pure function of persisted rows
   * and its arguments (see DETERMINISM above).
   */
  prepare(
    tx: DrizzleTransaction,
    request: { config: ToolBindingConfig; proposedActionSnapshot: Record<string, unknown> }
  ): Promise<PreparedToolCall>;
  /**
   * The effect. Runs with NO transaction open, after the Invocation is committed
   * `executing`, at most once (DURABLE_EXECUTION §2.1). An error proving nothing
   * was performed carries `consumption: "none"`.
   */
  execute(
    request: { config: ToolBindingConfig; inputs: Record<string, unknown> },
    ctx: ToolExecutionContext
  ): Promise<Record<string, unknown>>;
};

const internalFunctions = new Map<string, InternalToolFunction>();

/** Registers an internal function under the name a binding's `config.function` uses. Names are never reassigned. */
export function registerInternalToolFunction(name: string, fn: InternalToolFunction): void {
  if (internalFunctions.has(name)) {
    throw new Error(`registerInternalToolFunction: "${name}" is already registered.`);
  }
  internalFunctions.set(name, fn);
}

registerInternalToolFunction(RESEARCH_RETRIEVE_SYNTHETIC, researchRetrieveSynthetic);
registerInternalToolFunction(RESEARCH_RETRIEVE_LOCAL_CORPUS, researchRetrieveLocalCorpus);
registerInternalToolFunction(PUBLISH_REPORT_FILESYSTEM, publishReportFilesystem);

function adapterFor(binding: ToolBindingRow, capabilityName: string): InternalToolFunction {
  const name = binding.config?.function;
  if (binding.kind !== "internal") {
    throw new Error(`Tool Binding "${binding.id}" has kind "${binding.kind}", which has no adapter (fail closed).`);
  }
  const fn = typeof name === "string" ? internalFunctions.get(name) : undefined;
  if (!fn) {
    throw new Error(
      `Tool Binding "${binding.id}" names internal function ${JSON.stringify(name ?? null)}, which is not registered (fail closed).`
    );
  }
  if (fn.capabilityName !== capabilityName) {
    throw new Error(
      `Tool Binding "${binding.id}" of capability "${capabilityName}" names internal function "${String(name)}", ` +
        `which belongs to capability "${fn.capabilityName}" (fail closed).`
    );
  }
  return fn;
}

/**
 * Builds the Tool Invocation spec for `capabilityName`: selects the binding,
 * prepares the call, and returns a spec whose `execute` runs that binding's
 * adapter. Throws if the Capability is missing or ambiguous, has no binding, or
 * its selected binding cannot be executed.
 */
export async function resolveToolInvocation(
  tx: DrizzleTransaction,
  request: { capabilityName: string; permission: CapabilityPermission; proposedActionSnapshot: Record<string, unknown> }
): Promise<ToolInvocationSpec> {
  const matches = await tx.query.capabilities.findMany({ where: eq(capabilities.name, request.capabilityName) });
  if (matches.length !== 1) {
    throw new Error(`resolveToolInvocation: expected exactly one capability named "${request.capabilityName}", found ${matches.length}.`);
  }
  const capability = matches[0]!;

  const [binding] = (await tx.query.toolBindings.findMany({ where: eq(toolBindings.capabilityId, capability.id) })).sort(
    (a, b) => b.version - a.version || a.id.localeCompare(b.id)
  );
  if (!binding) {
    throw new Error(`resolveToolInvocation: capability "${request.capabilityName}" has no Tool Binding.`);
  }

  const fn = adapterFor(binding, capability.name);
  const config = binding.config ?? {};
  const prepared = await fn.prepare(tx, { config, proposedActionSnapshot: request.proposedActionSnapshot });

  return {
    kind: "tool",
    costClass: prepared.costClass,
    capabilityId: capability.id,
    permission: request.permission,
    proposedActionSnapshot: request.proposedActionSnapshot,
    toolBindingId: binding.id,
    estimatedCost: prepared.estimatedCost,
    execute: (ctx) => fn.execute({ config, inputs: prepared.inputs }, ctx),
  };
}
