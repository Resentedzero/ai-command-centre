/**
 * `keeper_answer` (V1.1): Keeper Think. Runs only when the operator explicitly presses
 * Think; an ordinary governed Goal in the Keeper project, run by the ordinary Keeper
 * Agent Definition, which holds only READ Grants:
 *
 *   1. tool `system.inspect` (READ): the bounded explanation of the question's subject — since R2
 *      Stage 6, the curated FACT / DERIVED / UNKNOWN answer when the question maps to an intent
 *   2. tool `system.keep_stats` (READ, R2 observability): the Keep's recorded statistics for the window the
 *      question names, only when the question asks for statistics (skipped otherwise, decided by code)
 *   3. tool `docs.retrieve` (READ): the guide cards matching the question
 *   4. llm (intent write, CHEAP by the Keeper's profile): the answer, key points and an
 *      optional proposal
 *   5. deterministic: the `keeper_answer` Artifact (a deliverable/v1 document), with
 *      `checks.unsupportedNumbers`: numbers in the answer that the records it was given do not contain
 *
 * The question is the Goal title; its subject is a `Subject:` line in the Goal
 * description, written by `POST /keeper/questions`. A proposal is data for a builder
 * form to pre-fill; nothing here or in the Keeper can create or change anything.
 */
import { eq } from "drizzle-orm";
import { artifacts, goals, taskInstances, workflowRuns } from "../../db/schema.js";
import type { DrizzleTransaction } from "../../events/emit.js";
import type { ContextBudget } from "../../context/types.js";
import type { DeferredInvocationSpec, LlmInvocationSpec, PlannedInvocationSpec } from "../../execution/types.js";
import { TIER_DIFFICULTY, type ExecutionProfile } from "../../definitions/executionProfile.js";
import { parseSubject, subjectKey, type Subject } from "../../keeper/explain.js";
import { resolveToolInvocation } from "../toolAdapters.js";
import { findRunByTaskInstanceId } from "../shared/runProvisioning.js";
import { evidenceBasisFor, persistDeliverableArtifact } from "../shared/deliverable.js";
import { SYSTEM_INSPECT_CAPABILITY } from "../systemInspect/capability.js";
import { DOCS_RETRIEVE_CAPABILITY } from "../docsRetrieve/capability.js";
import { KEEP_STATS_CAPABILITY, asksForKeepStats, keepStatsText, windowForQuestion } from "../keepStats/capability.js";

export const KEEPER_SUBJECT_PREFIX = "Subject: ";

export function keeperGoalDescription(subject: Subject): string {
  return `${KEEPER_SUBJECT_PREFIX}${subjectKey(subject)}`;
}

export const KEEPER_ANSWER_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    keyPoints: { type: "array", items: { type: "string" } },
    proposal: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["none", "agent", "workflow"] },
        name: { type: "string" },
        role: { type: "string" },
        objective: { type: "string" },
        instructions: { type: "string" },
        capabilities: { type: "array", items: { type: "string" } },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: { label: { type: "string" }, taskKind: { type: "string" }, agentName: { type: "string" }, instruction: { type: "string" } },
            required: ["label", "taskKind", "agentName", "instruction"],
            additionalProperties: false,
          },
        },
      },
      required: ["kind", "name", "role", "objective", "instructions", "capabilities", "steps"],
      additionalProperties: false,
    },
  },
  required: ["answer", "keyPoints", "proposal"],
  additionalProperties: false,
} as const satisfies Record<string, unknown>;

const KEEPER_DIRECTIVE =
  "You are the Keeper, the Command Keep's guide. Answer the operator's question (the Goal title) using only the system " +
  "snapshot and guide cards provided; they describe this system's real current state and how it works. Be concrete and " +
  "brief. When the snapshot has `facts`, `derived` and `unknown`, those are the whole truth: restate the facts and derived " +
  "lines in plain words, keep every unknown unknown, and never add a number, reason or record that is not there or guess. " +
  "Say plainly when the records do not show something. You cannot change anything and must never claim you did. " +
  "When Keep statistics are provided, write a mini report: the exact window (from and to), the key metrics with their values, " +
  "notable activity (for example which agents worked), one or two sentences of interpretation marked as your interpretation, " +
  "and the `unknown` items as limitations. Every number must come from the statistics; never compute new ones. " +
  "If the operator asks you to create, run or organise work, say that the Manager does that (Command, or Talk to the Manager in the world); you explain, you do not operate. " +
  "If creating an agent or workflow would help, describe it in `proposal` (kind agent or workflow) for the operator to review " +
  "in a builder form; otherwise set kind to none and leave its other fields empty.";

/**
 * Numbers of three or more digits in the model's answer that appear nowhere in the records it was
 * given (thousands separators ignored, so "3,450" matches 3450). Short numbers ("v2", "1 of 2") are
 * too common to check. A tripwire shown to the operator, not a gate; model output stays untrusted.
 */
/**
 * The human-readable record text of a `system.inspect` result: an intent answer's headline, facts,
 * derived lines and unknowns, or a general explanation's headline, fact values and reasons. Ids,
 * links, hashes, sizes and the operator's own question are left out, so a number cannot pass the
 * tripwire just by matching digits inside them.
 */
export function recordText(inspectResult: string): string {
  try {
    const e = (JSON.parse(inspectResult) as { explanation?: Record<string, unknown> }).explanation ?? {};
    const texts = (v: unknown, key?: string) => (Array.isArray(v) ? v.map((x) => (key && x && typeof x === "object" ? String((x as Record<string, unknown>)[key] ?? "") : String(x))) : []);
    return [String(e.headline ?? ""), ...texts(e.facts, "text"), ...texts(e.facts, "value"), ...texts(e.derived, "text"), ...texts(e.unknown), ...texts(e.reasons)].join("\n");
  } catch {
    return "";
  }
}

export function unsupportedNumbers(answer: string, records: string): string[] {
  const digits = (s: string) => s.replace(/(\d),(?=\d{3}\b)/g, "$1").match(/\d{3,}/g) ?? [];
  const known = new Set(digits(records));
  return [...new Set(digits(answer))].filter((d) => !known.has(d)).slice(0, 10);
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** A proposal is untrusted model output: bounded and reduced to the fields a builder form can pre-fill. */
export function sanitizeProposal(value: unknown): Record<string, unknown> {
  const p = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const kind = p.kind === "agent" || p.kind === "workflow" ? p.kind : "none";
  if (kind === "none") return { kind };
  const common = { kind, name: str(p.name, 80) };
  if (kind === "agent") {
    return {
      ...common,
      role: str(p.role, 200),
      objective: str(p.objective, 2_000),
      instructions: str(p.instructions, 4_000),
      capabilities: (Array.isArray(p.capabilities) ? p.capabilities : []).filter((c): c is string => typeof c === "string").slice(0, 10).map((c) => c.slice(0, 80)),
    };
  }
  return {
    ...common,
    steps: (Array.isArray(p.steps) ? p.steps : []).slice(0, 8).map((s) => {
      const r = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
      return { label: str(r.label, 200), taskKind: str(r.taskKind, 40), agentName: str(r.agentName, 80), instruction: str(r.instruction, 4_000) };
    }),
  };
}

export async function buildKeeperAnswerInvocationSpecs(
  tx: DrizzleTransaction,
  config: { contextBudget: ContextBudget; profile: ExecutionProfile },
  params: { taskInstanceId: string }
): Promise<PlannedInvocationSpec[]> {
  const run = await findRunByTaskInstanceId(tx, params.taskInstanceId);
  const taskInstance = await tx.query.taskInstances.findFirst({ where: eq(taskInstances.id, params.taskInstanceId) });
  const workflowRun = taskInstance?.workflowRunId ? await tx.query.workflowRuns.findFirst({ where: eq(workflowRuns.id, taskInstance.workflowRunId) }) : undefined;
  const goal = workflowRun ? await tx.query.goals.findFirst({ where: eq(goals.id, workflowRun.goalId) }) : undefined;
  if (!goal) throw new Error("keeper_answer: the question's Goal was not found (fail closed).");
  const question = goal.title;
  const subjectLine = (goal.description ?? "").split(/\r?\n/).find((l) => l.startsWith(KEEPER_SUBJECT_PREFIX));
  const subject = parseSubject(subjectLine?.slice(KEEPER_SUBJECT_PREFIX.length).trim()) ?? { type: "system", id: null };

  const inspect: DeferredInvocationSpec = async () =>
    resolveToolInvocation(tx, { capabilityName: SYSTEM_INSPECT_CAPABILITY.id, permission: "READ", proposedActionSnapshot: { subject: subjectKey(subject), question: question.slice(0, 1_000) } });
  const stats: DeferredInvocationSpec = async () =>
    asksForKeepStats(question)
      ? resolveToolInvocation(tx, { capabilityName: KEEP_STATS_CAPABILITY.id, permission: "READ", proposedActionSnapshot: { window: windowForQuestion(question) } })
      : { kind: "skip", reason: "the question does not ask for Keep statistics" };
  const docs: DeferredInvocationSpec = async () =>
    resolveToolInvocation(tx, { capabilityName: DOCS_RETRIEVE_CAPABILITY.id, permission: "READ", proposedActionSnapshot: { query: question.slice(0, 300) } });
  const write: DeferredInvocationSpec = async (ctx) => {
    const spec: LlmInvocationSpec = {
      kind: "llm",
      costClass: "llm",
      intent: "write",
      directive: KEEPER_DIRECTIVE,
      candidateArtifactIds: ctx.priorArtifacts.filter((a) => a.seqNo === 1 || a.seqNo === 2 || a.seqNo === 3).map((a) => a.artifactId),
      candidateToolCapabilityIds: [],
      contextBudget: config.contextBudget,
      taskDifficulty: TIER_DIFFICULTY[config.profile.preferredTier ?? "CHEAP"],
      riskTier: "low",
      expectedOutputShape: KEEPER_ANSWER_SCHEMA,
      ...(config.profile.provider ? { requiredProvider: config.profile.provider } : {}),
    };
    return spec;
  };
  const persist: DeferredInvocationSpec = async (ctx) => {
    const written = ctx.priorArtifacts.find((a) => a.seqNo === 4);
    const docsArtifact = ctx.priorArtifacts.find((a) => a.seqNo === 3);
    if (!written) throw new Error("keeper_answer: no answer was written (fail closed).");
    return {
      kind: "deterministic",
      costClass: "deterministic",
      execute: async () => {
        const read = async (id: string | undefined) => {
          const row = id ? await tx.query.artifacts.findFirst({ where: eq(artifacts.id, id) }) : undefined;
          return JSON.parse(row?.inlineContent ?? "null") as Record<string, unknown> | null;
        };
        const output = await read(written.artifactId);
        if (!output || typeof output.answer !== "string") throw new Error("keeper_answer: the answer is unreadable (fail closed).");
        const cards = ((await read(docsArtifact?.artifactId))?.results ?? []) as { title?: string; slug?: string }[];
        const inspected = ctx.priorArtifacts.find((a) => a.seqNo === 1);
        const snapshotText = inspected ? ((await tx.query.artifacts.findFirst({ where: eq(artifacts.id, inspected.artifactId) }))?.inlineContent ?? "") : "";
        const statsArtifact = ctx.priorArtifacts.find((a) => a.seqNo === 2);
        const statsStored = statsArtifact ? ((await tx.query.artifacts.findFirst({ where: eq(artifacts.id, statsArtifact.artifactId) }))?.inlineContent ?? "") : "";
        const keyPoints = Array.isArray(output.keyPoints) ? output.keyPoints.filter((k): k is string => typeof k === "string") : [];
        const basis = await evidenceBasisFor(tx, [run.id], []);
        await persistDeliverableArtifact(
          tx,
          written.invocationId,
          {
            title: question,
            summary: "",
            body: output.answer,
            findings: output.keyPoints,
            recommendations: [],
            sources: cards.filter((c) => c.title).map((c) => ({ label: c.title, ref: `docs/keeper/${c.slug}.md` })),
          },
          {
            basis,
            type: "keeper_answer",
            extra: {
              question,
              subject: subjectKey(subject),
              proposal: sanitizeProposal(output.proposal),
              checks: { unsupportedNumbers: unsupportedNumbers(`${output.answer} ${keyPoints.join(" ")}`, `${recordText(snapshotText)}\n${keepStatsText(statsStored)}`) },
            },
          }
        );
        return {};
      },
    };
  };
  return [inspect, stats, docs, write, persist];
}
