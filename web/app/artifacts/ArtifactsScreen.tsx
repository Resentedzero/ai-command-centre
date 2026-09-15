"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { getAgentDetail, getArtifact, type AgentDetail, type ArtifactDetail } from "../../lib/api";
import { useRefetchOnEvents } from "../../components/live";
import { AgentRoster, useAgentRoster } from "../../components/agents/roster";
import { PixelButton, RefreshNotice, Skeleton, StateNotice, StatusMark, cx, px } from "../../components/pixel/Pixel";
import { world } from "../../components/world/World";
import { countLabel, errorText, formatTime } from "../../lib/keep";
import s from "./artifacts.module.css";

type Output = AgentDetail["outputs"][number];

const CHESTS_PER_ROW = 6;
/** `GET /agents/:id` returns at most this many outputs, so a full list is shown as 10+. */
const OUTPUTS_CAP = 10;

/** A typed-unknown provenance field (from event payloads) shown as text, or an honest absence. */
function shown(v: unknown): string {
  return v === null || v === undefined ? "not recorded" : String(v);
}

/**
 * Artifacts (spec 15.1 screen 8; Figma "Artifacts — pixel (vault)"): what did
 * the agents produce, and where did it come from? There is no artifact list
 * route, so browsing is per agent (`GET /agents/:id` outputs): one chest per
 * output in the vault. Opening one reads `GET /artifacts/:id`: metadata and the
 * content hash check, provenance (invocation → run → agent → task → workflow
 * run → goal), the preview as plain text (the whole content on request, for an
 * approver; ROADMAP §7), and the compiled contexts that included it.
 */
export function ArtifactsScreen({ id, agentParam, full = false }: { id?: string; agentParam?: string; full?: boolean }) {
  const roster = useAgentRoster();
  const [artifact, setArtifact] = useState<ArtifactDetail | null>(null);
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const [content, setContent] = useState<string | null | undefined>(undefined);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);

  const artifactSeq = useRef(0);
  const loadArtifact = useCallback(async () => {
    if (!id) return;
    const n = ++artifactSeq.current;
    try {
      const d = await getArtifact(id, full);
      if (n !== artifactSeq.current) return;
      setArtifact(d);
      setArtifactError(null);
      if (full) setContent(d.artifact.content ?? null);
    } catch (err) {
      if (n === artifactSeq.current) setArtifactError(errorText(err));
    }
  }, [id, full]);

  useEffect(() => {
    setArtifact(null);
    setArtifactError(null);
    setContent(undefined);
    setContentError(null);
    void loadArtifact();
  }, [loadArtifact]);

  async function readAll() {
    if (!id) return;
    setContentLoading(true);
    setContentError(null);
    try {
      setContent((await getArtifact(id, true)).artifact.content ?? null);
    } catch (err) {
      setContentError(errorText(err));
    } finally {
      setContentLoading(false);
    }
  }

  const agentId = agentParam ?? artifact?.producedBy?.agent?.id ?? (id ? undefined : roster.entries[0]?.id);
  const [outputs, setOutputs] = useState<Output[] | null>(null);
  const [agentLabel, setAgentLabel] = useState<string | null>(null);
  const [outputsError, setOutputsError] = useState<string | null>(null);
  const seq = useRef(0);

  const loadOutputs = useCallback(async () => {
    if (!agentId) return;
    const n = ++seq.current;
    try {
      const d = await getAgentDetail(agentId);
      if (n !== seq.current) return;
      setOutputs(d.outputs);
      setAgentLabel(`${d.agent.name} v${d.agent.version}`);
      setOutputsError(null);
    } catch (err) {
      if (n === seq.current) setOutputsError(errorText(err));
    }
  }, [agentId]);

  useEffect(() => {
    setOutputs(null);
    setOutputsError(null);
    void loadOutputs();
  }, [loadOutputs]);
  useRefetchOnEvents(loadOutputs);

  const hrefFor = (artifactId: string) => `/artifacts/${artifactId}${agentId ? `?agent=${agentId}` : ""}`;
  const a = artifact?.artifact;
  const mismatch = a?.contentHashMatches === false;

  return (
    <main className={s.screen}>
      <div className={s.left}>
        <AgentRoster roster={roster} selectedId={agentId} hrefFor={(x) => `/artifacts?agent=${x}`} />
        <nav className={cx(px.board, s.outputs)} aria-label="Outputs">
          <span className={px.tab}>Outputs{outputs ? ` · ${countLabel(outputs.length, OUTPUTS_CAP)}` : ""}</span>
          {!agentId ? (
            <StateNotice message={id && !artifact && !artifactError ? <Skeleton /> : "Choose an agent to browse its outputs."} />
          ) : !outputs && outputsError ? (
            <StateNotice role="alert" message="Couldn't load this agent's outputs." detail={outputsError} action={<PixelButton onClick={() => void loadOutputs()}>Retry</PixelButton>} />
          ) : !outputs ? (
            <StateNotice role="status" message={<Skeleton />} />
          ) : outputs.length === 0 ? (
            <StateNotice message={`${agentLabel ?? "This agent"}'s vault is empty.`} />
          ) : (
            <ul className={s.list}>
              {outputs.map((o) => (
                <li key={o.id}>
                  <Link href={hrefFor(o.id)} className={cx(px.plaque, s.entry, o.id === id && px.selected)} aria-current={o.id === id ? "page" : undefined} data-testid="output">
                    <span className={o.id === id ? s.chestOpen : s.chest} aria-hidden />
                    <span className={s.entryText}>
                      {o.type} · {o.size} bytes
                      <span className={cx(px.dim, s.time)}>{formatTime(o.createdAt)}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {outputs && outputsError && <RefreshNotice error={outputsError} />}
          {agentId && <p className={px.detail}>This agent&apos;s most recent outputs.</p>}
        </nav>
      </div>

      <section className={s.main} aria-label="Artifact">
        <div className={s.top}>
          <div className={s.vault} role="img" aria-label={outputs ? `Vault: ${countLabel(outputs.length, OUTPUTS_CAP)} outputs` : "Vault"}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/world/room-v5-vault-2x.png" width={352} height={256} alt="" className={world.base} draggable={false} />
            <div className={s.floorPatch} />
            <div className={world.night} />
            {outputs?.map((o, i) => (
              <span
                key={o.id}
                className={cx(o.id === id ? s.chestOpen : s.chest, s.worldChest, o.id === id && s.bracket)}
                style={{ left: 40 + (i % CHESTS_PER_ROW) * 48, top: 184 + Math.floor(i / CHESTS_PER_ROW) * 36 }}
              />
            ))}
          </div>

          <div className={cx(px.parchment, s.meta)}>
            {!id ? (
              <>
                <h1 className={px.heading}>Vault</h1>
                <p>Choose an output to read it and see where it came from.</p>
              </>
            ) : !artifact && artifactError ? (
              <StateNotice
                role="alert"
                message={/ 404 /.test(artifactError) ? "This output's artifact wasn't found." : "Couldn't load this artifact."}
                detail={artifactError}
                action={<PixelButton onClick={() => void loadArtifact()}>Retry</PixelButton>}
              />
            ) : !a ? (
              <>
                <h1 className={px.heading}>
                  <Skeleton />
                </h1>
                <p>
                  Loading the artifact <Skeleton />
                </p>
              </>
            ) : (
              <>
                <h1 className={px.heading}>
                  {a.type} v{a.version}
                </h1>
                <dl className={px.kv}>
                  <dt>size</dt>
                  <dd>{a.size} bytes</dd>
                  <dt>created</dt>
                  <dd>{formatTime(a.createdAt)}</dd>
                  <dt>stored</dt>
                  <dd>{a.storedInline ? "inline" : "not inline"}</dd>
                  <dt>summary</dt>
                  <dd>{a.summary ?? "none recorded"}</dd>
                  <dt>hash</dt>
                  <dd className={s.hash}>{a.hash}</dd>
                </dl>
                {a.contentHashMatches === null ? (
                  <StatusMark state="none" tone="neutral" surface="parchment">
                    no inline content to check against the hash
                  </StatusMark>
                ) : mismatch ? (
                  <span role="alert">
                    <StatusMark state="mismatch" tone="fail" surface="parchment">
                      the content no longer matches its hash
                    </StatusMark>
                  </span>
                ) : (
                  <StatusMark state="match" tone="done" surface="parchment">
                    the content matches its hash
                  </StatusMark>
                )}
              </>
            )}
          </div>
        </div>

        {a && artifact && (
          <div className={s.panels}>
            <section className={cx(px.parchment, s.produced)} aria-label="Produced by" data-testid="produced-by">
              <div className={px.label}>Produced by</div>
              {!artifact.producedBy ? (
                <p>No producing invocation is recorded.</p>
              ) : (
                <dl className={px.kv}>
                  <dt>goal</dt>
                  <dd>
                    {artifact.producedBy.goal ? (
                      artifact.producedBy.workflowRunId ? (
                        <Link href={`/workflows/${artifact.producedBy.workflowRunId}`} className={s.inkLink}>
                          {artifact.producedBy.goal.title ?? "untitled goal"}
                        </Link>
                      ) : (
                        (artifact.producedBy.goal.title ?? "untitled goal")
                      )
                    ) : (
                      "no goal"
                    )}
                  </dd>
                  <dt>task</dt>
                  <dd>
                    {artifact.producedBy.taskDefinition.name} v{artifact.producedBy.taskDefinition.version}
                  </dd>
                  <dt>agent</dt>
                  <dd>
                    {artifact.producedBy.agent ? (
                      <Link href={`/agents/${artifact.producedBy.agent.id}`} className={s.inkLink}>
                        {artifact.producedBy.agent.name ?? "unnamed"} v{artifact.producedBy.agent.version ?? "?"}
                      </Link>
                    ) : (
                      "no agent bound"
                    )}
                  </dd>
                  <dt>invocation</dt>
                  <dd>
                    {artifact.producedBy.invocation.kind} #{artifact.producedBy.invocation.seqNo}
                  </dd>
                </dl>
              )}
            </section>

            <section className={s.reading} aria-label="Content">
              <span className={px.tab}>{content !== undefined ? "Full content" : "Preview"}</span>
              {mismatch && <p className={s.untrustedNote}>Untrusted: this content does not match its stored hash.</p>}
              {content !== undefined ? (
                content === null ? (
                  <p className={px.dim}>Nothing is stored inline to read.</p>
                ) : (
                  <pre className={cx(px.vellum, s.pre, mismatch && s.untrusted)} data-testid="artifact-content">
                    {content}
                  </pre>
                )
              ) : a.preview === null ? (
                <p className={px.dim}>Nothing is stored inline to read.</p>
              ) : (
                <>
                  {/* Model or tool output: rendered as text, never HTML. */}
                  <pre className={cx(px.vellum, s.pre, mismatch && s.untrusted)} data-testid="artifact-preview">
                    {a.preview}
                  </pre>
                  {a.truncated && (
                    <div className={s.row}>
                      <span className={px.detail}>The preview is truncated.</span>
                      <PixelButton onClick={() => void readAll()} disabled={contentLoading}>
                        Show the full content
                      </PixelButton>
                    </div>
                  )}
                </>
              )}
              {contentError && (
                <p role="alert" className={px.detail}>
                  Couldn&apos;t load the full content. {contentError}
                </p>
              )}
            </section>

            <section className={s.referenced} aria-label="Referenced by">
              <span className={px.tab}>Referenced by</span>
              {artifact.referencedBy.length === 0 ? (
                <p className={px.dim}>No compiled context has included this artifact.</p>
              ) : (
                <ol className={cx(px.vellum, s.refs)} data-testid="referenced-by">
                  {artifact.referencedBy.map((r, i) => (
                    <li key={`${r.invocationId ?? "none"}-${i}`}>
                      <span className={px.dim}>{formatTime(r.occurredAt)}</span> {shown(r.kind)} · tier {shown(r.tier)} · version {shown(r.version)}
                      {typeof r.hash === "string" && <span className={px.dim}> · {r.hash.slice(0, 12)}…</span>}
                    </li>
                  ))}
                </ol>
              )}
              {artifact.referencedByTruncated && <p className={px.detail}>Only the newest references are shown.</p>}
            </section>
          </div>
        )}
      </section>
    </main>
  );
}
