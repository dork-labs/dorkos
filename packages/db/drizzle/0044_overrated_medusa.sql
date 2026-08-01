PRAGMA foreign_keys=OFF;--> statement-breakpoint
-- HAND-WRITTEN, and `db:generate` will never reproduce it. Keep it first.
-- The rebuild below copies every pulse_runs row into a table that HAS the
-- foreign key, so a run pointing at a schedule that no longer exists fails the
-- copy — and because `runMigrations` is called uncaught at boot, that is a
-- server which never starts again. Orphans are reachable in the wild: the
-- sqlite3 CLI defaults `foreign_keys` OFF, as does any tool opening dork.db
-- bare. A run whose schedule is gone is unreadable history for a task that no
-- longer exists, which is exactly what the new cascade would have removed.
DELETE FROM `pulse_runs` WHERE `schedule_id` NOT IN (SELECT `id` FROM `pulse_schedules`);--> statement-breakpoint
CREATE TABLE `__new_pulse_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`schedule_id` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`duration_ms` integer,
	`output` text,
	`error` text,
	`session_id` text,
	`trigger` text DEFAULT 'scheduled' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`schedule_id`) REFERENCES `pulse_schedules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_pulse_runs`("id", "schedule_id", "status", "started_at", "finished_at", "duration_ms", "output", "error", "session_id", "trigger", "created_at") SELECT "id", "schedule_id", "status", "started_at", "finished_at", "duration_ms", "output", "error", "session_id", "trigger", "created_at" FROM `pulse_runs`;--> statement-breakpoint
DROP TABLE `pulse_runs`;--> statement-breakpoint
ALTER TABLE `__new_pulse_runs` RENAME TO `pulse_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;