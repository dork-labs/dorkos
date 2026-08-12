/**
 * DOR-1165: the per-session enqueue request sequencer.
 *
 * Two properties matter and each test below is red under a plausible wrong
 * implementation:
 *  - ordering: requests settle in call order even when the earliest is slowest
 *    (fails if calls are not chained);
 *  - no wedge: a REJECTED request does not skip or stall its successors (fails
 *    if the chain is a single-arm `prior.then(run)` that propagates rejection).
 */
import { describe, it, expect, vi } from 'vitest';
import { sequenceEnqueue } from '../enqueue-sequencer';

/** Resolve after `ms`, recording `label` at the moment it settles. */
function settleAfter(order: string[], label: string, ms: number): () => Promise<string> {
  return () =>
    new Promise<string>((resolve) =>
      setTimeout(() => {
        order.push(label);
        resolve(label);
      }, ms)
    );
}

describe('sequenceEnqueue (DOR-1165)', () => {
  it('settles requests in call order even when the first is the slowest', async () => {
    const order: string[] = [];
    const sid = 'session-a';
    // Earliest call is slowest: fired concurrently these would settle reversed.
    const runs = [
      sequenceEnqueue(sid, settleAfter(order, 'first', 30)),
      sequenceEnqueue(sid, settleAfter(order, 'second', 20)),
      sequenceEnqueue(sid, settleAfter(order, 'third', 5)),
    ];

    await Promise.all(runs);

    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('does not run a request until the previous one has settled', async () => {
    const events: string[] = [];
    const sid = 'session-b';
    const slow = () =>
      new Promise<void>((resolve) => {
        events.push('start-1');
        setTimeout(() => {
          events.push('end-1');
          resolve();
        }, 20);
      });
    const fast = () => {
      events.push('start-2');
      return Promise.resolve();
    };

    await Promise.all([sequenceEnqueue(sid, slow), sequenceEnqueue(sid, fast)]);

    // The second request must not START before the first has ENDED.
    expect(events).toEqual(['start-1', 'end-1', 'start-2']);
  });

  it('a rejected request neither skips nor wedges its successors', async () => {
    const ran: string[] = [];
    const sid = 'session-c';
    const failing = () => {
      ran.push('failing');
      return Promise.reject(new Error('network down'));
    };
    const after = () => {
      ran.push('after');
      return Promise.resolve('ok');
    };

    const failingResult = sequenceEnqueue(sid, failing);
    const afterResult = sequenceEnqueue(sid, after);

    // The failure surfaces to ITS OWN caller...
    await expect(failingResult).rejects.toThrow('network down');
    // ...and the successor still runs, in order, and resolves normally.
    await expect(afterResult).resolves.toBe('ok');
    expect(ran).toEqual(['failing', 'after']);
  });

  it('keeps separate sessions on independent chains', async () => {
    const order: string[] = [];
    const a = sequenceEnqueue('session-x', settleAfter(order, 'x-slow', 25));
    const b = sequenceEnqueue('session-y', settleAfter(order, 'y-fast', 5));

    await Promise.all([a, b]);

    // Different sessions do not serialize against each other, so the fast one on
    // session-y settles before the slow one on session-x.
    expect(order).toEqual(['y-fast', 'x-slow']);
  });

  it('starts a fresh chain after the previous one has fully drained', async () => {
    const order: string[] = [];
    const sid = 'session-z';

    await sequenceEnqueue(sid, settleAfter(order, 'a', 5));
    // The chain has drained; a later call still sequences correctly rather than
    // chaining off a stale, already-settled tail.
    await Promise.all([
      sequenceEnqueue(sid, settleAfter(order, 'b', 20)),
      sequenceEnqueue(sid, settleAfter(order, 'c', 5)),
    ]);

    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('does not emit an unhandled rejection when a request fails', async () => {
    const sid = 'session-unhandled';
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(sequenceEnqueue(sid, () => Promise.reject(new Error('boom')))).rejects.toThrow(
        'boom'
      );
      // Give any stray rejection a tick to surface.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
