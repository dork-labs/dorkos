CREATE TABLE `relay_delivery_receipts` (
	`message_id` text PRIMARY KEY NOT NULL,
	`subject` text NOT NULL,
	`owner_user_id` text,
	`state` text NOT NULL,
	`boot_epoch` text NOT NULL,
	`accepted_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`settled_at` text,
	`expires_at` text NOT NULL,
	`failure_code` text,
	`failure_message` text,
	CONSTRAINT "relay_delivery_receipt_state" CHECK("relay_delivery_receipts"."state" IN ('accepted', 'delivered', 'failed', 'outcome_unknown')),
	CONSTRAINT "relay_delivery_receipt_settlement" CHECK(
      ("relay_delivery_receipts"."state" = 'accepted' AND "relay_delivery_receipts"."settled_at" IS NULL AND "relay_delivery_receipts"."failure_code" IS NULL AND "relay_delivery_receipts"."failure_message" IS NULL)
      OR ("relay_delivery_receipts"."state" = 'delivered' AND "relay_delivery_receipts"."settled_at" IS NOT NULL AND "relay_delivery_receipts"."failure_code" IS NULL AND "relay_delivery_receipts"."failure_message" IS NULL)
      OR ("relay_delivery_receipts"."state" = 'failed' AND "relay_delivery_receipts"."settled_at" IS NOT NULL AND "relay_delivery_receipts"."failure_code" IS NOT NULL AND "relay_delivery_receipts"."failure_code" IN ('at_capacity', 'chat_unavailable', 'rate_limited', 'budget_exceeded', 'initiate_denied', 'untrusted_bridge_principal', 'turn_ceiling', 'adapter_unavailable', 'not_dispatched', 'adapter_failed') AND "relay_delivery_receipts"."failure_message" IS NOT NULL)
      OR ("relay_delivery_receipts"."state" = 'outcome_unknown' AND "relay_delivery_receipts"."settled_at" IS NOT NULL AND "relay_delivery_receipts"."failure_code" IS NOT NULL AND "relay_delivery_receipts"."failure_code" = 'observation_lost' AND "relay_delivery_receipts"."failure_message" IS NOT NULL)
    )
);
--> statement-breakpoint
CREATE INDEX `idx_relay_delivery_receipts_expiry` ON `relay_delivery_receipts` (`expires_at`,`message_id`);--> statement-breakpoint
CREATE INDEX `idx_relay_delivery_receipts_recovery` ON `relay_delivery_receipts` (`state`,`boot_epoch`);--> statement-breakpoint
CREATE TABLE `relay_receipt_observer_owner` (
	`singleton_key` text PRIMARY KEY NOT NULL,
	`owner_token` text NOT NULL,
	`pid` integer NOT NULL,
	`hostname` text NOT NULL,
	`claimed_at` text NOT NULL,
	CONSTRAINT "relay_receipt_observer_singleton" CHECK("relay_receipt_observer_owner"."singleton_key" = 'observer')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `relay_receipt_observer_owner_owner_token_unique` ON `relay_receipt_observer_owner` (`owner_token`);