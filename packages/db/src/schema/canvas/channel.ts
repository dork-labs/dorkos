import { sql } from 'drizzle-orm';
import {
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { sessionMessageAcceptanceReceipts } from '../session/message-acceptance.js';

/**
 * Durable channel identity and private closure tombstone. Deliberately not a foreign
 * key to canvas_documents: physical eviction must not erase acceptance or recovery evidence.
 */
export const canvasDocChannels = sqliteTable(
  'canvas_doc_channels',
  {
    documentId: text('document_id').primaryKey(),
    scope: text('scope').notNull(),
    nextDocSeq: integer('next_doc_seq').notNull().default(1),
    state: text('state', { mode: 'json' })
      .notNull()
      .default(sql`'{}'`),
    stateRev: integer('state_rev').notNull().default(0),
    /** First retained sequence; older cursors require a snapshot reset. */
    retentionFloor: integer('retention_floor').notNull().default(1),
    /** First sequence with complete receipt membership; older UUIDs may be unknowable. */
    receiptRetentionFloor: integer('receipt_retention_floor').notNull().default(1),
    declaration: text('declaration', { mode: 'json' }),
    declarationHash: text('declaration_hash'),
    openerAgentId: text('opener_agent_id'),
    manifestHash: text('manifest_hash'),
    closedAt: text('closed_at'),
    closureEvidence: text('closure_evidence', { mode: 'json' }),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('canvas_doc_channels_scope_idx').on(table.scope, table.closedAt)]
);

/** Accepted envelopes, ordered independently from the owning scope's stream. */
export const canvasDocEvents = sqliteTable(
  'canvas_doc_events',
  {
    documentId: text('document_id')
      .notNull()
      .references(() => canvasDocChannels.documentId),
    eventId: text('event_id').notNull(),
    docSeq: integer('doc_seq').notNull(),
    direction: text('direction', { enum: ['upstream', 'downstream', 'system'] }).notNull(),
    type: text('type').notNull(),
    payload: text('payload', { mode: 'json' }).notNull(),
    envelopeHash: text('envelope_hash').notNull(),
    /** Exact canonical UTF-8 envelope size; zero marks foundation rows awaiting backfill. */
    envelopeBytes: integer('envelope_bytes').notNull().default(0),
    /** Compact receipt header remains after app payload/provenance removal. */
    payloadPrunedAt: text('payload_pruned_at'),
    coalesceKey: text('coalesce_key'),
    clientTs: text('client_ts'),
    receivedAt: text('received_at').notNull(),
    provenance: text('provenance', { mode: 'json' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.documentId, table.eventId] }),
    uniqueIndex('canvas_doc_events_sequence_unique').on(table.documentId, table.docSeq),
    index('canvas_doc_events_received_idx').on(table.documentId, table.receivedAt),
    index('canvas_doc_events_retention_idx').on(table.receivedAt, table.documentId, table.docSeq),
    index('canvas_doc_events_unaccounted_idx')
      .on(table.documentId, table.eventId)
      .where(sql`${table.envelopeBytes}=0 AND ${table.payloadPrunedAt} IS NULL`),
  ]
);

/** Exact server-approved route authority; hashes bind approval to its declarations. */
export const canvasDocGrants = sqliteTable(
  'canvas_doc_grants',
  {
    grantId: text('grant_id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => canvasDocChannels.documentId),
    routeId: text('route_id').notNull(),
    revision: integer('revision').notNull().default(1),
    openerAgentId: text('opener_agent_id'),
    targetAgentId: text('target_agent_id'),
    targetSessionId: text('target_session_id'),
    targetRuntime: text('target_runtime'),
    normalizedRoute: text('normalized_route', { mode: 'json' }).notNull(),
    routeHash: text('route_hash').notNull(),
    declarationHash: text('declaration_hash').notNull(),
    manifestHash: text('manifest_hash'),
    approvedBy: text('approved_by').notNull(),
    approvalId: text('approval_id'),
    approvalEvidence: text('approval_evidence', { mode: 'json' }).notNull(),
    limits: text('limits', { mode: 'json' }).notNull(),
    allowedTypes: text('allowed_types', { mode: 'json' }).$type<string[]>().notNull(),
    writeOperation: text('write_operation', { mode: 'json' }),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at'),
    revokedAt: text('revoked_at'),
  },
  (table) => [
    uniqueIndex('canvas_doc_grants_document_id_unique').on(table.documentId, table.grantId),
    index('canvas_doc_grants_route_idx').on(table.documentId, table.routeId, table.revokedAt),
  ]
);

/**
 * Durable coalescing backlog and immutable admitted source generation. Acceptance
 * freezes inputEventIds/effectivePayload/generation; the store owns that CAS. The
 * nullable reference reuses shared admission without extending its source union here.
 */
export const canvasDocBatches = sqliteTable(
  'canvas_doc_batches',
  {
    batchId: text('batch_id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => canvasDocChannels.documentId),
    scope: text('scope').notNull(),
    routeId: text('route_id').notNull(),
    grantId: text('grant_id').notNull(),
    grantRevision: integer('grant_revision').notNull(),
    generation: text('generation').notNull(),
    inputEventIds: text('input_event_ids', { mode: 'json' }).$type<string[]>().notNull(),
    effectivePayload: text('effective_payload', { mode: 'json' }).notNull(),
    dueAt: text('due_at').notNull(),
    status: text('status', {
      enum: [
        'pending',
        'waiting',
        'accepted',
        'dispatching',
        'turn_started',
        'turn_done',
        'failed',
        'expired',
        'cancelled',
        'in_doubt',
      ],
    }).notNull(),
    attempt: integer('attempt').notNull().default(0),
    leaseUntil: text('lease_until'),
    waitingWarningAt: text('waiting_warning_at').default(sql`NULL`),
    relayMessageId: text('relay_message_id'),
    turnId: text('turn_id'),
    admissionReceiptId: text('admission_receipt_id').references(
      () => sessionMessageAcceptanceReceipts.id
    ),
    errorCode: text('error_code'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('canvas_doc_batches_document_id_unique').on(table.documentId, table.batchId),
    foreignKey({
      columns: [table.documentId, table.grantId],
      foreignColumns: [canvasDocGrants.documentId, canvasDocGrants.grantId],
    }),
    // Waiting is mergeable; in_doubt keeps the active slot until explicit settlement.
    uniqueIndex('canvas_doc_batches_pending_unique')
      .on(table.documentId, table.routeId)
      .where(sql`"status" in ('pending', 'waiting')`),
    uniqueIndex('canvas_doc_batches_active_unique')
      .on(table.documentId, table.routeId)
      .where(sql`"status" in ('accepted', 'dispatching', 'turn_started', 'in_doubt')`),
    index('canvas_doc_batches_due_idx').on(table.status, table.dueAt),
    index('canvas_doc_batches_lease_idx').on(table.status, table.leaseUntil),
    index('canvas_doc_batches_receipt_idx').on(table.admissionReceiptId),
  ]
);

/** Every routed input keeps its own outcome, even when its payload is superseded. */
export const canvasDocDeliveries = sqliteTable(
  'canvas_doc_deliveries',
  {
    documentId: text('document_id').notNull(),
    eventId: text('event_id').notNull(),
    routeId: text('route_id').notNull(),
    batchId: text('batch_id'),
    status: text('status', {
      enum: [
        'saved',
        'pending',
        'waiting',
        'routed',
        'superseded',
        'turn_started',
        'turn_done',
        'failed',
        'expired',
        'cancelled',
        'in_doubt',
      ],
    }).notNull(),
    turnId: text('turn_id'),
    reason: text('reason'),
    ackOutcome: text('ack_outcome', { enum: ['handled', 'rejected'] }),
    acknowledgedAt: text('acknowledged_at'),
    acknowledgedBy: text('acknowledged_by'),
    ackEvidence: text('ack_evidence', { mode: 'json' }),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.documentId, table.eventId, table.routeId] }),
    foreignKey({
      columns: [table.documentId, table.eventId],
      foreignColumns: [canvasDocEvents.documentId, canvasDocEvents.eventId],
    }),
    foreignKey({
      columns: [table.documentId, table.batchId],
      foreignColumns: [canvasDocBatches.documentId, canvasDocBatches.batchId],
    }),
    index('canvas_doc_deliveries_batch_idx').on(table.documentId, table.batchId),
    index('canvas_doc_deliveries_status_idx').on(table.status, table.updatedAt),
  ]
);

/** Recoverable ownership moves, retained separately from ordinary event payloads. */
export const canvasDocIdentityIntents = sqliteTable(
  'canvas_doc_identity_intents',
  {
    intentId: text('intent_id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => canvasDocChannels.documentId),
    fromScope: text('from_scope').notNull(),
    toScope: text('to_scope').notNull(),
    sourceId: text('source_id').notNull(),
    sourceGeneration: text('source_generation').notNull(),
    evidence: text('evidence', { mode: 'json' }).notNull(),
    status: text('status', { enum: ['pending', 'applied', 'in_doubt', 'failed'] }).notNull(),
    errorCode: text('error_code'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('canvas_doc_identity_intents_recovery_idx').on(table.status, table.updatedAt)]
);

/** Before/after file evidence prevents crash recovery from blindly repeating a write. */
export const canvasDocWriteIntents = sqliteTable(
  'canvas_doc_write_intents',
  {
    intentId: text('intent_id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => canvasDocChannels.documentId),
    eventId: text('event_id').notNull(),
    envelopeHash: text('envelope_hash').notNull(),
    grantId: text('grant_id').notNull(),
    sourceIdentity: text('source_identity', { mode: 'json' }).notNull(),
    resolvedCwd: text('resolved_cwd').notNull(),
    treeKind: text('tree_kind').notNull(),
    canonicalPath: text('canonical_path').notNull(),
    operation: text('operation', { enum: ['checkbox-toggle'] }).notNull(),
    input: text('input', { mode: 'json' }).notNull(),
    beforeHash: text('before_hash').notNull(),
    afterHash: text('after_hash').notNull(),
    expectedVersion: text('expected_version').notNull(),
    evidence: text('evidence', { mode: 'json' }),
    status: text('status', {
      enum: ['prepared', 'replaced', 'committed', 'no_op', 'conflict', 'in_doubt', 'failed'],
    }).notNull(),
    errorCode: text('error_code'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('canvas_doc_write_intents_event_unique').on(table.documentId, table.eventId),
    foreignKey({
      columns: [table.documentId, table.grantId],
      foreignColumns: [canvasDocGrants.documentId, canvasDocGrants.grantId],
    }),
    index('canvas_doc_write_intents_recovery_idx').on(table.status, table.updatedAt),
    index('canvas_doc_write_intents_path_idx').on(table.canonicalPath, table.status),
  ]
);
