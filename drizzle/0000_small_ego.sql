CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."budget_counter_scope" AS ENUM('run', 'task_instance', 'agent_definition', 'goal', 'day');--> statement-breakpoint
CREATE TYPE "public"."invocation_kind" AS ENUM('llm', 'tool', 'retrieval', 'deterministic', 'browser');--> statement-breakpoint
CREATE TYPE "public"."tool_binding_kind" AS ENUM('internal', 'direct_api', 'mcp', 'browser', 'process', 'webhook');--> statement-breakpoint
CREATE TABLE "agent_definitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"role" text NOT NULL,
	"objective" text NOT NULL,
	"instructions" text NOT NULL,
	"memory_policy" jsonb,
	"escalation_policy" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"invocation_id" uuid NOT NULL,
	"proposed_action_snapshot" jsonb NOT NULL,
	"risk_tier" text NOT NULL,
	"status" "approval_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"ttl" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"version" integer NOT NULL,
	"producing_invocation_id" uuid,
	"hash" text NOT NULL,
	"size" integer NOT NULL,
	"storage_reference" text,
	"inline_content" text,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_counters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" "budget_counter_scope" NOT NULL,
	"scope_ref_id" text NOT NULL,
	"limit_amount" numeric NOT NULL,
	"reserved_amount" numeric DEFAULT '0' NOT NULL,
	"consumed_amount" numeric DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capabilities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"static_risk_tag" text NOT NULL,
	"cost_profile" jsonb
);
--> statement-breakpoint
CREATE TABLE "capability_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_definition_id" uuid NOT NULL,
	"agent_definition_version" integer NOT NULL,
	"capability_id" uuid NOT NULL,
	"permissions" jsonb NOT NULL,
	"scope" jsonb,
	"max_trust_level_required" integer NOT NULL,
	"autonomy_state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"event_type" text NOT NULL,
	"event_version" integer NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sequence_no" integer NOT NULL,
	"causation_id" uuid,
	"goal_id" uuid,
	"workflow_run_id" uuid,
	"task_instance_id" uuid,
	"run_id" uuid,
	"invocation_id" uuid,
	"actor" text NOT NULL,
	"producer" text NOT NULL,
	"payload" jsonb NOT NULL,
	"tokens_in" integer,
	"tokens_out" integer,
	"cache_hit" boolean,
	"cost_amount" numeric,
	"model_id" text,
	CONSTRAINT "events_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"seq_no" integer NOT NULL,
	"kind" "invocation_kind" NOT NULL,
	"cost_class" text NOT NULL,
	"status" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "invocations_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_instance_id" uuid NOT NULL,
	"agent_definition_id" uuid,
	"agent_definition_version" integer,
	"status" text NOT NULL,
	"budget_envelope" jsonb,
	"outcome" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "task_definitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"input_schema" jsonb,
	"output_schema" jsonb,
	"default_context_budget" jsonb,
	"version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_instances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_definition_id" uuid NOT NULL,
	"task_definition_version" integer NOT NULL,
	"workflow_run_id" uuid,
	"project_id" uuid NOT NULL,
	"status" text NOT NULL,
	"input" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_bindings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"capability_id" uuid NOT NULL,
	"kind" "tool_binding_kind" NOT NULL,
	"config" jsonb,
	"trust_level" integer NOT NULL,
	"version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_definitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"graph_definition" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workflow_definition_id" uuid NOT NULL,
	"workflow_definition_version" integer NOT NULL,
	"goal_id" uuid NOT NULL,
	"status" text NOT NULL,
	"variables" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_invocation_id_invocations_id_fk" FOREIGN KEY ("invocation_id") REFERENCES "public"."invocations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_producing_invocation_id_invocations_id_fk" FOREIGN KEY ("producing_invocation_id") REFERENCES "public"."invocations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_grants" ADD CONSTRAINT "capability_grants_agent_definition_id_agent_definitions_id_fk" FOREIGN KEY ("agent_definition_id") REFERENCES "public"."agent_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_grants" ADD CONSTRAINT "capability_grants_capability_id_capabilities_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."capabilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invocations" ADD CONSTRAINT "invocations_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_task_instance_id_task_instances_id_fk" FOREIGN KEY ("task_instance_id") REFERENCES "public"."task_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_definition_id_agent_definitions_id_fk" FOREIGN KEY ("agent_definition_id") REFERENCES "public"."agent_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_instances" ADD CONSTRAINT "task_instances_task_definition_id_task_definitions_id_fk" FOREIGN KEY ("task_definition_id") REFERENCES "public"."task_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_instances" ADD CONSTRAINT "task_instances_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_instances" ADD CONSTRAINT "task_instances_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_bindings" ADD CONSTRAINT "tool_bindings_capability_id_capabilities_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."capabilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_definition_id_workflow_definitions_id_fk" FOREIGN KEY ("workflow_definition_id") REFERENCES "public"."workflow_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;