-- Add marketplace-05 `source_type` column to marketplace_install_events.
-- The column is added nullable first, backfilled with the only value
-- spec 04 ever wrote (`github`), then altered to NOT NULL so the new
-- privacy-contract invariant (all rows have a source type) holds.
ALTER TABLE "marketplace_install_events" ADD COLUMN "source_type" text;
--> statement-breakpoint
UPDATE "marketplace_install_events" SET "source_type" = 'github' WHERE "source_type" IS NULL;
--> statement-breakpoint
ALTER TABLE "marketplace_install_events" ALTER COLUMN "source_type" SET NOT NULL;
