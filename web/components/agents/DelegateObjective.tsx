"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { createGoal, createWorkflowDefinition, getRegistry, type AgentDetail, type RegistryData, type WorkflowGraph } from "../../lib/api";
import { errorText } from "../../lib/keep";
import { PixelButton, Skeleton, StateNotice, cx, px } from "../pixel/Pixel";
import b from "./builder.module.css";

/** The objective workflow's name for an agent version: one per version, reused while its settings are unchanged. */
export function objectiveWorkflowName(agent: { name: string; version: number }): string {
  return `${agent.name} v${agent.version} · objective`;
}

/**
 * Give an agent an objective (V1.1): the objective becomes a Goal; the work runs as that
 * agent version's one-step `agent_objective` workflow, created through the Registry the
 * first time (or versioned when the settings change) and started asynchronously. The
 * agent then decides its own governed actions within the limits shown.
 */
export function DelegateObjective({ agent, grants }: { agent: AgentDetail["agent"]; grants: AgentDetail["grants"] }) {
  const [registry, setRegistry] = useState<RegistryData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [intents, setIntents] = useState<string[] | null>(null);
  const [tools, setTools] = useState<Record<string, { on: boolean; maxCalls: string }>>({});
  const [done, setDone] = useState("");
  const [askWhen, setAskWhen] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<{ workflowRunId: string } | null>(null);

  const granted = new Set(grants.filter((g) => !g.revoked).map((g) => g.capabilityName));
  const canAsk = granted.has("review.checkpoint");

  useEffect(() => {
    getRegistry()
      .then((r) => {
        setRegistry(r);
        setIntents(r.builder?.thinkingIntents ?? []);
        const max = r.builder?.autonomyLimits.maxIterations ?? 1;
        setTools(Object.fromEntries((r.builder?.loopActions ?? []).filter((a) => granted.has(a.capability)).map((a) => [a.capability, { on: true, maxCalls: String(max) }])));
      })
      .catch((err) => setLoadError(errorText(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loadError) return <StateNotice role="alert" message="Couldn't load what this agent may do." detail={loadError} />;
  if (!registry || intents === null) return <StateNotice role="status" message={<Skeleton />} />;
  const task = registry.taskDefinitions.filter((t) => t.kind === "agent_objective" && t.planRegistered).sort((x, y) => y.version - x.version)[0];
  if (!task) return <StateNotice message="No autonomous objective task is registered, so objectives can't be delegated yet." detail='Run "npm run seed" to add the V1.1 building blocks.' />;
  const limits = registry.builder?.autonomyLimits;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const parameters: Record<string, unknown> = {
        intents,
        tools: Object.entries(tools)
          .filter(([, t]) => t.on)
          .map(([capability, t]) => ({ capability, maxCalls: Number(t.maxCalls) || 1 })),
        ...(done.trim() ? { completionCriteria: done.trim() } : {}),
        ...(canAsk && askWhen.trim() ? { escalateWhen: askWhen.trim() } : {}),
      };
      const graph: WorkflowGraph = {
        kind: "linear",
        description: `Objectives delegated to ${agent.name} v${agent.version}.`,
        steps: [{ stepId: "objective", label: "Work on the objective", taskDefinitionId: task!.id, taskDefinitionVersion: task!.version, agentDefinitionId: agent.id, agentDefinitionVersion: agent.version, parameters }],
      };
      const name = objectiveWorkflowName(agent);
      const versions = registry!.workflowDefinitions.filter((w) => w.name === name).sort((x, y) => y.version - x.version);
      const latest = versions[0];
      const same = latest?.graphDefinition && JSON.stringify(latest.graphDefinition) === JSON.stringify(graph);
      const workflowDefinitionId = same
        ? latest.id
        : (await createWorkflowDefinition({ name, graphDefinition: graph, ...(latest ? { previousVersion: latest.version } : {}) })).id;
      setStarted(await createGoal(title.trim(), details.trim() || undefined, { workflowDefinitionId, async: true }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (started) {
    return (
      <div className={cx(px.parchment, b.done)} role="status">
        <p>{agent.name} is working on it. It decides its own steps within its limits and stops when done.</p>
        <Link href={`/workflows/${started.workflowRunId}`} className={b.inkLink}>
          Watch the work
        </Link>
      </div>
    );
  }

  return (
    <form className={b.group} onSubmit={submit} aria-label="Give an objective">
      <label className={b.field}>
        <span className={px.label}>Objective</span>
        <input className={px.input} value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} placeholder="What should be accomplished?" />
      </label>
      <label className={b.field}>
        <span className={px.label}>Details (optional)</span>
        <textarea className={cx(px.input, b.textarea)} value={details} onChange={(e) => setDetails(e.target.value)} disabled={busy} />
      </label>
      <div role="group" aria-label="Thinking actions" className={b.perms}>
        <span className={px.label}>May think by</span>
        {(registry.builder?.thinkingIntents ?? []).map((i) => (
          <label key={i} className={b.check}>
            <input type="checkbox" checked={intents.includes(i)} onChange={(e) => setIntents(e.target.checked ? [...intents, i] : intents.filter((x) => x !== i))} disabled={busy} />
            {i}
          </label>
        ))}
      </div>
      <div role="group" aria-label="Actions" className={b.grants}>
        <span className={px.label}>May act with (its keys; Policy and approvals still apply)</span>
        {Object.keys(tools).length === 0 ? (
          <span className={px.dim}>None of this agent&apos;s keys can be used by an autonomous loop.</span>
        ) : (
          Object.entries(tools).map(([capability, t]) => (
            <div key={capability} className={b.row}>
              <label className={b.check}>
                <input type="checkbox" checked={t.on} onChange={(e) => setTools({ ...tools, [capability]: { ...t, on: e.target.checked } })} disabled={busy} />
                {capability}
              </label>
              <label className={b.inline}>
                at most
                <input className={px.input} type="number" min={1} max={limits?.maxIterations} value={t.maxCalls} onChange={(e) => setTools({ ...tools, [capability]: { ...t, maxCalls: e.target.value } })} disabled={busy} aria-label={`${capability} max calls`} />
                calls
              </label>
            </div>
          ))
        )}
      </div>
      <label className={b.field}>
        <span className={px.label}>Done when (optional)</span>
        <input className={px.input} value={done} onChange={(e) => setDone(e.target.value)} disabled={busy} />
      </label>
      {canAsk && (
        <label className={b.field}>
          <span className={px.label}>Ask me when (optional)</span>
          <input className={px.input} value={askWhen} onChange={(e) => setAskWhen(e.target.value)} disabled={busy} />
        </label>
      )}
      <p className={px.detail}>
        Limits: at most {limits?.maxIterations} iterations and {limits ? limits.maxActiveSeconds / 60 : "?"} active minutes (lower if this agent&apos;s profile says so);
        approval waits don&apos;t count. It uses subscription quota under the usual budgets and is not retried automatically.
      </p>
      <PixelButton type="submit" kind="approve" disabled={busy || !title.trim() || (intents.length === 0 && !Object.values(tools).some((t) => t.on))}>
        Start working
      </PixelButton>
      {busy && (
        <span role="status">
          Starting <Skeleton />
        </span>
      )}
      {error && (
        <div role="alert" className={b.error}>
          <p className={b.errorMessage}>Couldn&apos;t start the objective.</p>
          <p className={px.detail}>{error}</p>
        </div>
      )}
    </form>
  );
}
