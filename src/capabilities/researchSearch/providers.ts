/**
 * The external sources behind `research.search`: encyclopedic and scholarly, all
 * credential-free. No account, no key, no spend — verified live 2026-09-16.
 *
 * HONESTY. These return what a public index actually says, so results are `external`
 * evidence — unlike the local corpus, which is material we already held. They are NOT
 * general web search: nothing here crawls the open web, and a deliverable built on them
 * must say encyclopedic/scholarly, never "web research".
 *
 * WHAT IS DELIBERATELY ABSENT.
 * - OpenAlex: its anonymous quota is ~100 searches a day (10 credits of 1000 each), which
 *   a research agent would exhaust in an afternoon; raising it needs a signup. Crossref
 *   covers the same ground at 1-3 requests a second with no daily ceiling.
 * - PubMed: its abstracts live only in an XML payload of mixed content (`<AbstractText>`
 *   interleaved with markup, ~200 KB for five records), which needs a real XML parser.
 *   Adding one is a dependency decision that has not been taken (D9), so biomedical search
 *   is recorded as missing rather than half-built.
 *
 * UNTRUSTED. Everything returned here is third-party text. It is evidence to be cited,
 * never instruction: the Context Compiler fences it like any other tool result.
 */

/** One result, identical in shape whichever source produced it. */
export type ResearchResult = {
  sourceId: string;
  title: string;
  url: string;
  /** ISO date, or null when the source does not give one. */
  publishedAt: string | null;
  snippet: string | null;
  authors: string[];
  container: string | null;
  provider: ResearchProvider;
  retrievedAt: string;
};

export type ResearchProvider = "wikipedia" | "crossref" | "arxiv";
export const RESEARCH_PROVIDERS: ResearchProvider[] = ["wikipedia", "crossref", "arxiv"];

/** Why a search produced nothing, so "found nothing" is never confused with "failed". */
export class ResearchUnavailableError extends Error {
  constructor(
    readonly provider: ResearchProvider,
    message: string
  ) {
    super(message);
    this.name = "ResearchUnavailableError";
  }
}

const MAX_RESULTS = 5;
const SNIPPET_CHARS: Record<ResearchProvider, number> = { wikipedia: 1_200, crossref: 1_000, arxiv: 1_500 };
const TIMEOUT_MS = 15_000;

/**
 * The client identity sent to every source. Wikimedia REQUIRES one and answers 403 without
 * it; Crossref reads it to decide which request pool you are in. Deliberately an
 * application identity, never a person's address (D8) — it is published to third parties.
 */
export function researchUserAgent(env: NodeJS.ProcessEnv = process.env): string {
  return env.RESEARCH_USER_AGENT ?? "CommandCentreResearch/1.0 (AI Command Centre; research client)";
}

async function getText(url: string, provider: ResearchProvider, accept: string): Promise<{ status: number; body: string; contentType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": researchUserAgent(), accept },
      redirect: "follow",
    });
    return { status: response.status, body: await response.text(), contentType: response.headers.get("content-type") ?? "" };
  } catch (error) {
    throw new ResearchUnavailableError(provider, `${provider}: the request failed (${error instanceof Error ? error.message : String(error)}).`);
  } finally {
    clearTimeout(timer);
  }
}

/** Parses a body the source promised would be JSON — a non-JSON body is a failure, never an empty result. */
function asJson(raw: { status: number; body: string }, provider: ResearchProvider): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw.body);
    if (parsed === null || typeof parsed !== "object") throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new ResearchUnavailableError(provider, `${provider}: replied ${raw.status} with a body that is not JSON.`);
  }
}

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Cuts at a sentence boundary where there is one nearby, never mid-word. */
export function truncate(text: string, limit: number): string {
  const clean = collapse(text);
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit);
  const sentenceEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  const wordEnd = cut.lastIndexOf(" ");
  const end = sentenceEnd > limit * 0.6 ? sentenceEnd + 1 : wordEnd > 0 ? wordEnd : limit;
  return `${cut.slice(0, end).trim()}…`;
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === "string" ? value : "");

// ---------------------------------------------------------------------------
// Wikipedia — encyclopedic
// ---------------------------------------------------------------------------

/**
 * One call returns rank, plain-text intro and canonical URL together (`generator=search`
 * with `extracts`), so no follow-up is needed. Two traps live here: pages arrive in
 * arbitrary order and must be sorted by `index` to recover relevance, and with no hits the
 * `query` key is absent entirely rather than empty.
 */
async function searchWikipedia(query: string, retrievedAt: string): Promise<ResearchResult[]> {
  const url =
    "https://en.wikipedia.org/w/api.php?action=query&generator=search&prop=extracts|info&exintro=1&explaintext=1&exlimit=max&inprop=url&format=json&formatversion=2" +
    `&gsrsearch=${encodeURIComponent(query)}&gsrlimit=${MAX_RESULTS}`;
  const raw = await getText(url, "wikipedia", "application/json");
  if (raw.status === 403) throw new ResearchUnavailableError("wikipedia", "wikipedia: refused the client identity (403).");
  const body = asJson(raw, "wikipedia");
  // The Action API reports its own errors inside a 200.
  if ("error" in body) throw new ResearchUnavailableError("wikipedia", `wikipedia: ${text(record(body.error).info) || "rejected the request"}.`);

  const pages = list(record(body.query).pages).map(record);
  return pages
    .sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0))
    .slice(0, MAX_RESULTS)
    .map((page) => ({
      sourceId: String(page.pageid ?? page.title ?? ""),
      title: text(page.title),
      url: text(page.fullurl) || text(page.canonicalurl),
      // A last-edited time, which is not a publication date — named honestly in the UI.
      publishedAt: text(page.touched) || null,
      snippet: page.extract ? truncate(text(page.extract), SNIPPET_CHARS.wikipedia) : null,
      authors: [],
      container: "Wikipedia",
      provider: "wikipedia" as const,
      retrievedAt,
    }));
}

// ---------------------------------------------------------------------------
// Crossref — scholarly bibliographic
// ---------------------------------------------------------------------------

/** Crossref abstracts arrive as JATS XML when they arrive at all; this strips the few tags it uses. */
function stripJats(value: string): string {
  return collapse(
    value
      .replace(/<\/?jats:[^>]*>/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
  );
}

function crossrefDate(issued: Record<string, unknown>): string | null {
  const parts = list(list(issued["date-parts"])[0]).map((n) => Number(n));
  if (parts.length === 0 || !Number.isFinite(parts[0])) return null;
  const [year, month, day] = parts;
  return [String(year), month ? String(month).padStart(2, "0") : null, day ? String(day).padStart(2, "0") : null].filter(Boolean).join("-");
}

async function searchCrossref(query: string, retrievedAt: string): Promise<ResearchResult[]> {
  const url =
    "https://api.crossref.org/works?select=DOI,title,abstract,author,issued,container-title,URL,type,publisher" +
    `&rows=${MAX_RESULTS}&query.bibliographic=${encodeURIComponent(query)}`;
  const raw = await getText(url, "crossref", "application/json");
  // A bad identifier answers 404 in PLAIN TEXT, so the status must be read before the body.
  if (raw.status === 404) return [];
  if (raw.status !== 200) throw new ResearchUnavailableError("crossref", `crossref: replied ${raw.status}.`);

  const message = record(asJson(raw, "crossref").message);
  return list(message.items)
    .map(record)
    .slice(0, MAX_RESULTS)
    .map((item) => ({
      sourceId: text(item.DOI),
      title: collapse(text(list(item.title)[0])),
      url: text(item.URL),
      publishedAt: crossrefDate(record(item.issued)),
      snippet: item.abstract ? truncate(stripJats(text(item.abstract)), SNIPPET_CHARS.crossref) : null,
      // An author is either a person (given + family) or an organization (name).
      authors: list(item.author)
        .map(record)
        .map((author) => collapse(`${text(author.given)} ${text(author.family)}`) || text(author.name))
        .filter((name) => name !== ""),
      container: collapse(text(list(item["container-title"])[0])) || null,
      provider: "crossref" as const,
      retrievedAt,
    }));
}

// ---------------------------------------------------------------------------
// arXiv — preprints
// ---------------------------------------------------------------------------

const tagOf = (entry: string, tag: string): string | null => new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(entry)?.[1]?.trim() ?? null;

/**
 * arXiv answers Atom. Rather than adding an XML parser for one source, this reads the few
 * fields it needs from each `<entry>` block — a deliberate, bounded shortcut, kept honest
 * by a test over a captured real response.
 * ponytail: regex over a known Atom shape; swap for a parser if a second XML source lands.
 */
export function parseArxivAtom(xml: string, retrievedAt: string): ResearchResult[] {
  // A malformed query returns an entry titled "Error" rather than an HTTP error alone.
  if (/<title>\s*Error\s*<\/title>/.test(xml)) {
    throw new ResearchUnavailableError("arxiv", `arxiv: ${tagOf(xml, "summary") ?? "rejected the query"}.`);
  }
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
  return entries.slice(0, MAX_RESULTS).map((entry) => {
    const id = tagOf(entry, "id") ?? "";
    const canonical = id.replace(/^http:/, "https:").replace(/v\d+$/, "");
    const summary = tagOf(entry, "summary");
    return {
      sourceId: canonical.split("/abs/")[1] ?? canonical,
      title: collapse(tagOf(entry, "title") ?? ""),
      url: canonical,
      // `published` is the first version's date; `updated` would be the latest revision.
      publishedAt: tagOf(entry, "published"),
      snippet: summary ? truncate(summary, SNIPPET_CHARS.arxiv) : null,
      authors: [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((m) => collapse(m[1] ?? "")).filter((n) => n !== ""),
      container: tagOf(entry, "arxiv:journal_ref"),
      provider: "arxiv" as const,
      retrievedAt,
    };
  });
}

/**
 * arXiv asks for no more than one request every three seconds. One process serves this
 * runtime, so a module-level timestamp is the whole mechanism.
 * ponytail: single-process pacing; a second process would need a shared gate.
 */
let lastArxivCall = 0;
const ARXIV_MIN_INTERVAL_MS = 3_000;

async function searchArxiv(query: string, retrievedAt: string): Promise<ResearchResult[]> {
  const wait = ARXIV_MIN_INTERVAL_MS - (Date.now() - lastArxivCall);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastArxivCall = Date.now();

  // https, not http: the plain-http host answers with an empty body unless redirected.
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${MAX_RESULTS}&sortBy=relevance&sortOrder=descending`;
  const raw = await getText(url, "arxiv", "application/atom+xml");
  if (raw.status !== 200 && !/<entry>/.test(raw.body)) throw new ResearchUnavailableError("arxiv", `arxiv: replied ${raw.status}.`);
  return parseArxivAtom(raw.body, retrievedAt);
}

// ---------------------------------------------------------------------------

const SEARCHES: Record<ResearchProvider, (query: string, retrievedAt: string) => Promise<ResearchResult[]>> = {
  wikipedia: searchWikipedia,
  crossref: searchCrossref,
  arxiv: searchArxiv,
};

/** Searches one source. Returns `[]` for "nothing found"; throws only when the source failed. */
export async function searchProvider(provider: ResearchProvider, query: string, now: Date = new Date()): Promise<ResearchResult[]> {
  const search = SEARCHES[provider];
  if (!search) throw new ResearchUnavailableError(provider, `"${provider}" is not a configured research source.`);
  return await search(query, now.toISOString());
}
