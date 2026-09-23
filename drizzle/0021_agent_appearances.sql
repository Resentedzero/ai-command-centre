-- Journal `when` hand-set after 0020's (1789560000000): drizzle's migrator skips a migration whose `when` is older than the last applied one.
-- R2 agent visual identity: how a persistent agent looks, keyed by the agent's name (the identity that
-- spans every Agent Definition version), so a new version keeps its character and a new look mints no
-- version. Additive: agents without a row keep a default character. Presentation only; nothing in
-- governance, routing, context, execution or projections reads it.
CREATE TABLE "agent_appearances" (
	"agent_name" text PRIMARY KEY NOT NULL,
	"appearance" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
