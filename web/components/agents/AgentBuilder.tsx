"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  createAgentDefinition,
  getRegistry,
  type AgentDefinitionInput,
  type BuilderOptions,
  type ExecutionProfile,
  type GrantInput,
  type RegistryData,
} from "../../lib/api";
import { errorText } from "../../lib/keep";
import { PixelButton, Skeleton, StateNotice, cx, px } from "../pixel/Pixel";
import b from "./builder.module.css";

type GrantDraft = { enabled: boolean; permissions: string[]; autonomyState: string; maxTrustLevelRequired: number };

/** What a Keeper proposal (or any caller) may pre-fill. Nothing is written until the operator submits. */
export type AgentPrefill = Partial<Pick<AgentDefinitionInput, "name" | "role" | "objective" | "instructions" | "executionProfile">> & {
  grants?: { capabilityName: string; permissions: string[]; autonomyState?: string }[];
};

const DEFAULT_TRUST = 1;

/**
 * Agent Builder (V1.1): creates an Agent Definition, or its next version, with its
 * Capability Grants and execution profile, through the Registry's one versioned
 * write. Every option comes from `GET /registry` (`builder`); the API validates and
 * refuses. A new version never edits the old one: it is a new row with its own Grants.
 */
export function AgentBuilder({ fromId, prefill }: { fromId?: string; prefill?: AgentPrefill }) {
  const [registry, setRegistry] = useState<RegistryData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    getRegistry()
      .then(setRegistry)
      .catch((err) => setLoadError(errorText(err)));
  }, []);

  if (loadError) return <StateNotice role="alert" message="Couldn't load the Registry, so nothing can be offered." detail={loadError} />;
  if (!registry) return <StateNotice role="status" message={<>Loading the Registry <Skeleton /></>} />;
  if (!registry.builder) return <StateNotice role="alert" message="This API build doesn't offer the Agent Builder." detail="GET /registry returned no builder options." />;
  const base = fromId ? registry.agentDefinitions.find((d) => d.id === fromId) : undefined;
  if (fromId && !base) return <StateNotice role="alert" message="The agent to version wasn't found in the Registry." detail={fromId} />;
  return <BuilderForm registry={registry} options={registry.builder} base={base} prefill={prefill} />;
}

function BuilderForm({
  registry,
  options,
  base,
  prefill,
}: {
  registry: RegistryData;
  options: BuilderOptions;
  base?: RegistryData["agentDefinitions"][number];
  prefill?: AgentPrefill;
}) {
  const latestVersion = base ? Math.max(...registry.agentDefinitions.filter((d) => d.name === base.name).map((d) => d.version)) : undefined;
  const seedProfile: ExecutionProfile = base?.executionProfile ?? prefill?.executionProfile ?? {};

  const [name, setName] = useState(base?.name ?? prefill?.name ?? "");
  const [role, setRole] = useState(base?.role ?? prefill?.role ?? "");
  const [objective, setObjective] = useState(base?.objective ?? prefill?.objective ?? "");
  const [instructions, setInstructions] = useState(base?.instructions ?? prefill?.instructions ?? "");
  const [tier, setTier] = useState(seedProfile.preferredTier ?? "");
  const [provider, setProvider] = useState(seedProfile.provider ?? "");
  const [maxIterations, setMaxIterations] = useState(seedProfile.loop?.maxIterations?.toString() ?? "");
  const [maxActiveMinutes, setMaxActiveMinutes] = useState(
    seedProfile.loop?.maxActiveSeconds !== undefined ? String(seedProfile.loop.maxActiveSeconds / 60) : ""
  );

  const [grants, setGrants] = useState<Record<string, GrantDraft>>(() => {
    const drafts: Record<string, GrantDraft> = {};
    for (const c of registry.capabilities) {
      const existing = base
        ? registry.capabilityGrants.find((g) => g.agentDefinitionId === base.id && g.capabilityId === c.id && g.revokedAt === null)
        : undefined;
      const proposed = prefill?.grants?.find((g) => g.capabilityName === c.name);
      drafts[c.id] = existing
        ? { enabled: true, permissions: existing.permissions, autonomyState: existing.autonomyState, maxTrustLevelRequired: existing.maxTrustLevelRequired }
        : proposed
          ? { enabled: true, permissions: proposed.permissions, autonomyState: proposed.autonomyState ?? "ALWAYS_APPROVE", maxTrustLevelRequired: DEFAULT_TRUST }
          : { enabled: false, permissions: ["READ"], autonomyState: "ALWAYS_APPROVE", maxTrustLevelRequired: DEFAULT_TRUST };
    }
    return drafts;
  });

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ id: string; name: string; version: number } | null>(null);

  const limits = options.autonomyLimits;
  const enabledProviders = options.providers.filter((p) => p.enabled);
  const incomplete = !name.trim() || !role.trim() || !objective.trim() || !instructions.trim();

  const payload = useMemo<AgentDefinitionInput>(() => {
    const loop: NonNullable<ExecutionProfile["loop"]> = {};
    if (maxIterations.trim()) loop.maxIterations = Number(maxIterations);
    if (maxActiveMinutes.trim()) loop.maxActiveSeconds = Math.round(Number(maxActiveMinutes) * 60);
    const executionProfile: ExecutionProfile = {
      ...(tier ? { preferredTier: tier } : {}),
      ...(provider ? { provider } : {}),
      ...(Object.keys(loop).length > 0 ? { loop } : {}),
    };
    const grantInputs: GrantInput[] = Object.entries(grants)
      .filter(([, g]) => g.enabled)
      .map(([capabilityId, g]) => ({
        capabilityId,
        permissions: g.permissions,
        autonomyState: g.autonomyState,
        maxTrustLevelRequired: g.maxTrustLevelRequired,
      }));
    return {
      name: name.trim(),
      role: role.trim(),
      objective: objective.trim(),
      instructions: instructions.trim(),
      executionProfile,
      grants: grantInputs,
      ...(latestVersion !== undefined ? { previousVersion: latestVersion } : {}),
    };
  }, [name, role, objective, instructions, tier, provider, maxIterations, maxActiveMinutes, grants, latestVersion]);

  function patchGrant(capabilityId: string, patch: Partial<GrantDraft>) {
    setGrants((all) => ({ ...all, [capabilityId]: { ...all[capabilityId]!, ...patch } }));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    try {
      setSaved(await createAgentDefinition(payload));
    } catch (err) {
      setSaveError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  if (saved) {
    return (
      <div className={cx(px.parchment, b.done)} role="status">
        <h1 className={px.heading}>
          {saved.name} v{saved.version} recruited
        </h1>
        <p>The Registry recorded the version and its keys. Nothing older was changed.</p>
        <Link href={`/agents/${saved.id}`} className={b.inkLink}>
          Open {saved.name} v{saved.version}
        </Link>
      </div>
    );
  }

  return (
    <form className={b.form} onSubmit={submit} aria-label="Agent Builder">
      <header className={b.header}>
        <h1 className={px.heading}>{base ? `New version of ${base.name}` : "Recruit an agent"}</h1>
        <p className={px.detail}>
          {base
            ? `Saves ${base.name} v${latestVersion! + 1}. v${base.version} and every earlier version stay exactly as they are, and runs keep naming the version they used.`
            : "Saves version 1 of a new Agent Definition with its keys, in one Registry write."}
        </p>
      </header>

      <fieldset className={cx(px.board, b.group)}>
        <legend className={px.tab}>Identity</legend>
        <label className={b.field}>
          <span className={px.label}>Name</span>
          <input className={px.input} value={name} onChange={(e) => setName(e.target.value)} disabled={saving || !!base} required />
        </label>
        <label className={b.field}>
          <span className={px.label}>Role</span>
          <input className={px.input} value={role} onChange={(e) => setRole(e.target.value)} disabled={saving} required />
        </label>
        <label className={b.field}>
          <span className={px.label}>Objective</span>
          <textarea className={cx(px.input, b.textarea)} value={objective} onChange={(e) => setObjective(e.target.value)} disabled={saving} required />
        </label>
        <label className={b.field}>
          <span className={px.label}>Instructions</span>
          <textarea className={cx(px.input, b.textareaTall)} value={instructions} onChange={(e) => setInstructions(e.target.value)} disabled={saving} required />
        </label>
      </fieldset>

      <fieldset className={cx(px.board, b.group)}>
        <legend className={px.tab}>Keys (capabilities)</legend>
        <p className={px.detail}>
          Each key is a Capability Grant. Its autonomy decides whether the agent may act alone (AUTONOMOUS), acts on measured
          performance for low-risk reads (CONDITIONAL), or asks you first (ALWAYS_APPROVE). The Registry refuses AUTONOMOUS for
          SPEND, TRADE, PUBLISH and DELETE. Policy, budgets, approvals and stops still apply to every action.
        </p>
        {registry.capabilities.length === 0 ? (
          <p className={px.dim}>No capabilities are registered.</p>
        ) : (
          <ul className={b.grants}>
            {registry.capabilities.map((c) => {
              const g = grants[c.id]!;
              return (
                <li key={c.id} className={cx(px.vellum, b.grant)} data-testid="grant-row">
                  <label className={b.check}>
                    <input type="checkbox" checked={g.enabled} onChange={(e) => patchGrant(c.id, { enabled: e.target.checked })} disabled={saving} />
                    <span className={px.label}>{c.name}</span>
                    <span className={px.dim}>risk {c.staticRiskTag}</span>
                  </label>
                  {c.description && <p className={px.dim}>{c.description}</p>}
                  {g.enabled && (
                    <div className={b.grantControls}>
                      <div className={b.perms} role="group" aria-label={`${c.name} permissions`}>
                        {options.permissions.map((p) => (
                          <label key={p} className={b.check}>
                            <input
                              type="checkbox"
                              checked={g.permissions.includes(p)}
                              onChange={(e) =>
                                patchGrant(c.id, {
                                  permissions: e.target.checked ? [...g.permissions, p] : g.permissions.filter((x) => x !== p),
                                })
                              }
                              disabled={saving}
                            />
                            {p}
                          </label>
                        ))}
                      </div>
                      <label className={b.inline}>
                        autonomy
                        <select className={px.input} value={g.autonomyState} onChange={(e) => patchGrant(c.id, { autonomyState: e.target.value })} disabled={saving} aria-label={`${c.name} autonomy`}>
                          {options.autonomyStates.map((a) => (
                            <option key={a} value={a}>
                              {a}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className={b.inline}>
                        binding trust ≥
                        <select
                          className={px.input}
                          value={g.maxTrustLevelRequired}
                          onChange={(e) => patchGrant(c.id, { maxTrustLevelRequired: Number(e.target.value) })}
                          disabled={saving}
                          aria-label={`${c.name} trust`}
                        >
                          {[0, 1, 2].map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </fieldset>

      <fieldset className={cx(px.board, b.group)}>
        <legend className={px.tab}>Execution profile</legend>
        <p className={px.detail}>
          What the agent asks of the Model Router, never which model runs. The Router still raises the tier for risk or a retry,
          and never switches to another provider on its own.
        </p>
        <div className={b.row}>
          <label className={b.field}>
            <span className={px.label}>Preferred tier</span>
            <select className={px.input} value={tier} onChange={(e) => setTier(e.target.value)} disabled={saving}>
              <option value="">runtime default per task</option>
              {options.tiers.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className={b.field}>
            <span className={px.label}>Provider</span>
            <select className={px.input} value={provider} onChange={(e) => setProvider(e.target.value)} disabled={saving}>
              <option value="">the Router&apos;s configured order</option>
              {enabledProviders.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name} ({p.resourceUnits.join(", ")}; {p.tiers.join(", ")})
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className={b.row}>
          <label className={b.field}>
            <span className={px.label}>Max iterations (autonomous objectives)</span>
            <input
              className={px.input}
              type="number"
              min={1}
              max={limits.maxIterations}
              placeholder={`${limits.maxIterations} (ceiling)`}
              value={maxIterations}
              onChange={(e) => setMaxIterations(e.target.value)}
              disabled={saving}
            />
          </label>
          <label className={b.field}>
            <span className={px.label}>Max active minutes</span>
            <input
              className={px.input}
              type="number"
              min={limits.minActiveSeconds / 60}
              max={limits.maxActiveSeconds / 60}
              placeholder={`${limits.maxActiveSeconds / 60} (ceiling)`}
              value={maxActiveMinutes}
              onChange={(e) => setMaxActiveMinutes(e.target.value)}
              disabled={saving}
            />
          </label>
        </div>
        <p className={px.detail}>
          Ceilings: {limits.maxIterations} iterations and {limits.maxActiveSeconds / 60} active minutes per run (approval waits
          don&apos;t count); each task instance is held to{" "}
          {Object.entries(limits.taskInstanceBudgetCeilings)
            .map(([unit, amount]) => `${amount} ${unit}`)
            .join(" and ")}
          . An agent can only ask for less.
        </p>
      </fieldset>

      <fieldset className={cx(px.board, b.group)}>
        <legend className={px.tab}>Memory and escalation</legend>
        <p>Memory isn&apos;t built yet, so nothing is remembered between tasks beyond the artifacts runs produce.</p>
        <p className={px.detail}>
          Escalation is the approval behaviour of each key above, plus the approval gates you add to workflows.
        </p>
      </fieldset>

      <div className={b.actions}>
        <PixelButton type="submit" kind="approve" disabled={saving || incomplete}>
          {base ? `Save ${base.name} v${latestVersion! + 1}` : "Recruit agent"}
        </PixelButton>
        {saving && (
          <span role="status">
            Saving <Skeleton />
          </span>
        )}
      </div>
      {saveError && (
        <div role="alert" className={b.error}>
          <p className={b.errorMessage}>The Registry refused the agent.</p>
          <p className={px.detail}>{saveError}</p>
        </div>
      )}
    </form>
  );
}
