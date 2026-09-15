"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  askKeeper,
  getArtifact,
  getWorkflowRun,
  keeperExplain,
  keeperGuide,
  type KeeperExplanation,
  type KeeperGuideCard,
} from "../../lib/api";
import { parseDeliverable, type Deliverable } from "../../lib/deliverable";
import { errorText } from "../../lib/keep";
import { storeKeeperProposal } from "../../lib/keeperProposal";
import { DocumentView, Markdown } from "../deliverable/DocumentView";
import { PixelButton, Skeleton, StateNotice, StatusMark, cx, px } from "../pixel/Pixel";
import k from "./keeper.module.css";

type KeeperState = { open: boolean; setOpen: (open: boolean) => void };
const KeeperContext = createContext<KeeperState>({ open: false, setOpen: () => undefined });

export function KeeperProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <KeeperContext.Provider value={{ open, setOpen }}>{children}</KeeperContext.Provider>;
}

export function useKeeper(): KeeperState {
  return useContext(KeeperContext);
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** What the Keeper is asked about on this page: the run, agent or artifact on screen, else the whole system. Client state only. */
export function subjectForPath(path: string): string {
  const match = (prefix: string) => new RegExp(`^/${prefix}/(${UUID})(?:$|[/?#])`, "i").exec(path)?.[1];
  const run = match("workflows");
  if (run) return `workflow_run:${run}`;
  const agent = match("agents");
  if (agent) return `agent:${agent}`;
  const artifact = match("artifacts");
  if (artifact) return `artifact:${artifact}`;
  return "system";
}

/** The Keeper's door: a small persistent button; the Keeper also stands in the keep's entrance on the Overview. */
export function KeeperDock() {
  const { open, setOpen } = useKeeper();
  if (open) return null;
  return (
    <button type="button" className={k.dock} onClick={() => setOpen(true)} aria-label="Ask the Keeper">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/world/strips/rogue-idle-2x-outlined.png" width={34} height={34} alt="" className="px" />
      <span>Keeper</span>
    </button>
  );
}

type ThinkState =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "working"; workflowRunId: string; status: string }
  | { phase: "answered"; workflowRunId: string; artifactId: string; doc: Deliverable; proposal: Proposal | null }
  | { phase: "failed"; workflowRunId: string | null; error: string };

type Proposal = { kind: "agent" | "workflow"; href: string; label: string };

const POLL_MS = 2_000;

/**
 * The Keeper's panel (V1.1). Explain (this page's subject) and the guide search are
 * deterministic API reads that use no model. Think is the only model use: an explicit
 * press that starts a governed Goal, whose answer is shown as the document it produced.
 * A proposal only opens a pre-filled builder; nothing is saved from here.
 */
export function KeeperPanel() {
  const { open, setOpen } = useKeeper();
  const path = usePathname() ?? "/";
  const subject = subjectForPath(path);

  const [explanation, setExplanation] = useState<KeeperExplanation | null>(null);
  const [explainError, setExplainError] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [cards, setCards] = useState<KeeperGuideCard[] | null>(null);
  const [guideError, setGuideError] = useState<string | null>(null);
  const [think, setThink] = useState<ThinkState>({ phase: "idle" });
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const explainHere = useCallback(async () => {
    setExplainError(null);
    try {
      setExplanation(await keeperExplain(subject));
    } catch (err) {
      setExplainError(errorText(err));
    }
  }, [subject]);

  useEffect(() => {
    if (open) void explainHere();
  }, [open, explainHere]);

  useEffect(() => () => {
    if (poll.current) clearInterval(poll.current);
  }, []);

  async function lookUp(e: FormEvent) {
    e.preventDefault();
    setGuideError(null);
    try {
      setCards(await keeperGuide(question.trim()));
    } catch (err) {
      setGuideError(errorText(err));
    }
  }

  async function readAnswer(workflowRunId: string): Promise<boolean> {
    const run = await getWorkflowRun(workflowRunId);
    const status = run.workflowRun.status;
    if (status !== "completed" && status !== "failed") {
      setThink({ phase: "working", workflowRunId, status });
      return false;
    }
    if (status === "failed") {
      setThink({ phase: "failed", workflowRunId, error: "The Keeper's run failed. Open it to see why." });
      return true;
    }
    const ids = run.steps.flatMap((s) => s.run?.invocations.flatMap((i) => i.artifactIds) ?? []);
    for (const id of ids.reverse()) {
      const a = await getArtifact(id, true);
      if (a.artifact.type !== "keeper_answer") continue;
      const doc = parseDeliverable("keeper_answer", a.artifact.content);
      if (!doc) break;
      setThink({ phase: "answered", workflowRunId, artifactId: id, doc, proposal: proposalFrom(a.artifact.content ?? null) });
      return true;
    }
    setThink({ phase: "failed", workflowRunId, error: "The run finished without a readable answer." });
    return true;
  }

  async function startThinking() {
    if (poll.current) clearInterval(poll.current);
    setThink({ phase: "starting" });
    try {
      const { workflowRunId } = await askKeeper(question.trim(), subject);
      setThink({ phase: "working", workflowRunId, status: "in_progress" });
      poll.current = setInterval(() => {
        void readAnswer(workflowRunId)
          .then((done) => {
            if (done && poll.current) clearInterval(poll.current);
          })
          .catch((err) => setThink({ phase: "failed", workflowRunId, error: errorText(err) }));
      }, POLL_MS);
    } catch (err) {
      setThink({ phase: "failed", workflowRunId: null, error: errorText(err) });
    }
  }

  if (!open) return null;

  return (
    <aside className={cx(px.board, k.panel)} aria-label="The Keeper">
      <header className={k.header}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/world/strips/rogue-idle-2x-outlined.png" width={68} height={68} alt="" className="px" />
        <div>
          <h2 className={k.title}>The Keeper</h2>
          <p className={px.detail}>Explanations and look-ups read the keep&apos;s records and use no model.</p>
        </div>
        <PixelButton onClick={() => setOpen(false)} aria-label="Close the Keeper">
          Close
        </PixelButton>
      </header>

      <section className={k.section} aria-label="Here">
        <span className={px.tab}>{subject === "system" ? "The keep" : "This page"}</span>
        {explainError ? (
          <StateNotice role="alert" message="The Keeper couldn't read this." detail={explainError} action={<PixelButton onClick={() => void explainHere()}>Retry</PixelButton>} />
        ) : !explanation ? (
          <Skeleton label="reading" />
        ) : (
          <div className={cx(px.vellum, k.explain)} data-testid="keeper-explanation">
            <p className={k.headline}>{explanation.headline}</p>
            {explanation.facts.length > 0 && (
              <dl className={px.kv}>
                {explanation.facts.map((f) => (
                  <div key={f.label} style={{ display: "contents" }}>
                    <dt>{f.label}</dt>
                    <dd>{f.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {explanation.reasons.length > 0 && (
              <ul className={k.reasons}>
                {explanation.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            )}
            {explanation.next.length > 0 && (
              <div className={k.links}>
                {explanation.next.map((n) => (
                  <Link key={n.href + n.label} href={n.href} className={k.link} onClick={() => setOpen(false)}>
                    {n.label}
                  </Link>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      <section className={k.section} aria-label="Ask">
        <span className={px.tab}>Ask</span>
        <form onSubmit={lookUp} className={k.ask}>
          <input className={px.input} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="How do I create an agent?" aria-label="Question for the Keeper" />
          <PixelButton type="submit" disabled={!question.trim()}>
            Look it up
          </PixelButton>
        </form>
        {guideError && <p role="alert" className={px.detail}>{guideError}</p>}
        {cards && cards.length === 0 && <p className={px.dim}>No guide card matches. Think can reason about it instead.</p>}
        {cards?.map((c) => (
          <details key={c.slug} className={cx(px.vellum, k.card)} open={c === cards[0]} data-testid="keeper-card">
            <summary className={px.label}>{c.title}</summary>
            <Markdown text={c.body} />
          </details>
        ))}
      </section>

      <section className={k.section} aria-label="Think">
        <span className={px.tab}>Think</span>
        <p className={px.detail}>
          Think asks the Keeper&apos;s agent to reason about your question and this page. It runs as a governed goal on the CHEAP tier and uses
          subscription quota; the Keeper can only read, and proposes rather than changes.
        </p>
        <PixelButton onClick={() => void startThinking()} disabled={!question.trim() || think.phase === "starting" || think.phase === "working"}>
          Think
        </PixelButton>
        {think.phase === "starting" && <Skeleton label="starting" />}
        {think.phase === "working" && (
          <p role="status">
            <StatusMark state="active">Thinking</StatusMark>{" "}
            <Link href={`/workflows/${think.workflowRunId}`} className={k.link}>
              watch the run
            </Link>
          </p>
        )}
        {think.phase === "failed" && (
          <div role="alert">
            <p>{think.error}</p>
            {think.workflowRunId && (
              <Link href={`/workflows/${think.workflowRunId}`} className={k.link}>
                Open the run
              </Link>
            )}
          </div>
        )}
        {think.phase === "answered" && (
          <div className={k.answer} data-testid="keeper-answer">
            <DocumentView doc={think.doc} fallbackTitle={null} untrusted={false} />
            <div className={k.links}>
              <Link href={`/artifacts/${think.artifactId}`} className={k.link}>
                Evidence and raw answer
              </Link>
              {think.proposal && (
                <Link href={think.proposal.href} className={k.link}>
                  {think.proposal.label}
                </Link>
              )}
            </div>
          </div>
        )}
      </section>
    </aside>
  );
}

/** A proposal becomes a pre-filled builder link, held in this tab only. Nothing is written. */
function proposalFrom(content: string | null): Proposal | null {
  try {
    const p = (JSON.parse(content ?? "null") as { proposal?: Record<string, unknown> } | null)?.proposal;
    if (!p || (p.kind !== "agent" && p.kind !== "workflow")) return null;
    if (p.kind === "agent") {
      const key = storeKeeperProposal("agent", {
        name: p.name,
        role: p.role,
        objective: p.objective,
        instructions: p.instructions,
        // Suggested keys only; each asks you first until you choose otherwise in the builder.
        grants: (Array.isArray(p.capabilities) ? p.capabilities : []).map((c) => ({ capabilityName: String(c), permissions: ["READ"], autonomyState: "ALWAYS_APPROVE" })),
      });
      return { kind: "agent", href: `/agents/new?proposal=${key}`, label: `Review the proposed agent "${String(p.name ?? "")}"` };
    }
    const key = storeKeeperProposal("workflow", { name: p.name, steps: p.steps });
    return { kind: "workflow", href: `/workflows/new?proposal=${key}`, label: `Review the proposed workflow "${String(p.name ?? "")}"` };
  } catch {
    return null;
  }
}
