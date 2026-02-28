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
import type { EndpointInfo } from './types.js';

/**
 * Manages chokidar watchers on Maildir `new/` directories.
 *
 * When a new file is created in an endpoint's `new/` directory,
 * the watcher reads the envelope, dispatches to matching subscription
 * handlers, and manages claim/complete/fail lifecycle.
 */
export class WatcherManager {
  private readonly watchers = new Map<string, FSWatcher>();

  constructor(
    private readonly maildirStore: MaildirStore,
    private readonly subscriptionRegistry: SubscriptionRegistry,
    private readonly sqliteIndex: SqliteIndex,
    private readonly circuitBreaker: CircuitBreakerManager,
  ) {}

  /**
   * Start a chokidar watcher on an endpoint's `new/` directory.
   *
   * Returns a promise that resolves once the watcher is ready and
   * actively monitoring the directory.
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
      void this.handleNewMessage(endpoint, filePath);
    });

    this.watchers.set(endpoint.hash, watcher);

    // Wait for the watcher to be fully ready before returning
    return new Promise<void>((resolve) => {
      watcher.on('ready', () => resolve());
    });
  }

  /**
   * Stop the chokidar watcher for an endpoint.
   *
   * @param endpointHash - The hash of the endpoint whose watcher to stop
   */
  stopWatcher(endpointHash: string): void {
    const watcher = this.watchers.get(endpointHash);
    if (watcher) {
      void watcher.close();
      this.watchers.delete(endpointHash);
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
   * Handle a new message file appearing in an endpoint's `new/` directory.
   *
   * Reads the envelope, finds matching subscription handlers, invokes them,
   * then claims and completes the message. On handler error, the message
   * is moved to `failed/`.
   *
   * @param endpoint - The endpoint that received the message
   * @param filePath - The path to the new message file
   */
  private async handleNewMessage(endpoint: EndpointInfo, filePath: string): Promise<void> {
    // Extract message ID from filename (strip .json extension)
    const filename = path.basename(filePath);
    if (!filename.endsWith('.json')) return;
    const messageId = filename.slice(0, -5);

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
      this.sqliteIndex.updateStatus(messageId, 'delivered');
    } catch (err) {
      // Handler failed — move to failed/
      const reason = err instanceof Error ? err.message : String(err);
      await this.maildirStore.fail(endpoint.hash, messageId, reason);
      this.sqliteIndex.updateStatus(messageId, 'failed');
      this.circuitBreaker.recordFailure(endpoint.hash);
    }
  }
}
