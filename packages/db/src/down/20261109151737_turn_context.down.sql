.bail on
-- Down-migration for drizzle/20261109151737_turn_context.sql (context viewer phase 1: Record).
--
-- Drops the three turn-context tables and every recorded body with them, and removes the
-- migration's ledger row, so the next boot of a build that has it would apply it again. What is
-- lost is only the record of what past turns were sent: nothing else reads these tables.
--
-- Why it exists: a build without the migration ignores these tables, so it never sweeps them
-- either, and recorded text would stay on disk with no 30-day limit until the next upgrade.
--
-- It refuses, changing nothing, when a later migration has run. Drizzle only applies migrations
-- newer than the newest it has recorded, so this one would never be applied again, and the later
-- ones may rely on it.
--
-- Run it by hand, with DorkOS stopped, against a copy first:
--   sqlite3 ~/.dork/dork.db < packages/db/src/down/20261109151737_turn_context.down.sql
-- The `.bail on` above makes the sqlite3 shell stop at the first error, so the open transaction
-- is thrown away rather than committed half done. Any other runner must stop at the first error
-- too. The test that proves it: packages/db/src/__tests__/turn-context-migration.test.ts.
BEGIN IMMEDIATE;
-- Refuse before anything changes (see above).
CREATE TEMP TABLE `__turn_context_down_guard` (`refusals` integer NOT NULL CHECK (`refusals` = 0));
INSERT INTO `__turn_context_down_guard` SELECT count(*) FROM `__drizzle_migrations` WHERE `created_at` > 1794237457722;
DROP TABLE `__turn_context_down_guard`;
DROP TABLE `turn_context_parts`;
DROP TABLE `turn_contexts`;
DROP TABLE `turn_context_bodies`;
DELETE FROM `__drizzle_migrations` WHERE `created_at` = 1794237457722;
COMMIT;
