/**
 * Tests for {@link mapWithConcurrency}: an ordered promise pool shared by the
 * session fan-out and the marketplace update check.
 */
import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from '../map-with-concurrency.js';

/** A promise and the function that settles it, for driving the pool by hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('mapWithConcurrency', () => {
  it('returns results in input order even when later items finish first', async () => {
    // Purpose: callers index results by input position; a pool that returned
    // in completion order would attach one item's answer to another.
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const run = mapWithConcurrency([0, 1, 2], 3, async (i) => {
      await gates[i]!.promise;
      return `item-${i}`;
    });
    gates[2]!.resolve();
    gates[1]!.resolve();
    gates[0]!.resolve();

    expect(await run).toEqual(['item-0', 'item-1', 'item-2']);
  });

  it('never has more than `concurrency` calls in flight', async () => {
    // Purpose: the bound is the whole point — a pool that started everything
    // at once would open one git process per installed package.
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);

    await mapWithConcurrency(items, 3, async (i) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return i;
    });

    expect(peak).toBe(3);
  });

  it('resolves an empty input to an empty list without calling fn', async () => {
    // Purpose: a machine with nothing installed must not throw or spin.
    let calls = 0;
    const result = await mapWithConcurrency([], 4, async () => {
      calls += 1;
    });

    expect(result).toEqual([]);
    expect(calls).toBe(0);
  });
});
