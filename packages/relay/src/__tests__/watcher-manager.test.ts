import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { WatcherManager } from '../watcher-manager.js';
import type { SubscriptionRegistry } from '../subscription-registry.js';
import type { MaildirStore } from '../maildir-store.js';
import type { SqliteIndex } from '../sqlite-index.js';
import type { CircuitBreakerManager } from '../circuit-breaker.js';
import type { EndpointInfo } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function createMockMaildirStore(): MaildirStore {
  return {
    claim: vi.fn().mockResolvedValue({ ok: true, envelope: { subject: 'test' } }),
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
  } as unknown as MaildirStore;
}

function createMockSubscriptionRegistry(): SubscriptionRegistry {
  return {
    getSubscribers: vi.fn().mockReturnValue([]),
  } as unknown as SubscriptionRegistry;
}

function createMockSqliteIndex(): SqliteIndex {
  return {
    updateStatus: vi.fn(),
  } as unknown as SqliteIndex;
}

function createMockCircuitBreaker(): CircuitBreakerManager {
  return {
    recordFailure: vi.fn(),
  } as unknown as CircuitBreakerManager;
}

function createEndpoint(maildirPath: string): EndpointInfo {
  return {
    subject: 'relay.agent.test',
    hash: 'hash-test',
    maildirPath,
  };
}

/** Wait for a specified number of milliseconds. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll until a mock function has been called, with a timeout.
 * More reliable than fixed waits for chokidar-based tests.
 */
async function waitForCall(
  mockFn: ReturnType<typeof vi.fn>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (mockFn.mock.calls.length > 0) return;
    await wait(intervalMs);
  }
  throw new Error(`waitForCall timed out after ${timeoutMs}ms — mock was never called`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WatcherManager', () => {
  let maildirStore: MaildirStore;
  let subscriptionRegistry: SubscriptionRegistry;
  let sqliteIndex: SqliteIndex;
  let circuitBreaker: CircuitBreakerManager;
  let manager: WatcherManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'watcher-mgr-test-'));
    maildirStore = createMockMaildirStore();
    subscriptionRegistry = createMockSubscriptionRegistry();
    sqliteIndex = createMockSqliteIndex();
    circuitBreaker = createMockCircuitBreaker();
    manager = new WatcherManager(maildirStore, subscriptionRegistry, sqliteIndex, circuitBreaker);
  });

  afterEach(async () => {
    await manager.closeAll();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('startWatcher', () => {
    it('starts watching an endpoint new/ directory', async () => {
      const maildirPath = path.join(tmpDir, 'hash-test');
      fsSync.mkdirSync(path.join(maildirPath, 'new'), { recursive: true });
      const endpoint = createEndpoint(maildirPath);

      await manager.startWatcher(endpoint);

      // Watcher is running — no errors thrown
    });

    it('is idempotent — starting the same endpoint twice is a no-op', async () => {
      const maildirPath = path.join(tmpDir, 'hash-test');
      fsSync.mkdirSync(path.join(maildirPath, 'new'), { recursive: true });
      const endpoint = createEndpoint(maildirPath);

      await manager.startWatcher(endpoint);
      await manager.startWatcher(endpoint);

      // Second call returns immediately without error
    });
  });

  describe('stopWatcher', () => {
    it('stops the watcher for an endpoint', async () => {
      const maildirPath = path.join(tmpDir, 'hash-test');
      fsSync.mkdirSync(path.join(maildirPath, 'new'), { recursive: true });
      const endpoint = createEndpoint(maildirPath);

      await manager.startWatcher(endpoint);
      manager.stopWatcher('hash-test');

      // Watcher is stopped — no errors thrown
    });

    it('is safe to call with an unknown hash', () => {
      manager.stopWatcher('nonexistent');
      // No error thrown
    });
  });

  describe('closeAll', () => {
    it('closes all active watchers', async () => {
      const path1 = path.join(tmpDir, 'hash-1');
      const path2 = path.join(tmpDir, 'hash-2');
      fsSync.mkdirSync(path.join(path1, 'new'), { recursive: true });
      fsSync.mkdirSync(path.join(path2, 'new'), { recursive: true });

      await manager.startWatcher(createEndpoint(path1));
      await manager.startWatcher({
        subject: 'relay.agent.other',
        hash: 'hash-2',
        maildirPath: path2,
      });

      await manager.closeAll();

      // No errors thrown, watchers cleaned up
    });
  });

  describe('handleNewMessage (via watcher)', () => {
    it('dispatches to subscription handlers when a file appears in new/', async () => {
      const handler = vi.fn();
      vi.mocked(subscriptionRegistry.getSubscribers).mockReturnValue([handler]);

      const maildirPath = path.join(tmpDir, 'hash-test');
      fsSync.mkdirSync(path.join(maildirPath, 'new'), { recursive: true });
      const endpoint = createEndpoint(maildirPath);

      await manager.startWatcher(endpoint);

      // Write a .json file to trigger the watcher
      const msgPath = path.join(maildirPath, 'new', 'msg-001.json');
      fsSync.writeFileSync(msgPath, JSON.stringify({ subject: 'test' }));

      // Poll until chokidar detects the file and handler is invoked
      await waitForCall(vi.mocked(maildirStore.claim));

      expect(maildirStore.claim).toHaveBeenCalledWith('hash-test', 'msg-001');
      expect(handler).toHaveBeenCalled();
      expect(maildirStore.complete).toHaveBeenCalledWith('hash-test', 'msg-001');
      expect(sqliteIndex.updateStatus).toHaveBeenCalledWith('msg-001', 'delivered');
    });

    it('skips non-json files', async () => {
      const handler = vi.fn();
      vi.mocked(subscriptionRegistry.getSubscribers).mockReturnValue([handler]);

      const maildirPath = path.join(tmpDir, 'hash-test');
      fsSync.mkdirSync(path.join(maildirPath, 'new'), { recursive: true });
      const endpoint = createEndpoint(maildirPath);

      await manager.startWatcher(endpoint);

      // Write a non-json file, then a json file to confirm watcher is active
      fsSync.writeFileSync(path.join(maildirPath, 'new', 'readme.txt'), 'hi');

      // Write a json file to know when the watcher has processed
      fsSync.writeFileSync(
        path.join(maildirPath, 'new', 'sentinel.json'),
        JSON.stringify({ subject: 'test' }),
      );
      await waitForCall(vi.mocked(maildirStore.claim));

      // The claim should only have been called for the .json file
      expect(vi.mocked(maildirStore.claim).mock.calls).toHaveLength(1);
      expect(vi.mocked(maildirStore.claim).mock.calls[0][1]).toBe('sentinel');
    });

    it('moves to failed/ when handler throws', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('handler error'));
      vi.mocked(subscriptionRegistry.getSubscribers).mockReturnValue([handler]);

      const maildirPath = path.join(tmpDir, 'hash-test');
      fsSync.mkdirSync(path.join(maildirPath, 'new'), { recursive: true });
      const endpoint = createEndpoint(maildirPath);

      await manager.startWatcher(endpoint);

      fsSync.writeFileSync(
        path.join(maildirPath, 'new', 'msg-002.json'),
        JSON.stringify({ subject: 'test' }),
      );

      // Poll until the fail mock is called (handler rejection settles)
      await waitForCall(vi.mocked(maildirStore.fail));

      expect(maildirStore.fail).toHaveBeenCalledWith('hash-test', 'msg-002', 'handler error');
      expect(sqliteIndex.updateStatus).toHaveBeenCalledWith('msg-002', 'failed');
      expect(circuitBreaker.recordFailure).toHaveBeenCalledWith('hash-test');
    });
  });
});
