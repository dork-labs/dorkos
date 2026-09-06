-- Better Auth 1.7 scopes account identity by issuer: `account.issuer` is a new
-- required column, and identity lookups key on (issuer, accountId).
--
-- Hand-written rather than left as drizzle-kit generated it: the generated form
-- is a bare `ALTER TABLE account ADD issuer text NOT NULL`, which SQLite refuses
-- on a table that already has rows. The table is rebuilt instead, so existing
-- accounts are backfilled in the same step.
--
-- Backfill: `local:<providerId>`, the synthetic issuer Better Auth mints for
-- local authentication methods (`createLocalAccountIssuer`). Every existing row
-- is a `credential` account — DorkOS configures no social providers, so no row
-- needs the `local:oauth:` namespace.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_account` (
	`id` text PRIMARY KEY NOT NULL,
	`issuer` text NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_account`("id", "issuer", "account_id", "provider_id", "user_id", "access_token", "refresh_token", "id_token", "access_token_expires_at", "refresh_token_expires_at", "scope", "password", "created_at", "updated_at") SELECT "id", 'local:' || "provider_id", "account_id", "provider_id", "user_id", "access_token", "refresh_token", "id_token", "access_token_expires_at", "refresh_token_expires_at", "scope", "password", "created_at", "updated_at" FROM `account`;--> statement-breakpoint
DROP TABLE `account`;--> statement-breakpoint
ALTER TABLE `__new_account` RENAME TO `account`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `account_issuer_accountId_unique` ON `account` (`issuer`,`account_id`);
