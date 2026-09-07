/** Durable local connector identity, authority, and migration schema. */
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/** One configured provider instance and payer. */
export const connectorProviderInstances = sqliteTable(
  'connector_provider_instances',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    mode: text('mode', { enum: ['managed', 'byo'] }).notNull(),
    displayName: text('display_name').notNull(),
    custody: text('custody', { enum: ['managed', 'self-host', 'external'] }).notNull(),
    capabilityJson: text('capability_json').notNull(),
    credentialRef: text('credential_ref'),
    executionConfigDigest: text('execution_config_digest'),
    executionConfigGeneration: integer('execution_config_generation').notNull().default(0),
    /** Verified account or installation that owns this configured instance. */
    ownerKind: text('owner_kind', { enum: ['user', 'local_install'] }),
    /** Stable user or installation id; null only on unresolved historical rows. */
    ownerId: text('owner_id'),
    status: text('status', { enum: ['available', 'unavailable', 'migration_failed'] }).notNull(),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('connector_provider_instances_type_idx').on(table.type)]
);

/** Stable DorkOS connection with a private provider account binding. */
export const connections = sqliteTable(
  'connections',
  {
    id: text('id').primaryKey(),
    providerInstanceId: text('provider_instance_id')
      .notNull()
      .references(() => connectorProviderInstances.id),
    externalAccountRef: text('external_account_ref').notNull(),
    toolkit: text('toolkit').notNull(),
    label: text('label').notNull(),
    identityHint: text('identity_hint'),
    status: text('status', {
      enum: ['active', 'expired', 'revoked', 'pending'],
    }).notNull(),
    /** Local tombstone that provider inventory cannot clear. */
    lifecycleState: text('lifecycle_state', { enum: ['connected', 'disconnected'] })
      .notNull()
      .default('connected'),
    /** Operator pause, kept separate from provider-reported authentication status. */
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    authConfigRef: text('auth_config_ref'),
    grantReconciliationStatus: text('grant_reconciliation_status', {
      enum: ['ready', 'migration_needs_reconcile'],
    })
      .notNull()
      .default('migration_needs_reconcile'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    lastVerifiedAt: text('last_verified_at'),
  },
  (table) => [
    uniqueIndex('connections_instance_external_ref_unique').on(
      table.providerInstanceId,
      table.externalAccountRef
    ),
    index('connections_toolkit_idx').on(table.toolkit),
  ]
);

/** Immutable provider operation schema and security classification. */
export const connectorOperationRevisions = sqliteTable(
  'connector_operation_revisions',
  {
    id: text('id').primaryKey(),
    providerInstanceId: text('provider_instance_id')
      .notNull()
      .references(() => connectorProviderInstances.id),
    toolkit: text('toolkit').notNull(),
    operationSlug: text('operation_slug').notNull(),
    toolkitVersion: text('toolkit_version').notNull(),
    schemaHash: text('schema_hash').notNull(),
    capabilityClassification: text('capability_classification', {
      enum: ['read', 'write', 'destructive'],
    }).notNull(),
    retryPolicy: text('retry_policy', {
      enum: ['never', 'provider_idempotency_key'],
    })
      .notNull()
      .default('never'),
    /** Immutable upstream revision identity; empty for providers without revision references. */
    providerRevisionRef: text('provider_revision_ref').notNull().default(''),
    inputSchemaJson: text('input_schema_json').notNull(),
    discoveredAt: text('discovered_at').notNull(),
  },
  (table) => [
    uniqueIndex('connector_operation_revision_fingerprint_unique').on(
      table.providerInstanceId,
      table.toolkit,
      table.operationSlug,
      table.toolkitVersion,
      table.schemaHash,
      table.capabilityClassification,
      table.retryPolicy,
      table.providerRevisionRef
    ),
  ]
);

/** Explicit grant of one immutable operation revision to an agent or session. */
export const connectionOperationGrants = sqliteTable(
  'connection_operation_grants',
  {
    id: text('id').primaryKey(),
    subjectType: text('subject_type', { enum: ['agent', 'session'] }).notNull(),
    subjectId: text('subject_id').notNull(),
    agentId: text('agent_id'),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    operationRevisionId: text('operation_revision_id')
      .notNull()
      .references(() => connectorOperationRevisions.id),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
    revokedAt: text('revoked_at'),
  },
  (table) => [
    uniqueIndex('connection_operation_grants_subject_revision_unique').on(
      table.subjectType,
      table.subjectId,
      table.connectionId,
      table.operationRevisionId
    ),
    index('connection_operation_grants_agent_idx').on(table.agentId),
    index('connection_operation_grants_connection_revision_idx').on(
      table.connectionId,
      table.operationRevisionId
    ),
  ]
);

/** Canonical stable replacement for legacy agent account attachments. */
export const agentConnectionAttachments = sqliteTable(
  'agent_connection_attachments',
  {
    agentId: text('agent_id').notNull(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    attachedAt: text('attached_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.connectionId] }),
    index('agent_connection_attachments_connection_idx').on(table.connectionId),
  ]
);

/** Canonical attached/detached session precedence record. */
export const sessionConnectionOverrides = sqliteTable(
  'session_connection_overrides',
  {
    sessionId: text('session_id').notNull(),
    agentId: text('agent_id'),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    state: text('state', { enum: ['attached', 'detached'] }).notNull(),
    needsReconciliation: integer('needs_reconciliation', { mode: 'boolean' })
      .notNull()
      .default(false),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.connectionId] }),
    index('session_connection_overrides_agent_idx').on(table.agentId),
    index('session_connection_overrides_connection_idx').on(table.connectionId),
  ]
);

/**
 * Removed agent ids whose retained legacy consent rows must never be backfilled.
 *
 * This marker deliberately has no agent foreign key: it must survive removal
 * and only fences the one-way legacy migration. A later explicit attachment or
 * grant for a re-registered agent is canonical data and remains allowed.
 */
export const connectorLegacyAgentRevocations = sqliteTable('connector_legacy_agent_revocations', {
  agentId: text('agent_id').primaryKey(),
  revokedAt: text('revoked_at').notNull(),
});

/** Completed connector application backfills, distinct from Drizzle's ledger. */
export const connectorApplicationMigrations = sqliteTable('connector_application_migrations', {
  version: integer('version').primaryKey(),
  state: text('state', { enum: ['claimed', 'complete'] }).notNull(),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
});
