/** Durable connector event subscription, inbox, and audit schema. */
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { connections, connectorProviderInstances } from './connections.js';

/** Explicit event subscription owned by one connection and agent. */
export const connectorEventSubscriptions = sqliteTable(
  'connector_event_subscriptions',
  {
    id: text('id').primaryKey(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(),
    destinationKind: text('destination_kind', { enum: ['agent', 'room', 'channel'] }).notNull(),
    destinationId: text('destination_id').notNull(),
    eventType: text('event_type').notNull(),
    filterJson: text('filter_json').notNull(),
    filterHash: text('filter_hash').notNull(),
    deliveryMode: text('delivery_mode').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('connector_event_subscription_scope_unique').on(
      table.connectionId,
      table.eventType,
      table.agentId,
      table.destinationKind,
      table.destinationId,
      table.filterHash
    ),
    index('connector_event_subscriptions_agent_idx').on(table.agentId),
  ]
);

/** Durable protected provider event and retry/lease state. */
export const connectorEventInbox = sqliteTable(
  'connector_event_inbox',
  {
    id: text('id').primaryKey(),
    providerInstanceId: text('provider_instance_id')
      .notNull()
      .references(() => connectorProviderInstances.id),
    subscriptionId: text('subscription_id')
      .notNull()
      .references(() => connectorEventSubscriptions.id, { onDelete: 'cascade' }),
    providerEventId: text('provider_event_id').notNull(),
    payloadSchemaVersion: integer('payload_schema_version').notNull(),
    normalizedPayload: text('normalized_payload').notNull(),
    payloadProtection: text('payload_protection', { enum: ['minimized', 'encrypted'] }).notNull(),
    state: text('state', {
      enum: ['received', 'leased', 'dispatched', 'completed', 'failed', 'expired'],
    }).notNull(),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: text('next_attempt_at'),
    expiresAt: text('expires_at').notNull(),
    leaseOwner: text('lease_owner'),
    leasedUntil: text('leased_until'),
    receivedAt: text('received_at').notNull(),
    dispatchedAt: text('dispatched_at'),
    completedAt: text('completed_at'),
    failureCode: text('failure_code'),
  },
  (table) => [
    uniqueIndex('connector_event_inbox_provider_dedupe_unique').on(
      table.providerInstanceId,
      table.subscriptionId,
      table.providerEventId
    ),
    index('connector_event_inbox_claim_idx').on(
      table.providerInstanceId,
      table.state,
      table.nextAttemptAt,
      table.leasedUntil,
      table.expiresAt
    ),
  ]
);

/** Payload-free append-only audit of inbox delivery transitions. */
export const connectorEventReceipts = sqliteTable(
  'connector_event_receipts',
  {
    id: text('id').primaryKey(),
    inboxId: text('inbox_id')
      .notNull()
      .references(() => connectorEventInbox.id, { onDelete: 'cascade' }),
    subscriptionId: text('subscription_id').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    state: text('state').notNull(),
    recordedAt: text('recorded_at').notNull(),
    destinationReceiptId: text('destination_receipt_id'),
    failureCode: text('failure_code'),
  },
  (table) => [
    index('connector_event_receipts_inbox_idx').on(table.inboxId, table.recordedAt),
    index('connector_event_receipts_subscription_event_idx').on(
      table.subscriptionId,
      table.providerEventId
    ),
  ]
);
