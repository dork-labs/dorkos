.bail on
-- Down-migration for drizzle/20261116184410_dor4204_spending.sql (DOR-4204, the monthly spend
-- limit on paid app actions).
--
-- Drops the three spending tables and the migration's ledger row, so the next boot of a build
-- that has it would apply it again. What is lost is the limit, the prices a person set, and this
-- month's meter: after going back up, paid actions ask again until a limit is set.
--
-- It refuses, changing nothing, once a later migration has run. Drizzle only applies migrations
-- newer than the newest it has recorded, so this one would never be applied again, and the later
-- ones may rely on it.
--
-- Run it by hand, with DorkOS stopped, against a copy first:
--   sqlite3 ~/.dork/dork.db < packages/db/src/down/20261116184410_dor4204_spending.down.sql
-- The `.bail on` above makes the sqlite3 shell stop at the first error, so the open transaction
-- is thrown away rather than committed half done. The test that proves it:
-- packages/db/src/__tests__/spending-migration.test.ts.
BEGIN IMMEDIATE;
-- Refuse before anything changes (see above).
CREATE TEMP TABLE `__spending_down_guard` (`refusals` integer NOT NULL CHECK (`refusals` = 0));
INSERT INTO `__spending_down_guard` SELECT count(*) FROM `__drizzle_migrations` WHERE `created_at` > 1794854650053;
DROP TABLE `__spending_down_guard`;
DROP INDEX IF EXISTS `spending_runs_month_idx`;
DROP TABLE `spending_settings`;
DROP TABLE `spending_runs`;
DROP TABLE `spending_prices`;
DELETE FROM `__drizzle_migrations` WHERE `created_at` = 1794854650053;
COMMIT;
