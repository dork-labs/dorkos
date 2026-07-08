/**
 * Garbage collection for the Relay message bus.
 *
 * Nothing else bounds Relay storage: expired messages linger in the SQLite
 * index and their Maildir files, dead letters accumulate forever, crashed
 * in-flight messages strand in `cur/`, and dead-letter writes to unregistered
 * `relay.agent.*` subjects leave orphan mailbox directories behind. Without a
 * sweep, `countNewByEndpoint` grows monotonically until a persistent inbox
 * bricks at `maxMailboxSize` and rejects every further delivery (H4).
 *
 * This module runs one periodic sweep with four phases, ordered so each frees
 * work for the next:
 *
 * 1. **Expiry** — delete expired, non-dead-letter index rows AND their Maildir
 *    files in lockstep (file first, so a concurrent `rebuild` cannot resurrect
 *    a row whose file is already gone).
 * 2. **Dead-letter retention** — purge dead letters older than the retention
 *    window (files + sidecars + rows).
 * 3. **Crash recovery** — re-drive messages stranded in `cur/` (claimed but
 *    never completed) back to `new/` for redelivery, restoring at-least-once.
 * 4. **Orphan reaping** — remove mailbox directories that have no registered
 *    endpoint and no recent activity (e.g. dead-letter drops to `relay.agent.*`
 *    subjects, or historical orphans from the old mesh sweep bug).
 *
 * @module relay/relay-gc
 */
import type { SqliteIndex, MessageStatus } from './sqlite-index.js';
import type { MaildirStore } from './maildir-store.js';
import type { DeadLetterQueue } from './dead-letter-queue.js';
import type { EndpointRegistry } from './endpoint-registry.js';
import type { DeliveryPipeline } from './delivery-pipeline.js';
import type { RelayLogger } from './types.js';

// === Defaults ===

/** Default interval between GC sweeps (5 minutes). */
export const DEFAULT_GC_INTERVAL_MS = 5 * 60 * 1000;

/** Default retention window for dead letters (24 hours). */
export const DEFAULT_DEAD_LETTER_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Default minimum age before an unowned mailbox directory is reaped (24 hours). */
export const DEFAULT_ORPHAN_MAILDIR_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Default age after which a `cur/` message is treated as crash-stranded (5 minutes). */
export const DEFAULT_IN_FLIGHT_RECOVERY_MS = 5 * 60 * 1000;

// === Types ===

/** Tunable retention windows for the GC sweep. */
export interface RelayGcConfig {
  /** Dead letters older than this are purged. */
  deadLetterRetentionMs: number;
  /** Mailbox directories with no endpoint and no activity newer than this are reaped. */
  orphanMaildirRetentionMs: number;
  /** `cur/` messages older than this are treated as crash-stranded and re-driven. */
  inFlightRecoveryMs: number;
}

/** Dependencies injected into {@link RelayGc}. */
export interface RelayGcDeps {
  sqliteIndex: SqliteIndex;
  maildirStore: MaildirStore;
  deadLetterQueue: DeadLetterQueue;
  endpointRegistry: EndpointRegistry;
  deliveryPipeline: DeliveryPipeline;
  logger?: RelayLogger;
}

/** Per-phase counts from a single {@link RelayGc.sweep}. */
export interface RelayGcResult {
  /** Expired non-dead-letter rows (and their files) removed. */
  expiredRemoved: number;
  /** Dead letters purged past the retention window. */
  deadLettersPurged: number;
  /** Messages re-driven from `cur/` back to `new/` for redelivery. */
  inFlightRecovered: number;
  /** Orphan mailbox directories removed. */
  orphansReaped: number;
}

// === Helpers ===

/**
 * True for synthetic index hashes that never had a backing Maildir file:
 * the `*` publish accounting row and `adapter:<subject>` audit rows.
 */
function isSyntheticHash(endpointHash: string): boolean {
  return endpointHash === '*' || endpointHash.startsWith('adapter:');
}

/**
 * Map an index status to the Maildir subdirectory that holds its file during
 * the expiry sweep. `failed` is never seen here (dead letters are excluded from
 * {@link SqliteIndex.getExpired}); a `delivered` row's file is normally already
 * gone, so the unlink is a best-effort no-op.
 */
function subdirForStatus(status: MessageStatus): 'new' | 'cur' | null {
  switch (status) {
    case 'pending':
      return 'new';
    case 'delivered':
      return 'cur';
    case 'failed':
      return null;
  }
}

// === RelayGc ===

/**
 * Periodic garbage collector for Relay storage. Constructed and driven by
 * {@link RelayCore}, which owns the interval timer and calls {@link sweep}.
 */
export class RelayGc {
  private readonly logger: RelayLogger;

  constructor(
    private readonly deps: RelayGcDeps,
    private readonly config: RelayGcConfig
  ) {
    this.logger = deps.logger ?? { debug() {}, info() {}, warn() {}, error() {} };
  }

  /**
   * Run one full GC sweep. Each phase is isolated: a failure in one is logged
   * and the sweep continues, so a single bad file never blocks the rest.
   *
   * @param now - Current time in ms. Defaults to `Date.now()`. Injectable for tests.
   * @returns Per-phase removal counts.
   */
  async sweep(now: number = Date.now()): Promise<RelayGcResult> {
    const result: RelayGcResult = {
      expiredRemoved: 0,
      deadLettersPurged: 0,
      inFlightRecovered: 0,
      orphansReaped: 0,
    };

    result.expiredRemoved = await this.guard('expiry', () => this.collectExpired(now));
    result.deadLettersPurged = await this.guard('dead-letter retention', () =>
      this.purgeDeadLetters()
    );
    result.inFlightRecovered = await this.guard('crash recovery', () =>
      this.recoverStrandedInFlight(now)
    );
    result.orphansReaped = await this.guard('orphan reap', () => this.reapOrphanMaildirs(now));

    return result;
  }

  /**
   * Delete expired, non-dead-letter index rows and their Maildir files in
   * lockstep — file first so a concurrent {@link SqliteIndex.rebuild} cannot
   * re-index a row whose file has already gone.
   */
  private async collectExpired(now: number): Promise<number> {
    const expired = this.deps.sqliteIndex.getExpired(now);
    let removed = 0;

    for (const message of expired) {
      if (!isSyntheticHash(message.endpointHash)) {
        const subdir = subdirForStatus(message.status);
        if (subdir) {
          await this.deps.maildirStore.deleteMessageFile(message.endpointHash, subdir, message.id);
        }
      }
      this.deps.sqliteIndex.deleteMessage(message.id);
      removed++;
    }

    return removed;
  }

  /** Purge dead letters older than the configured retention window. */
  private async purgeDeadLetters(): Promise<number> {
    const { purged } = await this.deps.deadLetterQueue.purge({
      maxAgeMs: this.config.deadLetterRetentionMs,
    });
    return purged;
  }

  /**
   * Re-drive messages stranded in `cur/` (claimed but never completed) back to
   * `new/` for redelivery. Only messages older than `inFlightRecoveryMs` are
   * touched, so an in-progress dispatch is never disturbed.
   */
  private async recoverStrandedInFlight(now: number): Promise<number> {
    let recovered = 0;

    for (const endpoint of this.deps.endpointRegistry.listEndpoints()) {
      const strandedIds = await this.deps.maildirStore.listCurrent(endpoint.hash);
      for (const messageId of strandedIds) {
        const envelope = await this.deps.maildirStore.readEnvelope(endpoint.hash, 'cur', messageId);
        if (!envelope) continue;
        if (now - Date.parse(envelope.createdAt) < this.config.inFlightRecoveryMs) continue;

        const requeued = await this.deps.maildirStore.requeue(endpoint.hash, messageId);
        if (!requeued.ok) continue;

        this.deps.sqliteIndex.updateStatus(messageId, 'pending');
        // Redeliver immediately if a subscriber is attached; otherwise the
        // message waits in new/ and stays pollable via readInbox.
        await this.deps.deliveryPipeline.dispatchToSubscribers(endpoint, messageId);
        recovered++;
      }
    }

    return recovered;
  }

  /**
   * Remove mailbox directories that have no registered endpoint and no activity
   * newer than the orphan retention window. The activity check (newest file
   * mtime, or the directory's own mtime when empty) is the safety margin that
   * prevents deleting a directory a concurrent registration just created.
   */
  private async reapOrphanMaildirs(now: number): Promise<number> {
    let reaped = 0;
    const hashes = await this.deps.maildirStore.listEndpointHashes();

    for (const hash of hashes) {
      // `hash` equals the endpoint subject — a live endpoint owns its directory.
      if (this.deps.endpointRegistry.getEndpoint(hash)) continue;

      const newest = await this.deps.maildirStore.getNewestActivityMs(hash);
      if (newest !== null && now - newest < this.config.orphanMaildirRetentionMs) continue;

      await this.deps.maildirStore.removeMaildir(hash);
      reaped++;
    }

    return reaped;
  }

  /** Run one sweep phase, logging and swallowing any failure so the rest proceed. */
  private async guard(phase: string, fn: () => Promise<number>): Promise<number> {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`RelayGc: ${phase} phase failed: ${message}`);
      return 0;
    }
  }
}
