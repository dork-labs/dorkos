CREATE TABLE `session_birth_allocations` (
	`session_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`created_at` text NOT NULL,
	`source_kind` text NOT NULL,
	`owner_id` text,
	`location_id` text,
	`registered_agent_id` text,
	`recorded_registered_path` text,
	`internal_source` text,
	CONSTRAINT "session_birth_session_id" CHECK(length("session_birth_allocations"."session_id") > 0),
	CONSTRAINT "session_birth_version" CHECK(typeof("session_birth_allocations"."version") = 'integer' AND "session_birth_allocations"."version" = 1),
	CONSTRAINT "session_birth_created_at" CHECK(length("session_birth_allocations"."created_at") > 0),
	CONSTRAINT "session_birth_source_shape" CHECK(coalesce(
        ("session_birth_allocations"."source_kind" = 'person-location' AND
          length("session_birth_allocations"."owner_id") > 0 AND length("session_birth_allocations"."location_id") > 0 AND
          "session_birth_allocations"."registered_agent_id" IS NULL AND "session_birth_allocations"."recorded_registered_path" IS NULL AND
          "session_birth_allocations"."internal_source" IS NULL) OR
        ("session_birth_allocations"."source_kind" = 'person-agent' AND length("session_birth_allocations"."owner_id") > 0 AND
          length("session_birth_allocations"."registered_agent_id") > 0 AND length("session_birth_allocations"."recorded_registered_path") > 0 AND
          "session_birth_allocations"."location_id" IS NULL AND "session_birth_allocations"."internal_source" IS NULL) OR
        ("session_birth_allocations"."source_kind" = 'internal' AND "session_birth_allocations"."owner_id" IS NULL AND "session_birth_allocations"."location_id" IS NULL AND
          "session_birth_allocations"."registered_agent_id" IS NULL AND "session_birth_allocations"."recorded_registered_path" IS NULL AND
          CASE WHEN json_valid("session_birth_allocations"."internal_source") THEN
            json_type("session_birth_allocations"."internal_source") = 'object' AND (
              ((json_extract(internal_source, '$.kind') = 'chat-message' AND json_type(internal_source, '$.receiptId') = 'text' AND length(json_extract(internal_source, '$.receiptId')) > 0 AND json_type(internal_source, '$.queueMessageId') = 'text' AND length(json_extract(internal_source, '$.queueMessageId')) > 0 AND json_type(internal_source, '$.mintedToSessionId') = 'text' AND length(json_extract(internal_source, '$.mintedToSessionId')) > 0 AND json_type(internal_source, '$.fromSessionId') = 'text' AND length(json_extract(internal_source, '$.fromSessionId')) > 0 AND (json_type(internal_source, '$.targetAgentId') IS NULL OR (json_type(internal_source, '$.targetAgentId') = 'text' AND length(json_extract(internal_source, '$.targetAgentId')) > 0)) AND json_remove(internal_source, '$.kind', '$.receiptId', '$.queueMessageId', '$.mintedToSessionId', '$.fromSessionId', '$.targetAgentId') = '{}')
                AND json_extract("session_birth_allocations"."internal_source", '$.mintedToSessionId') = "session_birth_allocations"."session_id") OR
              ((json_extract(internal_source, '$.kind') = 'room-seat' AND json_type(internal_source, '$.roomId') = 'text' AND length(json_extract(internal_source, '$.roomId')) > 0 AND json_type(internal_source, '$.authorId') = 'text' AND length(json_extract(internal_source, '$.authorId')) > 0 AND json_type(internal_source, '$.boundSessionId') = 'text' AND length(json_extract(internal_source, '$.boundSessionId')) > 0 AND json_type(internal_source, '$.seatCreatedAt') = 'text' AND length(json_extract(internal_source, '$.seatCreatedAt')) > 0 AND json_remove(internal_source, '$.kind', '$.roomId', '$.authorId', '$.boundSessionId', '$.seatCreatedAt') = '{}')
                AND json_extract("session_birth_allocations"."internal_source", '$.boundSessionId') = "session_birth_allocations"."session_id") OR
              ((json_extract(internal_source, '$.kind') = 'task-run' AND json_type(internal_source, '$.runId') = 'text' AND length(json_extract(internal_source, '$.runId')) > 0 AND json_type(internal_source, '$.mintedSessionId') = 'text' AND length(json_extract(internal_source, '$.mintedSessionId')) > 0 AND json_remove(internal_source, '$.kind', '$.runId', '$.mintedSessionId') = '{}')
                AND json_extract("session_birth_allocations"."internal_source", '$.mintedSessionId') = "session_birth_allocations"."session_id") OR
              ((json_extract(internal_source, '$.kind') = 'heartbeat' AND json_type(internal_source, '$.agentId') = 'text' AND length(json_extract(internal_source, '$.agentId')) > 0 AND json_type(internal_source, '$.chatDate') = 'text' AND length(json_extract(internal_source, '$.chatDate')) > 0 AND json_type(internal_source, '$.mintedSessionId') = 'text' AND length(json_extract(internal_source, '$.mintedSessionId')) > 0 AND json_remove(internal_source, '$.kind', '$.agentId', '$.chatDate', '$.mintedSessionId') = '{}')
                AND json_extract("session_birth_allocations"."internal_source", '$.mintedSessionId') = "session_birth_allocations"."session_id") OR
              ((json_extract(internal_source, '$.kind') = 'connector-subscription' AND json_type(internal_source, '$.subscriptionId') = 'text' AND length(json_extract(internal_source, '$.subscriptionId')) > 0 AND json_type(internal_source, '$.mintedSessionId') = 'text' AND length(json_extract(internal_source, '$.mintedSessionId')) > 0 AND json_remove(internal_source, '$.kind', '$.subscriptionId', '$.mintedSessionId') = '{}')
                AND json_extract("session_birth_allocations"."internal_source", '$.mintedSessionId') = "session_birth_allocations"."session_id") OR
              ((json_extract(internal_source, '$.kind') = 'required-recovery' AND json_type(internal_source, '$.requirementId') = 'text' AND length(json_extract(internal_source, '$.requirementId')) > 0 AND json_type(internal_source, '$.mintedSessionId') = 'text' AND length(json_extract(internal_source, '$.mintedSessionId')) > 0 AND json_remove(internal_source, '$.kind', '$.requirementId', '$.mintedSessionId') = '{}')
                AND json_extract("session_birth_allocations"."internal_source", '$.mintedSessionId') = "session_birth_allocations"."session_id") OR
              ((json_extract(internal_source, '$.kind') = 'server-mint' AND json_type(internal_source, '$.owner') = 'text' AND length(json_extract(internal_source, '$.owner')) > 0 AND json_type(internal_source, '$.mintedSessionId') = 'text' AND length(json_extract(internal_source, '$.mintedSessionId')) > 0 AND json_remove(internal_source, '$.kind', '$.owner', '$.mintedSessionId') = '{}')
                AND json_extract("session_birth_allocations"."internal_source", '$.owner') IN (
                  'relay-binding', 'extension-start', 'agent-send', 'chat-start',
                  'todo-turn', 'carry-over', 'computer-local', 'room-turn'
                ) AND json_extract("session_birth_allocations"."internal_source", '$.mintedSessionId') = "session_birth_allocations"."session_id")
            )
          ELSE 0 END), 0))
);
--> statement-breakpoint
-- Add the nullable lifecycle without rebuilding legacy rows or reading a column they do not have.
ALTER TABLE `session_metadata` ADD COLUMN `model_launch_state` text
  CONSTRAINT `session_metadata_model_launch_state` CHECK (
    `model_launch_state` IS NULL OR
    `model_launch_state` IN ('pending-v1', 'attempted-v1', 'established-v1')
  );
