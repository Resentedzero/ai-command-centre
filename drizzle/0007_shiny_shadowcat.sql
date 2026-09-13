CREATE TABLE "subscription_quota_state" (
	"provider" text PRIMARY KEY NOT NULL,
	"five_hour_utilization" numeric,
	"five_hour_reset_at" timestamp with time zone,
	"seven_day_utilization" numeric,
	"seven_day_reset_at" timestamp with time zone,
	"observed_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"overage_status" text,
	"source" text NOT NULL,
	"observation_event_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscription_quota_state" ADD CONSTRAINT "subscription_quota_state_observation_event_id_events_id_fk" FOREIGN KEY ("observation_event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;