/**
 * The per-room serialized queue every write to a room's repo goes through
 * (spec `project-rooms` §3.6).
 *
 * Seeded defects, each run red before the code stood:
 *
 * - Setting `held = true` after the first `await` instead of before it reddens
 *   "runs one caller at a time": two callers made in one tick both take the lane.
 * - Dropping the `MAX_QUEUE_DEPTH` check reddens "refuses a caller when the
 *   queue is full" — the ninth caller queues and waits out the whole cap.
 * - Not splicing a timed-out waiter out of the queue reddens "a spent wait
 *   leaves the lane usable": the lane is handed to a caller that has already
 *   been refused and is never released, so every later caller times out too.
 * - Releasing outside a `finally` reddens "a failed task still releases the
 *   lane".
 */
import { describe, it, expect } from 'vitest';
import { RoomRepoMutex, MAX_QUEUE_DEPTH } from '../room-repo-mutex.js';

const ROOM = 'room-a';
const OTHER = 'room-b';

/** A refusal a test can recognize, standing in for a caller's own typed one. */
function busy(): Error {
  return new Error('BUSY');
}

/** A promise plus the handles to settle it from a test. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Let every already-queued microtask and macrotask run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('RoomRepoMutex', () => {
  it('runs one caller at a time, in the order they arrived', async () => {
    const mutex = new RoomRepoMutex();
    const gate = deferred();
    const order: string[] = [];

    // All three are started in ONE tick, which is the case a lane taken after
    // an `await` would get wrong.
    const first = mutex.run(ROOM, { waitMs: 1000, busy }, async () => {
      order.push('first-in');
      await gate.promise;
      order.push('first-out');
    });
    const second = mutex.run(ROOM, { waitMs: 1000, busy }, async () => {
      order.push('second');
    });
    const third = mutex.run(ROOM, { waitMs: 1000, busy }, async () => {
      order.push('third');
    });

    await settle();
    // The first is inside its task; nobody else has started.
    expect(order).toEqual(['first-in']);

    gate.resolve();
    await Promise.all([first, second, third]);
    expect(order).toEqual(['first-in', 'first-out', 'second', 'third']);
  });

  it('lets two rooms merge at the same time', async () => {
    const mutex = new RoomRepoMutex();
    const gate = deferred();
    const ran: string[] = [];

    const held = mutex.run(ROOM, { waitMs: 1000, busy }, async () => {
      ran.push('a');
      await gate.promise;
    });
    await mutex.run(OTHER, { waitMs: 1000, busy }, async () => {
      ran.push('b');
    });

    // B finished while A is still holding its own lane — the key is the room,
    // so one busy room never stops another.
    expect(ran).toEqual(['a', 'b']);
    gate.resolve();
    await held;
  });

  it('refuses a caller once the wait is spent', async () => {
    const mutex = new RoomRepoMutex();
    const gate = deferred();
    const held = mutex.run(ROOM, { waitMs: 1000, busy }, () => gate.promise);

    await expect(mutex.run(ROOM, { waitMs: 5, busy }, async () => 'never')).rejects.toThrow('BUSY');

    gate.resolve();
    await held;
  });

  it('leaves the lane usable after a spent wait', async () => {
    // The regression this pins: a timed-out waiter left in the queue is handed
    // the lane by the holder's release, and nothing ever releases it again — so
    // one impatient caller wedges the room permanently.
    const mutex = new RoomRepoMutex();
    const gate = deferred();
    const held = mutex.run(ROOM, { waitMs: 1000, busy }, () => gate.promise);

    await expect(mutex.run(ROOM, { waitMs: 5, busy }, async () => 'never')).rejects.toThrow('BUSY');
    gate.resolve();
    await held;

    await expect(mutex.run(ROOM, { waitMs: 50, busy }, async () => 'after')).resolves.toBe('after');
  });

  it('refuses a caller when the queue is already full', async () => {
    const mutex = new RoomRepoMutex();
    const gate = deferred();
    const held = mutex.run(ROOM, { waitMs: 60_000, busy }, () => gate.promise);
    // Fill it. Each of these has a long wait, so nothing times out — the
    // refusal below can only be the depth cap.
    const queued = Array.from({ length: MAX_QUEUE_DEPTH }, () =>
      mutex.run(ROOM, { waitMs: 60_000, busy }, async () => 'queued')
    );

    await expect(mutex.run(ROOM, { waitMs: 60_000, busy }, async () => 'over')).rejects.toThrow(
      'BUSY'
    );

    gate.resolve();
    await held;
    expect(await Promise.all(queued)).toHaveLength(MAX_QUEUE_DEPTH);
  });

  it('releases the lane when the task itself fails', async () => {
    const mutex = new RoomRepoMutex();
    await expect(
      mutex.run(ROOM, { waitMs: 50, busy }, () => Promise.reject(new Error('merge blew up')))
    ).rejects.toThrow('merge blew up');

    // The next caller is not refused: a failed merge must not wedge the room.
    await expect(mutex.run(ROOM, { waitMs: 50, busy }, async () => 'ok')).resolves.toBe('ok');
  });
});
