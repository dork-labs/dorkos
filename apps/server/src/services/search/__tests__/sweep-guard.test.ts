import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { logger } from '../../../lib/logger.js';
import { SearchIndexer, type SweepResult } from '../indexer.js';

/**
 * The in-flight guard added for DOR-1578.
 *
 * `runSweep` used to be safe under overlap only by argument (see its TSDoc):
 * every write happened to be idempotent, so two passes racing over the same
 * frontier wasted work rather than corrupting it. These tests are not about
 * that argument — they are about the guard that makes overlap impossible by
 * construction, regardless of whether the writes underneath stay idempotent.
 *
 * `sweep()` itself is spied on rather than driven through a real source: the
 * guard lives entirely in `runSweep`, which is private, so a controllable
 * deferred standing in for one in-flight pass is the direct way to observe it
 * without reaching through the mechanism layer. `runSweep` is invoked through
 * the cast below rather than through `start()` + a timer, so the guard is
 * exercised on demand instead of at the mercy of fake-timer microtask timing.
 *
 * That cast is not the only thing standing between this guard and the real
 * timer. `search-indexer.test.ts`'s "keeps sweeping on the interval, and stops
 * when it is told to" drives `start()` over a fake clock and counts three passes
 * in 2.5 seconds, so a guard that never released would fail there as
 * `expected 1 to be 3` — verified by deleting the release (DOR-1578 review).
 */

/** A promise this test controls the settlement of. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A `SweepResult` that triggers none of `runSweep`'s logging branches. */
function emptyResult(): SweepResult {
  return { containers: 0, indexed: 0, skipped: 0, pruned: 0, rebuilt: 0, failures: [] };
}

/** Let every already-queued microtask (a resolved/rejected promise's `.then`) run. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Fire one tick — what the interval timer does on each call. `runSweep` is private. */
function tick(indexer: SearchIndexer): void {
  (indexer as unknown as { runSweep: () => void }).runSweep();
}

/**
 * The exact line a skip streak logs.
 *
 * Named rather than counted alone, so a debug log from anywhere else in the pass
 * cannot satisfy an assertion about this one.
 */
const SKIP_LOG = '[Search] sweep tick skipped: the previous pass is still running';

let db: Db;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SearchIndexer sweep in-flight guard', () => {
  it('skips a tick that fires while the previous pass is still running', async () => {
    const indexer = new SearchIndexer(db, [], 1_000);
    const first = deferred<SweepResult>();
    const sweepSpy = vi.spyOn(indexer, 'sweep').mockReturnValue(first.promise);
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);

    tick(indexer); // the pass starts and stays pending
    expect(sweepSpy).toHaveBeenCalledTimes(1);

    tick(indexer); // fires while the first pass is still in flight
    expect(sweepSpy).toHaveBeenCalledTimes(1); // the underlying sweep ran exactly once
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledWith(SKIP_LOG);

    tick(indexer); // a stuck pass fires many ticks — only the first skip logs
    expect(sweepSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledTimes(1);

    first.resolve(emptyResult());
    await flushMicrotasks();
  });

  it('runs the next tick normally once the previous pass has completed', async () => {
    const indexer = new SearchIndexer(db, [], 1_000);
    const first = deferred<SweepResult>();
    const sweepSpy = vi
      .spyOn(indexer, 'sweep')
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(emptyResult());

    tick(indexer);
    expect(sweepSpy).toHaveBeenCalledTimes(1);

    first.resolve(emptyResult());
    await flushMicrotasks(); // let the guard's `finally` clear the flag

    tick(indexer); // the guard was released, so this tick runs the sweep again
    expect(sweepSpy).toHaveBeenCalledTimes(2);
  });

  it('logs the next skip streak too, so a second overlap is not silent', async () => {
    // The streak flag exists to collapse one stuck pass's many skips into one
    // line — not to silence every overlap after the first for the life of the
    // process. Without the reset in `runSweep`, this is exactly what happens,
    // and nothing else in the repo notices: the whole search suite stayed green
    // with the reset deleted, which is why this test exists (DOR-1578 review).
    const indexer = new SearchIndexer(db, [], 1_000);
    const first = deferred<SweepResult>();
    const second = deferred<SweepResult>();
    vi.spyOn(indexer, 'sweep')
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);

    tick(indexer); // pass one starts
    tick(indexer); // skipped — the first streak logs
    expect(debugSpy).toHaveBeenCalledTimes(1);

    first.resolve(emptyResult());
    await flushMicrotasks();

    tick(indexer); // pass two starts, and the streak flag resets with it
    tick(indexer); // skipped — this is a NEW streak, so it must log again
    expect(debugSpy).toHaveBeenCalledTimes(2);
    expect(debugSpy).toHaveBeenNthCalledWith(2, SKIP_LOG);

    second.resolve(emptyResult());
    await flushMicrotasks();
  });

  it('releases the guard when a sweep pass throws, so the next tick still runs', async () => {
    const indexer = new SearchIndexer(db, [], 1_000);
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const sweepSpy = vi
      .spyOn(indexer, 'sweep')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(emptyResult());

    tick(indexer);
    expect(sweepSpy).toHaveBeenCalledTimes(1);

    await flushMicrotasks(); // let the rejection propagate through the guard's `finally`
    expect(errorSpy).toHaveBeenCalledTimes(1);

    tick(indexer); // the throw did not wedge the guard shut
    expect(sweepSpy).toHaveBeenCalledTimes(2);
  });
});
