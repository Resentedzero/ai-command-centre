-- Events are append-only (spec §3e "append-only, immutable"; §8.7 "the raw Event table
-- itself, immutable — no separate audit log"). Until now that held only because no code
-- updated or deleted a row. The database now refuses UPDATE, DELETE and TRUNCATE, so the
-- audit log cannot be rewritten by a future writer, a script or a hand-run statement.
-- A correction is a new event, never an edit. Inserts are unaffected.
CREATE FUNCTION "events_refuse_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'events are immutable: append a new event instead of % on the event log', TG_OP;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "events_immutable" BEFORE UPDATE OR DELETE ON "events" FOR EACH ROW EXECUTE FUNCTION "events_refuse_mutation"();--> statement-breakpoint
CREATE TRIGGER "events_immutable_truncate" BEFORE TRUNCATE ON "events" FOR EACH STATEMENT EXECUTE FUNCTION "events_refuse_mutation"();
