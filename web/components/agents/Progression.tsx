"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { getAgentProgression, type AgentDetail, type AgentProgression } from "../../lib/api";
import { errorText, formatTime } from "../../lib/keep";
import { useRefetchOnEvents } from "../live";
import { PixelButton, Skeleton, StateNotice, cx, px } from "../pixel/Pixel";
import s from "./progression.module.css";
import { useKeeper } from "../keeper/Keeper";

const BAR_SEGMENTS = 10;

/** Plain words for each award rule (`src/projections/progressionRules.ts`). */
function awardWords(a: AgentProgression["awards"][number]): string {
  switch (a.rule) {
    case "task":
      return "Finished a task";
    case "research":
      return "The task was real research";
    case "capability":
      return `Used ${String(a.evidence.capability ?? "a capability")}`;
    case "workflow":
      return "Its workflow completed";
    case "mission":
      return "Its mission (goal) completed";
    case "validated_artifact":
      return "Deliverable backed by verified evidence";
    case "quality_verdict":
      return `Operator judged a deliverable ${String(a.evidence.verdict ?? "").toLowerCase()}`;
    default:
      return a.rule;
  }
}

/**
 * Progress (R2): the persistent agent's level, XP, measured work, specialisation, achievements and
 * reputation signals — one history for every version of its name. An interpretation of recorded
 * work that grants nothing: keys (Grants) stay the only authority.
 */
export function Progression({ agent, performance }: { agent: AgentDetail["agent"]; performance: AgentDetail["performanceAcrossVersions"] }) {
  const [p, setP] = useState<AgentProgression | null>(null);
  const [error, setError] = useState<string | null>(null);
  const keeper = useKeeper();
  const why = (intent: string, label: string) => (
    <button type="button" className={s.why} onClick={() => keeper.askAbout(intent, `agent:${agent.id}`)}>
      {label}
    </button>
  );
  const load = useCallback(async () => {
    try {
      setP(await getAgentProgression(agent.name));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [agent.name]);
  useEffect(() => {
    setP(null);
    void load();
  }, [load]);
  useRefetchOnEvents(load);

  if (!p) {
    return (
      <section className={cx(px.parchment, s.card)} aria-label="Progress">
        {error ? (
          <StateNotice role="alert" message="Couldn't load this agent's progress." detail={error} action={<PixelButton onClick={() => void load()}>Retry</PixelButton>} />
        ) : (
          <p>
            Loading progress <Skeleton />
          </p>
        )}
      </section>
    );
  }

  const span = p.nextLevelXp - p.levelStartXp;
  const filled = Math.min(BAR_SEGMENTS, Math.floor(((p.xp - p.levelStartXp) / span) * BAR_SEGMENTS));
  const verdictWords = Object.entries(p.reputation.verdicts)
    .filter(([, n]) => n > 0)
    .map(([v, n]) => `${n} ${v.toLowerCase()}`)
    .join(", ");

  return (
    <section className={cx(px.parchment, s.card)} aria-label="Progress" data-testid="agent-progress">
      <div className={s.levelRow}>
        <span className={s.level} aria-label={`Level ${p.level}`}>
          Lv {p.level}
        </span>
        <div className={s.grow}>
          <div className={s.bar} role="img" aria-label={`${p.xp - p.levelStartXp} of ${span} XP toward level ${p.level + 1}`}>
            {Array.from({ length: BAR_SEGMENTS }, (_, i) => (
              <span key={i} className={cx(s.segment, i < filled && s.filled)} />
            ))}
          </div>
          <div className={s.xp}>
            {p.xp.toLocaleString("en-GB")} XP · {(p.nextLevelXp - p.xp).toLocaleString("en-GB")} to level {p.level + 1}
          </div>
        </div>
      </div>

      <dl className={cx(px.kv, s.facts)}>
        <dt>work</dt>
        <dd data-testid="progress-performance">
          {performance && performance.samples > 0
            ? `${performance.successes} of ${performance.samples} measured runs succeeded (all versions counted)`
            : "no measured runs yet"}
        </dd>
        <dt>speciality</dt>
        <dd data-testid="progress-specialisation">
          {p.specialisation
            ? `${p.specialisation.domain} (${p.specialisation.runs} successful runs)`
            : `none yet — needs ${p.specialisationMinRuns} successful runs mostly in one kind of work`}
        </dd>
        <dt>reputation</dt>
        <dd data-testid="progress-reputation">
          {p.reputation.verdictCount === 0 && p.reputation.independentEndorsers.length === 0
            ? "not enough evidence yet: no operator verdicts or endorsements"
            : [
                p.reputation.verdictCount > 0 &&
                  `operator verdicts: ${verdictWords}${p.reputation.enoughVerdicts ? "" : ` (a reputation needs ${p.reputation.minVerdicts})`}`,
                p.reputation.independentEndorsers.length > 0 && `endorsed by ${p.reputation.independentEndorsers.join(", ")}`,
                p.reputation.mutualEndorsements > 0 && `${p.reputation.mutualEndorsements} mutual endorsement${p.reputation.mutualEndorsements === 1 ? "" : "s"} not counted`,
              ]
                .filter(Boolean)
                .join(" · ")}
        </dd>
      </dl>

      {p.achievements.length > 0 ? (
        <ul className={s.badges} aria-label="Achievements">
          {p.achievements.map((a) => (
            <li key={a.achievement} className={s.badge} title={`earned ${formatTime(a.earnedAt)}`}>
              <span className={s.star} aria-hidden />
              {a.label}
              {a.domain ? `: ${a.domain}` : ""}
            </li>
          ))}
        </ul>
      ) : (
        <p className={s.none}>No achievements yet.</p>
      )}

      <div className={s.whys} role="group" aria-label="Ask the Keeper why">
        {why("level", "Why this level?")}
        {why("xp_ledger", "How was the XP earned?")}
        {why("achievements", "Why these achievements?")}
        {why("specialisation", "Why this speciality?")}
      </div>

      <details className={s.ledger}>
        <summary>How this XP was earned ({p.awards.length})</summary>
        {p.awards.length === 0 ? (
          <p>Nothing yet: XP comes only from finished, successful work and the operator&apos;s verdicts.</p>
        ) : (
          <ol className={s.awards} data-testid="progress-awards">
            {p.awards.map((a) => (
              <li key={a.awardKey}>
                <span className={s.plus}>+{a.xp}</span>
                <span className={s.grow}>
                  {awardWords(a)}
                  {a.artifactId && (
                    <>
                      {" · "}
                      <Link href={`/artifacts/${a.artifactId}`}>deliverable</Link>
                    </>
                  )}
                  {a.workflowRunId && (
                    <>
                      {" · "}
                      <Link href={`/workflows/${a.workflowRunId}`}>workflow</Link>
                    </>
                  )}
                </span>
                <span className={s.when}>{formatTime(a.earnedAt, true)}</span>
              </li>
            ))}
          </ol>
        )}
        <p className={s.note}>
          A completed task, its workflow and its mission each count, so one finished step can earn several awards. Levels and
          XP grant no keys: what {agent.name} may do is set only by its Grants.
        </p>
      </details>
    </section>
  );
}
