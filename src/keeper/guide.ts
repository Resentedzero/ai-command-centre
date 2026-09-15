/**
 * The Keeper's guide (V1.1): deterministic retrieval over short, curated concept cards
 * in `docs/keeper/*.md` (how to create an agent, run vs invocation, budgets, ...). Term
 * matching only: no model, no index, no write. Cards are read once per process.
 *
 * A card is Markdown whose first line is `# Title` and which may carry a
 * `Keywords: a, b, c` line. `KEEPER_DOCS_ROOT` overrides the directory.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export type GuideCard = { slug: string; title: string; keywords: string[]; body: string };
export type GuideHit = GuideCard & { score: number };

const STOPWORDS = new Set(["the", "and", "for", "how", "what", "why", "does", "can", "with", "this", "that", "are", "you", "your", "from", "into", "when", "who", "which", "its", "not", "use", "get"]);

let cache: Promise<GuideCard[]> | null = null;

export function guideRoot(): string {
  return path.resolve(process.env.KEEPER_DOCS_ROOT ?? path.join(process.cwd(), "docs", "keeper"));
}

export function loadGuideCards(): Promise<GuideCard[]> {
  cache ??= (async () => {
    const root = guideRoot();
    const names = (await readdir(root).catch(() => [])).filter((n) => n.endsWith(".md")).sort();
    const cards: GuideCard[] = [];
    for (const name of names) {
      const text = await readFile(path.join(root, name), "utf8");
      const lines = text.split(/\r?\n/);
      const title = (lines.find((l) => l.startsWith("# ")) ?? name).replace(/^#\s+/, "").trim();
      const keywordLine = lines.find((l) => /^keywords:/i.test(l));
      const keywords = keywordLine ? keywordLine.replace(/^keywords:/i, "").split(",").map((k) => k.trim().toLowerCase()).filter(Boolean) : [];
      const body = lines.filter((l) => l !== keywordLine && !l.startsWith("# ")).join("\n").trim();
      cards.push({ slug: name.replace(/\.md$/, ""), title, keywords, body });
    }
    return cards;
  })();
  return cache;
}

export function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOPWORDS.has(t)))];
}

/** The best-matching cards for a question: title terms weigh 3, keywords 2, body 1. */
export async function searchGuide(query: string, limit = 3): Promise<GuideHit[]> {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const cards = await loadGuideCards();
  return cards
    .map((card) => {
      const title = card.title.toLowerCase();
      const body = card.body.toLowerCase();
      const score = terms.reduce(
        (sum, t) => sum + (title.includes(t) ? 3 : 0) + (card.keywords.some((k) => k.includes(t)) ? 2 : 0) + (body.includes(t) ? 1 : 0),
        0
      );
      return { ...card, score };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
    .slice(0, limit);
}
