.bail on
-- Down-migration for drizzle/20261109025955_connection_grant_approver_snapshot.sql (agent grant
-- autonomy, the request card).
--
-- Removes the `actor_snapshot_json` column and the `request_id` index, putting
-- `connection_grant_changes` back as `20261109000421_connection_grant_approvals` made it, and
-- removes the migration's ledger row, so the next boot of a build that has it would apply it again.
--
-- It refuses, changing nothing:
--   * while any row keeps an approver's snapshot. That is who approved an agent's access, as the
--     person was shown it; this file never drops one.
--   * once a later migration has run. Drizzle only applies migrations newer than the newest it
--     has recorded, so this one would never be applied again, and the later ones may rely on it.
--
-- Run it by hand, with DorkOS stopped, against a copy first:
--   sqlite3 ~/.dork/dork.db < packages/db/src/down/20261109025955_connection_grant_approver_snapshot.down.sql
-- The `.bail on` above makes the sqlite3 shell stop at the first error, so the open transaction
-- is thrown away rather than committed half done. The test that proves it:
-- packages/db/src/__tests__/connection-grant-approver-snapshot-migration.test.ts.
BEGIN IMMEDIATE;
-- Refuse before anything changes (see above).
CREATE TEMP TABLE `__approver_snapshot_down_guard` (`refusals` integer NOT NULL CHECK (`refusals` = 0));
INSERT INTO `__approver_snapshot_down_guard` SELECT count(*) FROM `__drizzle_migrations` WHERE `created_at` > 1794193195696;
INSERT INTO `__approver_snapshot_down_guard` SELECT count(*) FROM `connection_grant_changes` WHERE `actor_snapshot_json` IS NOT NULL;
DROP TABLE `__approver_snapshot_down_guard`;
DROP INDEX `connection_grant_changes_request_idx`;
ALTER TABLE `connection_grant_changes` DROP COLUMN `actor_snapshot_json`;
DELETE FROM `__drizzle_migrations` WHERE `created_at` = 1794193195696;
COMMIT;
