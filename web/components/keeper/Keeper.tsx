"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  askKeeper,
  keeperExplain,
  keeperExplanation,
  keeperGuide,
  keeperIdentity,
  type KeeperAnswer,
  type KeeperExplanation,
  type KeeperGuideCard,
  type KeeperIdentity,
} from "../../lib/api";
import { AgentSprite } from "../world/World";
import type { Deliverable } from "../../lib/deliverable";
import { errorText } from "../../lib/keep";
import { readRunAnswer } from "../../lib/workAnswer";
import { storeKeeperProposal } from "../../lib/keeperProposal";
import { DocumentView, Markdown } from "../deliverable/DocumentView";
import { PixelButton, Skeleton, StateNotice, StatusMark, cx, px } from "../pixel/Pixel";
import k from "./keeper.module.css";
import { AgentLabel } from "../agents/RoleIcon";

/** A question another screen hands to the Keeper: an intent about a subject ("why is this agent level 4?"). */
export type KeeperRequest = { intent: string; subject: string; nonce: number };

type KeeperState = {
  open: boolean;
  setOpen: (open: boolean) => void;
  identity: KeeperIdentity | null;
  request: KeeperRequest | null;
  askAbout: (intent: string, subject: string) => void;
};
const KeeperContext = createContext<KeeperState>({ open: false, setOpen: () => undefined, identity: null, request: null, askAbout: () => undefined });

export function KeeperProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [identity, setIdentity] = useState<KeeperIdentity | null>(null);
  const [request, setRequest] = useState<KeeperRequest | null>(null);
  useEffect(() => {
    // Presentation only: without it the Keeper is drawn as its default figure and offers no intent choices.
    Promise.resolve()
      .then(() => keeperIdentity())
      .then((found) => setIdentity(found ?? null))
      .catch(() => setIdentity(null));
  }, []);
  const askAbout = useCallback((intent: string, subject: string) => {
    setRequest({ intent, subject, nonce: Date.now() });
    setOpen(true);
  }, []);
  // Closing ends a handed-over question: the next opening explains the page again.
  const close = useCallback((next: boolean) => {
    if (!next) setRequest(null);
    setOpen(next);
  }, []);
  return <KeeperContext.Provider value={{ open, setOpen: close, identity, request, askAbout }}>{children}</KeeperContext.Provider>;
}

/**
 * The Keeper as a character: its persistent agent's chosen appearance through the ordinary appearance
 * system, else its default figure, the Rogue (D22). It stands still: the Keeper does no work here.
 */
export function KeeperFigure({ size }: { size: 34 | 68 }) {
  const { identity } = useKeeper();
  const drawn = identity?.appearance ?? identity?.look;
  if (drawn) {
    return (
      <span className={k.figure} style={{ width: size, height: size }} aria-hidden>
        <span style={{ position: "absolute", left: 0, top: 0, width: 68, height: 68, transform: size === 34 ? "scale(0.5)" : undefined, transformOrigin: "0 0" }}>
          <AgentSprite look={{ character: "knight", appearance: drawn }} pose="idle" footX={34} footY={68} frozen />
        </span>
      </span>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/world/strips/rogue-idle-2x-outlined.png" width={size} height={size} alt="" className="px" />;
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
      <KeeperFigure size={34} />
      <span>Keeper</span>
    </button>
  );
}

type ThinkState =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "working"; workflowRunId: string; status: string }
  | { phase: "answered"; workflowRunId: string; artifactId: string; doc: Deliverable; proposal: Proposal | null; unsupportedNumbers: string[] }
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
  const { open, setOpen, identity, request } = useKeeper();
  const path = usePathname() ?? "/";
  const pageSubject = subjectForPath(path);
  // A question handed over by another screen names its own subject; otherwise the page's.
  const subject = request?.subject ?? pageSubject;
  const subjectKind = subject.split(":")[0]!;
  const choices = (identity?.intents ?? []).filter((i) => i.subjects.includes(subjectKind));

  const [answer, setAnswer] = useState<KeeperAnswer | null>(null);
  const [answering, setAnswering] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);

  const explainIntent = useCallback(async (ask: { question?: string; intent?: string }, about: string) => {
    setAnswering(true);
    setAnswerError(null);
    try {
      setAnswer(await keeperExplanation(about, ask));
    } catch (err) {
      setAnswerError(errorText(err));
    } finally {
      setAnswering(false);
    }
  }, []);

  useEffect(() => {
    if (open && request) void explainIntent({ intent: request.intent }, request.subject);
  }, [open, request, explainIntent]);
  useEffect(() => {
    setAnswer(null);
  }, [pageSubject]);

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
    const answer = await readRunAnswer(workflowRunId, "keeper_answer");
    if (answer.phase === "working") {
      setThink({ phase: "working", workflowRunId, status: answer.status });
      return false;
    }
    if (answer.phase === "failed") setThink({ phase: "failed", workflowRunId, error: "The Keeper's run failed. Open it to see why." });
    else if (answer.phase === "unreadable") setThink({ phase: "failed", workflowRunId, error: "The run finished without a readable answer." });
    else setThink({ phase: "answered", workflowRunId, artifactId: answer.artifactId, doc: answer.doc, proposal: proposalFrom(answer.content), unsupportedNumbers: checksFrom(answer.content) });
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
        <KeeperFigure size={68} />
        <div>
          <h2 className={k.title}>The Keeper</h2>
          <p className={px.detail}>Explanations and look-ups read the keep&apos;s records and use no model.</p>
        </div>
        <PixelButton onClick={() => setOpen(false)} aria-label="Close the Keeper">
          Close
        </PixelButton>
      </header>

      <section className={k.section} aria-label="Explain">
        <span className={px.tab}>Explain</span>
        <p className={px.detail}>Ask why. The Keeper answers only from what the records show, and says what they don&apos;t.</p>
        {choices.length > 0 && (
          <div className={k.choices} role="group" aria-label="Questions the Keeper can answer here">
            {choices.map((c) => (
              <button key={c.id} type="button" className={k.choice} onClick={() => void explainIntent({ intent: c.id }, subject)} disabled={answering}>
                {c.label}
              </button>
            ))}
          </div>
        )}
        <form
          className={k.ask}
          onSubmit={(e) => {
            e.preventDefault();
            void explainIntent({ question: question.trim() }, subject);
          }}
        >
          <input className={px.input} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Why is this agent level 4?" aria-label="Question for the Keeper" />
          <PixelButton type="submit" disabled={!question.trim() || answering}>
            Explain
          </PixelButton>
        </form>
        {answering && <Skeleton label="reading the records" />}
        {answerError && <StateNotice role="alert" message="The Keeper couldn't read the records." detail={answerError} />}
        {answer && !answering && <AnswerView answer={answer} onNavigate={() => setOpen(false)} onAsk={(intent) => void explainIntent({ intent }, subject)} />}
      </section>

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
        <span className={px.tab}>How to</span>
        <form onSubmit={lookUp} className={k.ask}>
          <p className={px.detail}>Look up the guide cards for the question above.</p>
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
          Think asks the Keeper&apos;s agent to put the same records into words for your question. It runs as a governed goal on the CHEAP tier
          and uses subscription quota; the Keeper can only read, and proposes rather than changes.
        </p>
          <p className={px.dim}>
            The Keeper explains; it does not organise work. To make something happen, give the Manager an objective in{" "}
            <Link href="/command" className={k.link}>
              Command
            </Link>
            .
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
            {think.unsupportedNumbers.length > 0 && (
              <p role="alert" className={k.warn}>
                Check this answer: it mentions {think.unsupportedNumbers.join(", ")}, which the records it was given do not contain. Use Explain for the recorded facts.
              </p>
            )}
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

/** Numbers the answer used that its records did not contain (a code-written tripwire on the answer). */
function checksFrom(content: string | null): string[] {
  try {
    const found = (JSON.parse(content ?? "null") as { checks?: { unsupportedNumbers?: unknown } } | null)?.checks?.unsupportedNumbers;
    return Array.isArray(found) ? found.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** One intent answer: what is recorded, what is calculated from it, and what is not known, each with its source and records. */
function AnswerView({ answer, onNavigate, onAsk }: { answer: KeeperAnswer; onNavigate: () => void; onAsk: (intent: string) => void }) {
  const lines = (title: string, testId: string, list: KeeperAnswer["facts"]) =>
    list.length > 0 && (
      <div className={k.block} data-testid={testId}>
        <div className={px.label}>{title}</div>
        <ul className={k.lines}>
          {list.map((l, i) => (
            <li key={i}>
              <span>{l.text}</span>
              <span className={k.source} title="Where this comes from">
                {l.source}
              </span>
              {l.links.map((link) => (
                <Link key={link.href + link.label} href={link.href} className={k.link} onClick={onNavigate}>
                  {link.label}
                </Link>
              ))}
            </li>
          ))}
        </ul>
      </div>
    );
  return (
    <div className={cx(px.vellum, k.explain)} data-testid="keeper-intent-answer">
      <p className={k.headline}>{answer.headline}</p>
      {answer.subject.name && (
        <p className={px.detail}>
          About <AgentLabel name={answer.subject.name} />, across all its versions.
        </p>
      )}
      {lines("Recorded", "keeper-facts", answer.facts)}
      {lines("Calculated from the records", "keeper-derived", answer.derived)}
      {answer.unknown.length > 0 && (
        <div className={k.block} data-testid="keeper-unknown">
          <div className={px.label}>Not known from the records</div>
          <ul className={k.lines}>
            {answer.unknown.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        </div>
      )}
      {answer.intent === null && answer.canExplain.length > 0 && (
        <div className={k.choices} role="group" aria-label="What the Keeper can explain here">
          {answer.canExplain.map((c) => (
            <button key={c.intent} type="button" className={k.choice} onClick={() => onAsk(c.intent)}>
              {c.label}
            </button>
          ))}
        </div>
      )}
      <p className={px.detail}>Read from the records without a model · about {answer.size.estimatedTokens} tokens of context</p>
    </div>
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
