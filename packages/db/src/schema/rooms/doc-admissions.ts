import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import {
  canvasDocBatches,
  canvasDocDeliveries,
  canvasDocEvents,
  canvasDocGrants,
} from '../canvas/channel.js';
import { roomEntries } from '../rooms.js';

/** Durable native claim evidence only; rows do not issue source or responder authority. */
export const roomDocAdmissions = sqliteTable(
  'room_doc_admissions',
  {
    admissionId: text('admission_id').notNull().primaryKey(),
    documentId: text('document_id').notNull(),
    batchId: text('batch_id').notNull(),
    generation: text('generation').notNull(),
    sourceAttempt: integer('source_attempt').notNull(),
    roomId: text('room_id').notNull(),
    entryId: text('entry_id').notNull(),
    entrySeq: integer('entry_seq').notNull(),
    grantId: text('grant_id').notNull(),
    grantRevision: integer('grant_revision').notNull(),
    routeId: text('route_id').notNull(),
    routeHash: text('route_hash').notNull(),
    declarationHash: text('declaration_hash').notNull(),
    manifestHash: text('manifest_hash'),
    inputFingerprint: text('input_fingerprint').notNull(),
    authorityDigest: text('authority_digest').notNull(),
    effectivePayloadDigest: text('effective_payload_digest').notNull(),
    sourceHash: text('source_hash').notNull(),
    producerEvidenceJson: text('producer_evidence_json').notNull(),
    targetAgentId: text('target_agent_id').notNull(),
    targetAuthorId: text('target_author_id').notNull(),
    targetSessionId: text('target_session_id').notNull(),
    targetRuntime: text('target_runtime').notNull(),
    targetAgentPath: text('target_agent_path').notNull(),
    cascadeRoot: text('cascade_root').notNull(),
    rootRoomId: text('root_room_id').notNull(),
    rootEntryId: text('root_entry_id').notNull(),
    frozenCeiling: integer('frozen_ceiling').notNull(),
    dispatchAttempt: integer('dispatch_attempt').notNull(),
    bootEpoch: text('boot_epoch').notNull(),
    dispatchId: text('dispatch_id').notNull(),
    claimedAtMs: integer('claimed_at_ms').notNull(),
    claimedAt: text('claimed_at').notNull(),
    spendRowId: integer('spend_row_id'),
    status: text('status').notNull(),
    turnId: text('turn_id'),
    outcome: text('outcome'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    rowJson: text('row_json').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.documentId, table.batchId],
      foreignColumns: [canvasDocBatches.documentId, canvasDocBatches.batchId],
    })
      .onUpdate('no action')
      .onDelete('no action'),
    foreignKey({
      columns: [table.documentId, table.grantId],
      foreignColumns: [canvasDocGrants.documentId, canvasDocGrants.grantId],
    })
      .onUpdate('no action')
      .onDelete('no action'),
    foreignKey({
      columns: [table.roomId, table.entryId],
      foreignColumns: [roomEntries.roomId, roomEntries.id],
    })
      .onUpdate('no action')
      .onDelete('no action'),
    foreignKey({
      columns: [table.rootRoomId, table.rootEntryId],
      foreignColumns: [roomEntries.roomId, roomEntries.id],
    })
      .onUpdate('no action')
      .onDelete('no action'),
    uniqueIndex('room_doc_admissions_source_unique').on(
      table.documentId,
      table.batchId,
      table.generation
    ),
    uniqueIndex('room_doc_admissions_document_id_unique').on(table.documentId, table.admissionId),
    uniqueIndex('room_doc_admissions_entry_unique').on(table.roomId, table.entryId),
    uniqueIndex('room_doc_admissions_dispatch_unique').on(table.dispatchId),
    index('room_doc_admissions_document_window').on(table.documentId, table.claimedAtMs),
    index('room_doc_admissions_recovery').on(
      table.status,
      table.bootEpoch,
      table.updatedAt,
      table.admissionId
    ),
    index('room_doc_admissions_root').on(table.cascadeRoot, table.status),
    check('room_doc_admissions_check_0', sql`source_attempt>=0`),
    check('room_doc_admissions_check_1', sql`entry_seq>0`),
    check('room_doc_admissions_check_2', sql`grant_revision>=0`),
    check('room_doc_admissions_check_3', sql`length(route_hash)=64`),
    check('room_doc_admissions_check_4', sql`length(declaration_hash)=64`),
    check('room_doc_admissions_check_5', sql`length(input_fingerprint)=64`),
    check('room_doc_admissions_check_6', sql`length(authority_digest)=64`),
    check('room_doc_admissions_check_7', sql`length(effective_payload_digest)=64`),
    check('room_doc_admissions_check_8', sql`length(source_hash)=64`),
    check('room_doc_admissions_check_9', sql`json_valid(producer_evidence_json)`),
    check(
      'room_doc_admissions_check_10',
      sql`target_runtime IN ('claude-code','codex','opencode')`
    ),
    check('room_doc_admissions_check_11', sql`frozen_ceiling>0`),
    check('room_doc_admissions_check_12', sql`dispatch_attempt=1`),
    check('room_doc_admissions_check_13', sql`spend_row_id IS NULL OR spend_row_id>0`),
    check(
      'room_doc_admissions_check_14',
      sql`status IN ('claimed','turn_started','settled','in_doubt')`
    ),
    check(
      'room_doc_admissions_check_15',
      sql`outcome IS NULL OR outcome IN ('turn_done','failed','cancelled','in_doubt')`
    ),
    check('room_doc_admissions_check_16', sql`json_valid(row_json)`),
    check('room_doc_admissions_check_17', sql`cascade_root=root_entry_id`),
    check(
      'room_doc_admissions_check_18',
      sql`(status='claimed' AND turn_id IS NULL AND outcome IS NULL)
  OR (status='turn_started' AND turn_id IS NOT NULL AND outcome IS NULL)
  OR (status='in_doubt' AND outcome IS 'in_doubt')
  OR (status='settled' AND outcome IS NOT NULL AND (outcome IN ('failed','cancelled')
     OR (outcome='turn_done' AND turn_id IS NOT NULL)))`
    ),
    check(
      'room_doc_admissions_check_19',
      sql`json_extract(row_json,'$.admissionId') IS admission_id
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
  AND json_extract(row_json,'$.updatedAt') IS updated_at`
    ),
  ]
);

export const roomDocAdmissionInputs = sqliteTable(
  'room_doc_admission_inputs',
  {
    admissionId: text('admission_id').notNull(),
    documentId: text('document_id').notNull(),
    eventId: text('event_id').notNull(),
    routeId: text('route_id').notNull(),
    inputOrdinal: integer('input_ordinal').notNull(),
    docSeq: integer('doc_seq').notNull(),
    envelopeHash: text('envelope_hash').notNull(),
    sourceDeliveryStatus: text('source_delivery_status').notNull(),
    sourceDeliveryReason: text('source_delivery_reason'),
  },
  (table) => [
    primaryKey({ columns: [table.admissionId, table.inputOrdinal] }),
    foreignKey({
      columns: [table.documentId, table.admissionId],
      foreignColumns: [roomDocAdmissions.documentId, roomDocAdmissions.admissionId],
    })
      .onUpdate('no action')
      .onDelete('no action'),
    foreignKey({
      columns: [table.documentId, table.eventId],
      foreignColumns: [canvasDocEvents.documentId, canvasDocEvents.eventId],
    })
      .onUpdate('no action')
      .onDelete('no action'),
    foreignKey({
      columns: [table.documentId, table.eventId, table.routeId],
      foreignColumns: [
        canvasDocDeliveries.documentId,
        canvasDocDeliveries.eventId,
        canvasDocDeliveries.routeId,
      ],
    })
      .onUpdate('no action')
      .onDelete('no action'),
    uniqueIndex('room_doc_admission_inputs_event_unique').on(table.admissionId, table.eventId),
    uniqueIndex('room_doc_admission_inputs_route_unique').on(
      table.documentId,
      table.eventId,
      table.routeId
    ),
    check('room_doc_admission_inputs_check_0', sql`input_ordinal>=0 AND input_ordinal<100`),
    check('room_doc_admission_inputs_check_1', sql`doc_seq>0`),
    check('room_doc_admission_inputs_check_2', sql`length(envelope_hash)=64`),
  ]
);

export const roomDocExhaustedLineages = sqliteTable(
  'room_doc_exhausted_lineages',
  {
    cascadeRoot: text('cascade_root').notNull().primaryKey(),
    rootRoomId: text('root_room_id').notNull(),
    rootEntryId: text('root_entry_id').notNull(),
    originalAdmissionId: text('original_admission_id').notNull(),
    frozenCeiling: integer('frozen_ceiling').notNull(),
    exhaustedAt: text('exhausted_at').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.rootRoomId, table.rootEntryId],
      foreignColumns: [roomEntries.roomId, roomEntries.id],
    })
      .onUpdate('no action')
      .onDelete('no action'),
    index('room_doc_exhausted_lineages_anchor').on(table.rootRoomId, table.rootEntryId),
    check('room_doc_exhausted_lineages_check_0', sql`frozen_ceiling>0`),
    check('room_doc_exhausted_lineages_check_1', sql`cascade_root=root_entry_id`),
  ]
);

// No spend FK: normal room_turn_spend expiry must not erase native claim evidence.
// Exhaustion originalAdmissionId is immutable correlation, not a receipt FK.
