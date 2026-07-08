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
import { eq, and, lt, gt, asc, desc, sql, count } from 'drizzle-orm';
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
  /** The sender identity (e.g. `relay.human.slack.bot`). Nullable for legacy rows. */
  sender?: string | null;
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
        sender: message.sender ?? null,
      })
      .onConflictDoUpdate({
        target: [relayIndex.id, relayIndex.endpointHash],
        set: {
          subject: message.subject,
          endpointHash: message.endpointHash,
          status: message.status,
          createdAt: message.createdAt,
          // Preserve existing sender/expiresAt when the incoming write omits
          // them. The DLQ reject path and the adapter-delivery audit write reuse
          // the SAME envelope id as the publish accounting row but carry neither
          // `sender` nor `expiresAt`; a plain overwrite nulls them out and erases
          // the per-sender rate-limit accounting exactly for failing senders
          // (H2). COALESCE keeps the first-written non-null value.
          expiresAt: sql`coalesce(excluded.${sql.raw(relayIndex.expiresAt.name)}, ${relayIndex.expiresAt})`,
          sender: sql`coalesce(excluded.${sql.raw(relayIndex.sender.name)}, ${relayIndex.sender})`,
        },
      })
      .run();
  }

  /**
   * Delete a single message row, keyed by its composite `(id, endpointHash)`.
   *
   * The real deletion primitive for GC and dead-letter removal — replaces the
   * former "poison the row with an expired timestamp, then sweep it" trick.
   * The `endpointHash` is REQUIRED: because one envelope id now owns a row per
   * endpoint, deleting by bare id would wrongly remove a message's sibling
   * deliveries at other endpoints.
   *
   * @param id - The message id (envelope id).
   * @param endpointHash - The endpoint hash whose row to delete.
   * @returns `true` if a row was deleted, `false` if none matched.
   */
  deleteMessage(id: string, endpointHash: string): boolean {
    const result = this.db
      .delete(relayIndex)
      .where(and(eq(relayIndex.id, id), eq(relayIndex.endpointHash, endpointHash)))
      .run();
    return result.changes > 0;
  }

  /**
   * Update the status of an existing message row, keyed by its composite
   * `(id, endpointHash)`.
   *
   * The `endpointHash` is REQUIRED: a delivered/failed transition applies to
   * ONE endpoint's row, not to every row that shares the envelope id (the `*`
   * accounting row and other endpoints' deliveries must be left untouched).
   *
   * @param id - The message id (envelope id).
   * @param endpointHash - The endpoint hash whose row to update.
   * @param status - The new status (`pending`, `delivered`, or `failed`).
   * @returns `true` if a row was updated, `false` if the message was not found.
   */
  updateStatus(id: string, endpointHash: string, status: MessageStatus): boolean {
    const result = this.db
      .update(relayIndex)
      .set({ status })
      .where(and(eq(relayIndex.id, id), eq(relayIndex.endpointHash, endpointHash)))
      .run();
    return result.changes > 0;
  }

  // --- Read Operations ---

  /**
   * Get a single representative row for a message id.
   *
   * One envelope id now owns several rows: the `*` publish-accounting row, an
   * `adapter:<subject>` audit row, and one real row per Maildir endpoint. This
   * returns the most honest single row — a real endpoint delivery when present,
   * falling back to a synthetic (`*` / `adapter:`) row — so callers that only
   * need "did this message land, and with what status" get the truth instead of
   * the old hardcoded `*` placeholder (M5). Use {@link getMessageDeliveries} for
   * the full per-endpoint breakdown.
   *
   * @param id - The message id (envelope id).
   * @returns A representative indexed row, or `null` if the id is unknown.
   */
  getMessage(id: string): IndexedMessage | null {
    const rows = this.db.select().from(relayIndex).where(eq(relayIndex.id, id)).all().map(mapRow);
    if (rows.length === 0) return null;
    const real = rows.find((r) => !isSyntheticEndpointHash(r.endpointHash));
    return real ?? rows[0];
  }

  /**
   * Get every indexed row for a message id — the real per-endpoint delivery
   * rows plus any synthetic accounting rows (`*`, `adapter:<subject>`).
   *
   * This is the honest, joined view of one message's fate across all the places
   * it was routed, made possible by unifying identity on the envelope id.
   *
   * @param id - The message id (envelope id).
   * @returns All rows sharing the id, ordered by endpoint hash for stability.
   */
  getMessageDeliveries(id: string): IndexedMessage[] {
    return this.db
      .select()
      .from(relayIndex)
      .where(eq(relayIndex.id, id))
      .orderBy(asc(relayIndex.endpointHash))
      .all()
      .map(mapRow);
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
   * Get all messages with a given status, ordered by ID ascending (FIFO).
   *
   * A single indexed query — used by the dead-letter queue to enumerate all
   * `failed` rows without the O(subjects × messages) fan-out of iterating
   * every subject and re-querying.
   *
   * @param status - The status to filter by.
   * @returns An array of indexed messages with the given status.
   */
  getByStatus(status: MessageStatus): IndexedMessage[] {
    const rows = this.db
      .select()
      .from(relayIndex)
      .where(eq(relayIndex.status, status))
      .orderBy(asc(relayIndex.id))
      .all();
    return rows.map(mapRow);
  }

  /**
   * Count messages from a specific sender within a time window.
   * Used by the rate limiter for per-sender sliding window log checks.
   *
   * @param sender - The sender identity to filter by (e.g. `relay.human.slack.bot`).
   * @param windowStartIso - ISO 8601 timestamp marking the start of the window.
   * @returns The number of messages from this sender after the window start.
   */
  countSenderInWindow(sender: string, windowStartIso: string): number {
    const rows = this.db
      .select({ cnt: count() })
      .from(relayIndex)
      .where(and(sql`${relayIndex.createdAt} > ${windowStartIso}`, eq(relayIndex.sender, sender)))
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
      .where(and(eq(relayIndex.endpointHash, endpointHash), eq(relayIndex.status, 'pending')))
      .all();
    return rows[0]?.cnt ?? 0;
  }

  // --- Query Operations ---

  /**
   * Query messages with optional filters and cursor-based pagination.
   *
   * Supports filtering by subject, status, sender, and endpoint hash. Default
   * order is newest-first (`desc`, cursor pages toward older rows); pass
   * `order: 'asc'` for oldest-first FIFO reads.
   *
   * Pagination keys on the composite `(id, endpointHash)`, not the bare id:
   * because one envelope id now owns a row per endpoint, an id-only cursor could
   * straddle a page boundary and silently skip a message's sibling rows. The
   * `nextCursor` is an opaque space-separated `id endpointHash` token (see
   * `CURSOR_SEP`; a space cannot appear in either part — subjects and ULIDs are
   * dot/alnum tokens). A pre-upgrade id-only cursor is still accepted rather
   * than throwing, but is NOT loss-free: if that cursor happened to land inside
   * a shared id's group of sibling rows, the remaining siblings of that one id
   * are skipped for that in-flight pagination. Transient — only cursors minted
   * before the upgrade are affected.
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
    order?: 'asc' | 'desc';
  }): { messages: IndexedMessage[]; nextCursor?: string } {
    const order = filters?.order ?? 'desc';
    const conditions = [];

    if (filters?.subject) {
      conditions.push(eq(relayIndex.subject, filters.subject));
    }
    if (filters?.status) {
      conditions.push(eq(relayIndex.status, filters.status as 'pending' | 'delivered' | 'failed'));
    }
    if (filters?.sender) {
      conditions.push(eq(relayIndex.sender, filters.sender));
    }
    if (filters?.endpointHash) {
      conditions.push(eq(relayIndex.endpointHash, filters.endpointHash));
    }
    if (filters?.cursor) {
      const { id, endpointHash } = decodeCursor(filters.cursor);
      // Row-value comparison over the composite key, matching the ORDER BY.
      conditions.push(
        order === 'desc'
          ? sql`(${relayIndex.id}, ${relayIndex.endpointHash}) < (${id}, ${endpointHash})`
          : sql`(${relayIndex.id}, ${relayIndex.endpointHash}) > (${id}, ${endpointHash})`
      );
    }

    const limit = filters?.limit ?? 50;
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = this.db
      .select()
      .from(relayIndex)
      .where(whereClause)
      .orderBy(
        order === 'desc' ? desc(relayIndex.id) : asc(relayIndex.id),
        order === 'desc' ? desc(relayIndex.endpointHash) : asc(relayIndex.endpointHash)
      )
      .limit(limit + 1)
      .all();

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const messages = pageRows.map(mapRow);

    return {
      messages,
      ...(hasMore &&
        pageRows.length > 0 && {
          nextCursor: encodeCursor(pageRows[pageRows.length - 1]),
        }),
    };
  }

  // --- Maintenance Operations ---

  /**
   * List messages whose `expiresAt` has passed, EXCLUDING dead letters.
   *
   * Returns full rows so the GC sweep can delete the backing Maildir file
   * before removing the index row (files-first, so a mid-sweep {@link rebuild}
   * cannot resurrect a row whose file is already gone). Rows with
   * `status = 'failed'` are deliberately excluded: dead letters are retained on
   * their own (longer) retention window and purged via the dead-letter queue,
   * not by TTL.
   *
   * @param now - Current time as Unix timestamp in milliseconds. Defaults to `Date.now()`.
   * @returns Expired, non-failed indexed messages.
   */
  getExpired(now?: number): IndexedMessage[] {
    const isoNow = new Date(now ?? Date.now()).toISOString();
    const rows = this.db
      .select()
      .from(relayIndex)
      .where(
        and(
          sql`${relayIndex.expiresAt} IS NOT NULL`,
          lt(relayIndex.expiresAt, isoNow),
          sql`${relayIndex.status} != 'failed'`
        )
      )
      .all();
    return rows.map(mapRow);
  }

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
      .where(and(sql`${relayIndex.expiresAt} IS NOT NULL`, lt(relayIndex.expiresAt, isoNow)))
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
  async rebuild(maildirStore: MaildirStore, endpointHashes: Map<string, string>): Promise<number> {
    // Drop all existing data
    this.db.delete(relayIndex).run();

    let rebuildCount = 0;
    const subdirs = ['new', 'cur', 'failed'] as const;

    /**
     * Map Maildir subdirectory names to index status values.
     *
     * `cur/` maps to `pending`, NOT `delivered`: a message in `cur/` was
     * claimed but not yet completed (the live pipeline only flips a row to
     * `delivered` AFTER `complete()` removes the file). Labeling in-flight
     * `cur/` entries `delivered` was a lie that masked messages stranded by a
     * crash between claim and complete (M1); `pending` is honest and lets the
     * crash-recovery re-drive redeliver them.
     */
    const statusMap: Record<string, MessageStatus> = {
      new: 'pending',
      cur: 'pending',
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
            expiresAt: envelope.budget.ttl ? new Date(envelope.budget.ttl).toISOString() : null,
            sender: envelope.from,
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
    const totalRows = this.db.select({ cnt: count() }).from(relayIndex).all();
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
 * True for synthetic index endpoint hashes that never had a backing Maildir
 * file: the `*` publish-accounting row and `adapter:<subject>` audit rows. Real
 * Maildir endpoints use their subject string as the hash.
 *
 * @param endpointHash - The endpoint hash to classify.
 */
export function isSyntheticEndpointHash(endpointHash: string): boolean {
  return endpointHash === '*' || endpointHash.startsWith('adapter:');
}

/** Separator for the opaque composite `(id, endpointHash)` pagination cursor. */
const CURSOR_SEP = ' ';

/** Encode a row's composite key into an opaque pagination cursor. */
function encodeCursor(row: { id: string; endpointHash: string }): string {
  return `${row.id}${CURSOR_SEP}${row.endpointHash}`;
}

/**
 * Decode a pagination cursor into its `(id, endpointHash)` parts. A legacy
 * id-only cursor (no separator) is accepted by treating the endpoint hash as
 * empty, which sorts before any real hash. Honest caveat: for descending
 * pages, `(id, '') < (id, anyHash)` excludes ALL rows of that id — so a
 * pre-upgrade cursor that landed inside a shared id's sibling group skips that
 * id's remaining siblings for that one in-flight pagination. Transient (only
 * cursors minted before the upgrade), accepted over throwing on stale cursors.
 */
function decodeCursor(cursor: string): { id: string; endpointHash: string } {
  const sep = cursor.indexOf(CURSOR_SEP);
  if (sep === -1) return { id: cursor, endpointHash: '' };
  return { id: cursor.slice(0, sep), endpointHash: cursor.slice(sep + 1) };
}

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
    sender: row.sender,
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
  subdir: 'new' | 'cur' | 'failed'
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
