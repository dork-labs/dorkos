import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Derived SQLite index over Maildir message files.
 * This table is fully rebuildable from the Maildir filesystem.
 * Replaces relay/index.db 'messages' table.
 */
export const relayIndex = sqliteTable('relay_index', {
  id: text('id').primaryKey(), // ULID (message ID)
  subject: text('subject').notNull(),
  endpointHash: text('endpoint_hash').notNull(),
  status: text('status', {
    enum: ['pending', 'delivered', 'failed'], // was: 'new'/'cur' (Maildir terms)
  })
    .notNull()
    .default('pending'),
  expiresAt: text('expires_at'), // was: ttl INTEGER (Unix ms)
  payload: text('payload'),
  metadata: text('metadata'),
  createdAt: text('created_at').notNull(),
});

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
