-- Better Auth 1.7.3 went back to the 1.6 account shape: an account is known by
-- (provider_id, account_id), and `issuer` is never written again. A NOT NULL
-- column nobody writes fails every sign-up insert, so it goes, along with the
-- unique index built on it in 0087 (DOR-2036).
--
-- The index is dropped first: SQLite refuses to drop a column an index names.
DROP INDEX `account_issuer_accountId_unique`;--> statement-breakpoint
ALTER TABLE `account` DROP COLUMN `issuer`;
