import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { EventEmitter } from 'node:events';
import { WatcherManager } from '../watcher-manager.js';
import type { SubscriptionRegistry } from '../subscription-registry.js';
import type { MaildirStore } from '../maildir-store.js';
import type { SqliteIndex } from '../sqlite-index.js';
import type { CircuitBreakerManager } from '../circuit-breaker.js';
import type { EndpointInfo, RelayLogger } from '../types.js';

/** Reach into the private watcher map to simulate an EMFILE-style failure. */
function getWatcher(manager: WatcherManager, hash: string): EventEmitter {
  const watchers = (manager as unknown as { watchers: Map<string, EventEmitter> }).watchers;
  const watcher = watchers.get(hash);
  if (!watcher) throw new Error(`no watcher registered for hash ${hash}`);
  return watcher;
}

/** A spy logger satisfying the full {@link RelayLogger} surface. */
function createSpyLogger(): RelayLogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function createMockMaildirStore(): MaildirStore {
  return {
    claim: vi.fn().mockResolvedValue({ ok: true, envelope: { subject: 'test' } }),
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue({ ok: true, path: '/tmp/test/failed/msg.json' }),
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
    registeredAt: '2026-02-24T00:00:00.000Z',
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
  intervalMs = 50
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
        registeredAt: '2026-02-24T00:00:00.000Z',
      });

      await manager.closeAll();

      // No errors thrown, watchers cleaned up
    });
  });

  describe('setWasDispatched', () => {
    it('skips dispatch when wasDispatched returns true for the message ID', async () => {
      const handler = vi.fn();
      vi.mocked(subscriptionRegistry.getSubscribers).mockReturnValue([handler]);

      // Register a dedup guard that always reports "already dispatched"
      manager.setWasDispatched(() => true);

      const maildirPath = path.join(tmpDir, 'hash-test');
      fsSync.mkdirSync(path.join(maildirPath, 'new'), { recursive: true });
      const endpoint = createEndpoint(maildirPath);

      await manager.startWatcher(endpoint);

      // Write a JSON file — the dedup guard should prevent claim
      fsSync.writeFileSync(
        path.join(maildirPath, 'new', 'msg-dup-001.json'),
        JSON.stringify({ subject: 'test' })
      );

      // Let chokidar detect and process the first file before changing the guard
      await wait(300);

      // Write a second file WITHOUT dedup to confirm the watcher is still active
      manager.setWasDispatched((id) => id === 'msg-dup-001');
      const sentinelPath = path.join(maildirPath, 'new', 'sentinel.json');
      fsSync.writeFileSync(sentinelPath, JSON.stringify({ subject: 'test' }));

      await waitForCall(vi.mocked(maildirStore.claim));

      // Only sentinel was claimed — the deduped message was skipped
      const calls = vi.mocked(maildirStore.claim).mock.calls;
      expect(calls.every(([, id]) => id !== 'msg-dup-001')).toBe(true);
      expect(calls.some(([, id]) => id === 'sentinel')).toBe(true);
    });

    it('dispatches normally when wasDispatched returns false', async () => {
      const handler = vi.fn();
      vi.mocked(subscriptionRegistry.getSubscribers).mockReturnValue([handler]);

      // Guard that never blocks
      manager.setWasDispatched(() => false);

      const maildirPath = path.join(tmpDir, 'hash-dispatch');
      fsSync.mkdirSync(path.join(maildirPath, 'new'), { recursive: true });
      const endpoint: EndpointInfo = {
        subject: 'relay.agent.test',
        hash: 'hash-dispatch',
        maildirPath,
        registeredAt: '2026-02-24T00:00:00.000Z',
      };

      await manager.startWatcher(endpoint);

      // Small delay to let chokidar stabilise before writing
      await wait(200);

      fsSync.writeFileSync(
        path.join(maildirPath, 'new', 'msg-new-001.json'),
        JSON.stringify({ subject: 'test' })
      );

      await waitForCall(vi.mocked(maildirStore.claim));

      expect(maildirStore.claim).toHaveBeenCalledWith('hash-dispatch', 'msg-new-001');
      expect(handler).toHaveBeenCalled();
    });
  });

  describe('handleNewMessage (via watcher)', () => {
    it('dispatches to subscription handlers when a file appears in new/', async () => {
      const handler = vi.fn();
      vi.mocked(subscriptionRegistry.getSubscribers).mockReturnValue([handler]);

      const maildirPath = path.join(tmpDir, 'hash-handle');
      fsSync.mkdirSync(path.join(maildirPath, 'new'), { recursive: true });
      const endpoint: EndpointInfo = {
        subject: 'relay.agent.test',
        hash: 'hash-handle',
        maildirPath,
        registeredAt: '2026-02-24T00:00:00.000Z',
      };

      await manager.startWatcher(endpoint);

      // Small delay to let chokidar stabilise before writing
      await wait(200);

      // Write a .json file to trigger the watcher
      const msgPath = path.join(maildirPath, 'new', 'msg-001.json');
      fsSync.writeFileSync(msgPath, JSON.stringify({ subject: 'test' }));

      // Poll until chokidar detects the file and handler is invoked
      await waitForCall(vi.mocked(maildirStore.claim));

      expect(maildirStore.claim).toHaveBeenCalledWith('hash-handle', 'msg-001');
      expect(handler).toHaveBeenCalled();
      expect(maildirStore.complete).toHaveBeenCalledWith('hash-handle', 'msg-001');
      expect(sqliteIndex.updateStatus).toHaveBeenCalledWith('msg-001', 'hash-handle', 'delivered');
    });

    it('skips non-json files', async () => {
      const handler = vi.fn();
      vi.mocked(subscriptionRegistry.getSubscribers).mockReturnValue([handler]);

      const maildirPath = path.join(tmpDir, 'hash-nonjson');
      fsSync.mkdirSync(path.join(maildirPath, 'new'), { recursive: true });
      const endpoint: EndpointInfo = {
        subject: 'relay.agent.test',
        hash: 'hash-nonjson',
        maildirPath,
        registeredAt: '2026-02-24T00:00:00.000Z',
      };

      await manager.startWatcher(endpoint);
      await wait(200);

      // Write a non-json file, then a json file to confirm watcher is active
      fsSync.writeFileSync(path.join(maildirPath, 'new', 'readme.txt'), 'hi');

      // Write a json file to know when the watcher has processed
      fsSync.writeFileSync(
        path.join(maildirPath, 'new', 'sentinel.json'),
        JSON.stringify({ subject: 'test' })
      );
      await waitForCall(vi.mocked(maildirStore.claim));

      // The claim should only have been called for the .json file
      expect(vi.mocked(maildirStore.claim).mock.calls).toHaveLength(1);
      expect(vi.mocked(maildirStore.claim).mock.calls[0][1]).toBe('sentinel');
    });

    it('moves to failed/ when handler throws', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('handler error'));
      vi.mocked(subscriptionRegistry.getSubscribers).mockReturnValue([handler]);

      const maildirPath = path.join(tmpDir, 'hash-fail');
      fsSync.mkdirSync(path.join(maildirPath, 'new'), { recursive: true });
      const endpoint: EndpointInfo = {
        subject: 'relay.agent.test',
        hash: 'hash-fail',
        maildirPath,
        registeredAt: '2026-02-24T00:00:00.000Z',
      };

      await manager.startWatcher(endpoint);
      await wait(200);

      fsSync.writeFileSync(
        path.join(maildirPath, 'new', 'msg-002.json'),
        JSON.stringify({ subject: 'test' })
      );

      // Poll until the fail mock is called (handler rejection settles)
      await waitForCall(vi.mocked(maildirStore.fail));

      expect(maildirStore.fail).toHaveBeenCalledWith('hash-fail', 'msg-002', 'handler error');
      expect(sqliteIndex.updateStatus).toHaveBeenCalledWith('msg-002', 'hash-fail', 'failed');
      expect(circuitBreaker.recordFailure).toHaveBeenCalledWith('hash-fail');
    });
  });

  describe('watcher error handling', () => {
    /** Build a manager with a spy logger plus a ready-to-watch endpoint. */
    function setup(hash: string, subject: string) {
      const logger = createSpyLogger();
      const loggedManager = new WatcherManager(
        maildirStore,
        subscriptionRegistry,
        sqliteIndex,
        circuitBreaker,
        logger
      );
      const maildirPath = path.join(tmpDir, hash);
      fsSync.mkdirSync(path.join(maildirPath, 'new'), { recursive: true });
      const endpoint: EndpointInfo = {
        subject,
        hash,
        maildirPath,
        registeredAt: '2026-02-24T00:00:00.000Z',
      };
      return { logger, loggedManager, endpoint };
    }

    it('logs a watcher error through the injected logger, naming the endpoint', async () => {
      const { logger, loggedManager, endpoint } = setup('hash-error', 'relay.agent.error-test');
      // try/finally: closeAll() must run even if an assertion below throws, or a
      // failing test leaks this watcher into the rest of the run.
      try {
        await loggedManager.startWatcher(endpoint);

        const err = Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
        getWatcher(loggedManager, 'hash-error').emit('error', err);

        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringMatching(/^\[watcher-error\] WatcherManager: /),
          expect.objectContaining({
            endpointSubject: 'relay.agent.error-test',
            code: 'EMFILE',
            message: 'EMFILE: too many open files',
            stack: err.stack,
            suppressingFurtherErrors: true,
          })
        );
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('relay.agent.error-test'),
          expect.anything()
        );
      } finally {
        await loggedManager.closeAll();
      }
    });

    it('does not throw when no logger was injected (defaults to a silent logger)', async () => {
      const maildirPath = path.join(tmpDir, 'hash-error-silent');
      fsSync.mkdirSync(path.join(maildirPath, 'new'), { recursive: true });
      const endpoint: EndpointInfo = {
        ...createEndpoint(maildirPath),
        hash: 'hash-error-silent',
      };
      await manager.startWatcher(endpoint);

      expect(() =>
        getWatcher(manager, 'hash-error-silent').emit('error', new Error('EMFILE'))
      ).not.toThrow();
    });

    // A single fd-exhaustion episode can make chokidar fire 'error' many times
    // for one dead watcher. The handler must latch: log the first, drop repeats
    // of the same code.
    it('logs only the first of many errors carrying the same code', async () => {
      const { logger, loggedManager, endpoint } = setup(
        'hash-error-latch',
        'relay.agent.latch-test'
      );
      try {
        await loggedManager.startWatcher(endpoint);
        const watcher = getWatcher(loggedManager, 'hash-error-latch');

        watcher.emit('error', Object.assign(new Error('EMFILE 1'), { code: 'EMFILE' }));
        watcher.emit('error', Object.assign(new Error('EMFILE 2'), { code: 'EMFILE' }));
        watcher.emit('error', Object.assign(new Error('EMFILE 3'), { code: 'EMFILE' }));

        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ code: 'EMFILE', message: 'EMFILE 1' })
        );
      } finally {
        await loggedManager.closeAll();
      }
    });

    // The masking bug: a latch keyed on "any error at all" would let one benign
    // EACCES hide a real EMFILE storm that follows it. Keying on `code` means a
    // NEW code always gets its own line.
    it('logs a separate line for each distinct error code', async () => {
      const { logger, loggedManager, endpoint } = setup(
        'hash-error-codes',
        'relay.agent.codes-test'
      );
      try {
        await loggedManager.startWatcher(endpoint);
        const watcher = getWatcher(loggedManager, 'hash-error-codes');

        watcher.emit('error', Object.assign(new Error('permission denied'), { code: 'EACCES' }));
        watcher.emit('error', Object.assign(new Error('too many open files'), { code: 'EMFILE' }));

        expect(logger.warn).toHaveBeenCalledTimes(2);
        expect(logger.warn).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ code: 'EACCES' })
        );
        expect(logger.warn).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ code: 'EMFILE' })
        );
      } finally {
        await loggedManager.closeAll();
      }
    });

    it('says further errors of that code are suppressed, so an operator knows the silence is by design', async () => {
      const { logger, loggedManager, endpoint } = setup(
        'hash-error-notice',
        'relay.agent.notice-test'
      );
      try {
        await loggedManager.startWatcher(endpoint);
        getWatcher(loggedManager, 'hash-error-notice').emit(
          'error',
          Object.assign(new Error('EMFILE'), { code: 'EMFILE' })
        );

        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('further EMFILE errors from this watcher are suppressed'),
          expect.objectContaining({ suppressingFurtherErrors: true })
        );
      } finally {
        await loggedManager.closeAll();
      }
    });

    // Regression guard: if the latch were ever hoisted from a per-startWatcher()
    // closure onto a shared instance field, one endpoint's first error would
    // wrongly suppress another endpoint's first error too.
    it('scopes the latch per watcher — two endpoints each log their own first error', async () => {
      const logger = createSpyLogger();
      const loggedManager = new WatcherManager(
        maildirStore,
        subscriptionRegistry,
        sqliteIndex,
        circuitBreaker,
        logger
      );
      const makeEndpoint = (hash: string, subject: string): EndpointInfo => {
        const maildirPath = path.join(tmpDir, hash);
        fsSync.mkdirSync(path.join(maildirPath, 'new'), { recursive: true });
        return { subject, hash, maildirPath, registeredAt: '2026-02-24T00:00:00.000Z' };
      };
      try {
        await loggedManager.startWatcher(makeEndpoint('hash-scope-a', 'relay.agent.scope-a'));
        await loggedManager.startWatcher(makeEndpoint('hash-scope-b', 'relay.agent.scope-b'));

        getWatcher(loggedManager, 'hash-scope-a').emit('error', new Error('EMFILE A'));
        getWatcher(loggedManager, 'hash-scope-b').emit('error', new Error('EMFILE B'));

        expect(logger.warn).toHaveBeenCalledTimes(2);
      } finally {
        await loggedManager.closeAll();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Critical regression: startWatcher() must resolve even when the watcher
  // errors before ever going ready. Under real fd exhaustion chokidar emits
  // 'error' and never emits 'ready' — without settling from the error handler
  // too, this promise hangs forever, and so does every caller on the boot path
  // with it (server startup, an agent's relay tool call).
  // -------------------------------------------------------------------------

  describe('startWatcher settles on error', () => {
    it('resolves (does not hang) when the watcher errors before ever going ready', async () => {
      const maildirPath = path.join(tmpDir, 'hash-error-before-ready');
      fsSync.mkdirSync(path.join(maildirPath, 'new'), { recursive: true });
      const endpoint: EndpointInfo = {
        subject: 'relay.agent.hang-test',
        hash: 'hash-error-before-ready',
        maildirPath,
        registeredAt: '2026-02-24T00:00:00.000Z',
      };

      const startPromise = manager.startWatcher(endpoint);
      // This watches a real, healthy directory, so a real 'ready' would
      // otherwise arrive a few ms later and resolve the promise on its own —
      // making the test pass even without settle() in the error handler. Record
      // whether 'ready' fired and assert it did NOT: that names the mechanism
      // (the ERROR path settled it) rather than the outcome.
      const watcher = getWatcher(manager, 'hash-error-before-ready');
      let readyFired = false;
      watcher.on('ready', () => {
        readyFired = true;
      });
      watcher.emit('error', new Error('EMFILE'));

      await expect(startPromise).resolves.toBeUndefined();
      expect(readyFired).toBe(false);
    });
  });
});
