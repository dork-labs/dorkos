-- Existing receipts predate seat delivery; copy them as ordinary chat with no seat scope.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
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
	`delivery_route` text DEFAULT 'chat' NOT NULL,
	`seat_room_id` text,
	`seat_author_id` text,
	`seat_joined_at` text,
	`seat_session_id` text,
	`reply_to_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "chat_messages_delivery_route" CHECK("__new_chat_messages"."delivery_route" IN ('chat', 'seat')),
	CONSTRAINT "chat_messages_seat_scope" CHECK("__new_chat_messages"."delivery_route" = 'chat' OR ("__new_chat_messages"."seat_room_id" IS NOT NULL AND "__new_chat_messages"."seat_author_id" IS NOT NULL AND "__new_chat_messages"."seat_joined_at" IS NOT NULL AND "__new_chat_messages"."seat_session_id" IS NOT NULL)),
	CONSTRAINT "chat_messages_kind" CHECK("__new_chat_messages"."kind" IN ('message', 'report', 'start', 'stop'))
);
--> statement-breakpoint
INSERT INTO `__new_chat_messages`("id", "to_session_id", "from_session_id", "from_agent_path", "from_agent_id", "from_agent_name", "from_chat_title", "kind", "text", "summary", "nonce", "delivery", "status", "failure_reason", "queue_message_id", "ceiling_json", "delivery_route", "seat_room_id", "seat_author_id", "seat_joined_at", "seat_session_id", "reply_to_id", "created_at", "updated_at") SELECT "id", "to_session_id", "from_session_id", "from_agent_path", "from_agent_id", "from_agent_name", "from_chat_title", "kind", "text", "summary", "nonce", "delivery", "status", "failure_reason", "queue_message_id", "ceiling_json", 'chat', NULL, NULL, NULL, NULL, "reply_to_id", "created_at", "updated_at" FROM `chat_messages`;--> statement-breakpoint
DROP TABLE `chat_messages`;--> statement-breakpoint
ALTER TABLE `__new_chat_messages` RENAME TO `chat_messages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `chat_messages_to_idx` ON `chat_messages` (`to_session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `chat_messages_from_idx` ON `chat_messages` (`from_session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `chat_messages_queue_idx` ON `chat_messages` (`queue_message_id`);