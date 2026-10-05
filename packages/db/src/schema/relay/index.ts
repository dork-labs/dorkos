import { sqliteTable, text, primaryKey, index } from 'drizzle-orm/sqlite-core';
import { desc } from 'drizzle-orm';

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
  (table) => [
    primaryKey({ columns: [table.id, table.endpointHash] }),
    // ADR-0014: the rate limiter's sliding-window log runs
    // `SELECT COUNT(*) WHERE sender = ? AND created_at > ?` on every publish
    // (`SqliteIndex.countSenderInWindow`). Equality column first, range column
    // second — SQLite's planner picks this index for that predicate without
    // needing to fall back to a full table scan (verified via EXPLAIN QUERY
    // PLAN: "USING COVERING INDEX").
    //
    // `desc()` here is drizzle-orm's generic ORDER BY helper, not a per-column
    // SQLite index direction builder -- SQLiteColumn has no `.asc()`/`.desc()`
    // (that's Postgres-only in this drizzle-kit). Wrapping the column makes it
    // an `SQL` value, which drizzle-kit's SQLite index serializer renders
    // as a literal index-column expression instead of a bare identifier,
    // producing `CREATE INDEX ... ("sender", "created_at" desc)` -- valid
    // SQLite, confirmed against the generated migration. That is what actually
    // gets this ADR's committed `(sender, created_at DESC)` shape onto disk.
    index('idx_relay_index_sender_created_at').on(table.sender, desc(table.createdAt)),
  ]
);

/**
 * Delivery telemetry for Relay messages. Replaces relay/index.db 'message_traces' table.
 *
 * Two things here are load-bearing for the numbers the cockpit shows:
 *
 * - `status` separates `no_subscriber` from `failed`. A publish to a subject
 *   nobody listens on is not a failure, and counting it as one produced whole
 *   days reading "100% failure rate" with not one error message attached.
 * - `kind` separates a message's delivery span from an adapter's lifecycle
 *   event (connected / disconnected / error). Lifecycle rows used to be written
 *   as `status: 'delivered'` and were counted as delivered traffic, so simply
 *   restarting an integration inflated the delivered count.
 */
export const relayTraces = sqliteTable('relay_traces', {
  id: text('id').primaryKey(), // ULID
  messageId: text('message_id').notNull().unique(),
  traceId: text('trace_id').notNull(),
  subject: text('subject').notNull(),
  status: text('status', {
    enum: ['sent', 'delivered', 'failed', 'timeout', 'no_subscriber'],
  }).notNull(),
  /** `delivery` for a message span, `lifecycle` for an adapter connect/disconnect/error event. */
  kind: text('kind', { enum: ['delivery', 'lifecycle'] })
    .notNull()
    .default('delivery'),
  sentAt: text('sent_at').notNull(), // ISO 8601 TEXT (was: INTEGER Unix ms)
  deliveredAt: text('delivered_at'),
  processedAt: text('processed_at'),
  errorMessage: text('error_message'),
  metadata: text('metadata'),
});
