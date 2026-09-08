/**
 * Tenant-scoped hosted connector authority and accounting schema.
 *
 * Every externally supplied identifier is resolved beneath `tenantId`; private
 * provider account/configuration references never leave the hosted service.
 * Execution arguments and results are deliberately absent from these tables.
 *
 * @module db/managed-connectors-schema
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { user } from './auth-schema';
import { instance } from './instance-schema';

/** One random hosted connector tenant per Better Auth account. */
export const connectorTenant = pgTable(
  'connector_tenant',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    providerUserId: uuid('provider_user_id').notNull().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('connector_tenant_owner_unique').on(table.ownerUserId),
    uniqueIndex('connector_tenant_provider_user_unique').on(table.providerUserId),
  ]
);

/** Exact server-owned provider material used by one tenant. */
export const managedConnectorProvider = pgTable(
  'managed_connector_provider',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => connectorTenant.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    providerType: text('provider_type').notNull(),
    configurationDigest: text('configuration_digest').notNull(),
    materialGeneration: integer('material_generation').notNull().default(1),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    uniqueIndex('managed_connector_provider_tenant_type_unique').on(
      table.tenantId,
      table.providerType
    ),
  ]
);

/** Stable site-owned connection mapped privately to one provider account. */
export const managedConnectorConnection = pgTable(
  'managed_connector_connection',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => connectorTenant.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    originatingInstanceId: text('originating_instance_id').notNull(),
    providerInstanceId: text('provider_instance_id').notNull(),
    providerUserId: uuid('provider_user_id').notNull(),
    externalAccountRef: text('external_account_ref').notNull(),
    toolkit: text('toolkit').notNull(),
    authConfigId: text('auth_config_id').notNull(),
    label: text('label').notNull(),
    lifecycle: text('lifecycle').notNull().$type<'active' | 'paused' | 'disconnected'>(),
    authenticationStatus: text('authentication_status')
      .notNull()
      .$type<'active' | 'expired' | 'revoked' | 'pending'>(),
    materialGeneration: integer('material_generation').notNull(),
    bindingGeneration: integer('binding_generation').notNull().default(1),
    lifecycleScopeVersion: integer('lifecycle_scope_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    foreignKey({
      columns: [table.tenantId, table.providerInstanceId],
      foreignColumns: [managedConnectorProvider.tenantId, managedConnectorProvider.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.originatingInstanceId],
      foreignColumns: [instance.id],
    }).onDelete('cascade'),
    uniqueIndex('managed_connector_connection_external_unique').on(
      table.tenantId,
      table.providerInstanceId,
      table.externalAccountRef
    ),
    index('managed_connector_connection_tenant_lifecycle').on(table.tenantId, table.lifecycle),
    index('managed_connector_connection_origin').on(table.tenantId, table.originatingInstanceId),
  ]
);

/** Immutable exact operation revision available to hosted enforcement. */
export const managedConnectorOperationRevision = pgTable(
  'managed_connector_operation_revision',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => connectorTenant.id, { onDelete: 'cascade' }),
    id: uuid('id').notNull().defaultRandom(),
    providerInstanceId: text('provider_instance_id').notNull(),
    toolkit: text('toolkit').notNull(),
    operationSlug: text('operation_slug').notNull(),
    toolkitVersion: text('toolkit_version').notNull(),
    schemaHash: text('schema_hash').notNull(),
    classification: text('classification').notNull().$type<'read' | 'write' | 'destructive'>(),
    current: boolean('current').notNull().default(true),
    inputSchema: jsonb('input_schema').notNull().$type<Record<string, unknown>>(),
    discoveredAt: timestamp('discovered_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    foreignKey({
      columns: [table.tenantId, table.providerInstanceId],
      foreignColumns: [managedConnectorProvider.tenantId, managedConnectorProvider.id],
    }).onDelete('cascade'),
    // History may contain the same classification again, but a reclassification
    // always creates a fresh identity and never revives an old grant.
    uniqueIndex('managed_connector_revision_current_unique')
      .on(
        table.tenantId,
        table.providerInstanceId,
        table.toolkit,
        table.operationSlug,
        table.toolkitVersion,
        table.schemaHash
      )
      .where(sql`${table.current} = true`),
  ]
);

/** One exact active or retained grant for an agent on a linked instance. */
export const managedConnectorGrant = pgTable(
  'managed_connector_grant',
  {
    tenantId: uuid('tenant_id').notNull(),
    instanceId: text('instance_id').notNull(),
    connectionId: text('connection_id').notNull(),
    agentId: text('agent_id').notNull(),
    operationRevisionId: uuid('operation_revision_id').notNull(),
    scopeVersion: integer('scope_version').notNull(),
    active: boolean('active').notNull().default(false),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.tenantId,
        table.instanceId,
        table.connectionId,
        table.agentId,
        table.operationRevisionId,
      ],
    }),
    foreignKey({
      columns: [table.tenantId, table.connectionId],
      foreignColumns: [managedConnectorConnection.tenantId, managedConnectorConnection.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.tenantId, table.operationRevisionId],
      foreignColumns: [
        managedConnectorOperationRevision.tenantId,
        managedConnectorOperationRevision.id,
      ],
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.instanceId],
      foreignColumns: [instance.id],
    }).onDelete('cascade'),
    index('managed_connector_grant_dispatch_lookup').on(
      table.tenantId,
      table.instanceId,
      table.connectionId,
      table.agentId,
      table.scopeVersion,
      table.active
    ),
  ]
);

/** Durable idempotent local-to-hosted authority command. */
export const managedConnectorAuthorityCommand = pgTable(
  'managed_connector_authority_command',
  {
    tenantId: uuid('tenant_id').notNull(),
    instanceId: text('instance_id').notNull(),
    commandId: text('command_id').notNull(),
    requestHash: text('request_hash').notNull(),
    connectionId: text('connection_id').notNull(),
    kind: text('kind')
      .notNull()
      .$type<'replace_agent_grants' | 'set_connection_lifecycle' | 'set_event_subscription'>(),
    agentId: text('agent_id'),
    scopeKey: text('scope_key').notNull(),
    scopeVersion: integer('scope_version').notNull(),
    requestPayload: jsonb('request_payload').notNull().$type<Record<string, unknown>>(),
    state: text('state').notNull().$type<'pending' | 'applied' | 'rejected' | 'superseded'>(),
    appliedRevisionSetHash: text('applied_revision_set_hash'),
    appliedEventScopeHash: text('applied_event_scope_hash'),
    eventBindingId: uuid('event_binding_id'),
    rejectionCode: text('rejection_code'),
    // Captured from the server-owned binding, never supplied by a caller.
    cleanupBinding: jsonb('cleanup_binding').$type<{
      providerInstanceId: string;
      providerUserId: string;
      externalAccountRef: string;
      bindingGeneration: number;
      materialGeneration: number;
    }>(),
    cleanupClaimedAt: timestamp('cleanup_claimed_at', { withTimezone: true }),
    /** Disable-only event maintenance retry, independent of the physical trigger lease. */
    eventCleanupAfter: timestamp('event_cleanup_after', { withTimezone: true }),
    externalCleanup: text('external_cleanup')
      .notNull()
      .default('not_required')
      .$type<'not_required' | 'pending' | 'complete' | 'failed'>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.instanceId, table.commandId] }),
    // A rejected command for an unknown tenant-scoped connection remains
    // durable and queryable, so this target intentionally has no FK.
    foreignKey({ columns: [table.instanceId], foreignColumns: [instance.id] }).onDelete('cascade'),
    index('managed_connector_event_cleanup_due').on(
      table.kind,
      table.state,
      table.externalCleanup,
      table.eventCleanupAfter
    ),
    index('managed_connector_authority_scope').on(
      table.tenantId,
      table.instanceId,
      table.connectionId,
      table.agentId,
      table.scopeVersion
    ),
    uniqueIndex('managed_connector_authority_scope_version_unique').on(
      table.tenantId,
      table.instanceId,
      table.connectionId,
      table.scopeKey,
      table.scopeVersion
    ),
  ]
);

/** Expiring owner-bound browser authentication flow. */
export const managedConnectorAuthFlow = pgTable(
  'managed_connector_auth_flow',
  {
    tenantId: uuid('tenant_id').notNull(),
    id: uuid('id').notNull().defaultRandom(),
    ownerUserId: text('owner_user_id').notNull(),
    instanceId: text('instance_id').notNull(),
    providerInstanceId: text('provider_instance_id').notNull(),
    materialGeneration: integer('material_generation').notNull(),
    providerUserId: uuid('provider_user_id').notNull(),
    toolkit: text('toolkit').notNull(),
    requestedLabel: text('requested_label'),
    authConfigId: text('auth_config_id').notNull(),
    provisionalExternalAccountRef: text('provisional_external_account_ref'),
    upstreamAuthorizeUrl: text('upstream_authorize_url'),
    connectionId: text('connection_id'),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    browserNonceHash: text('browser_nonce_hash').notNull(),
    completionSessionHash: text('completion_session_hash'),
    browserCompletionHash: text('browser_completion_hash'),
    state: text('state')
      .notNull()
      .$type<
        'starting' | 'start_unknown' | 'waiting' | 'consumed' | 'connected' | 'failed' | 'reconcile'
      >(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    browserBoundAt: timestamp('browser_bound_at', { withTimezone: true }),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    foreignKey({
      columns: [table.tenantId, table.providerInstanceId],
      foreignColumns: [managedConnectorProvider.tenantId, managedConnectorProvider.id],
    }).onDelete('cascade'),
    foreignKey({ columns: [table.instanceId], foreignColumns: [instance.id] }).onDelete('cascade'),
    uniqueIndex('managed_connector_auth_flow_idempotency_unique').on(
      table.tenantId,
      table.instanceId,
      table.idempotencyKey
    ),
    index('managed_connector_auth_flow_expiry').on(table.tenantId, table.state, table.expiresAt),
  ]
);

/** Append-only authoritative hosted attempt receipt without arguments or result data. */
export const managedConnectorExecutionAttempt = pgTable(
  'managed_connector_execution_attempt',
  {
    tenantId: uuid('tenant_id').notNull(),
    instanceId: text('instance_id').notNull(),
    attemptId: text('attempt_id').notNull(),
    logicalOperationId: text('logical_operation_id').notNull(),
    attemptIndex: integer('attempt_index').notNull(),
    requestHash: text('request_hash').notNull(),
    connectionId: text('connection_id').notNull(),
    agentId: text('agent_id').notNull(),
    surface: text('surface').notNull().$type<'mcp' | 'rest' | 'cli' | 'event'>(),
    actorKind: text('actor_kind')
      .notNull()
      .$type<'operator' | 'agent' | 'program' | 'event' | 'runtime'>(),
    actorId: text('actor_id').notNull(),
    sessionId: text('session_id'),
    grantScopeVersion: integer('grant_scope_version').notNull(),
    operationRevisionId: uuid('operation_revision_id').notNull(),
    state: text('state').notNull().$type<'pending' | 'recorded'>(),
    executionLeaseToken: uuid('execution_lease_token').notNull(),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }).notNull(),
    dispatchClaimedAt: timestamp('dispatch_claimed_at', { withTimezone: true }),
    receiptId: uuid('receipt_id').notNull().defaultRandom(),
    outcome: text('outcome').$type<
      'success' | 'error' | 'cancelled' | 'outcome_unknown' | 'unsupported'
    >(),
    errorCode: text('error_code'),
    /** Private provider lookup reference. Never projected into public receipts or usage. */
    providerLogId: varchar('provider_log_id', { length: 1024 }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.instanceId, table.attemptId] }),
    foreignKey({
      columns: [table.tenantId, table.connectionId],
      foreignColumns: [managedConnectorConnection.tenantId, managedConnectorConnection.id],
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.tenantId, table.operationRevisionId],
      foreignColumns: [
        managedConnectorOperationRevision.tenantId,
        managedConnectorOperationRevision.id,
      ],
    }).onDelete('restrict'),
    foreignKey({ columns: [table.instanceId], foreignColumns: [instance.id] }).onDelete('cascade'),
    uniqueIndex('managed_connector_execution_receipt_unique').on(table.tenantId, table.receiptId),
    index('managed_connector_execution_logical_operation').on(
      table.tenantId,
      table.logicalOperationId,
      table.attemptIndex
    ),
    index('managed_connector_execution_connection_started').on(
      table.tenantId,
      table.instanceId,
      table.connectionId,
      table.createdAt,
      table.attemptId
    ),
    index('managed_connector_execution_agent_started').on(
      table.tenantId,
      table.instanceId,
      table.agentId,
      table.createdAt,
      table.attemptId
    ),
  ]
);

export type ConnectorTenant = typeof connectorTenant.$inferSelect;
export type ManagedConnectorProvider = typeof managedConnectorProvider.$inferSelect;
export type ManagedConnectorConnection = typeof managedConnectorConnection.$inferSelect;
export type ManagedConnectorOperationRevision =
  typeof managedConnectorOperationRevision.$inferSelect;
export type ManagedConnectorGrant = typeof managedConnectorGrant.$inferSelect;
export type ManagedConnectorAuthorityCommandRow =
  typeof managedConnectorAuthorityCommand.$inferSelect;
export type ManagedConnectorAuthFlow = typeof managedConnectorAuthFlow.$inferSelect;
export type ManagedConnectorExecutionAttempt = typeof managedConnectorExecutionAttempt.$inferSelect;
