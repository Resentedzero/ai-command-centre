"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  createGoal,
  createWorkflowDefinition,
  getRegistry,
  validateWorkflowDefinition,
  type RegistryData,
  type WorkflowDefinitionInput,
  type WorkflowGraph,
} from "../../lib/api";
import { errorText } from "../../lib/keep";
import { PixelButton, Skeleton, StateNotice, cx, px } from "../pixel/Pixel";
import b from "../agents/builder.module.css";

type StepDraft = {
  key: string;
  label: string;
  taskDefinitionId: string;
  agentDefinitionId: string;
  /** Kind-specific fields; turned into `parameters` on save. */
  instruction: string;
  question: string;
  inputs: string[];
  sourceStepKey: string;
  loopMaxIterations: string;
  loopMaxActiveMinutes: string;
  intents: string[];
  tools: { capability: string; maxCalls: string }[];
  completionCriteria: string;
  escalateWhen: string;
  rawParameters: string;
};

/** What a Keeper proposal (or any caller) may pre-fill. Nothing is written until the operator saves. */
export type WorkflowPrefill = { name?: string; description?: string; steps?: { label?: string; taskKind?: string; agentName?: string; instruction?: string }[] };

/** Which Artifact type a kind's step produces for later steps (`inputs[].artifactType`). */
const OUTPUT_TYPE: Record<string, "report" | "deliverable"> = { research_report: "report", agent_task: "deliverable", agent_objective: "deliverable" };
const KNOWN_KINDS = new Set(["research_report", "publish_report", "agent_task", "operator_checkpoint", "agent_objective"]);

let keySeq = 0;
const newKey = (label: string) => `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "step"}-${(++keySeq).toString(36)}`;

function emptyStep(registry: RegistryData, label: string): StepDraft {
  return {
    key: newKey(label),
    label,
    taskDefinitionId: registry.taskDefinitions.find((t) => t.planRegistered)?.id ?? "",
    agentDefinitionId: registry.agentDefinitions[0]?.id ?? "",
    instruction: "",
    question: "",
    inputs: [],
    sourceStepKey: "",
    loopMaxIterations: "",
    loopMaxActiveMinutes: "",
    intents: [],
    tools: [],
    completionCriteria: "",
    escalateWhen: "",
    rawParameters: "{}",
  };
}

/**
 * Workflow Builder (V1.1): a structured, linear step editor over the existing Workflow
 * Definition and interpreter. Steps are added, removed and reordered; each binds a Task
 * Definition (its kind decides the parameters) and an Agent version; later steps take
 * explicitly selected earlier outputs. "Check" runs every Registry check without saving;
 * "Save" creates a version (never edits one); a saved workflow can be run at once.
 */
export function WorkflowBuilder({ fromId, prefill }: { fromId?: string; prefill?: WorkflowPrefill }) {
  const [registry, setRegistry] = useState<RegistryData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    getRegistry()
      .then(setRegistry)
      .catch((err) => setLoadError(errorText(err)));
  }, []);
  if (loadError) return <StateNotice role="alert" message="Couldn't load the Registry, so no steps can be offered." detail={loadError} />;
  if (!registry) return <StateNotice role="status" message={<>Loading the Registry <Skeleton /></>} />;
  const base = fromId ? registry.workflowDefinitions.find((w) => w.id === fromId) : undefined;
  if (fromId && !base?.graphDefinition) return <StateNotice role="alert" message="The workflow to version wasn't found." detail={fromId} />;
  return <Composer registry={registry} base={base} prefill={prefill} />;
}

function Composer({ registry, base, prefill }: { registry: RegistryData; base?: RegistryData["workflowDefinitions"][number]; prefill?: WorkflowPrefill }) {
  const latestVersion = base ? Math.max(...registry.workflowDefinitions.filter((w) => w.name === base.name).map((w) => w.version)) : undefined;
  const taskById = useMemo(() => new Map(registry.taskDefinitions.map((t) => [t.id, t])), [registry]);
  const agentById = useMemo(() => new Map(registry.agentDefinitions.map((a) => [a.id, a])), [registry]);
  const checkpointCapability = registry.capabilities.find((c) => c.name === "review.checkpoint");

  const [name, setName] = useState(base?.name ?? prefill?.name ?? "");
  const [description, setDescription] = useState(base?.graphDefinition?.description ?? prefill?.description ?? "");
  const [steps, setSteps] = useState<StepDraft[]>(() => {
    if (base?.graphDefinition) {
      const drafts = base.graphDefinition.steps.map((s, i): StepDraft => {
        const p = s.parameters ?? {};
        const loop = (p.loop ?? {}) as { maxIterations?: number; maxActiveSeconds?: number };
        return {
          ...emptyStep(registry, s.label ?? `Step ${i + 1}`),
          key: s.stepId ?? newKey(s.label ?? `step-${i + 1}`),
          taskDefinitionId: registry.taskDefinitions.find((t) => t.id === s.taskDefinitionId)?.id ?? s.taskDefinitionId,
          agentDefinitionId: s.agentDefinitionId ?? "",
          instruction: typeof p.instruction === "string" ? p.instruction : "",
          question: typeof p.question === "string" ? p.question : "",
          inputs: Array.isArray(p.inputs) ? (p.inputs as { fromStepId: string }[]).map((x) => x.fromStepId) : [],
          loopMaxIterations: loop.maxIterations?.toString() ?? "",
          loopMaxActiveMinutes: loop.maxActiveSeconds !== undefined ? String(loop.maxActiveSeconds / 60) : "",
          intents: Array.isArray(p.intents) ? (p.intents as string[]) : [],
          tools: Array.isArray(p.tools) ? (p.tools as { capability: string; maxCalls: number }[]).map((t) => ({ capability: t.capability, maxCalls: String(t.maxCalls) })) : [],
          completionCriteria: typeof p.completionCriteria === "string" ? p.completionCriteria : "",
          escalateWhen: typeof p.escalateWhen === "string" ? p.escalateWhen : "",
          rawParameters: JSON.stringify(p, null, 2),
        };
      });
      // A publish step names its source by Task Definition; map it back to the earlier step.
      base.graphDefinition.steps.forEach((s, i) => {
        const source = s.parameters?.sourceTaskDefinitionId;
        const from = base.graphDefinition!.steps.findIndex((x, j) => j < i && x.taskDefinitionId === source);
        if (from >= 0) drafts[i]!.sourceStepKey = drafts[from]!.key;
      });
      return drafts;
    }
    return (prefill?.steps ?? [{ label: "Step 1" }]).map((p, i) => {
      const draft = emptyStep(registry, p.label ?? `Step ${i + 1}`);
      const task = p.taskKind ? registry.taskDefinitions.find((t) => t.kind === p.taskKind && t.planRegistered) : undefined;
      const agent = p.agentName ? registry.agentDefinitions.filter((a) => a.name === p.agentName).sort((x, y) => y.version - x.version)[0] : undefined;
      return { ...draft, taskDefinitionId: task?.id ?? draft.taskDefinitionId, agentDefinitionId: agent?.id ?? draft.agentDefinitionId, instruction: p.instruction ?? "" };
    });
  });

  const [busy, setBusy] = useState<"check" | "save" | null>(null);
  const [verdict, setVerdict] = useState<{ ok: boolean; text: string } | null>(null);
  const [saved, setSaved] = useState<{ id: string; name: string; version: number } | null>(null);

  function patch(key: string, change: Partial<StepDraft>) {
    setSteps((all) => all.map((s) => (s.key === key ? { ...s, ...change } : s)));
    setVerdict(null);
  }
  function move(index: number, by: -1 | 1) {
    setSteps((all) => {
      const next = [...all];
      const [step] = next.splice(index, 1);
      next.splice(index + by, 0, step!);
      return next;
    });
    setVerdict(null);
  }

  const payload = useMemo<WorkflowDefinitionInput>(() => {
    const graph: WorkflowGraph = {
      kind: "linear",
      ...(description.trim() ? { description: description.trim() } : {}),
      steps: steps.map((s) => {
        const task = taskById.get(s.taskDefinitionId);
        const agent = agentById.get(s.agentDefinitionId);
        const inputs = s.inputs
          .map((fromKey) => {
            const from = steps.find((x) => x.key === fromKey);
            const kind = from ? taskById.get(from.taskDefinitionId)?.kind : undefined;
            return from && kind && OUTPUT_TYPE[kind] ? { fromStepId: fromKey, artifactType: OUTPUT_TYPE[kind] } : null;
          })
          .filter((x): x is { fromStepId: string; artifactType: "report" | "deliverable" } => x !== null);
        let parameters: Record<string, unknown> | undefined;
        switch (task?.kind) {
          case "research_report":
            parameters = undefined;
            break;
          case "publish_report": {
            const source = steps.find((x) => x.key === s.sourceStepKey);
            parameters = { sourceTaskDefinitionId: source?.taskDefinitionId ?? "" };
            break;
          }
          case "agent_task":
            parameters = { instruction: s.instruction, ...(inputs.length ? { inputs } : {}) };
            break;
          case "operator_checkpoint":
            parameters = { question: s.question, inputs };
            break;
          case "agent_objective": {
            const loop: Record<string, number> = {};
            if (s.loopMaxIterations.trim()) loop.maxIterations = Number(s.loopMaxIterations);
            if (s.loopMaxActiveMinutes.trim()) loop.maxActiveSeconds = Math.round(Number(s.loopMaxActiveMinutes) * 60);
            parameters = {
              ...(Object.keys(loop).length ? { loop } : {}),
              intents: s.intents,
              tools: s.tools.filter((t) => t.capability).map((t) => ({ capability: t.capability, maxCalls: Number(t.maxCalls) || 1 })),
              ...(s.completionCriteria.trim() ? { completionCriteria: s.completionCriteria.trim() } : {}),
              ...(s.escalateWhen.trim() ? { escalateWhen: s.escalateWhen.trim() } : {}),
              ...(inputs.length ? { inputs } : {}),
            };
            break;
          }
          default:
            try {
              parameters = JSON.parse(s.rawParameters) as Record<string, unknown>;
            } catch {
              parameters = { invalidJson: s.rawParameters };
            }
        }
        return {
          stepId: s.key,
          label: s.label.trim() || s.key,
          taskDefinitionId: s.taskDefinitionId,
          taskDefinitionVersion: task?.version ?? 1,
          agentDefinitionId: s.agentDefinitionId,
          agentDefinitionVersion: agent?.version ?? 1,
          ...(parameters ? { parameters } : {}),
        };
      }),
    };
    return { name: name.trim(), graphDefinition: graph, ...(latestVersion !== undefined ? { previousVersion: latestVersion } : {}) };
  }, [name, description, steps, taskById, agentById, latestVersion]);

  async function check() {
    setBusy("check");
    try {
      await validateWorkflowDefinition(payload);
      setVerdict({ ok: true, text: "Every step passes the Registry's checks." });
    } catch (err) {
      setVerdict({ ok: false, text: errorText(err) });
    } finally {
      setBusy(null);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy("save");
    try {
      setSaved(await createWorkflowDefinition(payload));
    } catch (err) {
      setVerdict({ ok: false, text: errorText(err) });
    } finally {
      setBusy(null);
    }
  }

  if (saved) return <RunSaved saved={saved} />;

  const documentSteps = (index: number) => steps.slice(0, index).filter((x) => OUTPUT_TYPE[taskById.get(x.taskDefinitionId)?.kind ?? ""]);
  const capabilityNames = registry.capabilities.map((c) => c.name);

  return (
    <form className={b.form} onSubmit={save} aria-label="Workflow Builder">
      <header className={b.header}>
        <h1 className={px.heading}>{base ? `New version of ${base.name}` : "Build a workflow"}</h1>
        <p className={px.detail}>
          A known process as linear steps. The interpreter runs them in order; each step is governed like any other run.
          {base ? ` Saves v${latestVersion! + 1}; runs of earlier versions keep their own graph.` : ""}
        </p>
      </header>

      <fieldset className={cx(px.board, b.group)}>
        <legend className={px.tab}>Workflow</legend>
        <label className={b.field}>
          <span className={px.label}>Name</span>
          <input className={px.input} value={name} onChange={(e) => setName(e.target.value)} disabled={!!base || busy !== null} required />
        </label>
        <label className={b.field}>
          <span className={px.label}>Purpose</span>
          <textarea className={cx(px.input, b.textarea)} value={description} onChange={(e) => setDescription(e.target.value)} disabled={busy !== null} />
        </label>
      </fieldset>

      <ol className={b.steps} aria-label="Steps">
        {steps.map((s, i) => {
          const task = taskById.get(s.taskDefinitionId);
          const kind = task?.kind;
          const earlierDocs = documentSteps(i);
          const gateAgents = checkpointCapability
            ? registry.capabilityGrants.filter((g) => g.capabilityId === checkpointCapability.id && g.revokedAt === null && g.autonomyState === "ALWAYS_APPROVE").map((g) => g.agentDefinitionId)
            : [];
          return (
            <li key={s.key} className={cx(px.board, b.step)} data-testid="workflow-step">
              <div className={b.stepHead}>
                <label className={b.field}>
                  <span className={px.label}>
                    Step {i + 1} <span className={px.dim}>· id {s.key}</span>
                  </span>
                  <input className={px.input} value={s.label} onChange={(e) => patch(s.key, { label: e.target.value })} aria-label={`Step ${i + 1} label`} />
                </label>
                <PixelButton onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move step ${i + 1} up`}>
                  ↑
                </PixelButton>
                <PixelButton onClick={() => move(i, 1)} disabled={i === steps.length - 1} aria-label={`Move step ${i + 1} down`}>
                  ↓
                </PixelButton>
                <PixelButton kind="danger" onClick={() => setSteps((all) => all.filter((x) => x.key !== s.key))} disabled={steps.length === 1} aria-label={`Remove step ${i + 1}`}>
                  Remove
                </PixelButton>
              </div>
              <div className={b.row}>
                <label className={b.field}>
                  <span className={px.label}>Task</span>
                  <select className={px.input} value={s.taskDefinitionId} onChange={(e) => patch(s.key, { taskDefinitionId: e.target.value })} aria-label={`Step ${i + 1} task`}>
                    {registry.taskDefinitions
                      .filter((t) => t.planRegistered)
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} v{t.version} ({t.kind})
                        </option>
                      ))}
                  </select>
                </label>
                <label className={b.field}>
                  <span className={px.label}>Agent</span>
                  <select className={px.input} value={s.agentDefinitionId} onChange={(e) => patch(s.key, { agentDefinitionId: e.target.value })} aria-label={`Step ${i + 1} agent`}>
                    {registry.agentDefinitions.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} v{a.version} · {a.role}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {kind === "agent_task" && (
                <label className={b.field}>
                  <span className={px.label}>Instruction</span>
                  <textarea className={cx(px.input, b.textarea)} value={s.instruction} onChange={(e) => patch(s.key, { instruction: e.target.value })} aria-label={`Step ${i + 1} instruction`} />
                </label>
              )}
              {kind === "operator_checkpoint" && (
                <>
                  <label className={b.field}>
                    <span className={px.label}>Question for the approver</span>
                    <input className={px.input} value={s.question} onChange={(e) => patch(s.key, { question: e.target.value })} aria-label={`Step ${i + 1} question`} />
                  </label>
                  <p className={px.detail}>
                    The run stops here until you approve the exact outputs pinned below (their hashes). The step&apos;s agent must hold
                    review.checkpoint at ALWAYS_APPROVE
                    {gateAgents.length > 0 ? `: ${gateAgents.map((id) => agentById.get(id)).filter(Boolean).map((a) => `${a!.name} v${a!.version}`).join(", ")}` : ""}.
                  </p>
                </>
              )}
              {kind === "publish_report" && (
                <label className={b.field}>
                  <span className={px.label}>Publish the report of</span>
                  <select className={px.input} value={s.sourceStepKey} onChange={(e) => patch(s.key, { sourceStepKey: e.target.value })} aria-label={`Step ${i + 1} source`}>
                    <option value="">choose an earlier research step</option>
                    {steps.slice(0, i).filter((x) => taskById.get(x.taskDefinitionId)?.kind === "research_report").map((x) => (
                      <option key={x.key} value={x.key}>
                        {x.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {kind === "agent_objective" && (
                <ObjectiveFields step={s} index={i} capabilityNames={capabilityNames} limits={registry.builder?.autonomyLimits} onPatch={(c) => patch(s.key, c)} />
              )}
              {kind && !KNOWN_KINDS.has(kind) && (
                <label className={b.field}>
                  <span className={px.label}>Parameters (JSON)</span>
                  <textarea className={cx(px.input, b.textarea)} value={s.rawParameters} onChange={(e) => patch(s.key, { rawParameters: e.target.value })} aria-label={`Step ${i + 1} parameters`} />
                </label>
              )}
              {(kind === "agent_task" || kind === "operator_checkpoint" || kind === "agent_objective") && (
                <div role="group" aria-label={`Step ${i + 1} inputs`} className={b.perms}>
                  <span className={px.label}>Inputs</span>
                  {earlierDocs.length === 0 ? (
                    <span className={px.dim}>No earlier step produces a document.</span>
                  ) : (
                    earlierDocs.map((x) => (
                      <label key={x.key} className={b.check}>
                        <input
                          type="checkbox"
                          checked={s.inputs.includes(x.key)}
                          onChange={(e) => patch(s.key, { inputs: e.target.checked ? [...s.inputs, x.key] : s.inputs.filter((k) => k !== x.key) })}
                        />
                        {x.label} ({OUTPUT_TYPE[taskById.get(x.taskDefinitionId)!.kind]})
                      </label>
                    ))
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      <div className={b.actions}>
        <PixelButton onClick={() => setSteps((all) => [...all, emptyStep(registry, `Step ${all.length + 1}`)])} disabled={busy !== null}>
          Add step
        </PixelButton>
        <PixelButton onClick={() => void check()} disabled={busy !== null || !name.trim()}>
          Check
        </PixelButton>
        <PixelButton type="submit" kind="approve" disabled={busy !== null || !name.trim()}>
          {base ? `Save ${base.name} v${latestVersion! + 1}` : "Save workflow"}
        </PixelButton>
        {busy && (
          <span role="status">
            {busy === "check" ? "Checking" : "Saving"} <Skeleton />
          </span>
        )}
      </div>
      {verdict && (
        <div role={verdict.ok ? "status" : "alert"} className={verdict.ok ? undefined : b.error} data-testid="workflow-verdict">
          {!verdict.ok && <p className={b.errorMessage}>The Registry refused this workflow.</p>}
          <p className={px.detail}>{verdict.text}</p>
        </div>
      )}
    </form>
  );
}

function ObjectiveFields({
  step,
  index,
  capabilityNames,
  limits,
  onPatch,
}: {
  step: StepDraft;
  index: number;
  capabilityNames: string[];
  limits?: { maxIterations: number; maxActiveSeconds: number; minActiveSeconds: number };
  onPatch: (change: Partial<StepDraft>) => void;
}) {
  const INTENTS = ["plan", "brainstorm", "analyse", "compare", "critique", "write"];
  return (
    <>
      <p className={px.detail}>
        The Goal is the objective. The agent decides its own sequence of thinking and granted actions, within these limits, and
        stops when it judges the objective met or a limit is reached.
      </p>
      <div className={b.row}>
        <label className={b.field}>
          <span className={px.label}>Max iterations</span>
          <input className={px.input} type="number" min={1} max={limits?.maxIterations} placeholder={limits ? `${limits.maxIterations} (ceiling)` : ""} value={step.loopMaxIterations} onChange={(e) => onPatch({ loopMaxIterations: e.target.value })} aria-label={`Step ${index + 1} max iterations`} />
        </label>
        <label className={b.field}>
          <span className={px.label}>Max active minutes</span>
          <input className={px.input} type="number" placeholder={limits ? `${limits.maxActiveSeconds / 60} (ceiling)` : ""} value={step.loopMaxActiveMinutes} onChange={(e) => onPatch({ loopMaxActiveMinutes: e.target.value })} aria-label={`Step ${index + 1} max active minutes`} />
        </label>
      </div>
      <div role="group" aria-label={`Step ${index + 1} thinking actions`} className={b.perms}>
        <span className={px.label}>Thinking actions</span>
        {INTENTS.map((intent) => (
          <label key={intent} className={b.check}>
            <input type="checkbox" checked={step.intents.includes(intent)} onChange={(e) => onPatch({ intents: e.target.checked ? [...step.intents, intent] : step.intents.filter((x) => x !== intent) })} />
            {intent}
          </label>
        ))}
      </div>
      <div role="group" aria-label={`Step ${index + 1} granted actions`} className={b.grants}>
        <span className={px.label}>Actions (each also needs the agent&apos;s Grant; Policy still decides)</span>
        {step.tools.map((t, ti) => (
          <div key={ti} className={b.row}>
            <select className={px.input} value={t.capability} onChange={(e) => onPatch({ tools: step.tools.map((x, j) => (j === ti ? { ...x, capability: e.target.value } : x)) })} aria-label={`Step ${index + 1} action ${ti + 1}`}>
              <option value="">choose a capability</option>
              {capabilityNames.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <input className={px.input} type="number" min={1} value={t.maxCalls} onChange={(e) => onPatch({ tools: step.tools.map((x, j) => (j === ti ? { ...x, maxCalls: e.target.value } : x)) })} aria-label={`Step ${index + 1} action ${ti + 1} max calls`} />
            <PixelButton onClick={() => onPatch({ tools: step.tools.filter((_, j) => j !== ti) })}>Remove</PixelButton>
          </div>
        ))}
        <PixelButton onClick={() => onPatch({ tools: [...step.tools, { capability: "", maxCalls: "3" }] })}>Add action</PixelButton>
      </div>
      <label className={b.field}>
        <span className={px.label}>Done when</span>
        <textarea className={cx(px.input, b.textarea)} value={step.completionCriteria} onChange={(e) => onPatch({ completionCriteria: e.target.value })} aria-label={`Step ${index + 1} completion criteria`} />
      </label>
      <label className={b.field}>
        <span className={px.label}>Ask me (approval) when</span>
        <textarea className={cx(px.input, b.textarea)} value={step.escalateWhen} onChange={(e) => onPatch({ escalateWhen: e.target.value })} aria-label={`Step ${index + 1} escalate when`} />
      </label>
    </>
  );
}

function RunSaved({ saved }: { saved: { id: string; name: string; version: number } }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<{ workflowRunId: string } | null>(null);

  async function run(e: FormEvent) {
    e.preventDefault();
    setStarting(true);
    setError(null);
    try {
      setStarted(await createGoal(title.trim(), description.trim() || undefined, { workflowDefinitionId: saved.id, async: true }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className={b.form}>
      <div className={cx(px.parchment, b.done)} role="status">
        <h1 className={px.heading}>
          {saved.name} v{saved.version} saved
        </h1>
        <p>The Registry recorded the version. Nothing older was changed.</p>
      </div>
      <form className={cx(px.board, b.group)} onSubmit={run} aria-label="Run this workflow">
        <span className={px.tab}>Run it</span>
        <label className={b.field}>
          <span className={px.label}>Goal</span>
          <input className={px.input} value={title} onChange={(e) => setTitle(e.target.value)} disabled={starting || !!started} />
        </label>
        <label className={b.field}>
          <span className={px.label}>Details (optional)</span>
          <textarea className={cx(px.input, b.textarea)} value={description} onChange={(e) => setDescription(e.target.value)} disabled={starting || !!started} />
        </label>
        <p className={px.detail}>The run starts at once and continues in the background; it uses model quota under the usual budgets.</p>
        <PixelButton type="submit" disabled={starting || !!started || !title.trim()}>
          Start goal
        </PixelButton>
        {started && (
          <Link href={`/workflows/${started.workflowRunId}`} className={b.inkLink} style={{ color: "var(--pixel-label)" }}>
            Watch the run
          </Link>
        )}
        {error && (
          <div role="alert" className={b.error}>
            <p className={b.errorMessage}>Couldn&apos;t confirm the goal started.</p>
            <p className={px.detail}>{error}</p>
          </div>
        )}
      </form>
    </div>
  );
}
