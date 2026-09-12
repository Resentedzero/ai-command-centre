/**
 * `npm run dev:api` — the real-run entrypoint (Ruling 5, task-10-brief.md).
 * `server.ts`'s `buildServer` only BUILDS the Fastify app; this is the one
 * place that actually binds a port and calls `.listen()`, so
 * `tests/api/*.test.ts` never need to bind a real network port to exercise
 * the app (`app.inject()`, or a test-local `.listen({port: 0})` for the SSE
 * suite — see that suite's own header).
 *
 * Exercising `POST /goals`'s real LLM step against this locally-running
 * server requires a real `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` in the
 * operator's own `.env` (see `server.ts`'s Ruling 4 note) — this script does
 * not configure or supply one.
 */
import "dotenv/config";
import { buildServer } from "./server.js";

async function main() {
  const app = buildServer();
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "127.0.0.1";
  await app.listen({ port, host });
  // eslint-disable-next-line no-console
  console.log(`AI Command Centre API listening on http://${host}:${port}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
