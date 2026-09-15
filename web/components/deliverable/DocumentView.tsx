import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { basisLine, type Deliverable } from "../../lib/deliverable";
import { StatusMark, cx, px } from "../pixel/Pixel";
import s from "./deliverable.module.css";

/**
 * Markdown (GFM: tables, lists, emphasis, code) rendered as React elements only.
 * Model output: raw HTML is skipped, images are not loaded, and react-markdown's
 * default URL transform drops `javascript:` and other unsafe links.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className={s.markdown}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        disallowedElements={["img"]}
        unwrapDisallowed
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

const COMPLETION_TONE: Record<string, "done" | "wait" | "fail" | "neutral"> = {
  complete: "done",
  incomplete: "neutral",
  escalated: "wait",
};

/** The Document view: a deliverable as a readable document on dark vellum. */
export function DocumentView({ doc, fallbackTitle, untrusted }: { doc: Deliverable; fallbackTitle: string | null; untrusted: boolean }) {
  return (
    <article className={cx(px.vellum, s.document, untrusted && s.untrusted)} data-testid="deliverable-document">
      <header className={s.header}>
        <h2 className={s.title}>{doc.title ?? fallbackTitle ?? "Untitled document"}</h2>
        {doc.completion && (
          <StatusMark state={doc.completion.status} tone={COMPLETION_TONE[doc.completion.status] ?? "neutral"}>
            {doc.completion.status}
            {doc.completion.reason ? ` · ${doc.completion.reason}` : ""}
          </StatusMark>
        )}
      </header>
      {doc.basis && (
        <p className={s.basis} data-testid="evidence-basis">
          {basisLine(doc.basis)}
        </p>
      )}
      {doc.summary && (
        <section aria-label="Executive summary" className={s.section}>
          <h3 className={s.sectionTitle}>Executive summary</h3>
          <Markdown text={doc.summary} />
        </section>
      )}
      <section aria-label="Body" className={s.section}>
        <Markdown text={doc.body} />
      </section>
      {doc.findings.length > 0 && (
        <section aria-label="Findings" className={s.section}>
          <h3 className={s.sectionTitle}>Findings</h3>
          <ul>
            {doc.findings.map((f, i) => (
              <li key={i}>
                <Markdown text={f} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {doc.recommendations.length > 0 && (
        <section aria-label="Recommendations" className={s.section}>
          <h3 className={s.sectionTitle}>Recommendations</h3>
          <ol>
            {doc.recommendations.map((r, i) => (
              <li key={i}>
                <Markdown text={r} />
              </li>
            ))}
          </ol>
        </section>
      )}
      {doc.sources.length > 0 && (
        <section aria-label="Sources" className={s.section}>
          <h3 className={s.sectionTitle}>Sources</h3>
          <ol className={s.sources}>
            {doc.sources.map((src, i) => (
              <li key={i}>
                {src.label}
                {src.origin && <span className={px.dim}> · {src.origin}</span>}
                {src.ref && <span className={px.dim}> · {src.ref}</span>}
                {src.artifactId && (
                  <>
                    {" · "}
                    <a href={`/artifacts/${src.artifactId}`}>artifact</a>
                  </>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
    </article>
  );
}
