/**
 * Dead letter queue for the Relay message bus.
 *
 * Provides a high-level interface for rejecting messages, listing dead
 * letters, and purging old entries. Composes {@link MaildirStore} for
 * filesystem persistence and {@link SqliteIndex} for fast queries.
 *
 * Dead letters are messages that were rejected before or during delivery
 * (budget exceeded, access denied, TTL expired, consumer rejection).
 * Each dead letter consists of:
 * - The original envelope JSON in `failed/{id}.json`
 * - A sidecar file with rejection metadata in `failed/{id}.reason.json`
 * - An index row in SQLite with `status = 'failed'`
 *
 * @module relay/dead-letter-queue
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { MaildirStore } from './maildir-store.js';
import type { SqliteIndex } from './sqlite-index.js';
import type { DeadLetter } from './types.js';

// === Types ===

/** Options for creating a DeadLetterQueue. */
export interface DeadLetterQueueOptions {
  /** The MaildirStore instance for filesystem operations. */
  maildirStore: MaildirStore;

  /** The SqliteIndex instance for status tracking. */
  sqliteIndex: SqliteIndex;

  /**
   * Root directory for all mailboxes.
   * Must match the MaildirStore's rootDir so we can resolve file paths
   * for purge operations.
   */
  rootDir: string;
}

/** Result of a reject operation. */
export type RejectResult =
  | { ok: true; messageId: string }
  | { ok: false; error: string };

/** A dead letter entry with full metadata. */
export interface DeadLetterEntry {
  /** The ULID message ID. */
  messageId: string;

  /** The endpoint hash where the message was rejected. */
  endpointHash: string;

  /** The rejection reason. */
  reason: string;

  /** ISO 8601 timestamp of when the message was rejected. */
  failedAt: string;

  /** The original envelope, if readable from disk. */
  envelope: RelayEnvelope | null;
}

/** Options for listing dead letters. */
export interface ListDeadOptions {
  /** Filter to a specific endpoint hash. If omitted, lists across all endpoints. */
  endpointHash?: string;
}

/** Options for purging dead letters. */
export interface PurgeOptions {
  /**
   * Maximum age in milliseconds. Dead letters older than this are purged.
   * Compared against the `failedAt` timestamp in the sidecar file.
   */
  maxAgeMs: number;

  /** Filter to a specific endpoint hash. If omitted, purges across all indexed endpoints. */
  endpointHash?: string;
}

/** Result of a purge operation. */
export interface PurgeResult {
  /** Number of dead letters purged. */
  purged: number;
}

// === DeadLetterQueue ===

/**
 * High-level dead letter queue for rejected Relay messages.
 *
 * Composes MaildirStore (filesystem source of truth) and SqliteIndex
 * (derived index for queries). All writes go through MaildirStore first,
 * then update the index.
 *
 * @example
 * ```ts
 * const dlq = new DeadLetterQueue({ maildirStore, sqliteIndex, rootDir });
 *
 * // Reject a message
 * const result = await dlq.reject('a1b2c3', envelope, 'budget exceeded');
 *
 * // List all dead letters
 * const entries = await dlq.listDead();
 *
 * // Purge entries older than 24 hours
 * const purged = await dlq.purge({ maxAgeMs: 24 * 60 * 60 * 1000 });
 * ```
 */
export class DeadLetterQueue {
  private readonly maildirStore: MaildirStore;
  private readonly sqliteIndex: SqliteIndex;
  private readonly rootDir: string;

  constructor(options: DeadLetterQueueOptions) {
    this.maildirStore = options.maildirStore;
    this.sqliteIndex = options.sqliteIndex;
    this.rootDir = options.rootDir;
  }

  /**
   * Reject a message by writing it to the dead letter queue.
   *
   * Uses {@link MaildirStore.failDirect} for pre-delivery rejections
   * (the envelope never entered the normal Maildir flow). Also indexes
   * the dead letter in SQLite with `status = 'failed'`.
   *
   * @param endpointHash - The hash identifying the target endpoint's mailbox.
   * @param envelope - The rejected envelope.
   * @param reason - Human-readable reason for the rejection.
   * @returns A RejectResult indicating success or failure.
   */
  async reject(
    endpointHash: string,
    envelope: RelayEnvelope,
    reason: string,
  ): Promise<RejectResult> {
    // Write to Maildir failed/ directory with sidecar
    const failResult = await this.maildirStore.failDirect(endpointHash, envelope, reason);
    if (!failResult.ok) {
      return { ok: false, error: failResult.error };
    }

    // Index in SQLite with status='failed'
    this.sqliteIndex.insertMessage({
      id: envelope.id,
      subject: envelope.subject,
      endpointHash,
      status: 'failed',
      createdAt: envelope.createdAt,
      expiresAt: envelope.budget.ttl
        ? new Date(envelope.budget.ttl).toISOString()
        : null,
    });

    return { ok: true, messageId: envelope.id };
  }

  /**
   * List dead letters, optionally filtered by endpoint.
   *
   * When filtering by endpoint, scans the Maildir `failed/` directory
   * directly. When listing all, queries the SQLite index for messages
   * with `status = 'failed'`.
   *
   * @param options - Optional filtering options.
   * @returns Array of dead letter entries sorted by message ID (FIFO).
   */
  async listDead(options?: ListDeadOptions): Promise<DeadLetterEntry[]> {
    if (options?.endpointHash) {
      return this.listDeadForEndpoint(options.endpointHash);
    }

    return this.listDeadFromIndex();
  }

  /**
   * Purge dead letters older than a specified age.
   *
   * Removes both the envelope JSON and the `.reason.json` sidecar
   * from the Maildir `failed/` directory, and removes the corresponding
   * rows from the SQLite index.
   *
   * @param options - Purge configuration (maxAgeMs required).
   * @returns A PurgeResult with the count of purged entries.
   */
  async purge(options: PurgeOptions): Promise<PurgeResult> {
    const cutoffTime = Date.now() - options.maxAgeMs;
    let purged = 0;

    if (options.endpointHash) {
      purged = await this.purgeEndpoint(options.endpointHash, cutoffTime);
    } else {
      purged = await this.purgeFromIndex(cutoffTime);
    }

    return { purged };
  }

  // --- Private Helpers ---

  /**
   * List dead letters for a specific endpoint by scanning Maildir.
   *
   * @param endpointHash - The endpoint hash to list.
   */
  private async listDeadForEndpoint(endpointHash: string): Promise<DeadLetterEntry[]> {
    const messageIds = await this.maildirStore.listFailed(endpointHash);
    const entries: DeadLetterEntry[] = [];

    for (const messageId of messageIds) {
      const entry = await this.buildDeadLetterEntry(endpointHash, messageId);
      entries.push(entry);
    }

    return entries;
  }

  /**
   * List dead letters across all endpoints by querying the SQLite index.
   */
  private async listDeadFromIndex(): Promise<DeadLetterEntry[]> {
    const metrics = this.sqliteIndex.getMetrics();
    const failedCount = metrics.byStatus['failed'] ?? 0;
    if (failedCount === 0) return [];

    // Collect all failed messages from the index via subject queries
    const entries: DeadLetterEntry[] = [];
    const seen = new Set<string>();

    for (const { subject } of metrics.bySubject) {
      const messages = this.sqliteIndex.getBySubject(subject);
      for (const msg of messages) {
        if (msg.status !== 'failed' || seen.has(msg.id)) continue;
        seen.add(msg.id);

        const deadLetter = await this.maildirStore.readDeadLetter(msg.endpointHash, msg.id);
        entries.push({
          messageId: msg.id,
          endpointHash: msg.endpointHash,
          reason: deadLetter?.reason ?? 'unknown',
          failedAt: deadLetter?.failedAt ?? msg.createdAt,
          envelope: deadLetter?.envelope ?? null,
        });
      }
    }

    // Sort by messageId ascending (ULID = chronological FIFO order)
    entries.sort((a, b) => a.messageId.localeCompare(b.messageId));
    return entries;
  }

  /**
   * Build a DeadLetterEntry from a message ID and endpoint hash.
   *
   * @param endpointHash - The endpoint hash.
   * @param messageId - The ULID message ID.
   */
  private async buildDeadLetterEntry(
    endpointHash: string,
    messageId: string,
  ): Promise<DeadLetterEntry> {
    const deadLetter = await this.maildirStore.readDeadLetter(endpointHash, messageId);
    const envelope = await this.maildirStore.readEnvelope(endpointHash, 'failed', messageId);

    return {
      messageId,
      endpointHash,
      reason: deadLetter?.reason ?? 'unknown',
      failedAt: deadLetter?.failedAt ?? new Date().toISOString(),
      envelope: envelope ?? deadLetter?.envelope ?? null,
    };
  }

  /**
   * Purge dead letters for a specific endpoint older than cutoff.
   *
   * @param endpointHash - The endpoint hash to purge.
   * @param cutoffTime - Purge entries with failedAt before this Unix timestamp (ms).
   * @returns Number of entries purged.
   */
  private async purgeEndpoint(endpointHash: string, cutoffTime: number): Promise<number> {
    const messageIds = await this.maildirStore.listFailed(endpointHash);
    let purged = 0;

    for (const messageId of messageIds) {
      const shouldPurge = await this.isOlderThan(endpointHash, messageId, cutoffTime);
      if (!shouldPurge) continue;

      await this.removeDeadLetter(endpointHash, messageId);
      purged++;
    }

    return purged;
  }

  /**
   * Purge dead letters across all indexed endpoints older than cutoff.
   *
   * @param cutoffTime - Purge entries with failedAt before this Unix timestamp (ms).
   * @returns Number of entries purged.
   */
  private async purgeFromIndex(cutoffTime: number): Promise<number> {
    const metrics = this.sqliteIndex.getMetrics();
    const failedCount = metrics.byStatus['failed'] ?? 0;
    if (failedCount === 0) return 0;

    let purged = 0;
    const seen = new Set<string>();

    for (const { subject } of metrics.bySubject) {
      const messages = this.sqliteIndex.getBySubject(subject);
      for (const msg of messages) {
        if (msg.status !== 'failed' || seen.has(msg.id)) continue;
        seen.add(msg.id);

        const shouldPurge = await this.isOlderThan(msg.endpointHash, msg.id, cutoffTime);
        if (!shouldPurge) continue;

        await this.removeDeadLetter(msg.endpointHash, msg.id);
        purged++;
      }
    }

    return purged;
  }

  /**
   * Check if a dead letter is older than the given cutoff time.
   *
   * Reads the sidecar `.reason.json` for the `failedAt` timestamp.
   * Falls back to the index's `createdAt` if the sidecar is missing.
   *
   * @param endpointHash - The endpoint hash.
   * @param messageId - The message ID.
   * @param cutoffTime - Cutoff timestamp in milliseconds.
   * @returns `true` if the dead letter should be purged.
   */
  private async isOlderThan(
    endpointHash: string,
    messageId: string,
    cutoffTime: number,
  ): Promise<boolean> {
    const deadLetter = await this.maildirStore.readDeadLetter(endpointHash, messageId);
    if (!deadLetter) {
      // No sidecar — fall back to index createdAt
      const indexed = this.sqliteIndex.getMessage(messageId);
      if (!indexed) return true; // No record at all — safe to purge
      return new Date(indexed.createdAt).getTime() < cutoffTime;
    }

    return new Date(deadLetter.failedAt).getTime() < cutoffTime;
  }

  /**
   * Remove a dead letter from both Maildir and SQLite.
   *
   * Deletes the envelope JSON and the sidecar `.reason.json` from disk,
   * then removes the corresponding row from the SQLite index.
   *
   * File deletion errors are silently ignored (the file may have been
   * removed by another process).
   *
   * @param endpointHash - The endpoint hash.
   * @param messageId - The message ID to remove.
   */
  private async removeDeadLetter(endpointHash: string, messageId: string): Promise<void> {
    // Delete envelope file from Maildir failed/
    const failedDir = path.join(this.rootDir, endpointHash, 'failed');
    await silentUnlink(path.join(failedDir, `${messageId}.json`));
    await silentUnlink(path.join(failedDir, `${messageId}.reason.json`));

    // Remove from SQLite index by overwriting with expired expiresAt, then pruning
    this.sqliteIndex.insertMessage({
      id: messageId,
      subject: '',
      endpointHash,
      status: 'failed',
      createdAt: new Date(0).toISOString(),
      expiresAt: new Date(0).toISOString(),
    });
    this.sqliteIndex.deleteExpired(1);
  }
}

// === File Helpers ===

/**
 * Unlink a file, silently ignoring ENOENT errors.
 *
 * @param filePath - Absolute path to unlink.
 */
async function silentUnlink(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // Ignore — file may not exist or was already removed
  }
}
