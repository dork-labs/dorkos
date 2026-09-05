/**
 * A hermetic stand-in for chokidar, for tests that must not race the platform.
 *
 * ## Why this module exists
 *
 * `WatcherManager` and `AccessControl` both start real chokidar watchers, and
 * their tests used to prove their behaviour by writing a real file and polling a
 * hand-rolled 5s deadline until the event showed up. That reads as a test of
 * this repo's code and is mostly a test of the platform's fs-event latency: on a
 * machine already running several agents the events arrive late, or — worse —
 * not at all. chokidar reports `ready` a beat before libuv actually starts
 * delivering, so a write issued inside that window is dropped OUTRIGHT rather
 * than delivered late (measured on macOS; see `READY_DELIVERY_GRACE_MS` in
 * `access-control.ts`, and DOR-577 for the same family of failure in the session
 * list). No deadline survives that, because there is no event to wait for.
 *
 * So the dispatch contracts are pinned against an injected watcher the test
 * drives itself, and the real-filesystem wiring is proven once per suite by a
 * single smoke test that says so out loud.
 *
 * The injection point is `chokidar.watch` itself rather than a constructor
 * parameter: both modules already call it through a default import, and the
 * repo already fakes chokidar this way in
 * `apps/server/.../__tests__/session-list-watcher.test.ts`. Faking the module
 * keeps the production classes free of a seam that exists only for tests.
 *
 * Callers must restore the spy — `vi.restoreAllMocks()` in `afterEach`, or
 * {@link ChokidarInterceptor.restore} mid-test when the real watcher is wanted
 * back.
 *
 * @module __tests__/fake-watcher
 */
import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import chokidar, { type FSWatcher } from 'chokidar';

/**
 * A watcher that emits exactly what the test tells it to, and nothing else.
 *
 * It is an `EventEmitter`, so `watcher.emit('add', p)` / `'change'` / `'unlink'`
 * / `'ready'` / `'error'` reach the production handlers synchronously — which is
 * the whole point: the test controls when, and there is nothing to wait for.
 */
export class FakeWatcher extends EventEmitter {
  /** Whether {@link close} has been called. */
  closed = false;

  /** How many times {@link close} has been called. */
  closeCount = 0;

  /**
   * Record what the intercepted `chokidar.watch()` call asked for.
   *
   * @param watchedPath - The path the production code passed to `watch()`.
   * @param options - The options object it passed alongside, if any.
   */
  constructor(
    readonly watchedPath: string,
    readonly options: Record<string, unknown> | undefined
  ) {
    super();
  }

  /**
   * Stand in for `FSWatcher.close()`.
   *
   * @returns A promise that is already resolved — nothing is held open.
   */
  close(): Promise<void> {
    this.closed = true;
    this.closeCount += 1;
    return Promise.resolve();
  }
}

/** Handle on an installed `chokidar.watch` spy and the watchers it handed out. */
export interface ChokidarInterceptor {
  /** Every fake handed out since installation, in creation order. */
  readonly created: readonly FakeWatcher[];
  /**
   * The most recently created fake.
   *
   * @returns The last watcher `chokidar.watch()` was made to return.
   * @throws When nothing has called `chokidar.watch()` yet — a silent
   *   `undefined` here would surface much later as an unrelated assertion.
   */
  latest(): FakeWatcher;
  /**
   * Put the real `chokidar.watch` back, mid-test.
   *
   * For the one smoke test per suite that deliberately wants real filesystem
   * events after the rest of the file has opted out of them.
   */
  restore(): void;
}

/**
 * Make `chokidar.watch()` hand out {@link FakeWatcher}s until the spy is
 * restored.
 *
 * @returns The interceptor described by {@link ChokidarInterceptor}.
 */
export function interceptChokidar(): ChokidarInterceptor {
  const created: FakeWatcher[] = [];
  const spy = vi
    .spyOn(chokidar, 'watch')
    .mockImplementation((paths: unknown, options?: unknown): FSWatcher => {
      const watcher = new FakeWatcher(
        String(paths),
        options as Record<string, unknown> | undefined
      );
      created.push(watcher);
      return watcher as unknown as FSWatcher;
    });

  return {
    created,
    latest(): FakeWatcher {
      const last = created.at(-1);
      if (!last) throw new Error('interceptChokidar: chokidar.watch() has not been called yet');
      return last;
    },
    restore(): void {
      spy.mockRestore();
    },
  };
}

/** A promise plus the handle that settles it, for event-driven test barriers. */
export interface Deferred<T> {
  /** The promise a test awaits. */
  readonly promise: Promise<T>;
  /** Settles {@link promise}. Safe to call more than once; later calls are no-ops. */
  resolve(value: T): void;
  /** Whether {@link resolve} has been called. */
  readonly settled: boolean;
}

/**
 * Create a {@link Deferred}.
 *
 * Tests use it as a barrier a production code path trips — typically the last
 * mock in a dispatch chain — so a wait ends the instant the work is done rather
 * than after a polling interval.
 *
 * @returns A fresh deferred.
 */
export function deferred<T = void>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolveFn = res;
  });
  const handle = {
    promise,
    settled: false,
    resolve(value: T): void {
      handle.settled = true;
      resolveFn(value);
    },
  };
  return handle;
}
