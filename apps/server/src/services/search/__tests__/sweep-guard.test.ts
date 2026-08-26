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
