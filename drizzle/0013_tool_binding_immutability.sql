-- Tool Binding rows are immutable (docs/architecture/CAPABILITY_PLATFORM.md §2). A Tool
-- Invocation pins the binding id it was authorized and approved against, and its adapter runs
-- with that row's config; the pin only means something if the row cannot change underneath it.
-- A changed binding is a new row with a higher version. trust_level stays updatable on purpose:
-- it is re-read before every effect, so lowering it takes effect immediately.
-- One binding per (capability, version) makes selection unambiguous.
CREATE UNIQUE INDEX "tool_bindings_capability_version_unique" ON "tool_bindings" ("capability_id", "version");--> statement-breakpoint
CREATE FUNCTION "tool_bindings_refuse_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."capability_id" IS DISTINCT FROM OLD."capability_id"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."config" IS DISTINCT FROM OLD."config"
     OR NEW."version" IS DISTINCT FROM OLD."version" THEN
    RAISE EXCEPTION 'tool_bindings rows are immutable: add a new binding version instead of changing capability_id, kind, config or version (binding %)', OLD."id";
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "tool_bindings_immutable" BEFORE UPDATE ON "tool_bindings" FOR EACH ROW EXECUTE FUNCTION "tool_bindings_refuse_mutation"();
