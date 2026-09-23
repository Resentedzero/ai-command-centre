-- Living world refinement (plan §14): one current workspace (templates retire, never delete, the previous one),
-- the template a workspace came from, and the facing an agent takes at a workstation. Space only, never authority.
-- Journal `when` hand-set after 0023 (1789581600000): drizzle skips an older-dated migration.
ALTER TABLE "world_workspaces" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "world_workspaces" ADD COLUMN "template" text;--> statement-breakpoint
ALTER TABLE "world_workstations" ADD COLUMN "facing" text DEFAULT 'up' NOT NULL;