/**
 * The Keeper (V1.1): the operator's guide to the Command Keep.
 *
 *   GET  /keeper/explain?subject=system|<type>:<id>  — deterministic explanation, no model
 *   GET  /keeper/guide?q=<question>                   — deterministic guide cards, no model
 *   POST /keeper/questions {question, subject?}       — Think: a governed Goal, async (202)
 *
 * Seeing or asking the Keeper never runs a model. Only POST /keeper/questions does,
 * and only as an ordinary Goal in the Keeper project, run by the ordinary Keeper Agent
 * (READ Grants only) through the Router, Budget Governor, Policy, stops and events.
 * The Keeper's answers may carry a proposal; nothing here creates or changes a
 * Definition, Grant, Policy or run state on its behalf.
 */
import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "../server.js";
import { explain, parseSubject } from "../../keeper/explain.js";
import { searchGuide } from "../../keeper/guide.js";
import { findKeeperRefs } from "../../definitions/lookupSeed.js";
import { keeperGoalDescription } from "../../capabilities/keeperAnswer/buildInvocationSpecs.js";
import { createWorkflowRelay } from "../liveEventRelay.js";
import { createGoalWithWorkflowRun, driveInBackground } from "./goals.js";

const MAX_QUESTION = 1_000;
const MAX_GUIDE_QUERY = 300;

export function registerKeeperRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get<{ Querystring: { subject?: string } }>("/keeper/explain", async (request, reply) => {
    const subject = parseSubject(request.query.subject);
    if (!subject) return reply.status(400).send({ error: "subject must be system or <workflow_run|goal|approval|agent|artifact|run>:<uuid>" });
    const explanation = await explain(deps.db, subject);
    if (!explanation) return reply.status(404).send({ error: `No ${subject.type} found for id "${subject.id}"` });
    return reply.send(explanation);
  });

  app.get<{ Querystring: { q?: string } }>("/keeper/guide", async (request, reply) => {
    const q = request.query.q;
    if (typeof q !== "string" || q.trim() === "" || q.length > MAX_GUIDE_QUERY) {
      return reply.status(400).send({ error: `q must be 1 to ${MAX_GUIDE_QUERY} characters` });
    }
    const hits = await searchGuide(q, 3);
    return reply.send({ cards: hits.map(({ slug, title, body }) => ({ slug, title, body })) });
  });

  app.post<{ Body: { question?: unknown; subject?: unknown } }>("/keeper/questions", async (request, reply) => {
    const question = request.body?.question;
    if (typeof question !== "string" || question.trim() === "" || question.length > MAX_QUESTION) {
      return reply.status(400).send({ error: `question must be 1 to ${MAX_QUESTION} characters` });
    }
    const subject = parseSubject(request.body?.subject);
    if (!subject) return reply.status(400).send({ error: "subject must be system or <type>:<uuid>" });
    const refs = await deps.db.transaction((tx) => findKeeperRefs(tx));
    if (!refs) return reply.status(503).send({ error: 'The Keeper is not set up yet: run "npm run seed".' });

    const created = await createGoalWithWorkflowRun(deps, {
      title: question.trim(),
      description: keeperGoalDescription(subject),
      workflowDefinitionId: refs.workflowDefinitionId,
      projectId: refs.projectId,
    });
    if ("error" in created) return reply.status(400).send({ error: created.error });
    const relay = createWorkflowRelay(deps.db);
    await relay.track(created.workflowRunId, { fresh: true });
    await relay.flush();
    driveInBackground(relay, created.workflowRunId);
    return reply.status(202).send({ goalId: created.goalId, workflowRunId: created.workflowRunId, status: "in_progress" });
  });
}
