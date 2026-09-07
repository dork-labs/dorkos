/** Durable local connector authentication, managed authority, and receipt-mirror state. */
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { connections, connectorProviderInstances } from './connections.js';
import { connectorUsageAttempts } from './connector-usage.js';

/** Restart-safe owner authentication flow bound to one exact provider generation. */
export const connectorAuthenticationFlows = sqliteTable(
  'connector_authentication_flows',
  {
    id: text('id').primaryKey(),
    ownerKind: text('owner_kind', { enum: ['user', 'local_install'] }).notNull(),
    ownerId: text('owner_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    providerInstanceId: text('provider_instance_id')
      .notNull()
      .references(() => connectorProviderInstances.id),
    executionConfigGeneration: integer('execution_config_generation').notNull(),
    /** Provider-private flow handle. Never returned from a public route. */
    providerFlowId: text('provider_flow_id'),
    toolkit: text('toolkit').notNull(),
    label: text('label'),
    /** Stable local connection being reauthenticated, when this is reconnect. */
    reconnectConnectionId: text('reconnect_connection_id').references(() => connections.id),
    /** Owner-only provider consent URL; cleared on every terminal transition. */
    authorizeUrl: text('authorize_url'),
    /** Optional hash of callback state when a provider returns one to DorkOS. */
    callbackStateHash: text('callback_state_hash'),
    state: text('state', {
      enum: ['starting', 'pending', 'connected', 'failed', 'expired', 'start_unknown'],
    }).notNull(),
    resultConnectionId: text('result_connection_id').references(() => connections.id),
    failureReason: text('failure_reason'),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    completedAt: text('completed_at'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('connector_auth_flows_owner_state_idx').on(
      table.ownerKind,
      table.ownerId,
      table.state,
      table.expiresAt
    ),
    uniqueIndex('connector_auth_flows_owner_idempotency_unique').on(
      table.ownerKind,
      table.ownerId,
      table.idempotencyKey
    ),
    index('connector_auth_flows_provider_idx').on(
      table.providerInstanceId,
      table.executionConfigGeneration,
      table.state
    ),
  ]
);

/** Latest monotonic version for one managed connection authority scope. */
export const connectorManagedAuthorityScopes = sqliteTable(
  'connector_managed_authority_scopes',
  {
    managedConnectionId: text('managed_connection_id').notNull(),
    scopeKind: text('scope_kind', {
      enum: ['agent_grants', 'connection_lifecycle', 'event_subscription'],
    }).notNull(),
    /** Agent id for grants, subscription id for events, or fixed `connection` for lifecycle. */
    subjectId: text('subject_id').notNull(),
    scopeVersion: integer('scope_version').notNull(),
    lastCommandId: text('last_command_id').notNull(),
    lastCommandHash: text('last_command_hash').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('connector_managed_authority_scope_unique').on(
      table.managedConnectionId,
      table.scopeKind,
      table.subjectId
    ),
  ]
);

/** Durable idempotent local-to-hosted authority command outbox. */
export const connectorManagedAuthorityOutbox = sqliteTable(
  'connector_managed_authority_outbox',
  {
    commandId: text('command_id').primaryKey(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connections.id),
    providerInstanceId: text('provider_instance_id')
      .notNull()
      .references(() => connectorProviderInstances.id),
    executionConfigGeneration: integer('execution_config_generation').notNull(),
    ownerKind: text('owner_kind', { enum: ['user', 'local_install'] }).notNull(),
    ownerId: text('owner_id').notNull(),
    managedConnectionId: text('managed_connection_id').notNull(),
    scopeKind: text('scope_kind', {
      enum: ['agent_grants', 'connection_lifecycle', 'event_subscription'],
    }).notNull(),
    subjectId: text('subject_id').notNull(),
    scopeVersion: integer('scope_version').notNull(),
    requestHash: text('request_hash').notNull(),
    requestJson: text('request_json').notNull(),
    state: text('state', { enum: ['pending', 'applied', 'rejected', 'superseded'] }).notNull(),
    safeReason: text('safe_reason'),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: text('next_attempt_at'),
    leaseOwner: text('lease_owner'),
    leasedUntil: text('leased_until'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    resolvedAt: text('resolved_at'),
    compactedAt: text('compacted_at'),
  },
  (table) => [
    uniqueIndex('connector_managed_authority_version_unique').on(
      table.managedConnectionId,
      table.scopeKind,
      table.subjectId,
      table.scopeVersion
    ),
    index('connector_managed_authority_claim_idx').on(
      table.state,
      table.nextAttemptAt,
      table.leasedUntil
    ),
  ]
);

/** Append-only local mirror of one hosted authoritative managed receipt. */
export const connectorManagedUsageMirrors = sqliteTable(
  'connector_managed_usage_mirrors',
  {
    hostedReceiptId: text('hosted_receipt_id').primaryKey(),
    attemptId: text('attempt_id')
      .notNull()
      .unique()
      .references(() => connectorUsageAttempts.attemptId),
    outcome: text('outcome', {
      enum: ['success', 'error', 'cancelled', 'outcome_unknown', 'unsupported'],
    }).notNull(),
    errorCode: text('error_code'),
    completedAt: text('completed_at'),
    recordedAt: text('recorded_at').notNull(),
    mirroredAt: text('mirrored_at').notNull(),
  },
  (table) => [index('connector_managed_usage_mirrors_recorded_idx').on(table.recordedAt)]
);

/** Durable fair-retry schedule for managed attempts still missing a hosted receipt. */
export const connectorManagedReceiptRecoveries = sqliteTable(
  'connector_managed_receipt_recoveries',
  {
    attemptId: text('attempt_id')
      .primaryKey()
      .references(() => connectorUsageAttempts.attemptId, { onDelete: 'cascade' }),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: text('next_attempt_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('connector_managed_receipt_recovery_due_idx').on(table.nextAttemptAt)]
);
