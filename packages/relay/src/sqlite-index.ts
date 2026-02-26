/**
 * SQLite index derived from Maildir files for the Relay message bus.
 *
 * Provides fast structured queries (by subject, endpoint, status) on top
 * of the Maildir source-of-truth storage. The index is fully rebuildable
 * from Maildir files -- if it corrupts, call `rebuild()` to recreate it
 * from scratch.
 *
 * Uses Drizzle ORM against the consolidated @dorkos/db database.
 *
 * @module relay/sqlite-index
 */
import { eq, and, lt, desc, sql, count } from 'drizzle-orm';
import { relayIndex, type Db } from '@dorkos/db';
import type { RelayMetrics } from './types.js';
import type { MaildirStore } from './maildir-store.js';

// === Types ===

/** Status of a message in the index. */
export type MessageStatus = 'pending' | 'delivered' | 'failed';

/** Mapped message record (camelCase). */
export interface IndexedMessage {
  id: string;
  subject: string;
  endpointHash: string;
  status: MessageStatus;
  createdAt: string;
  expiresAt: string | null;
}

/** @deprecated Use `Db` from `@dorkos/db` instead. */
export interface SqliteIndexOptions {
  dbPath: string;
}

// === SqliteIndex ===

/**
 * SQLite-based index for Relay messages.
 *
 * This is a derived index over Maildir files -- not the source of truth.
 * If the index becomes corrupted, call {@link rebuild} to recreate it
 * from the Maildir directories on disk.
 *
 * @example
 * ```ts
 * import { createDb, runMigrations } from '@dorkos/db';
 * const db = createDb(':memory:');
 * runMigrations(db);
 * const index = new SqliteIndex(db);
 * index.insertMessage({
 *   id: '01JABC',
 *   subject: 'relay.agent.proj.backend',
 *   endpointHash: 'a1b2c3d4e5f6',
 *   status: 'pending',
 *   createdAt: new Date().toISOString(),
 *   expiresAt: new Date(Date.now() + 60000).toISOString(),
 * });
 * const messages = index.getBySubject('relay.agent.proj.backend');
 * ```
 */
export class SqliteIndex {
  constructor(private readonly db: Db) {}

  // --- Write Operations ---

  /**
   * Insert or replace a message in the index.
   *
   * Uses INSERT OR REPLACE so re-indexing is idempotent -- the same
   * message can be inserted multiple times without error.
   *
   * @param message - The indexed message record to insert.
   */
  insertMessage(message: IndexedMessage): void {
    this.db
      .insert(relayIndex)
      .values({
        id: message.id,
        subject: message.subject,
        endpointHash: message.endpointHash,
        status: message.status,
        createdAt: message.createdAt,
        expiresAt: message.expiresAt,
      })
      .onConflictDoUpdate({
        target: relayIndex.id,
        set: {
          subject: message.subject,
          endpointHash: message.endpointHash,
          status: message.status,
          createdAt: message.createdAt,
          expiresAt: message.expiresAt,
        },
      })
      .run();
  }

  /**
   * Update the status of an existing message.
   *
   * @param id - The ULID of the message to update.
   * @param status - The new status (`pending`, `delivered`, or `failed`).
   * @returns `true` if a row was updated, `false` if the message was not found.
   */
  updateStatus(id: string, status: MessageStatus): boolean {
    const result = this.db
      .update(relayIndex)
      .set({ status })
      .where(eq(relayIndex.id, id))
      .run();
    return result.changes > 0;
  }

  // --- Read Operations ---

  /**
   * Get a single message by ID.
   *
   * @param id - The ULID of the message.
   * @returns The indexed message, or `null` if not found.
   */
  getMessage(id: string): IndexedMessage | null {
    const rows = this.db
      .select()
      .from(relayIndex)
      .where(eq(relayIndex.id, id))
      .all();
    return rows.length > 0 ? mapRow(rows[0]) : null;
  }

  /**
   * Get all messages for a given subject, ordered by creation time descending.
   *
   * @param subject - The message subject to query.
   * @returns An array of indexed messages matching the subject.
   */
  getBySubject(subject: string): IndexedMessage[] {
    const rows = this.db
      .select()
      .from(relayIndex)
      .where(eq(relayIndex.subject, subject))
      .orderBy(desc(relayIndex.createdAt))
      .all();
    return rows.map(mapRow);
  }

  /**
   * Get all messages for a given endpoint hash, ordered by creation time descending.
   *
   * @param endpointHash - The endpoint hash to query.
   * @returns An array of indexed messages for the endpoint.
   */
  getByEndpoint(endpointHash: string): IndexedMessage[] {
    const rows = this.db
      .select()
      .from(relayIndex)
      .where(eq(relayIndex.endpointHash, endpointHash))
      .orderBy(desc(relayIndex.createdAt))
      .all();
    return rows.map(mapRow);
  }

  /**
   * Count messages sent within a time window by filtering on createdAt.
   * Used by the rate limiter for sliding window log checks.
   *
   * @param sender - Unused (retained for API compatibility). Rate limiting
   *        is now done at the RelayCore level before indexing.
   * @param windowStartIso - ISO 8601 timestamp marking the start of the window.
   * @returns The number of messages after the window start.
   */
  countSenderInWindow(_sender: string, windowStartIso: string): number {
    const rows = this.db
      .select({ cnt: count() })
      .from(relayIndex)
      .where(sql`${relayIndex.createdAt} > ${windowStartIso}`)
      .all();
    return rows[0]?.cnt ?? 0;
  }

  /**
   * Count unprocessed (status='pending') messages for an endpoint.
   * Used by backpressure detection.
   *
   * @param endpointHash - The endpoint hash to check.
   * @returns The number of messages with status 'pending' for this endpoint.
   */
  countNewByEndpoint(endpointHash: string): number {
    const rows = this.db
      .select({ cnt: count() })
      .from(relayIndex)
      .where(
        and(
          eq(relayIndex.endpointHash, endpointHash),
          eq(relayIndex.status, 'pending'),
        ),
      )
      .all();
    return rows[0]?.cnt ?? 0;
  }

  // --- Query Operations ---

  /**
   * Query messages with optional filters and cursor-based pagination.
   *
   * Supports filtering by subject, status, sender (no-op), and endpoint hash.
   * Uses ULID cursor for pagination (messages are sorted by id DESC).
   *
   * @param filters - Optional query filters
   * @returns An object with messages array and optional nextCursor
   */
  queryMessages(filters?: {
    subject?: string;
    status?: string;
    sender?: string;
    endpointHash?: string;
    cursor?: string;
    limit?: number;
  }): { messages: IndexedMessage[]; nextCursor?: string } {
    const conditions = [];

    if (filters?.subject) {
      conditions.push(eq(relayIndex.subject, filters.subject));
    }
    if (filters?.status) {
      conditions.push(
        eq(relayIndex.status, filters.status as 'pending' | 'delivered' | 'failed'),
      );
    }
    if (filters?.endpointHash) {
      conditions.push(eq(relayIndex.endpointHash, filters.endpointHash));
    }
    if (filters?.cursor) {
      conditions.push(lt(relayIndex.id, filters.cursor));
    }

    const limit = filters?.limit ?? 50;
    const whereClause =
      conditions.length > 0 ? and(...conditions) : undefined;

    const rows = this.db
      .select()
      .from(relayIndex)
      .where(whereClause)
      .orderBy(desc(relayIndex.id))
      .limit(limit + 1)
      .all();

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const messages = pageRows.map(mapRow);

    return {
      messages,
      ...(hasMore &&
        messages.length > 0 && {
          nextCursor: messages[messages.length - 1].id,
        }),
    };
  }

  // --- Maintenance Operations ---

  /**
   * Delete all messages whose expiresAt has passed.
   *
   * Compares the stored expiresAt (ISO 8601 string) against the current time.
   *
   * @param now - Current time as Unix timestamp in milliseconds. Defaults to `Date.now()`.
   * @returns The number of expired messages deleted.
   */
  deleteExpired(now?: number): number {
    const timestamp = now ?? Date.now();
    const isoNow = new Date(timestamp).toISOString();
    const result = this.db
      .delete(relayIndex)
      .where(
        and(
          sql`${relayIndex.expiresAt} IS NOT NULL`,
          lt(relayIndex.expiresAt, isoNow),
        ),
      )
      .run();
    return result.changes;
  }

  /**
   * Rebuild the entire index from Maildir files on disk.
   *
   * Drops all existing data and re-scans every endpoint's Maildir
   * directories (`new/`, `cur/`, `failed/`), reading each envelope
   * JSON file and inserting it into the index.
   *
   * This is the "nuclear option" for index corruption recovery.
   *
   * @param maildirStore - The MaildirStore to read envelopes from.
   * @param endpointHashes - Map of endpoint hash to subject. Needed to
   *        associate Maildir directories with their subjects.
   * @returns The number of messages re-indexed.
   */
  async rebuild(
    maildirStore: MaildirStore,
    endpointHashes: Map<string, string>,
  ): Promise<number> {
    // Drop all existing data
    this.db.delete(relayIndex).run();

    let rebuildCount = 0;
    const subdirs = ['new', 'cur', 'failed'] as const;

    /** Map Maildir subdirectory names to Drizzle status values. */
    const statusMap: Record<string, MessageStatus> = {
      new: 'pending',
      cur: 'delivered',
      failed: 'failed',
    };

    for (const [hash, _subject] of endpointHashes) {
      for (const subdir of subdirs) {
        const messageIds = await listMessageIds(maildirStore, hash, subdir);

        for (const messageId of messageIds) {
          const envelope = await maildirStore.readEnvelope(hash, subdir, messageId);
          if (!envelope) continue;

          this.insertMessage({
            id: messageId,
            subject: envelope.subject,
            endpointHash: hash,
            status: statusMap[subdir],
            createdAt: envelope.createdAt,
            expiresAt: envelope.budget.ttl
              ? new Date(envelope.budget.ttl).toISOString()
              : null,
          });
          rebuildCount++;
        }
      }
    }

    return rebuildCount;
  }

  // --- Metrics ---

  /**
   * Get aggregate metrics from the index.
   *
   * Returns total message count, counts by status, and counts by subject
   * (sorted by volume descending).
   *
   * @returns Aggregate relay metrics.
   */
  getMetrics(): RelayMetrics {
    // Total count
    const totalRows = this.db
      .select({ cnt: count() })
      .from(relayIndex)
      .all();
    const totalMessages = totalRows[0]?.cnt ?? 0;

    // Count by status
    const statusRows = this.db
      .select({
        status: relayIndex.status,
        cnt: count(),
      })
      .from(relayIndex)
      .groupBy(relayIndex.status)
      .all();
    const byStatus: Record<string, number> = {};
    for (const row of statusRows) {
      if (row.status) {
        byStatus[row.status] = row.cnt;
      }
    }

    // Count by subject
    const subjectRows = this.db
      .select({
        subject: relayIndex.subject,
        cnt: count(),
      })
      .from(relayIndex)
      .groupBy(relayIndex.subject)
      .orderBy(desc(count()))
      .all();
    const bySubject = subjectRows.map((row) => ({
      subject: row.subject,
      count: row.cnt,
    }));

    return { totalMessages, byStatus, bySubject };
  }

  // --- Lifecycle ---

  /**
   * Close the database connection.
   *
   * No-op for Drizzle — the consolidated database lifecycle is managed
   * by the server startup code. Retained for API compatibility.
   */
  close(): void {
    // No-op: database lifecycle is managed by the caller
  }

  /**
   * Check whether the database is using WAL journal mode.
   *
   * @returns `true` if WAL mode is active.
   */
  isWalMode(): boolean {
    const result = this.db.$client.pragma('journal_mode', {
      simple: true,
    }) as string;
    return result === 'wal';
  }
}

// === Helpers ===

/**
 * Convert a Drizzle result row to an IndexedMessage.
 *
 * @param row - Drizzle query result row.
 */
function mapRow(row: typeof relayIndex.$inferSelect): IndexedMessage {
  return {
    id: row.id,
    subject: row.subject,
    endpointHash: row.endpointHash,
    status: row.status as MessageStatus,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

/**
 * List message IDs from a Maildir subdirectory.
 *
 * Delegates to the appropriate MaildirStore list method based on the
 * subdirectory name.
 *
 * @param store - The MaildirStore to query.
 * @param hash - The endpoint hash.
 * @param subdir - The Maildir subdirectory to list.
 */
async function listMessageIds(
  store: MaildirStore,
  hash: string,
  subdir: 'new' | 'cur' | 'failed',
): Promise<string[]> {
  switch (subdir) {
    case 'new':
      return store.listNew(hash);
    case 'cur':
      return store.listCurrent(hash);
    case 'failed':
      return store.listFailed(hash);
  }
}
