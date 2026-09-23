-- Living workplace (plan §13): goal archive columns (presentation; nothing is moved or deleted) and the workspace
-- configuration tables (buildings, areas, workstations: space only, never authority). Empty until the operator
-- creates the world from the current keep (Settings) or runs the seed.
-- Journal `when` hand-set after 0022 (1789574400000): drizzle skips an older-dated migration.
CREATE TABLE "world_areas" (
	"id" uuid PRIMARY KEY NOT NULL,
	"building_id" uuid NOT NULL,
	"name" text NOT NULL,
	"purpose" text NOT NULL,
	"x" integer NOT NULL,
	"y" integer NOT NULL,
	"w" integer NOT NULL,
	"h" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "world_buildings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"x" integer NOT NULL,
	"y" integer NOT NULL,
	"w" integer NOT NULL,
	"h" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "world_workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "world_workstations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"area_id" uuid NOT NULL,
	"name" text NOT NULL,
	"activity" text NOT NULL,
	"x" integer NOT NULL,
	"y" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "archived_by" text;--> statement-breakpoint
ALTER TABLE "world_areas" ADD CONSTRAINT "world_areas_building_id_world_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."world_buildings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_buildings" ADD CONSTRAINT "world_buildings_workspace_id_world_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."world_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_workstations" ADD CONSTRAINT "world_workstations_area_id_world_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."world_areas"("id") ON DELETE no action ON UPDATE no action;