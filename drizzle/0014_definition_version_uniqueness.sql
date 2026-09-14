-- One row per (name, version) for versioned Definitions, and one Capability per name.
-- The Registry API allocates versions under a per-name lock (src/definitions/registryWrites.ts);
-- these indexes make the invariant hold for every writer, including seeds and future code.
-- resolveToolInvocation requires exactly one Capability per name. Fails on a database that
-- already holds duplicates; the seed never creates them.
CREATE UNIQUE INDEX "agent_definitions_name_version_unique" ON "agent_definitions" ("name", "version");--> statement-breakpoint
CREATE UNIQUE INDEX "task_definitions_name_version_unique" ON "task_definitions" ("name", "version");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_definitions_name_version_unique" ON "workflow_definitions" ("name", "version");--> statement-breakpoint
CREATE UNIQUE INDEX "capabilities_name_unique" ON "capabilities" ("name");
