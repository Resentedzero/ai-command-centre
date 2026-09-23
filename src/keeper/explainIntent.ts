/**
 * The Keeper's intent explanations (R2 Stage 6): deterministic answers to the questions in
 * `./intents.ts`, built only from the authoritative record for each, as
 *
 *   FACT     what the runtime records (each line names its source and links to the record)
 *   DERIVED  what code calculates from those facts (level from XP, sums, the rule applied)
 *   UNKNOWN  what the records do not show — never filled in
 *
 * CURATED, BOUNDED CONTEXT. Each explainer reads only the rows its question needs, for its one
 * subject: never other agents' records, never a Tool Binding's config, never an environment
 * variable, and never model-written content (decisions, deliverable text, answers) as a fact.
 * Sections and lines are capped; `size` reports the answer's characters and estimated tokens.
 *
 * READ-ONLY. The explainers take a `Reader` (query/select only); the route runs them in a
 * READ ONLY transaction, so Postgres refuses any write. No model, Run, Invocation or event.
 *
 * NOT AUTHORITY. Nothing that authorizes, routes, budgets or executes imports this module
 * (`tests/execution/structuralInvariants.test.ts`). It names no capability and no seeded Definition.
 */
import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  agentAchievements,
  agentDefinitions,
  agentDomainWork,
  agentEndorsements,
  agentPerformance,
  agentXpAwards,
  approvals,
  artifacts,
  capabilities,
  events,
  executionStops,
  invocations,
  runs,
  taskDefinitions,
  taskInstances,
  workflowRuns,
  goals as goalsTable,
} from "../db/schema.js";
import { availabilityOf } from "../workplace/availability.js";
import type { DrizzleTransaction } from "../events/emit.js";
import { availabilityFor, listMeetings, meetingPresence, readSettings, availabilityInputs } from "../workplace/workplace.js";
import { addDays, formatWall, fromWallClock, wallClock } from "../workplace/zonedTime.js";
import { estimateTokens } from "../context/tokenEstimate.js";
import { ACHIEVEMENTS, ACHIEVEMENT_CONDITIONS, LEVEL_STEP_XP, SPECIALISATION_MIN_RUNS, levelFor } from "../projections/progressionRules.js";
import type { Reader, Subject } from "./explain.js";
import { INTENT_BY_ID, agentNamedIn, classifyQuestion, intentsFor, isIntentId, type IntentId, type SubjectKind } from "./intents.js";

export type KeeperLink = { label: string; href: string };
export type KeeperLine = { text: string; source: string; links: KeeperLink[] };
export type KeeperAnswer = {
  intent: IntentId | null;
  intentLabel: string | null;
  subject: { type: SubjectKind; id: string | null; name: string | null };
  question: string | null;
  headline: string;
  facts: KeeperLine[];
  derived: KeeperLine[];
  unknown: string[];
  /** The authorities this answer's facts came from. */
  sources: string[];
  /** What else the Keeper can explain about this subject. */
  canExplain: { intent: IntentId; label: string }[];
  size: { characters: number; estimatedTokens: number };
};

export const LIMITS = { facts: 24, derived: 12, unknown: 6, text: 400, runs: 8, awards: 20 } as const;

const clip = (s: string) => (s.length > LIMITS.text ? `${s.slice(0, LIMITS.text - 1)}…` : s);
const words = (s: string) => s.replace(/_/g, " ");
const short = (id: string) => id.slice(0, 8);
const n = (v: number) => v.toLocaleString("en-GB");

const STOP_WORDS: Record<string, string> = {
  evidence_sufficient: "the agent finished and code verified the evidence it cited",
  agent_finished: "the agent said it was finished, without evidence code could verify",
  max_iterations: "it reached its iteration limit before finishing",
  active_time_limit: "it reached its active-time limit before finishing",
  budget_headroom: "the Budget Governor saw no headroom for another iteration, so the runtime stopped it (not counted against the agent)",
};

const POLICY_WORDS: Record<string, string> = {
  autonomy_autonomous: "the Grant lets the agent act without asking (AUTONOMOUS)",
  autonomy_always_approve: "the Grant is set to ask the operator first (ALWAYS_APPROVE)",
  unverified_binding_requires_approval: "the tool binding is unverified, so a human must approve",
  conditional_human_gated_action: "under Conditional Autonomy this kind of action always needs a human",
  conditional_insufficient_evidence: "there was not enough measured performance to allow it automatically",
  conditional_performance_meets_allow_threshold: "measured performance met the automatic-allow threshold",
  conditional_performance_below_allow_threshold: "measured performance was below the automatic-allow threshold",
  conditional_performance_below_deny_threshold: "measured performance was below the deny threshold",
};

/** Collects bounded lines. A line identical to one already recorded is counted, not repeated. */
class Builder {
  facts: KeeperLine[] = [];
  derived: KeeperLine[] = [];
  unknown: string[] = [];
  omitted = { facts: 0, derived: 0 };
  private repeats = new Map<KeeperLine, number>();
  private add(list: KeeperLine[], kind: "facts" | "derived", max: number, text: string, source: string, links: KeeperLink[]) {
    const same = list.find((l) => l.text.startsWith(clip(text)) && l.source === source);
    if (same) {
      const times = (this.repeats.get(same) ?? 1) + 1;
      this.repeats.set(same, times);
      same.text = `${clip(text)} (recorded ${times} times)`;
      return;
    }
    const unique = links.filter((l, i) => links.findIndex((o) => o.href === l.href) === i);
    if (list.length < max) list.push({ text: clip(text), source, links: unique });
    else this.omitted[kind]++;
  }
  fact(text: string, source: string, links: KeeperLink[] = []) {
    this.add(this.facts, "facts", LIMITS.facts, text, source, links);
  }
  derive(text: string, source: string, links: KeeperLink[] = []) {
    this.add(this.derived, "derived", LIMITS.derived, text, source, links);
  }
  dunno(text: string) {
    if (this.unknown.length < LIMITS.unknown) this.unknown.push(clip(text));
  }
}

type AgentTarget = { kind: "agent"; name: string; definitions: { id: string; version: number }[] };
type RunInfo = { id: string; status: string; attempt: number; workflowRunId: string | null; agentName: string | null; agentVersion: number | null; taskName: string | null };
type Target = AgentTarget | { kind: "runs"; subject: Subject; runs: RunInfo[]; omittedRuns?: boolean } | { kind: "artifact"; id: string } | { kind: "approval"; id: string; runs: RunInfo[] } | { kind: "system" };

const agentLink = (a: AgentTarget): KeeperLink => ({ label: a.name, href: `/agents/${a.definitions.at(-1)!.id}` });
const runLink = (r: Pick<RunInfo, "id" | "workflowRunId" | "agentName" | "agentVersion">): KeeperLink[] =>
  r.workflowRunId ? [{ label: `run ${short(r.id)}${r.agentName ? ` (${r.agentName} v${r.agentVersion})` : ""}`, href: `/workflows/${r.workflowRunId}` }] : [];
const artifactLink = (id: string, label = `artifact ${short(id)}`): KeeperLink => ({ label, href: `/artifacts/${id}` });
const runLabel = (r: RunInfo) => `run ${short(r.id)}${r.agentName ? ` by ${r.agentName} v${r.agentVersion}` : ""}${r.taskName ? ` (${r.taskName})` : ""}`;

/** Answers one question about one subject. `intent` may be given directly (the UI's choices) or classified from the question. */
/** `addressee`: the Keeper's own name, ignored in a question that also names another agent. */
export async function answerQuestion(db: Reader, input: { subject: Subject; question?: string | null; intent?: string | null; addressee?: string | null }): Promise<KeeperAnswer> {
  const question = input.question?.trim().slice(0, 1_000) || null;
  const names = [...new Set((await db.select({ name: agentDefinitions.name }).from(agentDefinitions)).map((r) => r.name))];
  const named = question ? agentNamedIn(question, names, input.addressee) : null;
  const intent: IntentId | null = isIntentId(input.intent) ? input.intent : question ? classifyQuestion(question, input.subject.type, named !== null && "name" in named) : null;

  const b = new Builder();
  const subjectOut: KeeperAnswer["subject"] = { type: input.subject.type, id: input.subject.id, name: null };
  const finish = (headline: string, chosen: IntentId | null): KeeperAnswer => {
    if (b.omitted.facts > 0) b.dunno(`${b.omitted.facts} more fact(s) are recorded but not listed here, to keep this answer bounded.`);
    const answer: KeeperAnswer = {
      intent: chosen,
      intentLabel: chosen ? INTENT_BY_ID.get(chosen)!.label : null,
      subject: subjectOut,
      question,
      headline: clip(headline),
      facts: b.facts,
      derived: b.derived,
      unknown: b.unknown,
      sources: [...new Set([...b.facts, ...b.derived].map((l) => l.source))],
      canExplain: intentsFor(subjectOut.type).map((i) => ({ intent: i.id, label: i.label })),
      size: { characters: 0, estimatedTokens: 0 },
    };
    const serialised = JSON.stringify({ ...answer, size: undefined });
    answer.size = { characters: serialised.length, estimatedTokens: estimateTokens(serialised) };
    return answer;
  };

  if (named && "ambiguous" in named) {
    b.dunno(`The question names more than one agent (${named.ambiguous.join(", ")}); ask about one.`);
    return finish("Which agent do you mean?", null);
  }
  if (!intent) {
    b.dunno("That question is not one the Keeper can answer from the records yet. It can explain the questions listed below.");
    return finish("I can't answer that from the records yet.", null);
  }

  const spec = INTENT_BY_ID.get(intent)!;
  const target = await resolveTarget(db, input.subject, named && "name" in named ? named.name : null, spec.subjects);
  if (!target) {
    const needs = spec.subjects.map(words).join(", ");
    b.dunno(`"${spec.label}" needs ${spec.subjects.includes("agent") ? "an agent (name it, or ask from its page)" : `one of: ${needs}`}; this page's subject is ${words(input.subject.type)}.`);
    return finish("I need a different subject to explain that.", intent);
  }
  if (target.kind === "agent") {
    subjectOut.type = "agent";
    subjectOut.id = target.definitions.at(-1)!.id;
    subjectOut.name = target.name;
  }

  if (target.kind === "runs" && target.omittedRuns) b.dunno(`This work has more than ${LIMITS.runs} runs; only the newest ${LIMITS.runs} are explained.`);
  const headline = await EXPLAINERS[intent](db, target, b);
  return finish(headline, intent);
}

async function resolveTarget(db: Reader, subject: Subject, namedAgent: string | null, accepts: SubjectKind[]): Promise<Target | null> {
  const agentByName = async (name: string): Promise<AgentTarget | null> => {
    const defs = await db.select({ id: agentDefinitions.id, version: agentDefinitions.version }).from(agentDefinitions).where(eq(agentDefinitions.name, name)).orderBy(asc(agentDefinitions.version));
    return defs.length > 0 ? { kind: "agent", name, definitions: defs } : null;
  };
  if (accepts.includes("agent") && namedAgent) return agentByName(namedAgent);
  if (!accepts.includes(subject.type)) return null;
  switch (subject.type) {
    case "system":
      return { kind: "system" };
    case "agent": {
      const def = await db.query.agentDefinitions.findFirst({ where: eq(agentDefinitions.id, subject.id) });
      return def ? agentByName(def.name) : null;
    }
    case "artifact":
      return (await db.query.artifacts.findFirst({ where: eq(artifacts.id, subject.id) })) ? { kind: "artifact", id: subject.id } : null;
    case "approval": {
      const approval = await db.query.approvals.findFirst({ where: eq(approvals.id, subject.id) });
      const inv = approval ? await db.query.invocations.findFirst({ where: eq(invocations.id, approval.invocationId) }) : undefined;
      return approval ? { kind: "approval", id: subject.id, runs: inv ? await runInfos(db, [inv.runId]) : [] } : null;
    }
    case "run":
      return (await db.query.runs.findFirst({ where: eq(runs.id, subject.id) })) ? { kind: "runs", subject, runs: await runInfos(db, [subject.id]) } : null;
    case "workflow_run":
    case "goal": {
      const wrId =
        subject.type === "workflow_run"
          ? subject.id
          : (await db.query.workflowRuns.findFirst({ where: eq(workflowRuns.goalId, subject.id), orderBy: desc(workflowRuns.createdAt) }))?.id;
      if (!wrId || !(await db.query.workflowRuns.findFirst({ where: eq(workflowRuns.id, wrId) }))) return null;
      // The newest runs (retries included), so a final failure is never the one left out.
      const ids = await db
        .select({ id: runs.id })
        .from(runs)
        .innerJoin(taskInstances, eq(taskInstances.id, runs.taskInstanceId))
        .where(eq(taskInstances.workflowRunId, wrId))
        .orderBy(desc(runs.startedAt))
        .limit(LIMITS.runs + 1);
      return { kind: "runs", subject, runs: await runInfos(db, ids.map((r) => r.id).slice(0, LIMITS.runs)), omittedRuns: ids.length > LIMITS.runs };
    }
  }
}

async function runInfos(db: Reader, ids: string[]): Promise<RunInfo[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ run: runs, ti: taskInstances, agentName: agentDefinitions.name, taskName: taskDefinitions.name })
    .from(runs)
    .innerJoin(taskInstances, eq(taskInstances.id, runs.taskInstanceId))
    .leftJoin(agentDefinitions, eq(agentDefinitions.id, runs.agentDefinitionId))
    .leftJoin(taskDefinitions, eq(taskDefinitions.id, taskInstances.taskDefinitionId))
    .where(inArray(runs.id, ids))
    .orderBy(asc(runs.startedAt));
  return rows.map((r) => ({
    id: r.run.id,
    status: r.run.status,
    attempt: r.run.attempt,
    workflowRunId: r.ti.workflowRunId,
    agentName: r.agentName,
    agentVersion: r.run.agentDefinitionVersion,
    taskName: r.taskName,
  }));
}

type Explainer = (db: Reader, target: Target, b: Builder) => Promise<string>;

const asAgent = (t: Target) => t as AgentTarget;
const runsOf = (t: Target): RunInfo[] => (t.kind === "runs" || t.kind === "approval" ? t.runs : []);

async function awardsOf(db: Reader, name: string) {
  return db.select().from(agentXpAwards).where(eq(agentXpAwards.agentName, name)).orderBy(desc(agentXpAwards.earnedAt), asc(agentXpAwards.awardKey));
}

function awardLinks(a: typeof agentXpAwards.$inferSelect): KeeperLink[] {
  const links: KeeperLink[] = [];
  if (a.artifactId) links.push(artifactLink(a.artifactId, "deliverable"));
  if (a.workflowRunId) links.push({ label: "workflow run", href: `/workflows/${a.workflowRunId}` });
  return links;
}

const AWARD_WORDS: Record<string, string> = {
  task: "a successful task",
  research: "that task being real research",
  capability: "using a capability in successful work",
  workflow: "its workflow completing",
  mission: "its mission (goal) completing",
  validated_artifact: "a deliverable backed by code-verified evidence",
  quality_verdict: "the operator's quality verdict",
};

async function levelFacts(db: Reader, a: AgentTarget, b: Builder) {
  const awards = await awardsOf(db, a.name);
  const xp = awards.reduce((s, x) => s + x.xp, 0);
  const lv = levelFor(xp);
  b.fact(`${a.name} has ${n(xp)} XP from ${awards.length} recorded award(s).`, "agent_xp_awards", [agentLink(a)]);
  b.derive(
    `Level ${lv.level} starts at ${n(lv.levelStartXp)} XP and level ${lv.level + 1} at ${n(lv.nextLevelXp)} XP, so ${a.name} is level ${lv.level}, ${n(lv.nextLevelXp - xp)} XP short of level ${lv.level + 1}.`,
    "progression rules: threshold(L) = " + LEVEL_STEP_XP + " × (L(L+1)/2 − 1)"
  );
  return { awards, xp, lv };
}

const EXPLAINERS: Record<IntentId, Explainer> = {
  async level(db, t, b) {
    const a = asAgent(t);
    const { lv, awards } = await levelFacts(db, a, b);
    if (awards.length === 0) b.dunno(`No XP award is recorded for ${a.name}: XP comes only from successful work and the operator's verdicts.`);
    b.derive("A level grants nothing: what an agent may do is set only by its Capability Grants.", "architecture rule");
    return `${a.name} is level ${lv.level}.`;
  },

  async xp_ledger(db, t, b) {
    const a = asAgent(t);
    const { awards, xp } = await levelFacts(db, a, b);
    const byRule = new Map<string, { count: number; xp: number }>();
    for (const w of awards) byRule.set(w.rule, { count: (byRule.get(w.rule)?.count ?? 0) + 1, xp: (byRule.get(w.rule)?.xp ?? 0) + w.xp });
    for (const [rule, s] of byRule) b.derive(`${n(s.xp)} XP from ${s.count} award(s) for ${AWARD_WORDS[rule] ?? words(rule)}.`, "agent_xp_awards (summed by rule)");
    for (const w of awards.slice(0, LIMITS.awards)) {
      b.fact(`+${w.xp} XP for ${AWARD_WORDS[w.rule] ?? words(w.rule)}${w.runId ? ` (run ${short(w.runId)})` : ""}, ${w.earnedAt.toISOString().slice(0, 10)}.`, "agent_xp_awards", awardLinks(w));
    }
    if (awards.length > LIMITS.awards) b.dunno(`${awards.length - LIMITS.awards} older award(s) are not listed; the agent's Progress ledger lists them all.`);
    if (awards.length === 0) b.dunno(`No XP award is recorded for ${a.name}.`);
    return `${a.name} earned ${n(xp)} XP.`;
  },

  async progression(db, t, b) {
    const a = asAgent(t);
    const { lv, awards } = await levelFacts(db, a, b);
    const ach = await db.select().from(agentAchievements).where(eq(agentAchievements.agentName, a.name)).orderBy(asc(agentAchievements.earnedAt));
    for (const x of ach) b.fact(`Achievement: ${achievementLabel(x.achievement)} (${x.earnedAt.toISOString().slice(0, 10)}).`, "agent_achievements");
    const domains = await domainCounts(db, a.name);
    for (const [domain, count] of domains) b.fact(`${count} successful run(s) in ${domain}.`, "agent_domain_work");
    const contributing = [...new Set(awards.map((w) => w.runId).filter((id): id is string => id !== null))];
    b.derive(`${contributing.length} distinct run(s) contributed XP.`, "agent_xp_awards");
    await performanceTotals(db, a, b);
    if (awards.length === 0) b.dunno(`${a.name} has no recorded progression yet.`);
    return `${a.name} is level ${lv.level} with ${ach.length} achievement(s).`;
  },

  async performance(db, t, b) {
    const a = asAgent(t);
    const rows = await db
      .select({ p: agentPerformance, version: agentDefinitions.version, task: taskDefinitions.name })
      .from(agentPerformance)
      .innerJoin(agentDefinitions, eq(agentDefinitions.id, agentPerformance.agentDefinitionId))
      .leftJoin(taskDefinitions, eq(taskDefinitions.id, agentPerformance.taskDefinitionId))
      .where(eq(agentDefinitions.name, a.name))
      .orderBy(asc(agentDefinitions.version));
    for (const r of rows) {
      const rate = Number(r.p.successRate);
      b.fact(`v${r.version} on ${r.task ?? "a task"} at tier ${r.p.modelTier}: success rate ${rate} over ${r.p.sampleCount} counted run(s).`, "agent_performance", [agentLink(a)]);
      b.derive(`v${r.version} at ${r.p.modelTier}: ${Math.round(rate * r.p.sampleCount)} of ${r.p.sampleCount} counted run(s) succeeded.`, "agent_performance (rate × samples)");
    }
    await performanceTotals(db, a, b);
    b.derive(
      "A run counts as a success only if it completed and any autonomous loop concluded complete; hitting the iteration or time limit counts as a failure; budget, policy, operator stops and infrastructure failures are not counted.",
      "performance rules (src/projections/runSamples.ts)"
    );
    const routed = await db
      .select({ payload: events.payload })
      .from(events)
      .innerJoin(runs, eq(runs.id, events.runId))
      .innerJoin(agentDefinitions, eq(agentDefinitions.id, runs.agentDefinitionId))
      .where(and(eq(agentDefinitions.name, a.name), eq(events.eventType, "invocation_started"), sql`${events.payload} ? 'historicalPerformance'`))
      .orderBy(desc(events.globalSeq))
      .limit(1);
    const hp = routed[0]?.payload.historicalPerformance as { consulted?: boolean; minSamples?: number } | undefined;
    if (hp?.minSamples !== undefined) b.fact(`The latest routing record for ${a.name} ${hp.consulted ? "consulted" : "did not consult"} performance, which needs at least ${hp.minSamples} samples to be used.`, "events.invocation_started (Model Router)");
    if (rows.length === 0) b.dunno(`No counted run is recorded for ${a.name} yet.`);
    return rows.length === 0 ? `${a.name} has no measured performance yet.` : `${a.name}'s measured performance.`;
  },

  async achievements(db, t, b) {
    const a = asAgent(t);
    const rows = await db.select().from(agentAchievements).where(eq(agentAchievements.agentName, a.name)).orderBy(asc(agentAchievements.earnedAt));
    for (const x of rows) {
      const ev = x.evidence as { runId?: string; runIds?: string[]; artifactId?: string };
      const linkRuns = await runInfos(db, [...(ev.runId ? [ev.runId] : []), ...(ev.runIds ?? [])].slice(0, 5));
      const links = [...linkRuns.flatMap(runLink), ...(ev.artifactId ? [artifactLink(ev.artifactId, "deliverable")] : [])];
      b.fact(`${achievementLabel(x.achievement)}, earned ${x.earnedAt.toISOString().slice(0, 10)}.`, "agent_achievements", links);
      const key = x.achievement.split(":")[0] as keyof typeof ACHIEVEMENT_CONDITIONS;
      if (ACHIEVEMENT_CONDITIONS[key]) b.derive(`${achievementLabel(x.achievement)} is awarded for ${ACHIEVEMENT_CONDITIONS[key]}.`, "progression rules");
    }
    if (rows.length === 0) b.dunno(`${a.name} has no recorded achievement.`);
    return `${a.name} has ${rows.length} achievement(s).`;
  },

  async specialisation(db, t, b) {
    const a = asAgent(t);
    const work = await db.select().from(agentDomainWork).where(eq(agentDomainWork.agentName, a.name)).orderBy(asc(agentDomainWork.earnedAt));
    const counts = await domainCounts(db, a.name);
    for (const [domain, count] of counts) {
      const inDomain = await runInfos(db, work.filter((w) => w.domain === domain).map((w) => w.runId).slice(0, 5));
      b.fact(`${count} successful run(s) did ${domain} work.`, "agent_domain_work", inDomain.flatMap(runLink));
    }
    const total = counts.reduce((s, [, c]) => s + c, 0);
    const [top, topRuns] = counts[0] ?? [null, 0];
    b.derive(`A specialisation needs at least ${SPECIALISATION_MIN_RUNS} successful runs in one domain and at least half of the agent's domain work. Domains come from what runs did (real research evidence, verified handoffs, publishing), never from a name or role.`, "progression rules");
    const qualifies = top !== null && topRuns >= SPECIALISATION_MIN_RUNS && topRuns * 2 >= total;
    if (qualifies) b.derive(`${top}: ${topRuns} of ${total} domain run(s), so ${a.name} specialises in ${top}.`, "agent_domain_work (applied)");
    else if (total > 0) b.derive(`The largest domain, ${top}, has ${topRuns} of ${total} run(s): not enough for a specialisation.`, "agent_domain_work (applied)");
    else b.dunno(`No domain work is recorded for ${a.name}.`);
    return qualifies ? `${a.name} is a ${top} specialist.` : `${a.name} has no specialisation yet.`;
  },

  async endorsements(db, t, b) {
    if (t.kind === "artifact") {
      const rows = await db.select().from(agentEndorsements).where(eq(agentEndorsements.artifactId, t.id));
      for (const e of rows) b.fact(`${e.endorserName} endorsed it: ${e.verified ? (e.mutual ? "proven, but mutual" : "proven") : `not counted (${words(e.excludedReason ?? "unverified")})`}.`, "agent_endorsements", [artifactLink(t.id)]);
      if (rows.length === 0) b.fact("No endorsement of this artifact is recorded.", "agent_endorsements");
      b.derive("Endorsements are worth no XP.", "progression rules");
      return `${rows.length} endorsement(s) of this artifact.`;
    }
    const a = asAgent(t);
    const received = await db.select().from(agentEndorsements).where(eq(agentEndorsements.endorsedName, a.name));
    const given = await db.select().from(agentEndorsements).where(eq(agentEndorsements.endorserName, a.name));
    for (const e of received) {
      b.fact(`${e.endorserName} endorsed deliverable ${short(e.artifactId)}: ${e.verified ? (e.mutual ? "proven, mutual (not counted as independent)" : "proven") : `not counted (${words(e.excludedReason ?? "unverified")})`}.`, "agent_endorsements", [artifactLink(e.artifactId, "deliverable")]);
    }
    for (const e of given) b.fact(`${a.name} endorsed ${e.endorsedName ?? "an unknown agent"}'s deliverable ${short(e.artifactId)}${e.verified ? "" : ` (not counted: ${words(e.excludedReason ?? "unverified")})`}.`, "agent_endorsements", [artifactLink(e.artifactId, "deliverable")]);
    const independent = [...new Set(received.filter((e) => e.verified && !e.mutual).map((e) => e.endorserName))];
    b.derive(`${independent.length} other agent(s) independently endorsed ${a.name}'s work. An endorsement counts only if the runtime proved the endorser received that exact deliverable from another agent; endorsements are worth no XP.`, "agent_endorsements (applied)");
    if (received.length === 0 && given.length === 0) b.fact(`No endorsement by or of ${a.name} is recorded.`, "agent_endorsements");
    return `${a.name}: ${independent.length} independent endorser(s).`;
  },

  async quality_verdict(db, t, b) {
    const artifactIds =
      t.kind === "artifact"
        ? [t.id]
        : (await db.select({ id: agentXpAwards.artifactId }).from(agentXpAwards).where(and(eq(agentXpAwards.agentName, asAgent(t).name), eq(agentXpAwards.rule, "quality_verdict")))).map((r) => r.id!).filter(Boolean);
    let count = 0;
    for (const id of artifactIds.slice(0, 10)) {
      const rows = await db
        .select({ actor: events.actor, at: events.occurredAt, payload: events.payload })
        .from(events)
        .where(and(eq(events.eventType, "quality_verdict_recorded"), sql`${events.payload}->>'artifactId' = ${id}`, sql`${events.actor} LIKE 'human:%'`))
        .orderBy(desc(events.globalSeq))
        .limit(5);
      rows.forEach((r, i) => {
        count++;
        b.fact(`${i === 0 ? "Current" : "Earlier"} verdict on artifact ${short(id)}: ${String(r.payload.verdict).toLowerCase()} by ${r.actor}, ${r.at.toISOString().slice(0, 10)}${typeof r.payload.rationale === "string" ? ` — "${r.payload.rationale}"` : ""}.`, "events.quality_verdict_recorded", [artifactLink(id)]);
      });
    }
    b.derive("Only the operator can record a verdict; an approval is not a verdict; only the latest verdict on an artifact counts toward XP.", "progression rules");
    if (count === 0) b.dunno("No operator quality verdict is recorded for this.");
    return count === 0 ? "No quality verdict recorded." : `${count} verdict record(s).`;
  },

  async run_outcome(db, t, b) {
    const list = runsOf(t);
    for (const r of list) {
      b.fact(`${runLabel(r)}: ${words(r.status)}${r.attempt > 1 ? `, attempt ${r.attempt}` : ""}.`, "runs.status", runLink(r));
      const terminal = await loopTerminal(db, r.id);
      if (terminal) b.fact(`Its autonomous loop ended ${terminal.status} (${words(terminal.reason)}) after ${terminal.iterations ?? "?"} of ${terminal.maxIterations ?? "?"} iterations.`, "events.agent_loop_iteration_recorded", runLink(r));
      if (terminal && STOP_WORDS[terminal.reason]) b.derive(`${words(terminal.reason)}: ${STOP_WORDS[terminal.reason]}.`, "loop terminal reasons");
      if (r.status === "failed") await failureFacts(db, r, b);
    }
    if (list.length === 0) b.dunno("No run is recorded for this yet.");
    const failed = list.filter((r) => r.status === "failed").length;
    return list.length === 0 ? "Nothing has run yet." : failed > 0 ? `${failed} of ${list.length} run(s) failed.` : `${list.filter((r) => r.status === "completed").length} of ${list.length} run(s) completed.`;
  },

  async stop_reason(db, t, b) {
    const list = runsOf(t);
    for (const r of list) {
      const terminal = await loopTerminal(db, r.id);
      if (terminal) {
        b.fact(`${runLabel(r)} stopped: ${words(terminal.reason)} after ${terminal.iterations ?? "?"} of ${terminal.maxIterations ?? "?"} iterations${terminal.activeSeconds !== undefined ? `, ${terminal.activeSeconds}s active of ${terminal.maxActiveSeconds}s` : ""}.`, "events.agent_loop_iteration_recorded", runLink(r));
        if (STOP_WORDS[terminal.reason]) b.derive(`${words(terminal.reason)} means ${STOP_WORDS[terminal.reason]}.`, "loop terminal reasons");
      }
      await failureFacts(db, r, b);
      if (!terminal && r.status !== "failed") b.fact(`${runLabel(r)} is ${words(r.status)}; it has no stop recorded.`, "runs.status", runLink(r));
    }
    if (list.length === 0) b.dunno("No run is recorded for this yet.");
    return list.length === 0 ? "Nothing has run yet." : "Why it stopped, from the records.";
  },

  async evidence(db, t, b) {
    const artifactId = t.kind === "artifact" ? t.id : null;
    let list = runsOf(t);
    if (artifactId) {
      const row = (await db.query.artifacts.findFirst({ where: eq(artifacts.id, artifactId) }))!;
      const matches = row.inlineContent === null ? null : createHash("sha256").update(row.inlineContent).digest("hex") === row.hash;
      b.fact(`A ${row.type} with sha256 ${row.hash.slice(0, 16)}….`, "artifacts.hash", [artifactLink(artifactId)]);
      if (matches === null) b.dunno("Its bytes are not stored inline, so the hash could not be rechecked.");
      else b.derive(matches ? "Its stored bytes still match that hash (rechecked now)." : "Its stored bytes NO LONGER match that hash: treat it as untrusted.", "sha256 recomputed");
      const producer = row.producingInvocationId ? await db.query.invocations.findFirst({ where: eq(invocations.id, row.producingInvocationId) }) : undefined;
      list = producer ? await runInfos(db, [producer.runId]) : [];
      if (!producer) b.dunno("No producing run is recorded for it.");
    }
    for (const r of list) {
      const terminal = await loopTerminal(db, r.id);
      if (!terminal) {
        b.dunno(`${runLabel(r)} has no autonomous-loop record, so no code-verified evidence is recorded for it.`);
        continue;
      }
      b.fact(`${runLabel(r)} ended ${terminal.status} (${words(terminal.reason)}).`, "events.agent_loop_iteration_recorded", runLink(r));
      for (const v of (terminal.evidence?.verified ?? []).slice(0, 8)) {
        b.fact(`Code verified ${v.capability === "handoff" ? "a handed-over deliverable" : `a ${v.capability} result`}${v.artifactId ? ` (artifact ${short(v.artifactId)}${v.hash ? `, sha256 ${v.hash.slice(0, 12)}…` : ""})` : ""}.`, "events.agent_loop_iteration_recorded (verified evidence)", v.artifactId ? [artifactLink(v.artifactId)] : []);
      }
      const rejected = terminal.evidence?.rejected?.length ?? 0;
      if (rejected > 0) b.fact(`${rejected} cited item(s) could not be verified and were rejected.`, "events.agent_loop_iteration_recorded (rejected evidence)", runLink(r));
      b.derive(
        terminal.reason === "evidence_sufficient"
          ? "evidence_sufficient means the agent cited results and code confirmed each one was really produced in this work (or handed over with its hash); the agent's own claim is not the evidence."
          : "Without evidence_sufficient, nothing the agent wrote about its evidence was verified by code.",
        "loop evidence rules"
      );
    }
    return artifactId ? "What supports this artifact." : "What supports this work.";
  },

  async handoff(db, t, b) {
    let list = runsOf(t);
    if (t.kind === "artifact") {
      const received = await db
        .select({ runId: events.runId })
        .from(events)
        .where(and(eq(events.eventType, "agent_loop_iteration_recorded"), sql`${events.payload}->'terminal'->'evidence'->'verified' @> ${JSON.stringify([{ artifactId: t.id, capability: "handoff" }])}::jsonb`))
        .limit(LIMITS.runs);
      list = await runInfos(db, received.map((r) => r.runId!).filter(Boolean));
      if (list.length === 0) b.fact("No run finished on this artifact as a verified handoff.", "events.agent_loop_iteration_recorded");
    }
    let found = 0;
    for (const r of list) {
      const terminal = await loopTerminal(db, r.id);
      for (const v of (terminal?.evidence?.verified ?? []).filter((x) => x.capability === "handoff")) {
        found++;
        const [from] = v.runId ? await runInfos(db, [v.runId]) : [];
        b.fact(
          `${runLabel(r)} finished on deliverable ${short(v.artifactId ?? "?")} (sha256 ${(v.hash ?? "?").slice(0, 12)}…) handed over${from ? ` from ${runLabel(from)}` : ""}${v.fromStep ? `, step "${v.fromStep}"` : ""}.`,
          "events.agent_loop_iteration_recorded (verified handoff)",
          [...runLink(r), ...(from ? runLink(from) : []), ...(v.artifactId ? [artifactLink(v.artifactId, "handed-over deliverable")] : [])]
        );
        if (v.artifactId) {
          const inContext = await db
            .select({ id: events.id })
            .from(events)
            .where(and(eq(events.runId, r.id), eq(events.eventType, "context_compiled"), sql`${events.payload}->'included' @> ${JSON.stringify([{ id: v.artifactId, hash: v.hash }])}::jsonb`))
            .limit(1);
          b.fact(inContext.length > 0 ? "The receiving run's compiled context included that exact artifact and hash." : "No compiled context of the receiving run records that artifact with that hash.", "events.context_compiled", runLink(r));
        }
      }
    }
    b.derive("A handoff is verified only if it is a code-written deliverable whose own step finished evidence_sufficient, passed by reference with its hash.", "handoff rules");
    if (found === 0 && t.kind !== "artifact") b.dunno("No verified handoff is recorded for this work.");
    return found === 0 ? "No verified handoff recorded." : `${found} verified handoff(s).`;
  },

  async policy(db, t, b) {
    const list = runsOf(t);
    const ids = list.map((r) => r.id);
    if (ids.length === 0) {
      b.dunno("No run is recorded for this yet.");
      return "Nothing has been evaluated yet.";
    }
    const rows = await db
      .select({ type: events.eventType, payload: events.payload, runId: events.runId, at: events.occurredAt, capability: capabilities.name })
      .from(events)
      .leftJoin(capabilities, sql`${capabilities.id}::text = ${events.payload}->>'capabilityId'`)
      .where(and(inArray(events.runId, ids), inArray(events.eventType, ["policy_evaluated", "approval_required", "approval_granted", "approval_rejected", "approval_expired"])))
      .orderBy(desc(events.globalSeq))
      .limit(LIMITS.facts + 1);
    if (rows.length > LIMITS.facts) b.dunno(`More policy and approval records exist; only the newest ${LIMITS.facts} are listed.`);
    const byRun = new Map(list.map((r) => [r.id, r]));
    for (const e of rows.slice(0, LIMITS.facts).reverse()) {
      const r = byRun.get(e.runId!)!;
      const p = e.payload as { decision?: string; basis?: string; permission?: string; riskTier?: string; autonomyState?: string; checkpoint?: string; resolvedBy?: string };
      if (e.type === "policy_evaluated") {
        b.fact(`Policy ${p.decision} ${p.permission ?? ""} on ${e.capability ?? "a capability"} (risk ${p.riskTier ?? "?"}, grant ${p.autonomyState ?? "?"}, ${words(p.checkpoint ?? "check")}).`, "events.policy_evaluated", runLink(r));
        if (p.basis) b.derive(`${p.decision}: ${POLICY_WORDS[p.basis] ?? words(p.basis)}.`, "policy basis");
      } else {
        b.fact(`${words(e.type)}${p.resolvedBy ? ` by ${p.resolvedBy}` : ""}${p.riskTier ? ` (risk ${p.riskTier})` : ""}.`, `events.${e.type}`, runLink(r));
      }
    }
    if (rows.length === 0) b.fact("No policy evaluation is recorded: this work used no capability that Policy governs.", "events.policy_evaluated");
    b.derive("Policy decides from the Grant, the action's computed risk and the binding's trust; an approval only lets that exact recorded action run.", "governance rules");
    return rows.length === 0 ? "No policy decision recorded." : "Policy decisions, from the records.";
  },

  async budget(db, t, b) {
    if (t.kind === "agent") {
      const rows = await db
        .select({ unit: sql<string>`${events.payload}->>'resourceUnit'`, total: sql<string>`SUM((${events.payload}->>'amount')::numeric)::text`, count: sql<number>`COUNT(*)::int` })
        .from(events)
        .innerJoin(runs, eq(runs.id, events.runId))
        .innerJoin(agentDefinitions, eq(agentDefinitions.id, runs.agentDefinitionId))
        .where(and(eq(agentDefinitions.name, t.name), eq(events.eventType, "budget_consumed")))
        .groupBy(sql`${events.payload}->>'resourceUnit'`);
      for (const r of rows) b.derive(`${t.name} consumed ${r.total} ${r.unit} over ${r.count} recorded charge(s), across all versions.`, "events.budget_consumed (summed per unit)", [agentLink(t)]);
      if (rows.length === 0) b.fact(`No consumption is recorded for ${t.name}.`, "events.budget_consumed");
      b.derive("Units are never combined or converted.", "budget rules");
      return `${t.name}'s recorded consumption.`;
    }
    const list = runsOf(t);
    for (const r of list) {
      const charges = await db.select({ payload: events.payload }).from(events).where(and(eq(events.runId, r.id), eq(events.eventType, "budget_consumed")));
      const units = new Map<string, { amount: number; estimated: number; reported: number; count: number }>();
      for (const c of charges) {
        const p = c.payload as { resourceUnit?: string; amount?: string; estimatedAmount?: string; basis?: string };
        const u = units.get(p.resourceUnit ?? "?") ?? { amount: 0, estimated: 0, reported: 0, count: 0 };
        u.amount += Number(p.amount ?? 0);
        u.estimated += Number(p.estimatedAmount ?? 0);
        u.reported += p.basis === "reported" ? 1 : 0;
        u.count++;
        units.set(p.resourceUnit ?? "?", u);
      }
      for (const [unit, u] of units) {
        b.fact(`${runLabel(r)} consumed ${n(u.amount)} ${unit} over ${u.count} charge(s) (${u.reported} of ${u.count} charged from a provider's own report, the rest at estimate); ${n(u.estimated)} had been reserved.`, "events.budget_consumed", runLink(r));
      }
      const denied = await db.select({ payload: events.payload }).from(events).where(and(eq(events.runId, r.id), eq(events.eventType, "budget_denied")));
      for (const d of denied) {
        const p = d.payload as { resourceUnit?: string; requestedAmount?: string; deniedCounter?: { scope?: string } };
        b.fact(`The Budget Governor refused ${p.requestedAmount ?? "?"} ${p.resourceUnit ?? ""} on the ${words(p.deniedCounter?.scope ?? "?")} counter.`, "events.budget_denied", runLink(r));
      }
      if (units.size === 0 && denied.length === 0) b.fact(`${runLabel(r)} recorded no consumption.`, "events.budget_consumed", runLink(r));
    }
    if (list.length === 0) b.dunno("No run is recorded for this yet.");
    b.derive("Units are never combined or converted.", "budget rules");
    return "Resource consumption, from the records.";
  },

  async model_tier(db, t, b) {
    const list = runsOf(t);
    for (const r of list) {
      const routes = await db
        .select({ payload: events.payload })
        .from(events)
        .where(and(eq(events.runId, r.id), eq(events.eventType, "invocation_started"), sql`${events.payload} ? 'resultingTier'`))
        .orderBy(desc(events.sequenceNo))
        .limit(7);
      if (routes.length > 6) b.dunno(`${runLabel(r)} routed more than 6 model calls; only the newest 6 are listed.`);
      for (const e of routes.slice(0, 6).reverse()) {
        const p = e.payload as { defaultTier?: string; tierSource?: string; resultingTier?: string; taskDifficulty?: string; riskTier?: string; escalationFloor?: string | null; requiredProvider?: string; resultingModelId?: string };
        b.fact(`${runLabel(r)}: ${p.resultingModelId ?? "a model"} at ${p.resultingTier} (default ${p.defaultTier}, from ${words(p.tierSource ?? "?")}; difficulty ${p.taskDifficulty ?? "?"}, risk ${p.riskTier ?? "?"}${p.escalationFloor ? `, retry floor ${p.escalationFloor}` : ""}${p.requiredProvider ? `, provider ${p.requiredProvider} required` : ""}).`, "events.invocation_started (Model Router)", runLink(r));
      }
      if (routes.length === 0) b.fact(`${runLabel(r)} made no model call.`, "events.invocation_started", runLink(r));
    }
    if (list.length === 0) b.dunno("No run is recorded for this yet.");
    b.derive("The Router maps difficulty to a tier, raises it for risk or a retry, never lowers it, and never switches provider on its own.", "routing rules");
    return "Model and tier choices, from the Router's records.";
  },

  /**
   * Why work is late, waiting or not finished (R2 Stage 10). Every line is a record, or a calculation over
   * one: a deadline the clock has passed, an approval nobody has answered, a run the runtime already
   * classified as failed, a step whose turn has not come. Where no record explains it, the Keeper says so
   * rather than offering a reason. It explains; it schedules nothing and changes nothing.
   */
  async delay(db, t, b) {
    if (t.kind === "agent") {
      const now = new Date();
      const [free] = await availabilityFor(db as unknown as DrizzleTransaction, [t.name], { start: now, end: new Date(now.getTime() + 60_000) });
      if (free && free.status !== "available") {
        for (const reason of free.reasons.slice(0, 3)) b.fact(`Its diary says: ${reason}.`, "workplace_calendar_events + workplace_settings", [agentLink(t)]);
        b.derive("A diary entry stops NEW work being given to it. Work already running is untouched, and this is not an emergency stop.", "availability rules");
      } else b.dunno("Nothing in its diary is holding it.");
      return `What holds ${t.name} is in its diary and its runs.`;
    }
    const list = runsOf(t);
    for (const r of list.slice(0, 5)) {
      b.fact(`${runLabel(r)}: ${words(r.status)}.`, "runs.status", runLink(r));
      if (r.status === "failed") await failureFacts(db, r, b);
    }
    // A goal's own deadline, when the subject is one.
    if (t.kind === "runs" && t.subject.type === "goal") {
      const goalId = t.subject.id;
      const goal = await db.query.goals.findFirst({ where: eq(goalsTable.id, goalId) });
      if (goal?.dueAt) {
        b.fact(`It is due at ${goal.dueAt.toISOString()}.`, "goals.due_at");
        b.derive(
          goal.dueAt.getTime() < Date.now()
            ? "That time has passed, so it is overdue. Overdue is read from the clock: it does not mean the work failed, and nothing was stopped because of it."
            : "That time has not passed, so it is not overdue.",
          "goals.due_at + the clock"
        );
      } else b.dunno("No deadline was set for this goal, so it cannot be late.");
      const wrs = await db.select({ id: workflowRuns.id, status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.goalId, goalId));
      const unfinished = wrs.filter((w) => w.status === "in_progress" || w.status === "paused");
      for (const w of unfinished.slice(0, 3)) b.fact(`Workflow run ${short(w.id)} is still ${words(w.status)}.`, "workflow_runs.status", [{ label: `run ${short(w.id)}`, href: `/workflows/${w.id}` }]);
      if (unfinished.length === 0 && wrs.length > 0) b.derive("Every workflow run on this goal has finished, so nothing is still waiting on it.", "workflow_runs.status");
      else if (unfinished.length > 0) b.derive("A workflow run advances one step at a time, so a later step waits until the one before it finishes.", "interpreter rules");
    }
    if (list.length === 0) b.dunno("No run is recorded for this yet, so nothing has been delayed.");
    return list.length === 0 ? "Nothing has run yet." : `${list.filter((r) => r.status !== "completed" && r.status !== "failed").length} of ${list.length} run(s) are still unfinished.`;
  },

  async ambient(db, t, b) {
    b.derive("Ambient life — wandering, resting, standing about — is presentation only: it writes nothing, runs nothing and earns nothing.", "presentation rules");
    b.derive("Real state always overrides it: stopped, then waiting for an approval, then a real meeting, then real work, then waiting for assigned work, then a break or time off the clock, and only then ambient life.", "presentation rules");
    if (t.kind !== "agent") return "Everything you see moving is real work.";
    const unfinished = await db
      .select({ status: runs.status, id: runs.id, wr: taskInstances.workflowRunId, goal: workflowRuns.goalId })
      .from(runs)
      .innerJoin(agentDefinitions, eq(agentDefinitions.id, runs.agentDefinitionId))
      .innerJoin(taskInstances, eq(taskInstances.id, runs.taskInstanceId))
      .leftJoin(workflowRuns, eq(workflowRuns.id, taskInstances.workflowRunId))
      .where(and(eq(agentDefinitions.name, t.name), sql`${runs.status} NOT IN ('completed', 'failed')`));
    const ids = t.definitions.map((d) => d.id);
    // A stop covers the agent if it is global, names one of its versions, or names one of its unfinished runs, workflow runs or goals.
    const covered = new Set([...ids, ...unfinished.flatMap((u) => [u.id, u.wr, u.goal]).filter((x): x is string => x !== null)].map((x) => x.toLowerCase()));
    const stops = (await db.select().from(executionStops).where(isNull(executionStops.liftedAt))).filter((s) => s.scope === "global" || covered.has(s.scopeRefId.toLowerCase()));
    for (const s of stops) b.fact(`A ${words(s.scope)} emergency stop is engaged${s.reason ? `: "${s.reason}"` : ""}.`, "execution_stops");
    for (const u of unfinished.slice(0, 5)) b.fact(`Run ${short(u.id)} is ${words(u.status)}.`, "runs.status", u.wr ? [{ label: `run ${short(u.id)}`, href: `/workflows/${u.wr}` }] : []);
    let state = stops.length > 0 ? "stopped" : ["active", "awaiting_approval", "pending"].find((s) => unfinished.some((u) => u.status === s)) ?? "idle";
    // With no unfinished run, the diary is what explains an agent: a break, or time outside its hours.
    // The same records the workplace answer cites, so the two never disagree.
    if (state === "idle") {
      const now = new Date();
      // The WORK clock, not the meeting one: whether an agent may be given work is `workOutsideHours`,
      // and this answer must agree with `api/agentState.ts`, which reads exactly these inputs.
      const range = { start: now, end: new Date(now.getTime() + 60_000) };
      const { clock, hours, commitments } = await availabilityInputs(db as unknown as DrizzleTransaction, [t.name], range);
      const free = availabilityOf({ agentName: t.name, range, clock, hours: hours.get(t.name)!, stopped: false, commitments });
      if (free.status !== "available") {
        state = free.reasons.some((r) => r.startsWith("break:")) ? "on a break" : "not at work";
        for (const reason of free.reasons.slice(0, 3)) b.fact(`Its diary says: ${reason}.`, "workplace_calendar_events + workplace_settings");
      }
    }
    b.derive(`So ${t.name}'s real state is ${words(state)}${state === "idle" ? ": it has no unfinished run and nothing in its diary, so it stands still" : ""}.`, "runtime state (runs + execution_stops + the workplace diary)", [agentLink(t)]);
    return `${t.name} is ${words(state)} in reality.`;
  },

  async workplace(db, t, b) {
    const tx = db as unknown as DrizzleTransaction;
    const now = new Date();
    const settings = await readSettings(tx);
    const tz = settings.timezone;
    const who = t.kind === "agent" ? t.name : null;
    const at = (iso: string) => formatWall(new Date(iso), tz);
    b.fact(`The Keep's clock reads ${formatWall(now, tz)} (${tz}).`, "workplace_settings.timezone");

    const presence = (await meetingPresence(tx, now)).filter((p) => !who || p.agentName === who);
    const byMeeting = new Map<string, typeof presence>();
    for (const p of presence) byMeeting.set(p.meetingId, [...(byMeeting.get(p.meetingId) ?? []), p]);
    for (const group of byMeeting.values()) {
      const m = group[0]!;
      b.fact(`${group.map((p) => p.agentName).join(", ")} ${group.length === 1 ? "is" : "are"} ${m.phase === "in_meeting" ? "in" : "gathering for"} "${m.title}" in ${m.roomName} (${at(m.startsAt)}–${at(m.endsAt).slice(11)}).`, "workplace_meetings + events.meeting_scheduled");
    }
    if (presence.length > 0) b.derive("They are there because a real, recorded meeting puts them there; the world draws nobody in a meeting room without one.", "presentation rules");

    const today = wallClock(now, tz);
    const dayStart = fromWallClock({ year: today.year, month: today.month, day: today.day, hour: 0, minute: 0 }, tz);
    const dayEnd = fromWallClock({ ...addDays(today, 1), hour: 0, minute: 0 }, tz);
    const todays = await listMeetings(tx, { from: dayStart, to: dayEnd, includeCancelled: true, ...(who ? { agentName: who } : {}) }, now);
    for (const m of todays.slice(0, 8)) b.fact(`Today: "${m.title}" ${at(m.startsAt).slice(11)}–${at(m.endsAt).slice(11)} in ${m.room.name}, ${words(m.status)}, ${m.participants.length} participant(s), organised by ${m.organiser}.`, "workplace_meetings");
    if (todays.length === 0) b.fact(`No meeting is recorded today${who ? ` for ${who}` : ""}.`, "workplace_meetings");

    const next = (await listMeetings(tx, { from: now, to: new Date(now.getTime() + 14 * 86_400_000), ...(who ? { agentName: who } : {}) }, now)).find((m) => m.status === "scheduled" || m.status === "starting");
    if (next) b.fact(`Next meeting: "${next.title}" at ${at(next.startsAt)} in ${next.room.name} with ${next.participants.map((p) => p.agentName).join(", ")}.`, "workplace_meetings");
    else b.fact(`No meeting is scheduled in the next 14 days${who ? ` for ${who}` : ""}.`, "workplace_meetings");

    // Availability for the rest of today's working hours.
    const endOfWork = fromWallClock({ year: today.year, month: today.month, day: today.day, hour: Math.floor(settings.workEndMinute / 60) % 24, minute: settings.workEndMinute % 60 }, tz);
    if (endOfWork > now) {
      const names = who ? [who] : [...new Set((await db.select({ name: agentDefinitions.name }).from(agentDefinitions)).map((r) => r.name))].sort();
      const availability = await availabilityFor(tx, names, { start: now, end: endOfWork });
      const free = availability.filter((a) => a.status === "available").map((a) => a.agentName);
      if (free.length > 0) b.fact(`Available for the rest of today's working hours (until ${formatWall(endOfWork, tz).slice(11)}): ${free.join(", ")}.`, "workplace availability (meetings, calendar entries, stops, working hours)");
      for (const a of availability.filter((a) => a.status !== "available").slice(0, 8)) b.fact(`${a.agentName} is ${a.status} before ${formatWall(endOfWork, tz).slice(11)}: ${a.reasons.join("; ")}.`, "workplace availability");
    } else b.dunno("Today's working hours are over, so no availability for this afternoon is computed.");

    const [refused] = await db
      .select({ payload: events.payload, at: events.occurredAt, goalId: events.goalId })
      .from(events)
      .where(and(eq(events.eventType, "manager_plan_rejected"), sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${events.payload}->'blockers') b WHERE b->>'code' IN ('no_common_availability','insufficient_room_capacity','participant_unavailable','participant_conflict','outside_working_hours','room_not_found','room_inactive','room_conflict','unknown_participant','meeting_not_found','meeting_not_changeable','duplicate_meeting','invalid_meeting'))`))
      .orderBy(desc(events.globalSeq))
      .limit(1);
    if (refused) {
      const blockers = ((refused.payload as { blockers?: { code: string; detail: string }[] }).blockers ?? []).slice(0, 3);
      b.fact(`The Manager's last refused meeting request (${formatWall(refused.at, tz)}): ${blockers.map((x) => `${words(x.code)} — ${x.detail}`).join("; ")}.`, "events.manager_plan_rejected", refused.goalId ? [{ label: "mission", href: `/command?goal=${refused.goalId}` }] : []);
    }
    b.derive("Availability, conflicts and rooms are decided by code from these records, never by a model.", "architecture rule");
    b.dunno("Nothing records what was said in a meeting unless an operator recorded its notes and decisions.");
    return presence.length > 0 ? `${presence.length} agent(s) are in or gathering for a real meeting now.` : next ? `The next meeting is "${next.title}" at ${at(next.startsAt)}.` : "No meeting is happening or scheduled.";
  },
};

function achievementLabel(key: string): string {
  const [base, domain] = key.split(":");
  const label = ACHIEVEMENTS[base as keyof typeof ACHIEVEMENTS] ?? key;
  return domain ? `${label}: ${domain}` : label;
}

async function domainCounts(db: Reader, name: string): Promise<[string, number][]> {
  const rows = await db.select({ domain: agentDomainWork.domain, count: sql<number>`COUNT(*)::int` }).from(agentDomainWork).where(eq(agentDomainWork.agentName, name)).groupBy(agentDomainWork.domain);
  return rows.map((r) => [r.domain, r.count] as [string, number]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

async function performanceTotals(db: Reader, a: AgentTarget, b: Builder) {
  const [row] = await db
    .select({ samples: sql<number>`COALESCE(SUM(${agentPerformance.sampleCount}), 0)::int`, successes: sql<number>`COALESCE(ROUND(SUM(${agentPerformance.successRate} * ${agentPerformance.sampleCount})), 0)::int` })
    .from(agentPerformance)
    .innerJoin(agentDefinitions, eq(agentDefinitions.id, agentPerformance.agentDefinitionId))
    .where(eq(agentDefinitions.name, a.name));
  if (row && row.samples > 0) b.derive(`${row.successes} of ${row.samples} counted run(s) succeeded across all versions.`, "agent_performance (summed)");
}

type Terminal = { status: string; reason: string; iterations?: number; maxIterations?: number; activeSeconds?: number; maxActiveSeconds?: number; evidence?: { verified?: { capability?: string; artifactId?: string; hash?: string; runId?: string; fromStep?: string }[]; rejected?: unknown[] } };

async function loopTerminal(db: Reader, runId: string): Promise<Terminal | null> {
  const row = await db.query.events.findFirst({
    where: and(eq(events.runId, runId), eq(events.eventType, "agent_loop_iteration_recorded"), sql`${events.payload} ? 'terminal'`),
    orderBy: desc(events.sequenceNo),
  });
  if (!row) return null;
  const p = row.payload as { terminal: Omit<Terminal, "iterations" | "maxIterations" | "activeSeconds" | "maxActiveSeconds">; iterations?: number; maxIterations?: number; activeSeconds?: number; maxActiveSeconds?: number };
  return { ...p.terminal, iterations: p.iterations, maxIterations: p.maxIterations, activeSeconds: p.activeSeconds, maxActiveSeconds: p.maxActiveSeconds };
}

async function failureFacts(db: Reader, r: RunInfo, b: Builder) {
  const halted = await db.query.events.findFirst({ where: and(eq(events.runId, r.id), eq(events.eventType, "run_halted")) });
  if (halted) {
    const p = halted.payload as { stopScope?: string };
    b.fact(`An emergency stop${p.stopScope ? ` (${words(p.stopScope)} scope)` : ""} halted ${runLabel(r)}.`, "events.run_halted", runLink(r));
  }
  const failed = await db.query.events.findFirst({ where: and(eq(events.runId, r.id), eq(events.eventType, "invocation_failed")), orderBy: desc(events.sequenceNo) });
  if (failed) {
    const p = failed.payload as { reason?: string; errorCode?: string };
    b.fact(`Its last failed action ended with ${p.errorCode ? `error code ${p.errorCode}` : "no error code"}; the reported error text was: "${clip(p.reason ?? "none")}".`, "events.invocation_failed", runLink(r));
  }
  if (r.status === "failed" && !halted && !failed) b.dunno(`${runLabel(r)} failed, but no failure detail is recorded.`);
}
