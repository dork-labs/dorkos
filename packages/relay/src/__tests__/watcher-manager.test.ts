/**
 * Tests for {@link WatcherManager}.
 *
 * Every behavioural test here drives an INJECTED watcher (see `./fake-watcher.ts`)
 * rather than a real chokidar one, and waits on a barrier the production code
 * itself trips rather than on a clock. That is deliberate: this file used to
 * write real files into a real tmpdir and poll a hand-rolled 5s deadline for the
 * `add` event, which made it a measurement of the machine's fs-event latency and
 * red it under multi-agent load (DOR-1777). One smoke test at the bottom keeps
 * the real wiring honest, and it is the only wall-clock bound left in the file.
 *
 * @module __tests__/watcher-manager
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { WatcherManager } from '../watcher-manager.js';
import type { SubscriptionRegistry } from '../subscription-registry.js';
import type { MaildirStore } from '../maildir-store.js';
import type { SqliteIndex } from '../sqlite-index.js';
import type { CircuitBreakerManager } from '../circuit-breaker.js';
import type { EndpointInfo, RelayLogger } from '../types.js';
import {
  interceptChokidar,
  deferred,
  type ChokidarInterceptor,
  type Deferred,
  type FakeWatcher,
} from './fake-watcher.js';

/** A spy logger satisfying the full {@link RelayLogger} surface. */
function createSpyLogger(): RelayLogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * Arm `sqliteIndex.updateStatus` as a delivery barrier.
 *
 * Flipping the index status is the last thing `handleNewMessage` does on the
 * success path, so a test awaiting the returned promise resumes exactly when the
 * dispatch finished — no polling and no clock. The `true` matches the real
 * index, which reports whether it updated a row.
 *
 * @param index - The mock index to arm.
 * @returns The barrier to await after emitting the `add` event.
 */
function armDeliveryBarrier(index: SqliteIndex): Deferred<void> {
  const barrier = deferred();
  vi.mocked(index.updateStatus).mockImplementation(() => {
    barrier.resolve();
    return true;
  });
  return barrier;
}

/**
 * An endpoint over a path nothing on disk needs to exist at.
 *
 * The store, registry, index and breaker are all doubles, and the watcher is
 * injected, so no test below this line touches the filesystem at all — the
 * exception is the real-filesystem smoke test, which builds its own tmpdir.
 */
function createEndpoint(hash = 'hash-test', subject = 'relay.agent.test'): EndpointInfo {
  return {
    subject,
    hash,
    maildirPath: path.join('/virtual/relay/endpoints', hash),
    registeredAt: '2026-02-24T00:00:00.000Z',
  };
}

describe('WatcherManager', () => {
  let maildirStore: MaildirStore;
  let subscriptionRegistry: SubscriptionRegistry;
  let sqliteIndex: SqliteIndex;
  let circuitBreaker: CircuitBreakerManager;
  let manager: WatcherManager;
  let chokidarSpy: ChokidarInterceptor;

  /**
   * Start a watcher and take it live, without waiting on anything real.
   *
   * `startWatcher` attaches its `ready` listener synchronously inside the
   * promise it returns, so the event can be fired the moment the call is made.
   */
  async function start(
    target: WatcherManager,
    endpoint: EndpointInfo,
    intercept: ChokidarInterceptor = chokidarSpy
  ): Promise<FakeWatcher> {
    const started = target.startWatcher(endpoint);
    const watcher = intercept.latest();
    watcher.emit('ready');
    await started;
    return watcher;
  }

  beforeEach(() => {
    chokidarSpy = interceptChokidar();
    maildirStore = createMockMaildirStore();
    subscriptionRegistry = createMockSubscriptionRegistry();
    sqliteIndex = createMockSqliteIndex();
    circuitBreaker = createMockCircuitBreaker();
    manager = new WatcherManager(maildirStore, subscriptionRegistry, sqliteIndex, circuitBreaker);
  });

  afterEach(async () => {
    await manager.closeAll();
    vi.restoreAllMocks();
  });

  describe('startWatcher', () => {
    it('watches the endpoint new/ directory, ignoring what is already there', async () => {
      const endpoint = createEndpoint();

      const watcher = await start(manager, endpoint);

      expect(watcher.watchedPath).toBe(path.join(endpoint.maildirPath, 'new'));
      // `ignoreInitial` is load-bearing: without it, every message already
      // sitting in new/ would be re-dispatched on every restart.
      expect(watcher.options).toMatchObject({ persistent: true, ignoreInitial: true });
    });

    it('is idempotent — starting the same endpoint twice creates one watcher', async () => {
      const endpoint = createEndpoint();

      await start(manager, endpoint);
      await manager.startWatcher(endpoint);

      expect(chokidarSpy.created).toHaveLength(1);
    });
  });

  describe('stopWatcher', () => {
    it('closes the watcher for an endpoint', async () => {
      const watcher = await start(manager, createEndpoint());

      await manager.stopWatcher('hash-test');

      expect(watcher.closed).toBe(true);
    });

    it('is safe to call with an unknown hash', async () => {
      await expect(manager.stopWatcher('nonexistent')).resolves.toBeUndefined();
    });
  });

  describe('closeAll', () => {
    it('closes all active watchers', async () => {
      const first = await start(manager, createEndpoint('hash-1'));
      const second = await start(manager, createEndpoint('hash-2', 'relay.agent.other'));

      await manager.closeAll();

      expect(first.closed).toBe(true);
      expect(second.closed).toBe(true);
    });
  });

  describe('setWasDispatched', () => {
    it('skips dispatch when wasDispatched returns true for the message ID', async () => {
      const handler = vi.fn();
      vi.mocked(subscriptionRegistry.getSubscribers).mockReturnValue([handler]);
      manager.setWasDispatched((id) => id === 'msg-dup-001');

      const endpoint = createEndpoint();
      const watcher = await start(manager, endpoint);
      const newDir = path.join(endpoint.maildirPath, 'new');

      // The guard is consulted before the first `await` in handleNewMessage, so
      // this event is fully decided by the time `emit` returns — there is
      // nothing to wait for and nothing to race.
      watcher.emit('add', path.join(newDir, 'msg-dup-001.json'));

      // A second, undeduped message proves the watcher is still dispatching, so
      // "not claimed" above means "skipped", not "wired to nothing".
      const delivered = armDeliveryBarrier(sqliteIndex);
      watcher.emit('add', path.join(newDir, 'sentinel.json'));
      await delivered.promise;

      const claimed = vi.mocked(maildirStore.claim).mock.calls;
      expect(claimed.every(([, id]) => id !== 'msg-dup-001')).toBe(true);
      expect(claimed.some(([, id]) => id === 'sentinel')).toBe(true);
    });

    it('dispatches normally when wasDispatched returns false', async () => {
      const handler = vi.fn();
      vi.mocked(subscriptionRegistry.getSubscribers).mockReturnValue([handler]);
      manager.setWasDispatched(() => false);

      const endpoint = createEndpoint('hash-dispatch');
      const watcher = await start(manager, endpoint);

      const delivered = armDeliveryBarrier(sqliteIndex);
      watcher.emit('add', path.join(endpoint.maildirPath, 'new', 'msg-new-001.json'));
      await delivered.promise;

      expect(maildirStore.claim).toHaveBeenCalledWith('hash-dispatch', 'msg-new-001');
      expect(handler).toHaveBeenCalled();
    });
  });

  describe('handleNewMessage (via watcher)', () => {
    it('dispatches to subscription handlers when a file appears in new/', async () => {
      const handler = vi.fn();
      vi.mocked(subscriptionRegistry.getSubscribers).mockReturnValue([handler]);

      const endpoint = createEndpoint('hash-handle');
      const watcher = await start(manager, endpoint);

      const delivered = armDeliveryBarrier(sqliteIndex);
      watcher.emit('add', path.join(endpoint.maildirPath, 'new', 'msg-001.json'));
      await delivered.promise;

      expect(maildirStore.claim).toHaveBeenCalledWith('hash-handle', 'msg-001');
      expect(handler).toHaveBeenCalled();
      expect(maildirStore.complete).toHaveBeenCalledWith('hash-handle', 'msg-001');
      expect(sqliteIndex.updateStatus).toHaveBeenCalledWith('msg-001', 'hash-handle', 'delivered');
    });

    it('skips non-json files', async () => {
      const handler = vi.fn();
      vi.mocked(subscriptionRegistry.getSubscribers).mockReturnValue([handler]);

      const endpoint = createEndpoint('hash-nonjson');
      const watcher = await start(manager, endpoint);
      const newDir = path.join(endpoint.maildirPath, 'new');

      const delivered = armDeliveryBarrier(sqliteIndex);
      // The extension check is the first statement in the handler, so the .txt
      // event is settled before the .json event is even emitted.
      watcher.emit('add', path.join(newDir, 'readme.txt'));
      watcher.emit('add', path.join(newDir, 'sentinel.json'));
      await delivered.promise;

      expect(vi.mocked(maildirStore.claim).mock.calls).toHaveLength(1);
      expect(vi.mocked(maildirStore.claim).mock.calls[0][1]).toBe('sentinel');
    });

    it('moves to failed/ when handler throws', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('handler error'));
      vi.mocked(subscriptionRegistry.getSubscribers).mockReturnValue([handler]);

      const endpoint = createEndpoint('hash-fail');
      const watcher = await start(manager, endpoint);

      const failed = deferred();
      vi.mocked(circuitBreaker.recordFailure).mockImplementation(() => failed.resolve());
      watcher.emit('add', path.join(endpoint.maildirPath, 'new', 'msg-002.json'));
      await failed.promise;

      expect(maildirStore.fail).toHaveBeenCalledWith('hash-fail', 'msg-002', 'handler error');
      expect(sqliteIndex.updateStatus).toHaveBeenCalledWith('msg-002', 'hash-fail', 'failed');
      expect(circuitBreaker.recordFailure).toHaveBeenCalledWith('hash-fail');
    });
  });

  describe('watcher error handling', () => {
    /** Build a manager with a spy logger over an endpoint that needs no disk. */
    function setup(hash: string, subject: string) {
      const logger = createSpyLogger();
      const loggedManager = new WatcherManager(
        maildirStore,
        subscriptionRegistry,
        sqliteIndex,
        circuitBreaker,
        logger
      );
      return { logger, loggedManager, endpoint: createEndpoint(hash, subject) };
    }

    it('logs a watcher error through the injected logger, naming the endpoint', async () => {
      const { logger, loggedManager, endpoint } = setup('hash-error', 'relay.agent.error-test');
      // try/finally: closeAll() must run even if an assertion below throws, or a
      // failing test leaks this watcher into the rest of the run.
      try {
        const watcher = await start(loggedManager, endpoint);

        const err = Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
        watcher.emit('error', err);

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
      const watcher = await start(manager, createEndpoint('hash-error-silent'));

      expect(() => watcher.emit('error', new Error('EMFILE'))).not.toThrow();
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
        const watcher = await start(loggedManager, endpoint);

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
        const watcher = await start(loggedManager, endpoint);

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
        const watcher = await start(loggedManager, endpoint);
        watcher.emit('error', Object.assign(new Error('EMFILE'), { code: 'EMFILE' }));

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
      try {
        const watcherA = await start(loggedManager, createEndpoint('hash-scope-a', 'scope.a'));
        const watcherB = await start(loggedManager, createEndpoint('hash-scope-b', 'scope.b'));

        watcherA.emit('error', new Error('EMFILE A'));
        watcherB.emit('error', new Error('EMFILE B'));

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
      // The injected watcher emits nothing on its own, so 'ready' is not coming
      // and cannot mask the mechanism under test. Lose `settle()` from the error
      // handler and this test hangs to its timeout rather than passing anyway —
      // which is precisely why the previous version of it, against a real
      // watcher over a healthy directory, needed a `readyFired` guard.
      const startPromise = manager.startWatcher(createEndpoint('hash-error-before-ready'));
      chokidarSpy.latest().emit('error', new Error('EMFILE'));

      await expect(startPromise).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // The one test in this file that touches the real filesystem and a real
  // chokidar watcher.
  //
  // Everything above proves what the manager does with an `add` event. This
  // proves an `add` event happens at all: that `chokidar.watch(<maildir>/new)`
  // sees a file really written there, and that the path it hands back has the
  // message id as its basename — the assumption every hermetic test encodes.
  // A chokidar major that changed either would sail past the tests above.
  //
  // Its bound is wall-clock and deliberate. Retrying under a FRESH filename is
  // the part that matters: chokidar reports `ready` a beat before libuv starts
  // delivering, so an early write is dropped outright, not delivered late, and
  // no amount of extra waiting on that path recovers it (measured on macOS —
  // see READY_DELIVERY_GRACE_MS in access-control.ts, and DOR-577).
  // -------------------------------------------------------------------------

  describe('real filesystem smoke', () => {
    /** Ceiling for the whole retry loop — generous, and paid only on failure. */
    const SMOKE_BUDGET_MS = 20_000;
    /** How long each attempt gives the platform before writing a fresh file. */
    const SMOKE_ATTEMPT_MS = 500;

    it('a file really written into new/ reaches the handler, keyed by its basename', async () => {
      chokidarSpy.restore();
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'watcher-mgr-smoke-'));
      const maildirPath = path.join(tmpDir, 'hash-real');
      const newDir = path.join(maildirPath, 'new');
      await fs.mkdir(newDir, { recursive: true });

      const handler = vi.fn();
      vi.mocked(subscriptionRegistry.getSubscribers).mockReturnValue([handler]);
      const delivered = armDeliveryBarrier(sqliteIndex);

      try {
        await manager.startWatcher({
          subject: 'relay.agent.smoke',
          hash: 'hash-real',
          maildirPath,
          registeredAt: '2026-02-24T00:00:00.000Z',
        });

        const deadline = Date.now() + SMOKE_BUDGET_MS;
        for (let attempt = 0; !delivered.settled && Date.now() < deadline; attempt += 1) {
          await fs.writeFile(
            path.join(newDir, `msg-real-${attempt}.json`),
            JSON.stringify({ subject: 'test' })
          );
          // The timer id is held so the loser of the race can be cancelled: a
          // race does not stop the branch it did not pick, so an uncancelled
          // timer per attempt would keep the event loop busy past the test.
          let attemptTimer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            delivered.promise,
            new Promise((resolve) => {
              attemptTimer = setTimeout(resolve, SMOKE_ATTEMPT_MS);
            }),
          ]);
          clearTimeout(attemptTimer);
        }
        if (!delivered.settled) {
          throw new Error(
            `a real chokidar watcher on ${newDir} delivered nothing within ${SMOKE_BUDGET_MS}ms`
          );
        }

        const claimed = vi.mocked(maildirStore.claim).mock.calls;
        const [claimedHash, messageId] = claimed[0]!;
        expect(claimedHash).toBe('hash-real');
        expect(messageId).toMatch(/^msg-real-\d+$/);
        expect(handler).toHaveBeenCalled();
        expect(sqliteIndex.updateStatus).toHaveBeenCalledWith(messageId, 'hash-real', 'delivered');
      } finally {
        await manager.closeAll();
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    }, 30_000);
  });
});
