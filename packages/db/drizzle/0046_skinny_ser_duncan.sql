PRAGMA foreign_keys=OFF;--> statement-breakpoint
-- `runtime` becomes nullable: a row minted before the session started has no
-- runtime to name yet (DOR-812). The copy below carries every existing value
-- through unchanged, and deliberately back-fills nothing — a row that exists
-- today belongs to a session that has already run somewhere, and there is no
-- provenance in it that could tell a binding from the old inferred guess.
--
-- ON ROLLBACK: a binary from before this migration reads an unbound row's NULL
-- as a runtime type and 503s that session (`runtimes.get(null)` misses). Only on
-- a downgrade, and only for sessions whose settings were changed before their
-- first message; sending that first message on the new binary binds the row and
-- the state is gone.
CREATE TABLE `__new_session_metadata` (
	`session_id` text PRIMARY KEY NOT NULL,
	`runtime` text,
	`agent_path` text,
	`created_at` text NOT NULL,
	`permission_mode` text,
	`model` text,
	`effort` text,
	`fast_mode` integer
);
--> statement-breakpoint
INSERT INTO `__new_session_metadata`("session_id", "runtime", "agent_path", "created_at", "permission_mode", "model", "effort", "fast_mode") SELECT "session_id", "runtime", "agent_path", "created_at", "permission_mode", "model", "effort", "fast_mode" FROM `session_metadata`;--> statement-breakpoint
DROP TABLE `session_metadata`;--> statement-breakpoint
ALTER TABLE `__new_session_metadata` RENAME TO `session_metadata`;--> statement-breakpoint
PRAGMA foreign_keys=ON;