/**
 * `research.search` reads public indexes honestly: it returns what a source actually said,
 * distinguishes "found nothing" from "the source failed", and never invents a result.
 *
 * Every response below is the real shape those APIs return (captured 2026-09-16), including
 * the awkward parts: Wikipedia's pages arrive out of order and vanish entirely when there
 * are no hits, Crossref wraps titles in arrays and answers 404 in plain text, and arXiv
 * reports a bad query as an Atom entry titled "Error" rather than as an HTTP failure.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResearchUnavailableError, parseArxivAtom, researchUserAgent, searchProvider, truncate } from "../../src/capabilities/researchSearch/providers.js";

function respond(body: string, init: { status?: number; contentType?: string } = {}) {
  const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
    Promise.resolve({
      status: init.status ?? 200,
      text: async () => Promise.resolve(body),
      headers: { get: () => init.contentType ?? "application/json" },
    } as unknown as Response)
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("wikipedia", () => {
  const page = (index: number, title: string) => ({
    index,
    pageid: 100 + index,
    title,
    fullurl: `https://en.wikipedia.org/wiki/${title}`,
    touched: "2026-09-10T12:48:51Z",
    extract: `${title} is a thing.`,
  });

  it("returns results in relevance order, not the order they arrive in", async () => {
    respond(JSON.stringify({ query: { pages: [page(3, "Third"), page(1, "First"), page(2, "Second")] } }));
    const results = await searchProvider("wikipedia", "machine learning");
    expect(results.map((r) => r.title)).toEqual(["First", "Second", "Third"]);
    expect(results[0]).toMatchObject({ url: "https://en.wikipedia.org/wiki/First", container: "Wikipedia", provider: "wikipedia" });
    expect(results[0]!.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("sends an application identity, which the source requires and refuses requests without", async () => {
    const fetchMock = respond(JSON.stringify({ query: { pages: [] } }));
    await searchProvider("wikipedia", "x");
    const headers = (fetchMock.mock.calls[0]![1] as unknown as { headers: Record<string, string> }).headers;
    expect(headers["user-agent"]).toBe(researchUserAgent());
    expect(headers["user-agent"]).not.toMatch(/@/); // an application, never a person's address
  });

  it("reads no hits as no results — the whole query key is absent, not empty", async () => {
    respond(JSON.stringify({ batchcomplete: true }));
    await expect(searchProvider("wikipedia", "zzzzq")).resolves.toEqual([]);
  });

  it("fails loudly when the source refuses or errors, rather than reporting an empty topic", async () => {
    respond("Please set a user-agent", { status: 403 });
    await expect(searchProvider("wikipedia", "x")).rejects.toBeInstanceOf(ResearchUnavailableError);
    respond(JSON.stringify({ error: { code: "missingparam", info: 'The "srsearch" parameter must be set.' } }));
    await expect(searchProvider("wikipedia", "x")).rejects.toThrow(/srsearch/);
  });
});

describe("crossref", () => {
  it("reads titles out of their array, both author shapes, and a JATS abstract", async () => {
    respond(
      JSON.stringify({
        message: {
          items: [
            {
              DOI: "10.1007/978-3-031-84300-6_13",
              title: ["Is Attention All You Need?"],
              URL: "https://doi.org/10.1007/978-3-031-84300-6_13",
              issued: { "date-parts": [[2025, 9]] },
              "container-title": ["From Human Attention to Computational Attention"],
              abstract: "<jats:p>This study discusses&nbsp;the parameters.</jats:p>",
              author: [{ given: "Patrick", family: "Mineault" }, { name: "ADHD Working Group of the Psychiatric Genomics Consortium" }],
            },
          ],
        },
      })
    );
    const [result] = await searchProvider("crossref", "attention");
    expect(result).toMatchObject({
      sourceId: "10.1007/978-3-031-84300-6_13",
      title: "Is Attention All You Need?",
      publishedAt: "2025-09",
      snippet: "This study discusses the parameters.",
      container: "From Human Attention to Computational Attention",
    });
    expect(result!.authors).toEqual(["Patrick Mineault", "ADHD Working Group of the Psychiatric Genomics Consortium"]);
  });

  it("treats an unknown identifier as no results, though the body is not JSON", async () => {
    respond("Resource not found.", { status: 404, contentType: "text/plain" });
    await expect(searchProvider("crossref", "nonsense")).resolves.toEqual([]);
  });

  it("fails when the source errors", async () => {
    respond("upstream exploded", { status: 503, contentType: "text/plain" });
    await expect(searchProvider("crossref", "x")).rejects.toBeInstanceOf(ResearchUnavailableError);
  });
});

describe("arxiv", () => {
  const atom = `<feed>
    <opensearch:totalResults>1</opensearch:totalResults>
    <entry>
      <id>http://arxiv.org/abs/1706.03762v7</id>
      <title>Attention Is All
  You Need</title>
      <published>2017-06-12T17:57:34Z</published>
      <summary>The dominant sequence transduction models
  are based on complex recurrent networks.</summary>
      <author><name>Ashish Vaswani</name></author>
      <author><name>Noam Shazeer</name></author>
      <arxiv:journal_ref>Phys.Lett. B716 (2012) 1-29</arxiv:journal_ref>
    </entry>
  </feed>`;

  it("canonicalises the id, collapses the source's line wrapping and keeps every author", () => {
    const [result] = parseArxivAtom(atom, "2026-09-16T00:00:00.000Z");
    expect(result).toMatchObject({
      sourceId: "1706.03762",
      url: "https://arxiv.org/abs/1706.03762",
      title: "Attention Is All You Need",
      publishedAt: "2017-06-12T17:57:34Z",
      snippet: "The dominant sequence transduction models are based on complex recurrent networks.",
      container: "Phys.Lett. B716 (2012) 1-29",
    });
    expect(result!.authors).toEqual(["Ashish Vaswani", "Noam Shazeer"]);
  });

  it("reads an empty feed as no results and a rejected query as a failure", () => {
    expect(parseArxivAtom("<feed><opensearch:totalResults>0</opensearch:totalResults></feed>", "t")).toEqual([]);
    expect(() => parseArxivAtom('<feed><entry><title>Error</title><summary>start must be an integer</summary></entry></feed>', "t")).toThrow(
      /start must be an integer/
    );
  });

  it("searches over https, because the plain-http host answers with an empty body", async () => {
    const fetchMock = respond(atom, { contentType: "application/atom+xml" });
    const results = await searchProvider("arxiv", "attention");
    expect(results).toHaveLength(1);
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/^https:\/\/export\.arxiv\.org/);
  });
});

describe("bounded extraction", () => {
  it("cuts long text at a sentence boundary and never mid-word", () => {
    const text = `${"First sentence here. ".repeat(20)}tail`;
    const cut = truncate(text, 100);
    expect(cut.length).toBeLessThanOrEqual(101);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut).not.toMatch(/\bFirs…$/);
  });

  it("leaves short text exactly as it was", () => {
    expect(truncate("  already  short  ", 100)).toBe("already short");
  });
});
