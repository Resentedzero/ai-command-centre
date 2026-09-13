CREATE TYPE "public"."execution_stop_scope" AS ENUM('global', 'agent_definition', 'capability_grant', 'workflow_run', 'run');--> statement-breakpoint
CREATE TABLE "execution_stops" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" "execution_stop_scope" NOT NULL,
	"scope_ref_id" text NOT NULL,
	"reason" text,
	"engaged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"engaged_by" text NOT NULL,
	"lifted_at" timestamp with time zone,
	"lifted_by" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "execution_stops_active_scope_idx" ON "execution_stops" USING btree ("scope","scope_ref_id") WHERE "execution_stops"."lifted_at" is null;