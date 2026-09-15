"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { approveApproval, listPendingApprovals, rejectApproval, type ApprovalData, type ApprovalResolution } from "../../lib/api";
import { isStale, useLive, useRefetchOnEvents } from "../../components/live";
import { ButtonMark, PixelButton, Skeleton, StateNotice, StatusMark, cx, px } from "../../components/pixel/Pixel";
import { world } from "../../components/world/World";
import { errorText, formatTime } from "../../lib/keep";
import s from "./approvals.module.css";

/** How often the queue re-reads with no event: a pending Approval can expire past its TTL silently. */
const APPROVALS_REFRESH_MS = 30_000;

/**
 * Approvals (spec 15.1 screen 4; Figma "Approvals v2 — pixel"): what exactly
 * am I being asked to allow? Reading-first. A small vignette of the sealed
 * council hall, then the request (capability, permission, agent, goal, risk
 * tier, TTL), the content to be acted on with its hash check, the preview as
 * plain text, and the frozen snapshot. Approve and Reject stay pinned in the
 * action bar. No client-side policy: the buttons call the API and re-read.
 */
export default function ApprovalsPage() {
  const { status } = useLive();
  const [approvals, setApprovals] = useState<ApprovalData[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      setApprovals(await listPendingApprovals());
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void refetch();
    const timer = setInterval(() => void refetch(), APPROVALS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refetch]);
  useRefetchOnEvents(refetch);

  async function resolve(id: string, action: (id: string) => Promise<ApprovalResolution>): Promise<void> {
    setPendingActionId(id);
    setActionError(null);
    setActionNotice(null);
    try {
      const result = await action(id);
      if (result?.advanceError) setActionNotice(result.advanceError);
    } catch (err) {
      setActionError(errorText(err));
    } finally {
      await refetch();
      setPendingActionId(null);
    }
  }

  const selected = approvals?.find((a) => a.id === selectedId) ?? approvals?.[0] ?? null;
  const stale = isStale(status) || (approvals !== null && loadError !== null);

  return (
    <main className={s.screen}>
      <nav className={cx(px.board, s.queue)} aria-label="Pending approvals">
        <span className={px.tab}>Pending{approvals ? ` · ${approvals.length}` : ""}</span>
        {!approvals && loadError ? (
          <StateNotice role="alert" message="Couldn't load approvals." detail={loadError} action={<PixelButton onClick={() => void refetch()}>Retry</PixelButton>} />
        ) : !approvals ? (
          <StateNotice role="status" message={<Skeleton />} />
        ) : approvals.length === 0 ? (
          <StateNotice message="Nothing is waiting for approval." />
        ) : (
          <ul className={s.list}>
            {approvals.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  data-testid="approval-row"
                  className={cx(px.plaque, s.entry, a.id === selected?.id && px.selected)}
                  aria-pressed={a.id === selected?.id}
                  onClick={() => setSelectedId(a.id)}
                >
                  <span className={s.title}>{a.context?.capabilityName ?? "Approval"}</span>
                  <StatusMark state={a.status} tone={a.status === "pending" ? "wait" : undefined} />
                  <span className={cx(px.dim, s.meta)}>
                    {a.context?.agent ? `${a.context.agent.name} v${a.context.agent.version} · ` : ""}risk {a.riskTier} · {formatTime(a.createdAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {approvals && loadError && (
          <p role="alert" className={px.detail}>
            Couldn&apos;t refresh the queue; it may be out of date. {loadError}
          </p>
        )}
      </nav>

      <section className={s.reading} aria-label="Approval request">
        <div className={s.scroll}>
          {actionError && (
            <p role="alert" className={s.error}>
              Couldn&apos;t resolve the approval. <span className={px.detail}>{actionError}</span>
            </p>
          )}
          {actionNotice && (
            <p role="alert" className={cx(px.parchment, s.notice)}>
              {actionNotice}
            </p>
          )}

          <div className={s.top}>
            <div className={cx(s.vignette, stale && world.stale)} role="img" aria-label={selected ? "The council hall seal, waiting" : "The council hall"}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/world/room-v5-council-2x.png" width={480} height={256} alt="" className={world.base} draggable={false} />
              <div className={world.night} />
              {selected && (
                <>
                  <img className={world.light} src="/world/light-wait-2x.png" style={{ left: 64, top: 48 }} alt="" />
                  <div className={world.seal} style={{ left: 184, top: 192 }} />
                </>
              )}
            </div>

            {selected ? (
              <div className={cx(px.parchment, s.request)} data-testid="approval-context">
                <h1 className={px.label}>
                  {selected.context?.capabilityName ?? "Capability not recorded"}
                  {selected.context?.permission ? ` · ${selected.context.permission}` : ""}
                </h1>
                <dl className={px.kv}>
                  <dt>status</dt>
                  <dd>
                    <StatusMark state={selected.status} tone={selected.status === "pending" ? "wait" : undefined} surface="parchment" />
                  </dd>
                  <dt>risk tier</dt>
                  <dd>{selected.riskTier}</dd>
                  <dt>agent</dt>
                  <dd>{selected.context?.agent ? `${selected.context.agent.name} v${selected.context.agent.version}` : "not recorded"}</dd>
                  <dt>goal</dt>
                  <dd>
                    {selected.context?.goal ? (
                      selected.context.workflowRunId ? (
                        <Link href={`/workflows/${selected.context.workflowRunId}`} className={s.inkLink}>
                          {selected.context.goal.title}
                        </Link>
                      ) : (
                        selected.context.goal.title
                      )
                    ) : (
                      "standalone task"
                    )}
                  </dd>
                  <dt>requested</dt>
                  <dd>{formatTime(selected.createdAt)}</dd>
                  <dt>expires</dt>
                  <dd>{selected.ttl ? formatTime(selected.ttl) : "no expiry set"}</dd>
                </dl>
                <div className={px.detail}>
                  approval {selected.id} · invocation {selected.invocationId}
                </div>
              </div>
            ) : (
              approvals !== null && <StateNotice className={px.board} message="Choose a request from the queue." />
            )}
          </div>

          {selected?.context?.artifact && <ArtifactToAct artifact={selected.context.artifact} />}

          {selected && (
            <section className={s.block}>
              <span className={px.tab}>Proposed action</span>
              <pre className={cx(px.vellum, s.pre)}>{JSON.stringify(selected.proposedActionSnapshot, null, 2)}</pre>
            </section>
          )}
        </div>

        {selected && (
          <div className={cx(px.board, s.actions)}>
            <span className={s.actionText}>Decide this request. The decision is recorded and the workflow continues from it.</span>
            <PixelButton
              kind="approve"
              onClick={() => void resolve(selected.id, approveApproval)}
              disabled={pendingActionId === selected.id}
              aria-label={`Approve ${selected.context?.capabilityName ?? "approval"} ${selected.id}`}
            >
              <ButtonMark tone="done" />
              Approve
            </PixelButton>
            <PixelButton
              kind="danger"
              onClick={() => void resolve(selected.id, rejectApproval)}
              disabled={pendingActionId === selected.id}
              aria-label={`Reject ${selected.context?.capabilityName ?? "approval"} ${selected.id}`}
            >
              <ButtonMark tone="fail" />
              Reject
            </PixelButton>
          </div>
        )}
      </section>
    </main>
  );
}

function ArtifactToAct({ artifact }: { artifact: NonNullable<NonNullable<ApprovalData["context"]>["artifact"]> }) {
  const mismatch = artifact.hashMatchesSnapshot === false;
  return (
    <section className={s.block} aria-label="What it will act on">
      <span className={px.tab}>What it will act on</span>
      <div className={cx(px.parchment, s.strip)}>
        <span>
          {artifact.type} · {artifact.size} bytes
        </span>
        <span className={s.hash} title={artifact.hash}>
          hash {artifact.hash.slice(0, 16)}…
        </span>
        {artifact.hashMatchesSnapshot === null ? (
          <StatusMark state="none" tone="neutral" surface="parchment">
            no hash pinned in the proposal
          </StatusMark>
        ) : mismatch ? (
          <span role="alert">
            <StatusMark state="mismatch" tone="fail" surface="parchment">
              This content no longer matches what was proposed. Approving will fail.
            </StatusMark>
          </span>
        ) : (
          <StatusMark state="match" tone="done" surface="parchment">
            content matches the proposal
          </StatusMark>
        )}
      </div>
      {artifact.preview === null ? (
        <p className={px.dim}>No inline content to preview.</p>
      ) : (
        <>
          {mismatch && <p className={s.error}>Untrusted preview: it is not what was proposed.</p>}
          {/* Model output: rendered as text by React, never as HTML. */}
          <pre data-testid="approval-preview" className={cx(px.vellum, s.pre, mismatch && s.untrusted)}>
            {artifact.preview}
          </pre>
          {artifact.truncated && (
            <p className={px.detail}>
              (preview truncated){" "}
              <Link href={`/artifacts/${artifact.id}?full=1`} className={s.link}>
                Read the full content
              </Link>
            </p>
          )}
        </>
      )}
    </section>
  );
}
