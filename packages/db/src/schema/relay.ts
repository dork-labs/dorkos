import { sqliteTable, text, primaryKey } from 'drizzle-orm/sqlite-core';

/**
 * Derived SQLite index over Maildir message files.
 * This table is fully rebuildable from the Maildir filesystem.
 * Replaces relay/index.db 'messages' table.
 *
 * The primary key is composite `(id, endpoint_hash)`: since message identity was
 * unified so one envelope's `id` is reused as the Maildir filename at every
 * endpoint it reaches (plus the `*` publish-accounting row and `adapter:<subject>`
 * audit rows), a single `id` now legitimately owns one row PER endpoint. The
 * endpoint hash disambiguates them.
 */
export const relayIndex = sqliteTable(
  'relay_index',
  {
    id: text('id').notNull(), // ULID / envelope id (shared across a message's endpoint rows)
    subject: text('subject').notNull(),
    endpointHash: text('endpoint_hash').notNull(),
    status: text('status', {
      enum: ['pending', 'delivered', 'failed'], // was: 'new'/'cur' (Maildir terms)
    })
      .notNull()
      .default('pending'),
    expiresAt: text('expires_at'), // was: ttl INTEGER (Unix ms)
    sender: text('sender'),
    payload: text('payload'),
    metadata: text('metadata'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.id, table.endpointHash] })]
);

/** Delivery telemetry for Relay messages. Replaces relay/index.db 'message_traces' table. */
export const relayTraces = sqliteTable('relay_traces', {
  id: text('id').primaryKey(), // ULID
  messageId: text('message_id').notNull().unique(),
  traceId: text('trace_id').notNull(),
  subject: text('subject').notNull(),
  status: text('status', {
    enum: ['sent', 'delivered', 'failed', 'timeout'],
  }).notNull(),
  sentAt: text('sent_at').notNull(), // ISO 8601 TEXT (was: INTEGER Unix ms)
  deliveredAt: text('delivered_at'),
  processedAt: text('processed_at'),
  errorMessage: text('error_message'),
  metadata: text('metadata'),
});
