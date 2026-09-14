-- Tool Binding rows now select the code that runs them: `config.function` names an
-- internal function registered in src/capabilities/toolAdapters.ts. The two seeded
-- bindings predate that and carry {}. Only internal rows still at {} (or null) are
-- touched, so a deliberately configured binding is never changed.
UPDATE "tool_bindings" SET "config" = '{"function": "research.retrieve.synthetic"}'::jsonb
FROM "capabilities"
WHERE "tool_bindings"."capability_id" = "capabilities"."id"
  AND "capabilities"."name" = 'research.retrieve'
  AND "tool_bindings"."kind" = 'internal'
  AND ("tool_bindings"."config" IS NULL OR "tool_bindings"."config" = '{}'::jsonb);--> statement-breakpoint
UPDATE "tool_bindings" SET "config" = '{"function": "publish.report.filesystem"}'::jsonb
FROM "capabilities"
WHERE "tool_bindings"."capability_id" = "capabilities"."id"
  AND "capabilities"."name" = 'publish.report'
  AND "tool_bindings"."kind" = 'internal'
  AND ("tool_bindings"."config" IS NULL OR "tool_bindings"."config" = '{}'::jsonb);
