/** Durable connector reconciliation and runtime-authority state. */
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import {
  connections,
  connectorOperationRevisions,
  connectorProviderInstances,
} from './connections.js';

/** Server-owned complete operation snapshot awaiting an owner decision. */
export const connectorReconciliationPreviews = sqliteTable(
  'connector_reconciliation_previews',
  {
    id: text('id').primaryKey(),
    ownerKind: text('owner_kind', { enum: ['user', 'local_install'] }).notNull(),
    ownerId: text('owner_id').notNull(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connections.id),
    providerInstanceId: text('provider_instance_id')
      .notNull()
      .references(() => connectorProviderInstances.id),
    /** Process generation that created the preview; restart always invalidates it. */
    bootEpoch: text('boot_epoch').notNull(),
    executionConfigGeneration: integer('execution_config_generation').notNull(),
    completeRevisionSetHash: text('complete_revision_set_hash').notNull(),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    consumedAt: text('consumed_at'),
  },
  (table) => [
    index('connector_reconciliation_previews_owner_state_idx').on(
      table.ownerKind,
      table.ownerId,
      table.consumedAt,
      table.expiresAt
    ),
    index('connector_reconciliation_previews_connection_idx').on(table.connectionId),
  ]
);

/** Exact operation member of one complete reconciliation snapshot. */
export const connectorReconciliationCandidates = sqliteTable(
  'connector_reconciliation_candidates',
  {
    previewId: text('preview_id')
      .notNull()
      .references(() => connectorReconciliationPreviews.id, { onDelete: 'cascade' }),
    operationRevisionId: text('operation_revision_id')
      .notNull()
      .references(() => connectorOperationRevisions.id),
    supported: integer('supported', { mode: 'boolean' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.previewId, table.operationRevisionId] })]
);

/** Named agent whose exact grants may be replaced by one reconciliation apply. */
export const connectorReconciliationAgents = sqliteTable(
  'connector_reconciliation_agents',
  {
    previewId: text('preview_id')
      .notNull()
      .references(() => connectorReconciliationPreviews.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.previewId, table.agentId] }),
    index('connector_reconciliation_agents_agent_idx').on(table.agentId, table.previewId),
  ]
);

/** Existing exact grant preserved as the default for one named agent in a preview. */
export const connectorReconciliationDefaults = sqliteTable(
  'connector_reconciliation_defaults',
  {
    previewId: text('preview_id')
      .notNull()
      .references(() => connectorReconciliationPreviews.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(),
    operationRevisionId: text('operation_revision_id')
      .notNull()
      .references(() => connectorOperationRevisions.id),
  },
  (table) => [
    primaryKey({ columns: [table.previewId, table.agentId, table.operationRevisionId] }),
    index('connector_reconciliation_defaults_agent_idx').on(table.agentId, table.previewId),
  ]
);

/** Hashed short-lived bearer binding for one active runtime turn. */
export const connectorRuntimeBindings = sqliteTable(
  'connector_runtime_bindings',
  {
    id: text('id').primaryKey(),
    tokenHash: text('token_hash').notNull().unique(),
    bootEpoch: text('boot_epoch').notNull(),
    ownerKind: text('owner_kind', { enum: ['user', 'local_install'] }).notNull(),
    ownerId: text('owner_id').notNull(),
    runtime: text('runtime', { enum: ['claude-code', 'codex', 'opencode'] }).notNull(),
    canonicalSessionId: text('canonical_session_id').notNull(),
    agentId: text('agent_id').notNull(),
    agentPath: text('agent_path').notNull(),
    canonicalCwd: text('canonical_cwd'),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    revokedAt: text('revoked_at'),
    revokeReason: text('revoke_reason'),
  },
  (table) => [
    index('connector_runtime_bindings_agent_idx').on(table.agentId, table.revokedAt),
    index('connector_runtime_bindings_session_idx').on(table.canonicalSessionId, table.revokedAt),
    index('connector_runtime_bindings_expiry_idx').on(
      table.bootEpoch,
      table.revokedAt,
      table.expiresAt
    ),
  ]
);
