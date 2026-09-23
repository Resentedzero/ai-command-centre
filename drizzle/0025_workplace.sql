CREATE TABLE "workplace_agent_settings" (
	"agent_name" text PRIMARY KEY NOT NULL,
	"work_start_minute" integer,
	"work_end_minute" integer,
	"working_days" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workplace_calendar_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_name" text,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"cancelled_at" timestamp with time zone,
	"goal_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workplace_meeting_participants" (
	"meeting_id" uuid NOT NULL,
	"agent_name" text NOT NULL,
	"role" text DEFAULT 'participant' NOT NULL,
	CONSTRAINT "workplace_meeting_participants_pk" PRIMARY KEY("meeting_id","agent_name")
);
--> statement-breakpoint
CREATE TABLE "workplace_meetings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"agenda" text DEFAULT '' NOT NULL,
	"organiser" text NOT NULL,
	"room_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decisions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"goal_id" uuid,
	"run_id" uuid,
	"invocation_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workplace_notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"recipient" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"sender" text NOT NULL,
	"meeting_id" uuid,
	"goal_id" uuid,
	"channel" text DEFAULT 'internal' NOT NULL,
	"deliver_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workplace_notifications_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "workplace_rooms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"purpose" text NOT NULL,
	"capacity" integer NOT NULL,
	"location_area_name" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workplace_rooms_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "workplace_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"timezone" text DEFAULT 'Europe/London' NOT NULL,
	"work_start_minute" integer DEFAULT 540 NOT NULL,
	"work_end_minute" integer DEFAULT 1020 NOT NULL,
	"working_days" jsonb DEFAULT '[1,2,3,4,5]'::jsonb NOT NULL,
	"outside_working_hours" text DEFAULT 'forbid' NOT NULL,
	"default_meeting_minutes" integer DEFAULT 30 NOT NULL,
	"reminder_minutes" integer DEFAULT 10 NOT NULL,
	"gather_minutes" integer DEFAULT 2 NOT NULL,
	"notify_invitations" boolean DEFAULT true NOT NULL,
	"notify_reminders" boolean DEFAULT true NOT NULL,
	"notify_announcements" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workplace_calendar_events" ADD CONSTRAINT "workplace_calendar_events_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_meeting_participants" ADD CONSTRAINT "workplace_meeting_participants_meeting_id_workplace_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."workplace_meetings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_meetings" ADD CONSTRAINT "workplace_meetings_room_id_workplace_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."workplace_rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_meetings" ADD CONSTRAINT "workplace_meetings_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_notifications" ADD CONSTRAINT "workplace_notifications_meeting_id_workplace_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."workplace_meetings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_notifications" ADD CONSTRAINT "workplace_notifications_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;