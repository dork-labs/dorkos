.bail on
-- Down-migration for drizzle/20261111015020_canvas_opened_by.sql (DOR-3293, apps in their own
-- frame).
--
-- Removes the `opened_by_extension_id` column from `canvas_documents` and the migration's ledger
-- row, so the next boot of a build that has it would apply it again. What is lost is only which
-- app opened a canvas tab: the tab stays, with no "Opened by" line.
--
-- It refuses, changing nothing, once a later migration has run. Drizzle only applies migrations
-- newer than the newest it has recorded, so this one would never be applied again, and the later
-- ones may rely on it.
--
-- Run it by hand, with DorkOS stopped, against a copy first:
--   sqlite3 ~/.dork/dork.db < packages/db/src/down/20261111015020_canvas_opened_by.down.sql
-- The `.bail on` above makes the sqlite3 shell stop at the first error, so the open transaction
-- is thrown away rather than committed half done. The test that proves it:
-- packages/db/src/__tests__/canvas-opened-by-migration.test.ts.
BEGIN IMMEDIATE;
-- Refuse before anything changes (see above).
CREATE TEMP TABLE `__canvas_opened_by_down_guard` (`refusals` integer NOT NULL CHECK (`refusals` = 0));
INSERT INTO `__canvas_opened_by_down_guard` SELECT count(*) FROM `__drizzle_migrations` WHERE `created_at` > 1794361820581;
DROP TABLE `__canvas_opened_by_down_guard`;
ALTER TABLE `canvas_documents` DROP COLUMN `opened_by_extension_id`;
DELETE FROM `__drizzle_migrations` WHERE `created_at` = 1794361820581;
COMMIT;
