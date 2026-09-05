/**
 * Watcher manager for the Relay message bus.
 *
 * Manages chokidar file watchers on endpoint `new/` directories for
 * push delivery to subscription handlers. Handles watcher lifecycle,
 * message claiming, and handler dispatch.
 *
 * @module relay/watcher-manager
 */
import * as path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { SubscriptionRegistry } from './subscription-registry.js';
import type { MaildirStore } from './maildir-store.js';
import type { SqliteIndex } from './sqlite-index.js';
import type { CircuitBreakerManager } from './circuit-breaker.js';
import type { EndpointInfo, RelayLogger } from './types.js';
import { noopLogger } from './types.js';

/**
 * Manages chokidar watchers on Maildir `new/` directories.
 *
 * When a new file is created in an endpoint's `new/` directory,
 * the watcher reads the envelope, dispatches to matching subscription
 * handlers, and manages claim/complete/fail lifecycle.
 *
 * chokidar is the fast path, not the source of truth: once a watcher goes
 * ready, `sweepPending` re-reads the directory and dispatches whatever is
 * actually there, so a message written while the watcher was starting up — or
 * while this process was not running — is delivered rather than dropped.
 *
 * An optional `wasDispatched` callback can be provided to suppress
 * duplicate handler invocations when the synchronous fast-path in
 * `DeliveryPipeline.dispatchToSubscribers` has already handled the
 * same message ID.
 */
export class WatcherManager {
  private readonly watchers = new Map<string, FSWatcher>();

  /**
   * Optional dedup guard supplied by DeliveryPipeline.
   * Returns `true` when the pipeline already dispatched this message ID.
   */
  private wasDispatched?: (messageId: string) => boolean;

  /**
   * Create a watcher manager over an endpoint's Maildir delivery machinery.
   *
   * @param maildirStore - Store used to claim/complete/fail messages.
   * @param subscriptionRegistry - Registry resolving subject to handlers.
   * @param sqliteIndex - Index whose delivery status is updated per message.
   * @param circuitBreaker - Breaker that records per-endpoint handler failures.
   * @param logger - Optional logger for watcher diagnostics. Defaults to a
   *   silent logger so standalone/test usage stays quiet.
   */
  constructor(
    private readonly maildirStore: MaildirStore,
    private readonly subscriptionRegistry: SubscriptionRegistry,
    private readonly sqliteIndex: SqliteIndex,
    private readonly circuitBreaker: CircuitBreakerManager,
    private readonly logger: RelayLogger = noopLogger
  ) {}

  /**
   * Register a callback used to detect messages already dispatched by the
   * synchronous delivery fast-path, preventing double invocation of handlers.
   *
   * @param callback - Returns `true` if the given message ID was already dispatched
   */
  setWasDispatched(callback: (messageId: string) => boolean): void {
    this.wasDispatched = callback;
  }

  /**
   * Start a chokidar watcher on an endpoint's `new/` directory.
   *
   * Returns a promise that resolves once the watcher is ready, actively
   * monitoring the directory, and the reconcile sweep has enumerated whatever
   * was already waiting there. The sweep's own dispatches are NOT awaited —
   * one `readdir` is all the boot path pays for.
   *
   * @param endpoint - The endpoint to watch
   */
  startWatcher(endpoint: EndpointInfo): Promise<void> {
    if (this.watchers.has(endpoint.hash)) return Promise.resolve();

    const newDir = path.join(endpoint.maildirPath, 'new');
    const watcher = chokidar.watch(newDir, {
      persistent: true,
      ignoreInitial: true,
    });

    watcher.on('add', (filePath: string) => {
      this.dispatchFile(endpoint, filePath);
    });

    this.watchers.set(endpoint.hash, watcher);

    // Wait for the watcher to be fully ready before returning — but a watcher
    // that errors before going ready (e.g. EMFILE) never emits 'ready' at all,
    // so `settle()` below must also run from the error handler. Without it this
    // promise hangs forever, and so does every caller on the boot path with it:
    // server startup registers `relay.system.console` roughly a thousand lines
    // before `app.listen`, so an fd-starved machine would hang before binding
    // its port, with no error and no log. Resolving rather than rejecting is
    // deliberate: the server's catch around relay init tears the whole
    // subsystem down (`relayCore = undefined`) on a throw, so rejecting would
    // trade one degraded endpoint for no relay at all.
    return new Promise<void>((resolve) => {
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        // Reconcile before reporting live: chokidar is a fast path, never the
        // source of truth. See `sweepPending` for what the bare event misses.
        // Both arms resolve, for the same reason the error handler settles at
        // all — nothing the sweep can do may leave a boot-path caller hanging.
        void this.sweepPending(endpoint, watcher).then(
          () => resolve(),
          () => resolve()
        );
      };
      watcher.on('ready', settle);

      // Without this handler a watcher failure has nowhere to go but the
      // process-wide unhandled-error path. Messages already claimed keep
      // flowing; only push delivery for this endpoint is affected. Latched per
      // distinct error code rather than a single boolean: a benign EACCES must
      // never suppress the EMFILE storm that follows it. The Set lives in this
      // per-call closure, so one endpoint's latch cannot silence another's.
      const seenCodes = new Set<string>();
      watcher.on('error', (err) => {
        const code = (err as NodeJS.ErrnoException)?.code ?? 'unknown';
        if (!seenCodes.has(code)) {
          seenCodes.add(code);
          // Logged as an explicit object, never the bare Error: the server's
          // NDJSON reporter spreads what it is given, and `message`/`stack` are
          // non-enumerable on an Error, so they would vanish (DOR-832).
          this.logger.warn(
            `[watcher-error] WatcherManager: endpoint ${endpoint.subject} (${newDir}) — further ${code} errors from this watcher are suppressed`,
            {
              endpointSubject: endpoint.subject,
              newDir,
              code,
              message: err instanceof Error ? err.message : String(err),
              stack: err instanceof Error ? err.stack : undefined,
              suppressingFurtherErrors: true,
            }
          );
        }
        settle();
      });
    });
  }

  /**
   * Stop and remove a watcher for the given endpoint hash.
   *
   * @param endpointHash - Hash of the endpoint to stop watching
   */
  async stopWatcher(endpointHash: string): Promise<void> {
    const watcher = this.watchers.get(endpointHash);
    if (watcher) {
      this.watchers.delete(endpointHash);
      await watcher.close();
    }
  }

  /**
   * Close all active watchers.
   *
   * Used during graceful shutdown to ensure all file watchers
   * are cleaned up.
   */
  async closeAll(): Promise<void> {
    for (const [hash, watcher] of this.watchers) {
      await watcher.close();
      this.watchers.delete(hash);
    }
  }

  /**
   * Deliver whatever is already sitting in the endpoint's `new/` directory.
   *
   * chokidar's `ready` does not mean "nothing was missed". `chokidar.watch()`
   * returns before it has attached anything: it awaits a full scan of the
   * directory and only then calls `fs.watch` on it, so a file created inside
   * that window produces no `add` event at all — not a late one (measured
   * against chokidar 5 in DOR-577, where the same gap kept sessions off the
   * session list until the next restart). For push delivery that window is a
   * message dropped outright, because nothing re-reads `new/` afterwards.
   *
   * So this is a reconcile, not a grace period: one `listNew` after `ready`,
   * dispatching every message the directory actually holds. It is strictly
   * stronger than waiting a few milliseconds, because it also covers mail that
   * arrived while this process was not running at all — a restart with unread
   * mail on disk, or an endpoint re-registered after downtime. Ordering is what
   * makes it safe: the watcher is attached before the listing is taken, so the
   * two overlap rather than leaving a gap between them, and a message caught by
   * both is deduped by `claim` — an atomic rename only one caller can win.
   *
   * One shot is enough here — unlike DOR-577's periodic sweep, this watches a
   * single directory that already exists, so once `fs.watch` is attached its
   * events keep coming. What that leaves uncovered is a message written by
   * ANOTHER process in the millisecond or two after the listing, while libuv is
   * still warming up. Nothing this process publishes is exposed to it:
   * `DeliveryPipeline.deliverToEndpoint` dispatches to subscribers itself and
   * never waits for an fs event (`wasDispatched` is how the two stay out of
   * each other's way).
   *
   * Failure is logged and dropped: a mailbox that cannot be listed still gets
   * live push delivery, and its stranded mail is still pollable via `readInbox`.
   *
   * @param endpoint - The endpoint whose `new/` directory to reconcile.
   * @param watcher - The watcher this sweep belongs to; the sweep is abandoned
   *   if the endpoint has been stopped or restarted in the meantime.
   */
  private async sweepPending(endpoint: EndpointInfo, watcher: FSWatcher): Promise<void> {
    let messageIds: string[];
    try {
      messageIds = await this.maildirStore.listNew(endpoint.hash);
    } catch (err) {
      // Logged as an explicit object, never the bare Error — see the watcher
      // error handler above for why (DOR-832).
      this.logger.warn(
        `[watcher-sweep] WatcherManager: could not list pending messages for ${endpoint.subject} — mail already in new/ waits for a poll`,
        {
          endpointSubject: endpoint.subject,
          maildirPath: endpoint.maildirPath,
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        }
      );
      return;
    }

    // Stopped (or replaced) while the listing was in flight — its dispatches
    // would be delivering on behalf of a watcher that no longer exists.
    if (this.watchers.get(endpoint.hash) !== watcher) return;

    for (const messageId of messageIds) {
      this.dispatch(endpoint, messageId);
    }
  }

  /**
   * Route a watcher `add` event into the shared dispatch path.
   *
   * @param endpoint - The endpoint that received the message.
   * @param filePath - The path chokidar reported, whose basename is the ID.
   */
  private dispatchFile(endpoint: EndpointInfo, filePath: string): void {
    const filename = path.basename(filePath);
    if (!filename.endsWith('.json')) return;
    this.dispatch(endpoint, filename.slice(0, -5));
  }

  /**
   * Kick off delivery of one message, without waiting for it.
   *
   * The single entry point both the watcher and {@link sweepPending} use, so
   * the two cannot drift apart. Deliberately not awaited: a handler can run a
   * whole agent turn, and neither an fs event nor the boot path may block on
   * that. The `catch` is the price of not awaiting — without it an unexpected
   * throw inside `handleNewMessage` (a `complete()` that is not ENOENT, say)
   * would land on the process-wide unhandled-rejection path.
   *
   * @param endpoint - The endpoint that received the message.
   * @param messageId - The message ID, i.e. its filename without `.json`.
   */
  private dispatch(endpoint: EndpointInfo, messageId: string): void {
    void this.handleNewMessage(endpoint, messageId).catch((err: unknown) => {
      this.logger.warn(
        `[watcher-dispatch] WatcherManager: delivery of ${messageId} to ${endpoint.subject} threw`,
        {
          endpointSubject: endpoint.subject,
          messageId,
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        }
      );
    });
  }

  /**
   * Handle a new message sitting in an endpoint's `new/` directory.
   *
   * Reads the envelope, finds matching subscription handlers, invokes them,
   * then claims and completes the message. On handler error, the message
   * is moved to `failed/`.
   *
   * @param endpoint - The endpoint that received the message
   * @param messageId - The message ID (filename without the `.json` extension)
   */
  private async handleNewMessage(endpoint: EndpointInfo, messageId: string): Promise<void> {
    // Skip if DeliveryPipeline already dispatched this message synchronously.
    // This prevents double-invocation of subscription handlers when the
    // chokidar `add` event fires after the fast-path claim has run.
    if (this.wasDispatched?.(messageId)) return;

    // Find matching subscription handlers
    const handlers = this.subscriptionRegistry.getSubscribers(endpoint.subject);
    if (handlers.length === 0) return;

    // Claim the message (move from new/ to cur/)
    const claimResult = await this.maildirStore.claim(endpoint.hash, messageId);
    if (!claimResult.ok) return;

    // Invoke all handlers
    try {
      await Promise.all(handlers.map((handler) => handler(claimResult.envelope)));

      // All handlers succeeded — complete the message (remove from cur/)
      await this.maildirStore.complete(endpoint.hash, messageId);
      this.sqliteIndex.updateStatus(messageId, endpoint.hash, 'delivered');
    } catch (err) {
      // Handler failed — move to failed/. Skip the status flip when the cur/
      // file is already gone (fail() ok:false): a concurrent invocation
      // settled this message and it may have been delivered.
      const reason = err instanceof Error ? err.message : String(err);
      const failResult = await this.maildirStore.fail(endpoint.hash, messageId, reason);
      if (failResult.ok) {
        this.sqliteIndex.updateStatus(messageId, endpoint.hash, 'failed');
        this.circuitBreaker.recordFailure(endpoint.hash);
      }
    }
  }
}
