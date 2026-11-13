CREATE TABLE `work_claims` (
	`agent_id` text NOT NULL,
	`claim_key` text NOT NULL,
	`session_id` text NOT NULL,
	`note` text,
	`claimed_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	PRIMARY KEY(`agent_id`, `claim_key`),
	CONSTRAINT "work_claims_key_length" CHECK(length("work_claims"."claim_key") BETWEEN 1 AND 120),
	CONSTRAINT "work_claims_note_length" CHECK("work_claims"."note" IS NULL OR length("work_claims"."note") <= 200)
);
--> statement-breakpoint
CREATE INDEX `work_claims_session_idx` ON `work_claims` (`session_id`);