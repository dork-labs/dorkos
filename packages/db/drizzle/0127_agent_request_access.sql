ALTER TABLE `connector_agent_requests` ADD `requested_access` text DEFAULT 'read' NOT NULL;--> statement-breakpoint
-- A request that named any action which changes something asks for the nearest
-- level that could cover it, Read and write. A delete (destructive) is in no
-- level at all (ADR 260928-121730), so a request naming only a delete maps to
-- Read and write, the widest level, and the person still decides.
UPDATE `connector_agent_requests` SET `requested_access` = 'read-write' WHERE EXISTS (SELECT 1 FROM json_each(`connector_agent_requests`.`requested_operations_json`) AS `asked` JOIN `connector_operation_revisions` AS `revision` ON `revision`.`operation_slug` = `asked`.`value` AND `revision`.`toolkit` = `connector_agent_requests`.`service_slug` WHERE `revision`.`capability_classification` IN ('write', 'destructive'));--> statement-breakpoint
-- Rewrite each agent request's stored action and review context to the level
-- shape, keys in canonical (sorted) order, so no row still names guessed
-- actions. The stored action hash is left as it is: agent requests only ever
-- write it, and nothing re-derives or compares it.
UPDATE `connector_review_requests` SET `action_payload_json` = (SELECT json_object('access', `request`.`requested_access`, 'kind', 'agent_connection_request', 'reason', `request`.`reason`, 'requestedEvents', json(`request`.`requested_events_json`), 'serviceSlug', `request`.`service_slug`, 'version', 1) FROM `connector_agent_requests` AS `request` WHERE `request`.`review_request_id` = `connector_review_requests`.`id`), `review_context_json` = (SELECT json_object('access', `request`.`requested_access`, 'reason', `request`.`reason`, 'requestedEvents', json(`request`.`requested_events_json`), 'serviceSlug', `request`.`service_slug`) FROM `connector_agent_requests` AS `request` WHERE `request`.`review_request_id` = `connector_review_requests`.`id`) WHERE `action_kind` = 'agent_connection_request' AND EXISTS (SELECT 1 FROM `connector_agent_requests` AS `request` WHERE `request`.`review_request_id` = `connector_review_requests`.`id`);
