DROP INDEX "budget_counters_scope_scope_ref_id_idx";--> statement-breakpoint
ALTER TABLE "budget_counters" ADD COLUMN "resource_unit" text DEFAULT 'usd' NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "cost_unit" text;--> statement-breakpoint
CREATE UNIQUE INDEX "budget_counters_scope_scope_ref_id_resource_unit_idx" ON "budget_counters" USING btree ("scope","scope_ref_id","resource_unit");--> statement-breakpoint
-- Backfill (hand-added, not drizzle-kit generated): every pre-existing
-- usage-bearing event was denominated in USD, because USD was the only unit
-- that existed before this migration. `budget_counters.resource_unit` is
-- backfilled by its own DEFAULT 'usd' above; `events.cost_unit` is nullable
-- (non-usage events legitimately have none), so it needs this explicit pass.
--
-- The WHERE clause mirrors emitEvent's `hasUsage` predicate EXACTLY, so a row
-- gets a unit if and only if a reader would reconstruct a `usage` object for
-- it. Idempotent: re-running changes nothing.
UPDATE "events" SET "cost_unit" = 'usd'
WHERE "cost_unit" IS NULL
  AND ("tokens_in" IS NOT NULL
    OR "tokens_out" IS NOT NULL
    OR "cache_hit" IS NOT NULL
    OR "cost_amount" IS NOT NULL
    OR "model_id" IS NOT NULL);