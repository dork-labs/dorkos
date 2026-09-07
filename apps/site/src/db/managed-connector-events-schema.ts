/** Tenant-scoped managed receive consent, private physical triggers and protected delivery inbox. */
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
} from 'drizzle-orm/pg-core';
import {
  connectorTenant,
  managedConnectorConnection,
  managedConnectorProvider,
} from './managed-connectors-schema';

/** Immutable server-owned event definition; discovery changes require fresh receive consent. */
export const managedConnectorEventDefinition = pgTable(
  'managed_connector_event_definition',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => connectorTenant.id, { onDelete: 'cascade' }),
    id: uuid('id').notNull().defaultRandom(),
    providerInstanceId: text('provider_instance_id').notNull(),
    toolkit: text('toolkit').notNull(),
    eventType: text('event_type').notNull(),
    definitionHash: text('definition_hash').notNull(),
    definition: jsonb('definition').notNull().$type<Record<string, unknown>>(),
    current: boolean('current').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    foreignKey({
      columns: [table.tenantId, table.providerInstanceId],
      foreignColumns: [managedConnectorProvider.tenantId, managedConnectorProvider.id],
    }),
    index('managed_event_definition_scope_idx').on(
      table.tenantId,
      table.providerInstanceId,
      table.toolkit,
      table.eventType
    ),
  ]
);

/** Physical upstream binding; private project/user provenance never crosses into public wire requests. */
export const managedConnectorEventBinding = pgTable(
  'managed_connector_event_binding',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => connectorTenant.id, { onDelete: 'cascade' }),
    id: uuid('id').notNull().defaultRandom(),
    providerInstanceId: text('provider_instance_id').notNull(),
    providerGeneration: integer('provider_generation').notNull(),
    externalAccountRef: text('external_account_ref').notNull(),
    definitionId: uuid('definition_id').notNull(),
    filterHash: text('filter_hash').notNull(),
    filter: jsonb('filter').notNull().$type<Record<string, unknown>>(),
    providerTriggerRef: text('provider_trigger_ref'),
    providerTriggerUuid: text('provider_trigger_uuid'),
    externalAccountUuid: text('external_account_uuid'),
    state: text('state')
      .notNull()
      .$type<'pending' | 'ready' | 'outcome_unknown' | 'retired'>()
      .default('pending'),
    leaseOwner: uuid('lease_owner'),
    leasedUntil: timestamp('leased_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    foreignKey({
      columns: [table.tenantId, table.providerInstanceId],
      foreignColumns: [managedConnectorProvider.tenantId, managedConnectorProvider.id],
    }),
    foreignKey({
      columns: [table.tenantId, table.definitionId],
      foreignColumns: [
        managedConnectorEventDefinition.tenantId,
        managedConnectorEventDefinition.id,
      ],
    }),
    uniqueIndex('managed_event_binding_scope_unique').on(
      table.tenantId,
      table.providerInstanceId,
      table.providerGeneration,
      table.externalAccountRef,
      table.definitionId,
      table.filterHash
    ),
    index('managed_event_binding_trigger_idx').on(
      table.providerInstanceId,
      table.providerTriggerRef
    ),
  ]
);

/** Independently revocable receive consent for one exact local agent and destination. */
export const managedConnectorEventSubscription = pgTable(
  'managed_connector_event_subscription',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => connectorTenant.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    connectionId: text('connection_id').notNull(),
    targetInstanceId: text('target_instance_id').notNull(),
    bindingId: uuid('binding_id').notNull(),
    agentId: text('agent_id').notNull(),
    destinationKind: text('destination_kind').notNull().$type<'agent' | 'room' | 'channel'>(),
    destinationId: text('destination_id').notNull(),
    scopeVersion: integer('scope_version').notNull(),
    connectionGeneration: integer('connection_generation').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    foreignKey({
      columns: [table.tenantId, table.connectionId],
      foreignColumns: [managedConnectorConnection.tenantId, managedConnectorConnection.id],
    }),
    foreignKey({
      columns: [table.tenantId, table.bindingId],
      foreignColumns: [managedConnectorEventBinding.tenantId, managedConnectorEventBinding.id],
    }),
    index('managed_event_subscription_target_idx').on(
      table.tenantId,
      table.targetInstanceId,
      table.enabled
    ),
  ]
);

/** Seven-day managed offline inbox; ACK clears payload and preserves bounded dedupe metadata. */
export const managedConnectorEventInbox = pgTable(
  'managed_connector_event_inbox',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => connectorTenant.id, { onDelete: 'cascade' }),
    id: uuid('id').notNull().defaultRandom(),
    subscriptionId: text('subscription_id').notNull(),
    subscriptionVersion: integer('subscription_version').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    targetInstanceId: text('target_instance_id').notNull(),
    protectedPayload: text('protected_payload').notNull(),
    state: text('state')
      .notNull()
      .$type<'received' | 'leased' | 'acknowledged' | 'expired'>()
      .default('received'),
    leaseToken: uuid('lease_token'),
    leaseKeyId: text('lease_key_id'),
    leasedUntil: timestamp('leased_until', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    metadataExpiresAt: timestamp('metadata_expires_at', { withTimezone: true }).notNull(),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    foreignKey({
      columns: [table.tenantId, table.subscriptionId],
      foreignColumns: [
        managedConnectorEventSubscription.tenantId,
        managedConnectorEventSubscription.id,
      ],
    }),
    uniqueIndex('managed_event_inbox_dedupe_unique').on(
      table.tenantId,
      table.subscriptionId,
      table.providerEventId
    ),
    index('managed_event_inbox_pull_idx').on(
      table.tenantId,
      table.targetInstanceId,
      table.state,
      table.expiresAt
    ),
    index('managed_event_inbox_retention_idx').on(table.expiresAt, table.metadataExpiresAt),
  ]
);
