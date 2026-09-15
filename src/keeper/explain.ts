/**
 * The Keeper's deterministic explanations (V1.1): "why is this stuck", "why did it
 * fail", "what is this approval", "what is this agent allowed to do", "what can the
 * Command Keep do". Plain reads of the authoritative rows and events, turned into
 * sentences by code. No model, no Run, no Invocation, no event, no write of any kind.
 *
 * Used by `GET /keeper/explain` and, as bounded system state for a Keeper Think answer,
 * by the `system.inspect` capability. It names no capability and no seeded Definition.
 */
import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  agentDefinitions,
  approvals,
  artifacts,
  capabilities,
  capabilityGrants,
  events,
  executionStops,
  goals,
  invocations,
  runs,
  taskDefinitions,
  taskInstances,
  toolBindings,
  workflowDefinitions,
  workflowRuns,
} from "../db/schema.js";
import type { DrizzleTransaction } from "../events/emit.js";

export type Reader = Pick<DrizzleTransaction, "query" | "select">;

export const SUBJECT_TYPES = ["system", "workflow_run", "goal", "approval", "agent", "artifact", "run"] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];
export type Subject = { type: "system"; id: null } | { type: Exclude<SubjectType, "system">; id: string };

export type Explanation = {
  subject: { type: SubjectType; id: string | null };
  headline: string;
  status: string | null;
  facts: { label: string; value: string }[];
  reasons: string[];
  next: { label: string; href: string }[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `system`, or `<type>:<uuid>`. Null when malformed. */
export function parseSubject(raw: unknown): Subject | null {
  if (raw === undefined || raw === null || raw === "" || raw === "system") return { type: "system", id: null };
  if (typeof raw !== "string") return null;
  const [type, id, ...rest] = raw.split(":");
  if (rest.length > 0 || !id || !UUID.test(id) || !SUBJECT_TYPES.includes(type as SubjectType) || type === "system") return null;
  return { type: type as Exclude<SubjectType, "system">, id };
}

export function subjectKey(subject: Subject): string {
  return subject.type === "system" ? "system" : `${subject.type}:${subject.id}`;
}

const words = (s: string) => s.replace(/_/g, " ");

const AUTONOMY_WORDS: Record<string, string> = {
  AUTONOMOUS: "acts without asking",
  ALWAYS_APPROVE: "asks you first, every time",
  CONDITIONAL: "a low-risk read may run on measured performance; anything else asks you first",
};

const BASIS_WORDS: Record<string, string> = {
  autonomy_always_approve: "the agent's Grant for this capability is set to ask you first (ALWAYS_APPROVE)",
  unverified_binding_requires_approval: "the tool binding is unverified, so a human must approve",
  conditional_human_gated_action: "this kind of action is always human-gated under Conditional Autonomy",
  conditional_insufficient_evidence: "there is not yet enough measured performance to allow it automatically",
  conditional_performance_below_allow_threshold: "measured performance is below the automatic-allow threshold",
};

/** Explains one subject, or returns null when it does not exist. */
export async function explain(db: Reader, subject: Subject): Promise<Explanation | null> {
  switch (subject.type) {
    case "system":
      return explainSystem(db);
    case "workflow_run":
      return explainWorkflowRun(db, subject.id);
    case "goal":
      return explainGoal(db, subject.id);
    case "approval":
      return explainApproval(db, subject.id);
    case "agent":
      return explainAgent(db, subject.id);
    case "artifact":
      return explainArtifact(db, subject.id);
    case "run":
      return explainRun(db, subject.id);
  }
}

async function activeStopsFor(db: Reader, keys: { scope: string; ref: string | null }[]) {
  const rows = await db.select().from(executionStops).where(isNull(executionStops.liftedAt));
  return rows.filter((s) => keys.some((k) => k.scope === s.scope && (s.scope === "global" || (k.ref !== null && k.ref.toLowerCase() === s.scopeRefId.toLowerCase()))));
}

async function explainWorkflowRun(db: Reader, id: string): Promise<Explanation | null> {
  const wr = await db.query.workflowRuns.findFirst({ where: eq(workflowRuns.id, id) });
  if (!wr) return null;
  const goal = await db.query.goals.findFirst({ where: eq(goals.id, wr.goalId) });
  const def = await db.query.workflowDefinitions.findFirst({
    where: and(eq(workflowDefinitions.id, wr.workflowDefinitionId), eq(workflowDefinitions.version, wr.workflowDefinitionVersion)),
  });
  const steps = ((def?.graphDefinition as { steps?: { label?: string }[] } | null)?.steps ?? []);
  const vars = (wr.variables ?? {}) as { stepTaskInstanceIds?: (string | null)[]; stepRunIds?: (string | null)[] };
  // One slot per step, null until that step starts: the current step is the last filled slot.
  const slotArray = vars.stepTaskInstanceIds ?? [];
  const slots = slotArray.filter((s): s is string => typeof s === "string");
  let index = -1;
  slotArray.forEach((s, i) => {
    if (typeof s === "string") index = i;
  });
  const runId = index >= 0 ? ((vars.stepRunIds ?? [])[index] ?? undefined) : undefined;
  const run = runId ? await db.query.runs.findFirst({ where: eq(runs.id, runId) }) : undefined;
  const taskInstance = index >= 0 ? await db.query.taskInstances.findFirst({ where: eq(taskInstances.id, slotArray[index]!) }) : undefined;
  const taskDefinition = taskInstance
    ? await db.query.taskDefinitions.findFirst({ where: and(eq(taskDefinitions.id, taskInstance.taskDefinitionId), eq(taskDefinitions.version, taskInstance.taskDefinitionVersion)) })
    : undefined;
  const agent = run?.agentDefinitionId
    ? await db.query.agentDefinitions.findFirst({ where: and(eq(agentDefinitions.id, run.agentDefinitionId), eq(agentDefinitions.version, run.agentDefinitionVersion!)) })
    : undefined;

  const facts: Explanation["facts"] = [
    { label: "goal", value: goal?.title ?? "not found" },
    { label: "workflow", value: def ? `${def.name} v${def.version}` : "definition not found" },
    { label: "status", value: words(wr.status) },
    { label: "step", value: index >= 0 ? `${index + 1} of ${steps.length}${steps[index]?.label ? ` (${steps[index]!.label})` : ""}` : `not started (${steps.length} steps)` },
  ];
  if (taskDefinition) facts.push({ label: "task", value: `${taskDefinition.name} (${taskDefinition.kind})` });
  if (agent) facts.push({ label: "agent", value: `${agent.name} v${agent.version}` });
  if (run) facts.push({ label: "run", value: `${words(run.status)} · attempt ${run.attempt}` });

  const reasons: string[] = [];
  const next: Explanation["next"] = [{ label: "Open the workflow run", href: `/workflows/${wr.id}` }];
  let headline: string;

  const stops = await activeStopsFor(db, [
    { scope: "global", ref: null },
    { scope: "goal", ref: wr.goalId },
    { scope: "workflow_run", ref: wr.id },
    { scope: "run", ref: run?.id ?? null },
    { scope: "agent_definition", ref: run?.agentDefinitionId ?? null },
  ]);

  if (wr.status === "completed") {
    headline = "This workflow run completed.";
    const produced = await deliverablesOf(db, slots);
    if (produced.length === 0) reasons.push("Every step completed. No document-type output was recorded.");
    for (const a of produced) {
      reasons.push(`It produced a ${a.type}${a.summary ? `: "${a.summary}"` : ""}.`);
      next.push({ label: `Read the ${a.type}`, href: `/artifacts/${a.id}` });
    }
  } else if (wr.status === "failed") {
    headline = "This workflow run failed.";
    reasons.push(...(await failureReasons(db, run?.id)));
  } else if (wr.status === "paused") {
    headline = "This workflow run is paused.";
    reasons.push("An operator paused it. Nothing runs until it is resumed.");
  } else if (stops.length > 0) {
    headline = "This workflow run is held by an emergency stop.";
    for (const s of stops) reasons.push(`A ${words(s.scope)} stop is engaged${s.reason ? `: "${s.reason}"` : ""}. The next action will be refused until it is lifted.`);
  } else if (run?.status === "awaiting_approval") {
    headline = "This workflow run is waiting for your approval.";
    reasons.push(...(await approvalReasons(db, run.id)));
    next.push({ label: "Review approvals", href: "/approvals" });
  } else if (!run) {
    headline = "This workflow run has not started a step yet.";
    reasons.push("Its first step starts on the next advance.");
  } else {
    const latest = await db.query.invocations.findFirst({ where: eq(invocations.runId, run.id), orderBy: desc(invocations.seqNo) });
    headline = latest?.status === "executing" ? `Step ${index + 1} is working: a ${latest.kind} call is in flight.` : `Step ${index + 1} is in progress.`;
    if (latest) reasons.push(`Latest action: ${latest.kind} #${latest.seqNo}, ${words(latest.status)}.`);
    if (latest?.status === "executing") reasons.push("Model and tool calls run outside the database; the run continues when this one returns (each Claude call is bounded).");
  }

  if (run) {
    const loop = await db.query.events.findFirst({
      where: and(eq(events.runId, run.id), eq(events.eventType, "agent_loop_iteration_recorded")),
      orderBy: desc(events.sequenceNo),
    });
    if (loop) {
      const p = loop.payload as { iteration?: number | null; maxIterations?: number; terminal?: { status: string; reason: string }; iterations?: number; action?: { type?: string; intent?: string; capability?: string }; outcome?: { status?: string } };
      if (p.terminal) reasons.push(`Autonomous work ended ${p.terminal.status} (${words(p.terminal.reason)}) after ${p.iterations ?? "?"} of ${p.maxIterations ?? "?"} iterations.`);
      else reasons.push(`Autonomous work: iteration ${p.iteration} of ${p.maxIterations} recorded (${p.action?.type ?? "?"}${p.action?.intent ? ` ${p.action.intent}` : ""}${p.action?.capability ? ` ${p.action.capability}` : ""}, ${p.outcome?.status ?? "?"}).`);
    }
  }
  return { subject: { type: "workflow_run", id }, headline, status: wr.status, facts, reasons, next };
}

async function deliverablesOf(db: Reader, taskInstanceIds: string[]) {
  if (taskInstanceIds.length === 0) return [];
  const runRows = await db.select({ id: runs.id }).from(runs).where(and(inArray(runs.taskInstanceId, taskInstanceIds), eq(runs.status, "completed")));
  if (runRows.length === 0) return [];
  return db
    .select({ id: artifacts.id, type: artifacts.type, summary: artifacts.summary })
    .from(artifacts)
    .innerJoin(invocations, eq(artifacts.producingInvocationId, invocations.id))
    .where(and(inArray(invocations.runId, runRows.map((r) => r.id)), inArray(artifacts.type, ["deliverable", "report", "keeper_answer"])));
}

async function failureReasons(db: Reader, runId: string | undefined): Promise<string[]> {
  if (!runId) return ["No step run was recorded."];
  const reasons: string[] = [];
  const halted = await db.query.events.findFirst({ where: and(eq(events.runId, runId), eq(events.eventType, "run_halted")) });
  if (halted) {
    const stop = (halted.payload as { stop?: { scope?: string; reason?: string | null } }).stop;
    reasons.push(`An emergency stop halted it${stop?.scope ? ` (${words(stop.scope)} scope)` : ""}${stop?.reason ? `: "${stop.reason}"` : ""}.`);
  }
  const failed = await db.query.events.findFirst({ where: and(eq(events.runId, runId), eq(events.eventType, "invocation_failed")), orderBy: desc(events.sequenceNo) });
  if (failed) {
    const p = failed.payload as { reason?: string; errorCode?: string };
    reasons.push(`The failing action reported: ${p.reason ?? "no reason recorded"}${p.errorCode ? ` (${p.errorCode})` : ""}.`);
  }
  const denied = await db.query.events.findFirst({ where: and(eq(events.runId, runId), eq(events.eventType, "budget_denied")), orderBy: desc(events.sequenceNo) });
  if (denied) {
    const p = denied.payload as { scope?: string; resourceUnit?: string };
    reasons.push(`The Budget Governor refused a reservation${p.scope ? ` on the ${words(p.scope)} counter` : ""}${p.resourceUnit ? ` (${p.resourceUnit})` : ""}.`);
  }
  const rejected = await db.query.events.findFirst({ where: and(eq(events.runId, runId), inArray(events.eventType, ["approval_rejected", "approval_expired"])) });
  if (rejected) reasons.push(rejected.eventType === "approval_rejected" ? "A human rejected the approval it needed." : "The approval it needed expired before a decision.");
  const policy = await db.query.events.findFirst({ where: and(eq(events.runId, runId), eq(events.eventType, "policy_evaluated")), orderBy: desc(events.sequenceNo) });
  if (policy && (policy.payload as { decision?: string }).decision === "DENY") {
    reasons.push(`Policy denied the action (${words(String((policy.payload as { basis?: string }).basis ?? "no basis recorded"))}).`);
  }
  if (reasons.length === 0) reasons.push("No failure detail was recorded for its last run.");
  const retries = await db.query.runs.findFirst({ where: eq(runs.id, runId) });
  if (retries && retries.attempt > 1) reasons.push(`This was attempt ${retries.attempt}.`);
  return reasons;
}

async function approvalReasons(db: Reader, runId: string): Promise<string[]> {
  const rows = await db
    .select({ approval: approvals, invocation: invocations })
    .from(approvals)
    .innerJoin(invocations, eq(approvals.invocationId, invocations.id))
    .where(and(eq(invocations.runId, runId), eq(approvals.status, "pending")));
  const reasons: string[] = [];
  for (const { approval, invocation } of rows) reasons.push(...(await describeApproval(db, approval, invocation)));
  return reasons.length > 0 ? reasons : ["It is marked as awaiting approval, but no pending approval was found (it may have just been decided)."];
}

async function describeApproval(db: Reader, approval: typeof approvals.$inferSelect, invocation: typeof invocations.$inferSelect): Promise<string[]> {
  const capability = invocation.capabilityId ? await db.query.capabilities.findFirst({ where: eq(capabilities.id, invocation.capabilityId) }) : undefined;
  const evaluation = await db.query.events.findFirst({
    where: and(eq(events.invocationId, invocation.id), eq(events.eventType, "policy_evaluated")),
    orderBy: asc(events.sequenceNo),
  });
  const basis = (evaluation?.payload as { basis?: string } | undefined)?.basis;
  const snapshot = approval.proposedActionSnapshot ?? {};
  const out = [
    `Approval is needed to ${capability ? `use ${capability.name}` : "take a tool action"} (${invocation.permission ?? "no permission recorded"}), risk ${approval.riskTier}.`,
    `Why: ${basis ? (BASIS_WORDS[basis] ?? words(basis)) : "Policy required approval"}.`,
  ];
  if (typeof snapshot.question === "string") out.push(`The question: "${snapshot.question}".`);
  if (approval.ttl) out.push(`It expires at ${approval.ttl.toISOString()} if nobody decides; expiry counts as a rejection.`);
  out.push("Approving lets exactly the recorded action run (its snapshot, and any pinned hash, must still match); rejecting fails the step.");
  return out;
}

async function explainGoal(db: Reader, id: string): Promise<Explanation | null> {
  const goal = await db.query.goals.findFirst({ where: eq(goals.id, id) });
  if (!goal) return null;
  const latest = await db.query.workflowRuns.findFirst({ where: eq(workflowRuns.goalId, id), orderBy: desc(workflowRuns.createdAt) });
  if (!latest) return { subject: { type: "goal", id }, headline: `Goal "${goal.title}" has no workflow run.`, status: goal.status, facts: [{ label: "status", value: goal.status }], reasons: [], next: [] };
  const inner = (await explainWorkflowRun(db, latest.id))!;
  return { ...inner, subject: { type: "goal", id }, facts: [{ label: "goal status", value: words(goal.status) }, ...inner.facts] };
}

async function explainApproval(db: Reader, id: string): Promise<Explanation | null> {
  const approval = await db.query.approvals.findFirst({ where: eq(approvals.id, id) });
  if (!approval) return null;
  const invocation = await db.query.invocations.findFirst({ where: eq(invocations.id, approval.invocationId) });
  const run = invocation ? await db.query.runs.findFirst({ where: eq(runs.id, invocation.runId) }) : undefined;
  const agent = run?.agentDefinitionId
    ? await db.query.agentDefinitions.findFirst({ where: and(eq(agentDefinitions.id, run.agentDefinitionId), eq(agentDefinitions.version, run.agentDefinitionVersion!)) })
    : undefined;
  const reasons = invocation ? await describeApproval(db, approval, invocation) : ["Its invocation was not found."];
  const status = approval.status;
  return {
    subject: { type: "approval", id },
    headline: status === "pending" ? "This approval is waiting for your decision." : `This approval was ${status}.`,
    status,
    facts: [
      { label: "status", value: status },
      { label: "agent", value: agent ? `${agent.name} v${agent.version}` : "not recorded" },
      { label: "risk", value: approval.riskTier },
    ],
    reasons,
    next: [{ label: "Open approvals", href: "/approvals" }],
  };
}

async function explainAgent(db: Reader, id: string): Promise<Explanation | null> {
  const agent = await db.query.agentDefinitions.findFirst({ where: eq(agentDefinitions.id, id) });
  if (!agent) return null;
  const grants = await db
    .select({ grant: capabilityGrants, capability: capabilities })
    .from(capabilityGrants)
    .innerJoin(capabilities, eq(capabilityGrants.capabilityId, capabilities.id))
    .where(and(eq(capabilityGrants.agentDefinitionId, id), eq(capabilityGrants.agentDefinitionVersion, agent.version), isNull(capabilityGrants.revokedAt)));
  const unfinished = (await db.select({ status: runs.status }).from(runs).where(eq(runs.agentDefinitionId, id))).filter((r) => r.status !== "completed" && r.status !== "failed");
  const stops = await activeStopsFor(db, [
    { scope: "global", ref: null },
    { scope: "agent_definition", ref: id },
  ]);
  const profile = (agent.executionProfile ?? {}) as { preferredTier?: string; provider?: string; loop?: { maxIterations?: number; maxActiveSeconds?: number } };
  const reasons = grants.length === 0
    ? ["It holds no keys (Capability Grants): it can think and write, but it cannot use any capability."]
    : grants.map(({ grant, capability }) => `May use ${capability.name} (${grant.permissions.join(", ")}): ${AUTONOMY_WORDS[grant.autonomyState] ?? grant.autonomyState}.`);
  reasons.push("Whatever its keys allow, Policy, budgets, approvals and emergency stops still apply to every action.");
  for (const s of stops) reasons.push(`A ${words(s.scope)} stop is engaged${s.reason ? `: "${s.reason}"` : ""}, so it cannot act.`);
  return {
    subject: { type: "agent", id },
    headline: `${agent.name} v${agent.version}: ${agent.role}.`,
    status: stops.length > 0 ? "stopped" : unfinished.length > 0 ? "working" : "idle",
    facts: [
      { label: "objective", value: agent.objective },
      { label: "unfinished runs", value: String(unfinished.length) },
      { label: "tier", value: profile.preferredTier ?? "runtime default" },
      ...(profile.provider ? [{ label: "provider", value: `${profile.provider} only` }] : []),
      ...(profile.loop?.maxIterations ? [{ label: "iteration limit", value: String(profile.loop.maxIterations) }] : []),
    ],
    reasons,
    next: [
      { label: "Open the agent", href: `/agents/${id}` },
      { label: "Make a new version", href: `/agents/new?from=${id}` },
    ],
  };
}

async function explainArtifact(db: Reader, id: string): Promise<Explanation | null> {
  const row = await db.query.artifacts.findFirst({ where: eq(artifacts.id, id) });
  if (!row) return null;
  const matches = row.inlineContent === null ? null : createHash("sha256").update(row.inlineContent).digest("hex") === row.hash;
  const reasons = [
    matches === null ? "Its bytes are not stored inline, so the hash was not rechecked here." : matches ? "Its stored bytes still match their sha256 hash." : "Its stored bytes NO LONGER match their hash: treat it as untrusted.",
    "Artifacts are immutable: the database refuses changes; a new version would be a new artifact.",
  ];
  try {
    const content = JSON.parse(row.inlineContent ?? "null") as { format?: string; completion?: { status: string; reason: string }; basis?: { externalResearch?: boolean; note?: string | null } } | null;
    if (content?.completion) reasons.push(`The work behind it ended ${content.completion.status} (${words(content.completion.reason)}).`);
    if (content?.basis) reasons.push(content.basis.externalResearch ? "External research contributed to it." : `No external research was performed${content.basis.note ? `: ${content.basis.note}` : "."}`);
  } catch {
    // Not JSON: nothing more to say about its content.
  }
  return {
    subject: { type: "artifact", id },
    headline: `A ${row.type} (version ${row.version}, ${row.size} bytes).`,
    status: matches === false ? "hash_mismatch" : "ok",
    facts: [
      { label: "type", value: row.type },
      { label: "sha256", value: row.hash },
      { label: "created", value: row.createdAt.toISOString() },
    ],
    reasons,
    next: [{ label: "Open it", href: `/artifacts/${id}` }],
  };
}

async function explainRun(db: Reader, id: string): Promise<Explanation | null> {
  const run = await db.query.runs.findFirst({ where: eq(runs.id, id) });
  if (!run) return null;
  const ti = await db.query.taskInstances.findFirst({ where: eq(taskInstances.id, run.taskInstanceId) });
  if (ti?.workflowRunId) {
    const inner = await explainWorkflowRun(db, ti.workflowRunId);
    if (inner) return { ...inner, subject: { type: "run", id } };
  }
  return { subject: { type: "run", id }, headline: `A standalone run, ${words(run.status)}.`, status: run.status, facts: [], reasons: await failureReasons(db, id), next: [] };
}

async function explainSystem(db: Reader): Promise<Explanation> {
  const agentRows = await db.select({ name: agentDefinitions.name }).from(agentDefinitions);
  const capabilityRows = await db.select().from(capabilities).orderBy(asc(capabilities.name));
  const bindingRows = await db.select().from(toolBindings);
  const workflowRows = await db.select({ name: workflowDefinitions.name }).from(workflowDefinitions);
  const kinds = new Set((await db.select({ kind: taskDefinitions.kind }).from(taskDefinitions)).map((t) => t.kind));
  const pending = await db.select({ id: approvals.id }).from(approvals).where(eq(approvals.status, "pending"));
  const stops = await db.select().from(executionStops).where(isNull(executionStops.liftedAt));
  const running = await db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.status, "in_progress"));

  // Imported lazily: the tool-adapter registry imports `system.inspect`, which imports this module.
  const { evidenceClassOfFunction } = await import("../capabilities/toolAdapters.js");
  const evidence = capabilityRows.map((c) => {
    const newest = bindingRows.filter((b) => b.capabilityId === c.id).sort((a, b) => b.version - a.version)[0];
    return { name: c.name, evidenceClass: newest ? evidenceClassOfFunction(newest.config?.function) : undefined };
  });
  const reasons = [
    `Capabilities: ${evidence.map((e) => (e.evidenceClass ? `${e.name} (${e.evidenceClass})` : e.name)).join(", ") || "none"}.`,
    evidence.some((e) => e.evidenceClass === "external")
      ? "External research is available through a capability whose binding reaches external sources."
      : "No capability performs external web research: research here means retrieving data already held (fixture or local documents), and deliverables say so.",
    kinds.has("agent_objective") ? "Agents can be given open-ended objectives and work autonomously within limits (12 iterations, 15 active minutes, budgets, approvals, stops)." : "Autonomous objectives are not set up (run the seed).",
    kinds.has("agent_task") ? "Custom workflows can chain agent tasks, pass outputs between steps and add approval gates." : "",
    stops.length > 0 ? `${stops.length} emergency stop(s) are engaged.` : "No emergency stop is engaged.",
  ].filter(Boolean);
  return {
    subject: { type: "system", id: null },
    headline: "What the Command Keep can do right now.",
    status: stops.some((s) => s.scope === "global") ? "stopped" : "running",
    facts: [
      { label: "agents", value: String(new Set(agentRows.map((a) => a.name)).size) },
      { label: "workflows", value: String(new Set(workflowRows.map((w) => w.name)).size) },
      { label: "runs in progress", value: String(running.length) },
      { label: "pending approvals", value: String(pending.length) },
    ],
    reasons,
    next: [
      { label: "Recruit an agent", href: "/agents/new" },
      { label: "Build a workflow", href: "/workflows/new" },
      ...(pending.length > 0 ? [{ label: "Review approvals", href: "/approvals" }] : []),
    ],
  };
}
