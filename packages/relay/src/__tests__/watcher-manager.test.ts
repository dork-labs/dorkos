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
import { MaildirStore } from '../maildir-store.js';
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
  // `claim` models the real thing — an atomic `new/` -> `cur/` rename that
  // exactly one caller can win. That is the entire dedup story between the
  // startup sweep and the watcher, so a mock that said `ok: true` to everyone
  // would make a double delivery look like a pass.
  const claimed = new Set<string>();
  return {
    claim: vi.fn(async (endpointHash: string, messageId: string) => {
      const key = `${endpointHash}/${messageId}`;
      if (claimed.has(key)) {
        return { ok: false, error: 'claim failed: ENOENT' };
      }
      claimed.add(key);
      return { ok: true, envelope: { subject: 'test' }, path: `/virtual/cur/${messageId}.json` };
    }),
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue({ ok: true, path: '/tmp/test/failed/msg.json' }),
    // Nothing is pending unless a test says so — the sweep is a no-op by default.
    listNew: vi.fn().mockResolvedValue([]),
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
 * Arm a barrier that trips when `claim` is next called and has returned.
 *
 * The counterpart to {@link armDeliveryBarrier} for the paths that are
 * SUPPOSED to stop early: a duplicate dispatch loses the claim race and never
 * reaches the index, so there is no delivery to wait on — but the attempt is
 * still observable, and waiting for it is what makes "exactly once" an
 * assertion about finished work rather than about work that had not started.
 *
 * @param store - The mock store whose `claim` to wrap.
 * @returns The barrier to await after triggering the second dispatch.
 */
function armNextClaimBarrier(store: MaildirStore): Deferred<void> {
  const barrier = deferred();
  const inner = vi.mocked(store.claim).getMockImplementation();
  if (!inner) throw new Error('armNextClaimBarrier: claim has no implementation to wrap');
  vi.mocked(store.claim).mockImplementation(async (endpointHash, messageId) => {
    const result = await inner(endpointHash, messageId);
    barrier.resolve();
    return result;
  });
  return barrier;
}

/**
 * Yield past a macrotask boundary, draining everything queued behind it.
 *
 * The claim barrier trips inside the `claim` mock, which is one microtask
 * BEFORE its caller resumes — so a duplicate dispatch that (wrongly) went on to
 * invoke a handler would not have done it yet, and "handler called once" would
 * pass for the wrong reason. A macrotask boundary drains every pending
 * microtask, including the ones those microtasks queue, so after this the
 * duplicate has finished whatever it was going to do. Nothing on that path
 * touches a timer or real IO, so one hop is a bound, not a guess.
 *
 * @returns A promise resolved on the next macrotask.
 */
async function flushPendingDispatches(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Race a promise against a descriptive deadline.
 *
 * Only the real-filesystem smoke needs one: everything else waits on a barrier
 * the production code trips. A bare vitest timeout would say "test timed out"
 * and name nothing.
 *
 * @param promise - What to wait for.
 * @param ms - The ceiling, paid only on failure.
 * @param what - What did not happen, for the error message.
 * @returns The promise's value.
 */
async function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  // The timer id is held so the loser of the race can be cancelled — an
  // uncancelled timer keeps the event loop busy past the end of the test.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
  // The one test in this file that touches the real filesystem, a real
  // chokidar watcher and a real MaildirStore.
  //
  // Everything above drives the dispatch contracts against doubles. This proves
  // the wiring underneath them, in two halves:
  //
  //  1. The sweep's own path — a real `ready`, the real `listNew` behind it,
  //     and the real `claim`/`complete` that move a message out of the mailbox.
  //     Its file is written BEFORE the watcher exists, so it arrives by
  //     directory listing, which is why this half needs no retry loop: a
  //     listing cannot be dropped. (It used to need one. Delivery depended on
  //     catching a real `add`, and chokidar reports `ready` a beat before libuv
  //     starts delivering, so an early write was dropped outright rather than
  //     delivered late — no amount of waiting recovered it, only a fresh
  //     filename. Measured on macOS; see READY_DELIVERY_GRACE_MS in
  //     access-control.ts, and DOR-577.)
  //
  //  2. The `add` path, which half 1 no longer touches: that a real chokidar
  //     event fires for a file written into a live `new/`, and that the path it
  //     hands back has the message id as its basename — the assumption every
  //     hermetic test encodes, and one a chokidar major could change silently.
  //     Sever `watcher.on('add')` and only fake-watcher tests would notice.
  //
  // Half 2 is the only wall-clock bound left in this file, and it is bounded
  // twice over: it writes well past the ready window rather than into it, and
  // then waits on a barrier with a generous deadline.
  // -------------------------------------------------------------------------

  describe('real filesystem smoke', () => {
    /** Ceiling on each delivery — generous, and paid only on failure. */
    const SMOKE_BUDGET_MS = 20_000;
    /**
     * How long to let the platform's event stream warm up before the live write.
     *
     * Ten times the 25ms `READY_DELIVERY_GRACE_MS` that `access-control.ts`
     * measured and found holds at a load average around 130. Writing INTO that
     * window is what made the old retry loop necessary; this test steps over it
     * instead, and the first delivery has already happened by then anyway.
     */
    const READY_SETTLE_MS = 250;

    it('reaches the handler both from the listing and from a real add event, keyed by basename', async () => {
      chokidarSpy.restore();
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'watcher-mgr-smoke-'));
      // A real store, not the double: `listNew` and `claim` are the two calls
      // the sweep leans on, and a mocked listing would prove only that the
      // mock returns what it was told to.
      const store = new MaildirStore({ rootDir: tmpDir });
      await store.ensureMaildir('hash-real');
      const claimSpy = vi.spyOn(store, 'claim');
      const smokeManager = new WatcherManager(
        store,
        subscriptionRegistry,
        sqliteIndex,
        circuitBreaker
      );
      const newDir = path.join(tmpDir, 'hash-real', 'new');

      const handler = vi.fn();
      vi.mocked(subscriptionRegistry.getSubscribers).mockReturnValue([handler]);
      const delivered = armDeliveryBarrier(sqliteIndex);

      try {
        // Written before the watcher exists: the message this endpoint missed
        // while it was down, which is the wider half of what the sweep covers.
        await fs.writeFile(path.join(newDir, 'msg-real.json'), JSON.stringify({ subject: 'test' }));

        await smokeManager.startWatcher({
          subject: 'relay.agent.smoke',
          hash: 'hash-real',
          maildirPath: path.join(tmpDir, 'hash-real'),
          registeredAt: '2026-02-24T00:00:00.000Z',
        });

        await withDeadline(
          delivered.promise,
          SMOKE_BUDGET_MS,
          `a real watcher over ${newDir} delivered nothing`
        );

        expect(claimSpy).toHaveBeenCalledWith('hash-real', 'msg-real');
        expect(handler).toHaveBeenCalledWith({ subject: 'test' });
        // Exactly once against a real listing, a real claim and a real watcher:
        // `ignoreInitial` keeps chokidar off the file, and the atomic rename
        // behind `claim` settles it if anything else reaches for it anyway.
        expect(handler).toHaveBeenCalledTimes(1);
        expect(sqliteIndex.updateStatus).toHaveBeenCalledWith('msg-real', 'hash-real', 'delivered');
        // Delivered means gone from the mailbox — claimed out of new/ and
        // completed out of cur/.
        expect(await store.listNew('hash-real')).toEqual([]);
        expect(await store.listCurrent('hash-real')).toEqual([]);

        // --- Half 2: the live `add` path, which the sweep did not exercise.
        const liveDelivered = deferred();
        vi.mocked(sqliteIndex.updateStatus).mockImplementation((messageId) => {
          if (messageId === 'msg-live') liveDelivered.resolve();
          return true;
        });
        await new Promise<void>((resolve) => setTimeout(resolve, READY_SETTLE_MS));
        await fs.writeFile(path.join(newDir, 'msg-live.json'), JSON.stringify({ subject: 'live' }));

        await withDeadline(
          liveDelivered.promise,
          SMOKE_BUDGET_MS,
          `a real chokidar 'add' on ${newDir} delivered nothing`
        );

        expect(claimSpy).toHaveBeenCalledWith('hash-real', 'msg-live');
        expect(handler).toHaveBeenCalledWith({ subject: 'live' });
        expect(await store.listNew('hash-real')).toEqual([]);
      } finally {
        await smokeManager.closeAll();
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    }, 30_000);
  });
});
