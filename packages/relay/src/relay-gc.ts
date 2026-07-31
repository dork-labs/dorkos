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
import type { TraceStoreLike } from './types.js';
import { isSyntheticEndpointHash } from './sqlite-index.js';
import type { SqliteIndex, MessageStatus, IndexedMessage } from './sqlite-index.js';
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

/**
 * Default retention for **unread mail in a durable inbox** (7 days).
 *
 * ## Why this exists at all
 *
 * A message's `budget.ttl` is a delivery deadline: it is how long the relay may
 * keep trying to hand a message on, and it defaults to one hour. It was also,
 * by accident, how long an agent's inbox kept mail nobody had read — the same
 * timestamp landed in the index's `expires_at`, and this sweep deleted the row
 * and unlinked the file. An agent that was off for an afternoon came back to an
 * empty mailbox, with no dead letter and nothing in any surface to say a
 * message had ever arrived. Forty-six empty mailboxes on one live machine.
 *
 * Those are two different questions and now have two different answers. Unread
 * mail in a `relay.inbox.*` inbox is kept for this much longer window, and when
 * it does finally expire it is **dead-lettered**, not deleted — so it is still
 * readable, still counted, and still recoverable.
 */
export const DEFAULT_UNDELIVERED_MAIL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// === Types ===

/** Tunable retention windows for the GC sweep. */
export interface RelayGcConfig {
  /** Dead letters older than this are purged. */
  deadLetterRetentionMs: number;
  /** Mailbox directories with no endpoint and no activity newer than this are reaped. */
  orphanMaildirRetentionMs: number;
  /** `cur/` messages claimed longer ago than this are treated as crash-stranded and re-driven. */
  inFlightRecoveryMs: number;
  /**
   * How long unread mail in a durable inbox is kept, regardless of the
   * message's own delivery TTL. See
   * {@link DEFAULT_UNDELIVERED_MAIL_RETENTION_MS}.
   */
  undeliveredMailRetentionMs: number;
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
  /**
   * Optional trace store, so mail that finally times out unread leaves a
   * record rather than vanishing between two sweeps.
   */
  traceStore?: TraceStoreLike;
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
      const disposition = await this.disposeUnreadMail(message, now);
      // Unread mail lives on its own, much longer window (see
      // DEFAULT_UNDELIVERED_MAIL_RETENTION_MS) and is dead-lettered rather than
      // deleted when it does run out.
      if (disposition === 'kept') continue;
      if (disposition === 'retired') {
        removed++;
        continue;
      }

      if (!isSyntheticEndpointHash(message.endpointHash)) {
        for (const subdir of subdirsForStatus(message.status)) {
          await this.deps.maildirStore.deleteMessageFile(message.endpointHash, subdir, message.id);
        }
      }
      this.deps.sqliteIndex.deleteMessage(message.id, message.endpointHash);
      removed++;
    }

    return removed;
  }

  /**
   * Decide what an expired row means when it is unread mail in a durable inbox.
   *
   * Three answers:
   *
   * - `'not-mail'` — anything else: an ephemeral dispatch/query inbox, a
   *     synthetic accounting row, or a message already claimed into `cur/` by a
   *     handler (that one is the crash-recovery phase's job, not this one). The
   *     ordinary expiry deletion applies.
   * - `'kept'` — unread mail inside its own, much longer retention window. The
   *     message's delivery TTL says nothing about how long its owner's inbox
   *     should hold it, and treating it as if it did emptied real mailboxes
   *     under agents that were merely offline.
   * - `'retired'` — unread past that window: dead-lettered, so it is still
   *     readable and still counted, and the trace moved to `timeout` so
   *     something says it expired unread.
   *
   * @param message - An expired index row.
   * @param now - Current time in ms.
   */
  private async disposeUnreadMail(
    message: IndexedMessage,
    now: number
  ): Promise<'not-mail' | 'kept' | 'retired'> {
    if (message.status !== 'pending') return 'not-mail';
    if (isSyntheticEndpointHash(message.endpointHash)) return 'not-mail';
    // The endpoint hash IS the subject for Maildir endpoints.
    if (inferEndpointType(message.endpointHash) !== 'persistent') return 'not-mail';

    // Only a file still sitting in `new/` is unread. A pending row whose file
    // has moved to `cur/` was claimed and never completed — crash recovery
    // re-drives that one, and expiry still cleans up after it.
    const envelope = await this.deps.maildirStore.readEnvelope(
      message.endpointHash,
      'new',
      message.id
    );
    if (!envelope) return 'not-mail';

    const age = now - new Date(message.createdAt).getTime();
    if (age < this.config.undeliveredMailRetentionMs) return 'kept';

    // `reject` writes the dead letter and flips the index row to `failed`,
    // which takes it out of this sweep's query for good. The unread copy in
    // `new/` has to go with it, or a later `rebuild()` would re-index the same
    // message as pending and dead-letter it a second time.
    await this.deps.deadLetterQueue.reject(
      message.endpointHash,
      envelope,
      `unread for ${Math.round(age / 86_400_000)} day(s) — mailbox retention reached`
    );
    await this.deps.maildirStore.deleteMessageFile(message.endpointHash, 'new', message.id);

    try {
      this.deps.traceStore?.updateSpan(message.id, {
        status: 'timeout',
        error: 'expired unread in its inbox',
      });
    } catch {
      // Tracing is best-effort — never fail a sweep for it.
    }

    this.logger.warn(
      `RelayGc: dead-lettered mail nobody read in ${message.endpointHash} ` +
        `(message ${message.id}, ${Math.round(age / 86_400_000)} day(s) old)`
    );
    return 'retired';
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
        this.deps.sqliteIndex.updateStatus(messageId, endpoint.hash, 'pending');
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
