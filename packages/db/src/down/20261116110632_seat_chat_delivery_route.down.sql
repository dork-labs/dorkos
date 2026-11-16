.bail on
-- Stop DorkOS and back up the database first. Refuse when any later migration exists.
PRAGMA foreign_keys=OFF;
BEGIN IMMEDIATE;
CREATE TEMP TABLE seat_route_down_guard (ok INTEGER CHECK(ok = 1));
INSERT INTO seat_route_down_guard SELECT CASE WHEN MAX(created_at) = 1794827192742 THEN 1 ELSE 0 END FROM __drizzle_migrations;
UPDATE chat_messages SET status='failed', failure_reason='Private seat delivery interrupted by downgrade.' WHERE delivery_route='seat' AND status IN ('queued','working');
CREATE TABLE `__new_chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`to_session_id` text NOT NULL,
	`from_session_id` text NOT NULL,
	`from_agent_path` text NOT NULL,
	`from_agent_id` text,
	`from_agent_name` text NOT NULL,
	`from_chat_title` text,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`summary` text,
	`nonce` text,
	`delivery` text NOT NULL,
	`status` text NOT NULL,
	`failure_reason` text,
	`queue_message_id` text,
	`ceiling_json` text NOT NULL,
	`reply_to_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "chat_messages_kind" CHECK("kind" IN ('message', 'report', 'start', 'stop'))
);
INSERT INTO __new_chat_messages("id", "to_session_id", "from_session_id", "from_agent_path", "from_agent_id", "from_agent_name", "from_chat_title", "kind", "text", "summary", "nonce", "delivery", "status", "failure_reason", "queue_message_id", "ceiling_json", "reply_to_id", "created_at", "updated_at") SELECT "id", "to_session_id", "from_session_id", "from_agent_path", "from_agent_id", "from_agent_name", "from_chat_title", "kind", "text", "summary", "nonce", "delivery", "status", "failure_reason", "queue_message_id", "ceiling_json", "reply_to_id", "created_at", "updated_at" FROM chat_messages;
DROP TABLE chat_messages;
ALTER TABLE __new_chat_messages RENAME TO chat_messages;
CREATE INDEX chat_messages_to_idx ON chat_messages(to_session_id,created_at);
CREATE INDEX chat_messages_from_idx ON chat_messages(from_session_id,created_at);
CREATE INDEX chat_messages_queue_idx ON chat_messages(queue_message_id);
DELETE FROM __drizzle_migrations WHERE created_at = 1794827192742;
DROP TABLE seat_route_down_guard;
COMMIT;
PRAGMA foreign_keys=ON;
