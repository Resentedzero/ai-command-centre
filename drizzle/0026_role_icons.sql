CREATE TABLE "agent_role_icons" (
	"agent_name" text PRIMARY KEY NOT NULL,
	"icon_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
