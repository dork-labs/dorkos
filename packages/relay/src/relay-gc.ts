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
 *    Gated on time-since-CLAIM (the `cur/` file's ctime, stamped by the atomic
 *    claim rename), never the envelope's `createdAt` — queue time says nothing
 *    about whether a handler is still actively processing.
 * 4. **Orphan reaping** — remove mailbox directories that have no registered
 *    endpoint and no recent activity (e.g. dead-letter drops to `relay.agent.*`
 *    subjects, or historical orphans from the old mesh sweep bug). Durable
 *    `relay.inbox.*` persistent inboxes are NEVER reaped — the endpoint
 *    registry is in-memory, so after a restart every directory is briefly
 *    "unowned" and a persistent inbox holding unread mail must survive until
 *    its owner re-registers.
 *
 * @module relay/relay-gc
 */
import { inferEndpointType } from './types.js';
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

/**
 * Default time-since-claim after which a `cur/` message is treated as
 * crash-stranded (30 minutes) — comfortably above any plausible handler
 * duration (agent turns routinely run many minutes), so an actively-processing
 * message is never re-driven into a double delivery.
 */
export const DEFAULT_IN_FLIGHT_RECOVERY_MS = 30 * 60 * 1000;

// === Types ===

/** Tunable retention windows for the GC sweep. */
export interface RelayGcConfig {
  /** Dead letters older than this are purged. */
  deadLetterRetentionMs: number;
  /** Mailbox directories with no endpoint and no activity newer than this are reaped. */
  orphanMaildirRetentionMs: number;
  /** `cur/` messages claimed longer ago than this are treated as crash-stranded and re-driven. */
  inFlightRecoveryMs: number;
}

/** Per-sweep options for {@link RelayGc.sweep}. */
export interface RelayGcSweepOptions {
  /**
   * Skip the orphan-maildir reap phase. Used for the construction-time sweep:
   * the in-memory endpoint registry is empty right after a restart, so every
   * directory would look unowned — reaping is deferred one interval to let
   * endpoints re-register.
   */
  skipOrphanReap?: boolean;
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
 * Map an index status to the Maildir subdirectories that may hold its file
 * during the expiry sweep. A `pending` row's file lives in `new/` normally but
 * in `cur/` when a claim is in flight (the index only flips after complete),
 * so both must be checked — deleting only `new/` would strand an orphan `cur/`
 * file with no index row. `failed` is never seen here (dead letters are
 * excluded from {@link SqliteIndex.getExpired}); a `delivered` row's file is
 * normally already gone, so the unlink is a best-effort no-op.
 */
function subdirsForStatus(status: MessageStatus): ReadonlyArray<'new' | 'cur'> {
  switch (status) {
    case 'pending':
      return ['new', 'cur'];
    case 'delivered':
      return ['cur'];
    case 'failed':
      return [];
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
   * @param options - Per-sweep options (e.g. skip orphan reaping on the construction sweep).
   * @returns Per-phase removal counts.
   */
  async sweep(now: number = Date.now(), options?: RelayGcSweepOptions): Promise<RelayGcResult> {
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
    if (!options?.skipOrphanReap) {
      result.orphansReaped = await this.guard('orphan reap', () => this.reapOrphanMaildirs(now));
    }

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
        for (const subdir of subdirsForStatus(message.status)) {
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
   * `new/` for redelivery.
   *
   * Recovery is gated on time-since-CLAIM: the atomic `new/` -> `cur/` rename
   * updates the file's ctime, so a `cur/` file whose ctime is recent belongs to
   * a delivery that is still in flight and must not be touched — re-driving it
   * would invoke the handlers a second time. The envelope's `createdAt` is
   * deliberately NOT used: it includes arbitrary queue time and would flag a
   * just-claimed old message as stranded.
   */
  private async recoverStrandedInFlight(now: number): Promise<number> {
    let recovered = 0;

    for (const endpoint of this.deps.endpointRegistry.listEndpoints()) {
      const strandedIds = await this.deps.maildirStore.listCurrent(endpoint.hash);
      for (const messageId of strandedIds) {
        const claimedAtMs = await this.deps.maildirStore.getMessageCtimeMs(
          endpoint.hash,
          'cur',
          messageId
        );
        // Vanished mid-sweep (completed/failed concurrently) — nothing to do.
        if (claimedAtMs === null) continue;
        if (now - claimedAtMs < this.config.inFlightRecoveryMs) continue;

        const requeued = await this.deps.maildirStore.requeue(endpoint.hash, messageId);
        if (!requeued.ok) continue;

        // Tolerates a missing index row (updateStatus no-ops) — e.g. an
        // orphaned cur/ file whose row was expired by a previous sweep.
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
   *
   * Durable `relay.inbox.*` persistent inboxes are exempt: registration state
   * is in-memory only, so an offline owner (or a fresh restart) makes them look
   * unowned — reaping one would destroy unread no-TTL mail.
   */
  private async reapOrphanMaildirs(now: number): Promise<number> {
    let reaped = 0;
    const hashes = await this.deps.maildirStore.listEndpointHashes();

    for (const hash of hashes) {
      // `hash` equals the endpoint subject — a live endpoint owns its directory.
      if (this.deps.endpointRegistry.getEndpoint(hash)) continue;

      // Never reap durable persistent inboxes (see method docs). Ephemeral
      // dispatch/query inboxes are still reaped — their owners are transient
      // tool calls with their own TTL lifecycle.
      if (inferEndpointType(hash) === 'persistent') continue;

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
