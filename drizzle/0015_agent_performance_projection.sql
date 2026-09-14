CREATE TABLE "agent_performance" (
	"agent_definition_id" uuid NOT NULL,
	"agent_definition_version" integer NOT NULL,
	"task_definition_id" uuid NOT NULL,
	"model_tier" text NOT NULL,
	"success_rate" numeric NOT NULL,
	"avg_cost" jsonb NOT NULL,
	"avg_retries" numeric NOT NULL,
	"sample_count" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_performance_pk" PRIMARY KEY("agent_definition_id","agent_definition_version","task_definition_id","model_tier")
);
--> statement-breakpoint
ALTER TABLE "agent_performance" ADD CONSTRAINT "agent_performance_agent_definition_id_agent_definitions_id_fk" FOREIGN KEY ("agent_definition_id") REFERENCES "public"."agent_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_performance" ADD CONSTRAINT "agent_performance_task_definition_id_task_definitions_id_fk" FOREIGN KEY ("task_definition_id") REFERENCES "public"."task_definitions"("id") ON DELETE no action ON UPDATE no action;