CREATE TABLE `session_context` (
	`session_id` text PRIMARY KEY NOT NULL,
	`context_tokens` integer NOT NULL,
	`context_max_tokens` integer NOT NULL,
	`observed_at` text NOT NULL
);
