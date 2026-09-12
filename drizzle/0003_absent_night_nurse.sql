ALTER TABLE "capability_grants" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invocations" ADD COLUMN "capability_id" uuid;--> statement-breakpoint
ALTER TABLE "invocations" ADD COLUMN "permission" text;--> statement-breakpoint
ALTER TABLE "invocations" ADD COLUMN "proposed_action_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "invocations" ADD CONSTRAINT "invocations_capability_id_capabilities_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."capabilities"("id") ON DELETE no action ON UPDATE no action;