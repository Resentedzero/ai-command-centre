-- R2 agent progression: projections rebuilt from Events, keyed on the persistent agent name (src/projections/agentProgression.ts).
-- Presentation and evidence only; no governance, routing, execution or context code reads them.
-- Journal `when` hand-set after 0021 (1789567200000): drizzle skips an older-dated migration.
CREATE TABLE "agent_achievements" (
	"agent_name" text NOT NULL,
	"achievement" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"earned_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_achievements_pk" PRIMARY KEY("agent_name","achievement")
);
--> statement-breakpoint
CREATE TABLE "agent_domain_work" (
	"agent_name" text NOT NULL,
	"domain" text NOT NULL,
	"run_id" uuid NOT NULL,
	"earned_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_domain_work_pk" PRIMARY KEY("agent_name","domain","run_id")
);
--> statement-breakpoint
CREATE TABLE "agent_endorsements" (
	"invocation_id" uuid PRIMARY KEY NOT NULL,
	"endorser_name" text NOT NULL,
	"endorser_run_id" uuid NOT NULL,
	"endorsed_name" text,
	"artifact_id" uuid NOT NULL,
	"artifact_hash" text NOT NULL,
	"verified" boolean NOT NULL,
	"mutual" boolean NOT NULL,
	"excluded_reason" text,
	"recorded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_xp_awards" (
	"agent_name" text NOT NULL,
	"award_key" text NOT NULL,
	"rule" text NOT NULL,
	"xp" integer NOT NULL,
	"run_id" uuid,
	"workflow_run_id" uuid,
	"goal_id" uuid,
	"artifact_id" uuid,
	"evidence" jsonb NOT NULL,
	"earned_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_xp_awards_pk" PRIMARY KEY("agent_name","award_key")
);
