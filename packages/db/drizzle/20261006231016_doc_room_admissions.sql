CREATE TABLE `room_doc_admission_inputs` (
	`admission_id` text NOT NULL,
	`document_id` text NOT NULL,
	`event_id` text NOT NULL,
	`route_id` text NOT NULL,
	`input_ordinal` integer NOT NULL,
	`doc_seq` integer NOT NULL,
	`envelope_hash` text NOT NULL,
	`source_delivery_status` text NOT NULL,
	`source_delivery_reason` text,
	PRIMARY KEY(`admission_id`, `input_ordinal`),
	FOREIGN KEY (`document_id`,`admission_id`) REFERENCES `room_doc_admissions`(`document_id`,`admission_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`,`event_id`) REFERENCES `canvas_doc_events`(`document_id`,`event_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`,`event_id`,`route_id`) REFERENCES `canvas_doc_deliveries`(`document_id`,`event_id`,`route_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "room_doc_admission_inputs_check_0" CHECK(input_ordinal>=0 AND input_ordinal<100),
	CONSTRAINT "room_doc_admission_inputs_check_1" CHECK(doc_seq>0),
	CONSTRAINT "room_doc_admission_inputs_check_2" CHECK(length(envelope_hash)=64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_doc_admission_inputs_event_unique` ON `room_doc_admission_inputs` (`admission_id`,`event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `room_doc_admission_inputs_route_unique` ON `room_doc_admission_inputs` (`document_id`,`event_id`,`route_id`);--> statement-breakpoint
CREATE TABLE `room_doc_admissions` (
	`admission_id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`batch_id` text NOT NULL,
	`generation` text NOT NULL,
	`source_attempt` integer NOT NULL,
	`room_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`entry_seq` integer NOT NULL,
	`grant_id` text NOT NULL,
	`grant_revision` integer NOT NULL,
	`route_id` text NOT NULL,
	`route_hash` text NOT NULL,
	`declaration_hash` text NOT NULL,
	`manifest_hash` text,
	`input_fingerprint` text NOT NULL,
	`authority_digest` text NOT NULL,
	`effective_payload_digest` text NOT NULL,
	`source_hash` text NOT NULL,
	`producer_evidence_json` text NOT NULL,
	`target_agent_id` text NOT NULL,
	`target_author_id` text NOT NULL,
	`target_session_id` text NOT NULL,
	`target_runtime` text NOT NULL,
	`target_agent_path` text NOT NULL,
	`cascade_root` text NOT NULL,
	`root_room_id` text NOT NULL,
	`root_entry_id` text NOT NULL,
	`frozen_ceiling` integer NOT NULL,
	`dispatch_attempt` integer NOT NULL,
	`boot_epoch` text NOT NULL,
	`dispatch_id` text NOT NULL,
	`claimed_at_ms` integer NOT NULL,
	`claimed_at` text NOT NULL,
	`spend_row_id` integer,
	`status` text NOT NULL,
	`turn_id` text,
	`outcome` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`row_json` text NOT NULL,
	FOREIGN KEY (`document_id`,`batch_id`) REFERENCES `canvas_doc_batches`(`document_id`,`batch_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`,`grant_id`) REFERENCES `canvas_doc_grants`(`document_id`,`grant_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`room_id`,`entry_id`) REFERENCES `room_entries`(`room_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`root_room_id`,`root_entry_id`) REFERENCES `room_entries`(`room_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "room_doc_admissions_check_0" CHECK(source_attempt>=0),
	CONSTRAINT "room_doc_admissions_check_1" CHECK(entry_seq>0),
	CONSTRAINT "room_doc_admissions_check_2" CHECK(grant_revision>=0),
	CONSTRAINT "room_doc_admissions_check_3" CHECK(length(route_hash)=64),
	CONSTRAINT "room_doc_admissions_check_4" CHECK(length(declaration_hash)=64),
	CONSTRAINT "room_doc_admissions_check_5" CHECK(length(input_fingerprint)=64),
	CONSTRAINT "room_doc_admissions_check_6" CHECK(length(authority_digest)=64),
	CONSTRAINT "room_doc_admissions_check_7" CHECK(length(effective_payload_digest)=64),
	CONSTRAINT "room_doc_admissions_check_8" CHECK(length(source_hash)=64),
	CONSTRAINT "room_doc_admissions_check_9" CHECK(json_valid(producer_evidence_json)),
	CONSTRAINT "room_doc_admissions_check_10" CHECK(target_runtime IN ('claude-code','codex','opencode')),
	CONSTRAINT "room_doc_admissions_check_11" CHECK(frozen_ceiling>0),
	CONSTRAINT "room_doc_admissions_check_12" CHECK(dispatch_attempt=1),
	CONSTRAINT "room_doc_admissions_check_13" CHECK(spend_row_id IS NULL OR spend_row_id>0),
	CONSTRAINT "room_doc_admissions_check_14" CHECK(status IN ('claimed','turn_started','settled','in_doubt')),
	CONSTRAINT "room_doc_admissions_check_15" CHECK(outcome IS NULL OR outcome IN ('turn_done','failed','cancelled','in_doubt')),
	CONSTRAINT "room_doc_admissions_check_16" CHECK(json_valid(row_json)),
	CONSTRAINT "room_doc_admissions_check_17" CHECK(cascade_root=root_entry_id),
	CONSTRAINT "room_doc_admissions_check_18" CHECK((status='claimed' AND turn_id IS NULL AND outcome IS NULL)
  OR (status='turn_started' AND turn_id IS NOT NULL AND outcome IS NULL)
  OR (status='in_doubt' AND outcome IS 'in_doubt')
  OR (status='settled' AND outcome IS NOT NULL AND (outcome IN ('failed','cancelled')
     OR (outcome='turn_done' AND turn_id IS NOT NULL)))),
	CONSTRAINT "room_doc_admissions_check_19" CHECK(json_extract(row_json,'$.admissionId') IS admission_id
  AND json_extract(row_json,'$.entryId') IS entry_id
  AND json_extract(row_json,'$.source.documentId') IS document_id
  AND json_extract(row_json,'$.source.batchId') IS batch_id
  AND json_extract(row_json,'$.source.generation') IS generation
  AND json_extract(row_json,'$.sourceAttempt') IS source_attempt
  AND json_extract(row_json,'$.sourceHash') IS source_hash
  AND json_extract(row_json,'$.dispatchAttempt') IS dispatch_attempt
  AND json_extract(row_json,'$.bootEpoch') IS boot_epoch
  AND json_extract(row_json,'$.dispatchId') IS dispatch_id
  AND json_extract(row_json,'$.claimedAtMs') IS claimed_at_ms
  AND json_extract(row_json,'$.spendRowId') IS spend_row_id
  AND json_extract(row_json,'$.status') IS status
  AND json_extract(row_json,'$.turnId') IS turn_id
  AND json_extract(row_json,'$.outcome') IS outcome
  AND json_extract(row_json,'$.source.roomId') IS room_id
  AND json_extract(row_json,'$.source.grantId') IS grant_id
  AND json_extract(row_json,'$.source.grantRevision') IS grant_revision
  AND json_extract(row_json,'$.source.routeId') IS route_id
  AND json_extract(row_json,'$.source.routeHash') IS route_hash
  AND json_extract(row_json,'$.source.declarationHash') IS declaration_hash
  AND json_extract(row_json,'$.source.manifestHash') IS manifest_hash
  AND json_extract(row_json,'$.source.inputFingerprint') IS input_fingerprint
  AND json_extract(row_json,'$.source.authorityDigest') IS authority_digest
  AND json_extract(row_json,'$.source.effectivePayloadDigest') IS effective_payload_digest
  AND json_extract(row_json,'$.source.agentId') IS target_agent_id
  AND json_extract(row_json,'$.source.authorId') IS target_author_id
  AND json_extract(row_json,'$.source.sessionId') IS target_session_id
  AND json_extract(row_json,'$.source.runtime') IS target_runtime
  AND json_extract(row_json,'$.source.agentPath') IS target_agent_path
  AND json_extract(row_json,'$.cascadeRoot') IS cascade_root
  AND json_extract(row_json,'$.rootRoomId') IS root_room_id
  AND json_extract(row_json,'$.rootEntryId') IS root_entry_id
  AND json_extract(row_json,'$.ceiling') IS frozen_ceiling
  AND json(json_extract(row_json,'$.producerEvidence')) IS json(producer_evidence_json)
  AND json_extract(row_json,'$.createdAt') IS created_at
  AND json_extract(row_json,'$.claimedAt') IS claimed_at
  AND json_extract(row_json,'$.updatedAt') IS updated_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_doc_admissions_source_unique` ON `room_doc_admissions` (`document_id`,`batch_id`,`generation`);--> statement-breakpoint
CREATE UNIQUE INDEX `room_doc_admissions_document_id_unique` ON `room_doc_admissions` (`document_id`,`admission_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `room_doc_admissions_entry_unique` ON `room_doc_admissions` (`room_id`,`entry_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `room_doc_admissions_dispatch_unique` ON `room_doc_admissions` (`dispatch_id`);--> statement-breakpoint
CREATE INDEX `room_doc_admissions_document_window` ON `room_doc_admissions` (`document_id`,`claimed_at_ms`);--> statement-breakpoint
CREATE INDEX `room_doc_admissions_recovery` ON `room_doc_admissions` (`status`,`boot_epoch`,`updated_at`,`admission_id`);--> statement-breakpoint
CREATE INDEX `room_doc_admissions_root` ON `room_doc_admissions` (`cascade_root`,`status`);--> statement-breakpoint
CREATE TABLE `room_doc_exhausted_lineages` (
	`cascade_root` text PRIMARY KEY NOT NULL,
	`root_room_id` text NOT NULL,
	`root_entry_id` text NOT NULL,
	`original_admission_id` text NOT NULL,
	`frozen_ceiling` integer NOT NULL,
	`exhausted_at` text NOT NULL,
	FOREIGN KEY (`root_room_id`,`root_entry_id`) REFERENCES `room_entries`(`room_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "room_doc_exhausted_lineages_check_0" CHECK(frozen_ceiling>0),
	CONSTRAINT "room_doc_exhausted_lineages_check_1" CHECK(cascade_root=root_entry_id)
);
--> statement-breakpoint
CREATE INDEX `room_doc_exhausted_lineages_anchor` ON `room_doc_exhausted_lineages` (`root_room_id`,`root_entry_id`);--> statement-breakpoint
CREATE TABLE `canvas_doc_channel_tokens` (
	`token_id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`document_id` text NOT NULL,
	`allowed_types` text NOT NULL,
	`directions` text NOT NULL,
	`permissions` text NOT NULL,
	`creator_id` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`binding_version` integer NOT NULL,
	`document_scope` text NOT NULL,
	`document_generation` text NOT NULL,
	`document_birth` text NOT NULL,
	`document_incarnation` text NOT NULL,
	`declaration_hash` text NOT NULL,
	`manifest_hash` text,
	`approved_grant_bindings` text NOT NULL,
	`issuer_binding` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `canvas_doc_channels`(`document_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `canvas_doc_channel_tokens_hash_unique` ON `canvas_doc_channel_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `canvas_doc_channel_tokens_document_idx` ON `canvas_doc_channel_tokens` (`document_id`,`revoked_at`,`expires_at`);--> statement-breakpoint
-- Existing pre-Room rows retain NULL native custody; do not invent an admission.
ALTER TABLE `canvas_doc_batches` ADD `delivery_kind` text CONSTRAINT "canvas_doc_batches_room_agreement_0" CHECK(delivery_kind IS NULL OR delivery_kind IN ('private_session','room_app_event'));--> statement-breakpoint
ALTER TABLE `canvas_doc_batches` ADD `room_admission_id` text;--> statement-breakpoint
ALTER TABLE `canvas_doc_batches` ADD `room_source_attempt` integer;--> statement-breakpoint
ALTER TABLE `canvas_doc_batches` ADD `room_source_json` text;--> statement-breakpoint
ALTER TABLE `canvas_doc_batches` ADD `room_source_hash` text CONSTRAINT "canvas_doc_batches_room_agreement_1" CHECK(
 (delivery_kind IS NOT 'room_app_event' AND room_admission_id IS NULL
  AND room_source_attempt IS NULL AND room_source_json IS NULL AND room_source_hash IS NULL)
 OR
 (delivery_kind IS 'room_app_event' AND admission_receipt_id IS NULL
  AND room_admission_id IS NOT NULL AND length(room_admission_id)>0
  AND room_source_attempt IS NOT NULL AND room_source_attempt>=0
  AND room_source_json IS NOT NULL AND json_valid(room_source_json)
  AND room_source_hash IS NOT NULL AND length(room_source_hash)=64
  AND room_source_hash NOT GLOB '*[^0-9a-f]*'
  AND json_extract(room_source_json,'$.admissionId') IS room_admission_id
  AND json_extract(room_source_json,'$.documentId') IS document_id
  AND json_extract(room_source_json,'$.batchId') IS batch_id
  AND json_extract(room_source_json,'$.generation') IS generation
  AND json_extract(room_source_json,'$.sourceAttempt') IS room_source_attempt));--> statement-breakpoint
CREATE UNIQUE INDEX `canvas_doc_batches_room_admission_unique` ON `canvas_doc_batches` (`room_admission_id`) WHERE room_admission_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `canvas_doc_batches_room_resume` ON `canvas_doc_batches` (`delivery_kind`,`status`,`updated_at`,`batch_id`);--> statement-breakpoint
ALTER TABLE `canvas_doc_channels` ADD `room_spend_floor_ms` integer;--> statement-breakpoint
ALTER TABLE `canvas_doc_deliveries` ADD `delivery_kind` text CONSTRAINT "canvas_doc_deliveries_room_agreement_0" CHECK(delivery_kind IS NULL OR delivery_kind IN ('private_session','room_app_event'));--> statement-breakpoint
ALTER TABLE `canvas_doc_deliveries` ADD `room_admission_id` text CONSTRAINT "canvas_doc_deliveries_room_agreement_1" CHECK(
 (delivery_kind IS NOT 'room_app_event' AND room_admission_id IS NULL)
 OR (delivery_kind IS 'room_app_event' AND room_admission_id IS NOT NULL
     AND length(room_admission_id)>0));--> statement-breakpoint
CREATE INDEX `canvas_doc_deliveries_room_admission` ON `canvas_doc_deliveries` (`room_admission_id`,`document_id`,`route_id`);--> statement-breakpoint
CREATE INDEX `idx_room_entries_global_root` ON `room_entries` (`id`,`room_id`) WHERE id=cascade_root;--> statement-breakpoint
CREATE INDEX `idx_room_entries_global_descendants` ON `room_entries` (`cascade_root`,`room_id`,`id`);