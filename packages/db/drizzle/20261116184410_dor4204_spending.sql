CREATE TABLE `spending_prices` (
	`toolkit` text PRIMARY KEY NOT NULL,
	`price_micro` integer NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "spending_prices_positive" CHECK("spending_prices"."price_micro" > 0)
);
--> statement-breakpoint
CREATE TABLE `spending_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`month` text NOT NULL,
	`toolkit` text NOT NULL,
	`agent_id` text NOT NULL,
	`amount_micro` integer NOT NULL,
	`source` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "spending_runs_amount" CHECK("spending_runs"."amount_micro" >= 0)
);
--> statement-breakpoint
CREATE INDEX `spending_runs_month_idx` ON `spending_runs` (`month`);--> statement-breakpoint
CREATE TABLE `spending_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`limit_micro` integer,
	`updated_at` text NOT NULL,
	CONSTRAINT "spending_settings_singleton" CHECK("spending_settings"."id" = 1),
	CONSTRAINT "spending_settings_limit_positive" CHECK("spending_settings"."limit_micro" IS NULL OR "spending_settings"."limit_micro" > 0)
);
