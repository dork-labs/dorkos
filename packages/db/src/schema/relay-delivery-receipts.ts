import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Authoritative, minimized observations of HTTP agent-target delivery. */
export const relayDeliveryReceipts = sqliteTable(
  'relay_delivery_receipts',
  {
    messageId: text('message_id').primaryKey().notNull(),
    subject: text('subject').notNull(),
    ownerUserId: text('owner_user_id'),
    state: text('state', {
      enum: ['accepted', 'delivered', 'failed', 'outcome_unknown'],
    }).notNull(),
    bootEpoch: text('boot_epoch').notNull(),
    acceptedAt: text('accepted_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    settledAt: text('settled_at'),
    expiresAt: text('expires_at').notNull(),
    failureCode: text('failure_code', {
      enum: [
        'at_capacity',
        'chat_unavailable',
        'rate_limited',
        'budget_exceeded',
        'initiate_denied',
        'untrusted_bridge_principal',
        'turn_ceiling',
        'adapter_unavailable',
        'not_dispatched',
        'adapter_failed',
        'observation_lost',
      ],
    }),
    failureMessage: text('failure_message'),
  },
  (table) => [
    index('idx_relay_delivery_receipts_expiry').on(table.expiresAt, table.messageId),
    index('idx_relay_delivery_receipts_recovery').on(table.state, table.bootEpoch),
    check(
      'relay_delivery_receipt_state',
      sql`${table.state} IN ('accepted', 'delivered', 'failed', 'outcome_unknown')`
    ),
    check(
      'relay_delivery_receipt_settlement',
      sql`
      (${table.state} = 'accepted' AND ${table.settledAt} IS NULL AND ${table.failureCode} IS NULL AND ${table.failureMessage} IS NULL)
      OR (${table.state} = 'delivered' AND ${table.settledAt} IS NOT NULL AND ${table.failureCode} IS NULL AND ${table.failureMessage} IS NULL)
      OR (${table.state} = 'failed' AND ${table.settledAt} IS NOT NULL AND ${table.failureCode} IS NOT NULL AND ${table.failureCode} IN ('at_capacity', 'chat_unavailable', 'rate_limited', 'budget_exceeded', 'initiate_denied', 'untrusted_bridge_principal', 'turn_ceiling', 'adapter_unavailable', 'not_dispatched', 'adapter_failed') AND ${table.failureMessage} IS NOT NULL)
      OR (${table.state} = 'outcome_unknown' AND ${table.settledAt} IS NOT NULL AND ${table.failureCode} IS NOT NULL AND ${table.failureCode} = 'observation_lost' AND ${table.failureMessage} IS NOT NULL)
    `
    ),
  ]
);

/** Exclusive observer ownership is scoped to this database, never its path alias. */
export const relayReceiptObserverOwner = sqliteTable(
  'relay_receipt_observer_owner',
  {
    singletonKey: text('singleton_key', { enum: ['observer'] })
      .primaryKey()
      .notNull(),
    ownerToken: text('owner_token').notNull().unique(),
    pid: integer('pid').notNull(),
    hostname: text('hostname').notNull(),
    claimedAt: text('claimed_at').notNull(),
  },
  (table) => [check('relay_receipt_observer_singleton', sql`${table.singletonKey} = 'observer'`)]
);
