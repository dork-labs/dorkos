ALTER TABLE `approvals` ADD `raises_permissions` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `session_message_queue` ADD `held_to_default` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `session_metadata` ADD `last_turn_held` integer;--> statement-breakpoint
ALTER TABLE `room_entries` ADD `held_to_default` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Cards already waiting when this lands: the same rule the gate applies to a new
-- card (DOR-3037), read from what the row kept. A settings patch is marked
-- whatever it touched, since the row does not keep its input.
UPDATE `approvals` SET `raises_permissions` = 1 WHERE `state` = 'pending' AND `tier` <> 'observe' AND (`area` IN ('permissions', 'safety', 'reach') OR `capability_id` IN ('operator.config_patch', 'permissions.change', 'marketplace.install', 'create_agent', 'mcp.enable'));