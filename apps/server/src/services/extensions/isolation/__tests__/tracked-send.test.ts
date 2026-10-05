/**
 * The child exits only once its last messages are written (DOR-2686 review):
 * on Windows the IPC pipe is asynchronous, so exiting right after a send can
 * drop it. A raw sender whose callbacks fire later stands in for that pipe.
 */
import { describe, expect, it } from 'vitest';
import { createTrackedSend } from '../child/tracked-send.js';

/** A raw sender that holds every callback until `flush`. */
function slowPipe() {
  const pending: ((err: Error | null) => void)[] = [];
  return {
    raw: (_message: unknown, callback: (err: Error | null) => void) => {
      pending.push(callback);
      return true;
    },
    flushOne: () => pending.shift()?.(null),
    get queued() {
      return pending.length;
    },
  };
}

describe('createTrackedSend', () => {
  // Purpose: whenDrained waits for EVERY written callback, not just the send call.
  it('resolves only after every send was written', async () => {
    const pipe = slowPipe();
    const tracked = createTrackedSend(pipe.raw);
    tracked.send({ type: 'emit', event: 'a', data: 1 });
    tracked.send({ type: 'emit', event: 'b', data: 2 });
    let drained = false;
    const done = tracked.whenDrained().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    pipe.flushOne();
    await Promise.resolve();
    expect(drained).toBe(false);
    pipe.flushOne();
    await done;
    expect(drained).toBe(true);
  });

  // Purpose: with nothing in flight it resolves at once.
  it('resolves at once when idle', async () => {
    await expect(createTrackedSend(slowPipe().raw).whenDrained()).resolves.toBeUndefined();
  });

  // Purpose: a send that throws (cannot be serialized) is not counted as
  // in flight forever, and the throw still reaches the caller.
  it('settles a send that throws', async () => {
    const tracked = createTrackedSend(() => {
      throw new Error('could not be cloned');
    });
    expect(() => tracked.send({ fn: () => 1 })).toThrow('could not be cloned');
    await expect(tracked.whenDrained()).resolves.toBeUndefined();
  });
});
