-- Better Auth 1.7.3 went back to the 1.6 account shape: an account is known by
-- (provider_id, account_id), and `issuer` is never written again. A NOT NULL
-- column nobody writes fails every sign-up insert, so it goes, along with the
-- unique index built on it in 0087 (DOR-2036).
--
-- That index was also the only rule keeping one row per identity, because
-- 0087 derived issuer 1:1 from provider_id. The same rule is restated on the
-- key Better Auth now looks up by. Better Auth links accounts check-then-insert,
-- and a duplicate would make every later lookup of that identity throw. Rows
-- here are already unique on that pair (0087's index held it); if one is not,
-- CREATE UNIQUE INDEX fails with "UNIQUE constraint failed" and the whole
-- migration rolls back rather than dropping anything.
--
-- The issuer index is dropped before the column: SQLite refuses to drop a
-- column an index names.
CREATE UNIQUE INDEX `account_provider_accountId_unique` ON `account` (`provider_id`,`account_id`);--> statement-breakpoint
DROP INDEX `account_issuer_accountId_unique`;--> statement-breakpoint
ALTER TABLE `account` DROP COLUMN `issuer`;
