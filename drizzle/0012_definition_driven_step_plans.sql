-- Task Definition kinds now select a registered task plan (src/capabilities/taskPlans.ts), and
-- each graph step binds its Agent Definition and plan parameters
-- (src/workflow/buildInvocationSpecsFromDefinitions.ts). Rows seeded before that carry free-text
-- kinds and steps with no bindings. These updates make explicit exactly what the removed
-- hard-coded step dispatcher did for those rows. They touch only rows still in the old shape:
-- the graph only when both steps are the seeded Task Definitions in order, neither step is bound
-- yet, and each seeded Agent resolves to exactly one row. Other graph keys are preserved.
UPDATE "task_definitions" SET "kind" = 'research_report' WHERE "name" = 'Research-Report' AND "kind" = 'standalone';--> statement-breakpoint
UPDATE "task_definitions" SET "kind" = 'publish_report' WHERE "name" = 'Review-and-Publish' AND "kind" = 'workflow-step';--> statement-breakpoint
UPDATE "workflow_definitions" AS wd
SET "graph_definition" = jsonb_set(
  jsonb_set(
    wd."graph_definition",
    '{steps,0}',
    (wd."graph_definition" -> 'steps' -> 0)
      || jsonb_build_object('agentDefinitionId', researcher."id", 'agentDefinitionVersion', researcher."version")
  ),
  '{steps,1}',
  (wd."graph_definition" -> 'steps' -> 1)
    || jsonb_build_object(
      'agentDefinitionId', publisher."id",
      'agentDefinitionVersion', publisher."version",
      'parameters', jsonb_build_object('sourceTaskDefinitionId', research_task."id")
    )
)
FROM "agent_definitions" AS researcher, "agent_definitions" AS publisher,
     "task_definitions" AS research_task, "task_definitions" AS publish_task
WHERE wd."name" = 'Research-and-Publish'
  AND wd."graph_definition" ->> 'kind' = 'linear'
  AND jsonb_array_length(wd."graph_definition" -> 'steps') = 2
  AND research_task."name" = 'Research-Report' AND publish_task."name" = 'Review-and-Publish'
  AND wd."graph_definition" -> 'steps' -> 0 ->> 'taskDefinitionId' = research_task."id"::text
  AND wd."graph_definition" -> 'steps' -> 1 ->> 'taskDefinitionId' = publish_task."id"::text
  AND NOT ((wd."graph_definition" -> 'steps' -> 0) ? 'agentDefinitionId')
  AND NOT ((wd."graph_definition" -> 'steps' -> 1) ? 'agentDefinitionId')
  AND researcher."name" = 'Researcher' AND researcher."version" = 1
  AND publisher."name" = 'Publisher' AND publisher."version" = 1
  AND (SELECT count(*) FROM "agent_definitions" WHERE "name" = 'Researcher' AND "version" = 1) = 1
  AND (SELECT count(*) FROM "agent_definitions" WHERE "name" = 'Publisher' AND "version" = 1) = 1;
