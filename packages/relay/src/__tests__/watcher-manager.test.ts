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
import * as path from 'node:path';
import { WatcherManager } from '../watcher-manager.js';
import type { SubscriptionRegistry } from '../subscription-registry.js';
import { MaildirStore } from '../maildir-store.js';
import type { SqliteIndex } from '../sqlite-index.js';
import type { CircuitBreakerManager } from '../circuit-breaker.js';
import type { EndpointInfo } from '../types.js';
import {
  interceptChokidar,
  deferred,
  type ChokidarInterceptor,
  type FakeWatcher,
} from './fake-watcher.js';
import {
  createSpyLogger,
  createMockMaildirStore,
  createMockSubscriptionRegistry,
  createMockSqliteIndex,
  createMockCircuitBreaker,
  armDeliveryBarrier,
  armNextClaimBarrier,
  flushPendingDispatches,
  createEndpoint,
} from './watcher-manager.fixtures.js';

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
    it('watches the endpoint new/ directory, leaving the initial scan to the sweep', async () => {
      const endpoint = createEndpoint();

      const watcher = await start(manager, endpoint);

      expect(watcher.watchedPath).toBe(path.join(endpoint.maildirPath, 'new'));
      // `ignoreInitial` is still load-bearing, for a different reason than it
      // used to be: what is already in new/ IS delivered now, but by the sweep
      // (see below), which claims each message once. Letting chokidar replay
      // the same files as `add` events would just be a second dispatcher racing
      // the first for a claim only one of them can win.
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

  // -------------------------------------------------------------------------
  // The startup reconcile (DOR-1787).
  //
  // chokidar's `ready` does not mean "nothing was missed": `chokidar.watch()`
  // returns before it has attached anything, and a file created inside that
  // window produces no `add` event at all — measured in DOR-577, where the same
  // gap kept sessions off the session list. For push delivery that was a
  // message dropped outright, because nothing re-read new/ afterwards. So the
  // manager lists the directory once the watcher is live and dispatches what is
  // really there.
  //
  // `listNew` is a directory listing, not an event, so these tests need no
  // filesystem and no clock: the mock decides what the mailbox holds.
  // -------------------------------------------------------------------------

  describe('startup reconcile sweep', () => {
    it('delivers a message that was already sitting in new/ when the watcher started', async () => {
      const handler = vi.fn();
      vi.mocked(subscriptionRegistry.getSubscribers).mockReturnValue([handler]);
      vi.mocked(maildirStore.listNew).mockResolvedValue(['msg-pre-existing']);

      const delivered = armDeliveryBarrier(sqliteIndex);
      await start(manager, createEndpoint('hash-sweep'));
      await delivered.promise;

      expect(maildirStore.listNew).toHaveBeenCalledWith('hash-sweep');
      expect(maildirStore.claim).toHaveBeenCalledWith('hash-sweep', 'msg-pre-existing');
      expect(handler).toHaveBeenCalled();
      expect(maildirStore.complete).toHaveBeenCalledWith('hash-sweep', 'msg-pre-existing');
      expect(sqliteIndex.updateStatus).toHaveBeenCalledWith(
        'msg-pre-existing',
        'hash-sweep',
        'delivered'
      );
    });

    // The backlog is drained one message at a time, matching
    // `RelayCore.drainEndpointBacklog` — the other function that drains this
    // same directory to these same subscribers. A parallel drain would turn N
    // stranded messages into N concurrent handler invocations, and a handler
    // here can be a whole agent turn.
    //
    // The probe is a gate rather than a delay, so it needs no clock: the first
    // message's claim parks, and a drain that had moved on would already have
    // claimed the other two by the time the gate is checked.
    it('dispatches every pending message one at a time, in the FIFO order the listing gives', async () => {
      const seen: string[] = [];
      vi.mocked(subscriptionRegistry.getSubscribers).mockReturnValue([vi.fn()]);
      vi.mocked(maildirStore.listNew).mockResolvedValue(['msg-a', 'msg-b', 'msg-c']);

      const gate = deferred();
      const inner = vi.mocked(maildirStore.claim).getMockImplementation()!;
      vi.mocked(maildirStore.claim).mockImplementation(async (endpointHash, messageId) => {
        if (messageId === 'msg-a') await gate.promise;
        return inner(endpointHash, messageId);
      });

      const allDelivered = deferred();
      vi.mocked(sqliteIndex.updateStatus).mockImplementation((messageId) => {
        seen.push(messageId);
        if (seen.length === 3) allDelivered.resolve();
        return true;
      });

      await start(manager, createEndpoint('hash-fifo'));
      await flushPendingDispatches();

      // Everything the drain could do without the gate opening, it has done.
      expect(vi.mocked(maildirStore.claim).mock.calls.map(([, id]) => id)).toEqual(['msg-a']);
      expect(seen).toEqual([]);

      gate.resolve();
      await allDelivered.promise;

      expect(seen).toEqual(['msg-a', 'msg-b', 'msg-c']);
    });

    // The both-saw-it case, in each order. Whichever dispatcher gets there
    // second loses the claim — the atomic rename the mock store models — so the
    // handler runs once. Both orders are pinned because in production the order
    // is decided by the platform, not by this code.
    it('delivers exactly once when the sweep dispatches first and the watcher event follows', async () => {
      const handler = vi.fn();
      vi.mocked(subscriptionRegistry.getSubscribers).mockReturnValue([handler]);
      vi.mocked(maildirStore.listNew).mockResolvedValue(['msg-both']);

      const endpoint = createEndpoint('hash-both-sweep-first');
      const delivered = armDeliveryBarrier(sqliteIndex);
      const watcher = await start(manager, endpoint);
      await delivered.promise;

      const secondClaim = armNextClaimBarrier(maildirStore);
      watcher.emit('add', path.join(endpoint.maildirPath, 'new', 'msg-both.json'));
      await secondClaim.promise;
      await flushPendingDispatches();

      expect(vi.mocked(maildirStore.claim).mock.calls).toHaveLength(2);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(vi.mocked(sqliteIndex.updateStatus).mock.calls).toHaveLength(1);
    });

    it('delivers exactly once when the watcher event lands before the sweep lists it', async () => {
      const handler = vi.fn();
      vi.mocked(subscriptionRegistry.getSubscribers).mockReturnValue([handler]);
      vi.mocked(maildirStore.listNew).mockResolvedValue(['msg-both']);

      const endpoint = createEndpoint('hash-both-watcher-first');
      const started = manager.startWatcher(endpoint);
      const watcher = chokidarSpy.latest();

      const delivered = armDeliveryBarrier(sqliteIndex);
      watcher.emit('add', path.join(endpoint.maildirPath, 'new', 'msg-both.json'));
      await delivered.promise;

      const secondClaim = armNextClaimBarrier(maildirStore);
      watcher.emit('ready');
      await started;
      await secondClaim.promise;
      await flushPendingDispatches();

      expect(vi.mocked(maildirStore.claim).mock.calls).toHaveLength(2);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(vi.mocked(sqliteIndex.updateStatus).mock.calls).toHaveLength(1);
    });

    it('honours wasDispatched for swept messages, exactly as for watcher events', async () => {
      vi.mocked(subscriptionRegistry.getSubscribers).mockReturnValue([vi.fn()]);
      vi.mocked(maildirStore.listNew).mockResolvedValue(['msg-dup-001', 'sentinel']);
      manager.setWasDispatched((id) => id === 'msg-dup-001');

      // The sentinel proves the sweep ran at all, so "msg-dup-001 was not
      // claimed" means "skipped", not "the sweep never got there".
      const delivered = armDeliveryBarrier(sqliteIndex);
      await start(manager, createEndpoint('hash-sweep-dedup'));
      await delivered.promise;

      const claimed = vi.mocked(maildirStore.claim).mock.calls;
      expect(claimed.every(([, id]) => id !== 'msg-dup-001')).toBe(true);
      expect(claimed.some(([, id]) => id === 'sentinel')).toBe(true);
    });

    it('keeps the watcher alive and logs when the mailbox cannot be listed', async () => {
      const logger = createSpyLogger();
      const loggedManager = new WatcherManager(
        maildirStore,
        subscriptionRegistry,
        sqliteIndex,
        circuitBreaker,
        logger
      );
      const handler = vi.fn();
      vi.mocked(subscriptionRegistry.getSubscribers).mockReturnValue([handler]);
      vi.mocked(maildirStore.listNew).mockRejectedValue(
        Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      );

      try {
        const endpoint = createEndpoint('hash-sweep-fail', 'relay.agent.sweep-fail');
        // A sweep that throws must not take the start promise — nor push
        // delivery — down with it.
        const watcher = await start(loggedManager, endpoint);

        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringMatching(/^\[watcher-sweep\] WatcherManager: /),
          expect.objectContaining({
            endpointSubject: 'relay.agent.sweep-fail',
            message: 'EACCES: permission denied',
          })
        );

        const delivered = armDeliveryBarrier(sqliteIndex);
        watcher.emit('add', path.join(endpoint.maildirPath, 'new', 'msg-after-fail.json'));
        await delivered.promise;

        expect(maildirStore.claim).toHaveBeenCalledWith('hash-sweep-fail', 'msg-after-fail');
        expect(handler).toHaveBeenCalled();
      } finally {
        await loggedManager.closeAll();
      }
    });

    it('abandons the sweep when the endpoint was stopped while the listing was in flight', async () => {
      vi.mocked(subscriptionRegistry.getSubscribers).mockReturnValue([vi.fn()]);
      const listing = deferred<string[]>();
      vi.mocked(maildirStore.listNew).mockReturnValue(listing.promise);

      const started = manager.startWatcher(createEndpoint('hash-sweep-stopped'));
      chokidarSpy.latest().emit('ready');
      await manager.stopWatcher('hash-sweep-stopped');

      // The mailbox answers only now — for a watcher nobody is listening to.
      listing.resolve(['msg-orphan']);
      await started;

      expect(maildirStore.claim).not.toHaveBeenCalled();
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
});
