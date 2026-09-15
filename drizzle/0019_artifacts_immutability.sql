-- Artifacts are immutable (operator decision R-ART1, 2026-09-15). Approvals pin an
-- Artifact's content hash (spec §9.5), and compiled contexts record the exact artifact
-- id, version and hash they included (§5.13), so an in-place edit would silently change
-- what those records point at. A new version is a new `artifacts` row with its own
-- `artifact_created`; `artifact_updated` is retired. The database now refuses UPDATE,
-- DELETE and TRUNCATE, as migration 0016 does for events. Inserts are unaffected.
CREATE FUNCTION "artifacts_refuse_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'artifacts are immutable: a new version is a new artifacts row, never % of an existing one', TG_OP;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "artifacts_immutable" BEFORE UPDATE OR DELETE ON "artifacts" FOR EACH ROW EXECUTE FUNCTION "artifacts_refuse_mutation"();--> statement-breakpoint
CREATE TRIGGER "artifacts_immutable_truncate" BEFORE TRUNCATE ON "artifacts" FOR EACH STATEMENT EXECUTE FUNCTION "artifacts_refuse_mutation"();
