ALTER TABLE "events" ADD COLUMN "global_seq" bigserial NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "events_global_seq_idx" ON "events" USING btree ("global_seq");