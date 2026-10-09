import { describe, expect, it } from 'vitest';
import { CapacityHold } from '../adapters/claude-code/capacity-hold.js';

describe('original pool nonwaiting document prerequisite', () => {
  it('refuses malformed configured ceilings without a lease or waiting debt', () => {
    for (const maxConcurrent of [
      NaN,
      Infinity,
      -Infinity,
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const pool = new CapacityHold({ maxConcurrent, holdCeilingMs: 60_000 });
      expect(pool.tryAcquire()).toBeNull();
      expect(pool.running).toBe(0);
      expect(pool.waiting).toBe(0);
      pool.drain();
    }
  });

  it('shares the configured pool with ordinary acquisition and creates no wait debt', async () => {
    const pool = new CapacityHold({ maxConcurrent: 1, holdCeilingMs: 60_000 });
    const ordinary = await pool.acquire({ mayWait: false });
    if (typeof ordinary === 'string') throw new Error('original slot missing');
    try {
      expect(pool.tryAcquire()).toBeNull();
      expect(pool.running).toBe(1);
      expect(pool.waiting).toBe(0);
    } finally {
      pool.release(ordinary);
      pool.drain();
    }
    const selected = pool.tryAcquire();
    expect(selected).not.toBeNull();
    if (selected) pool.release(selected);
    expect(pool.running).toBe(0);
  });

  it('hands the original freed slot to the older ordinary waiter before fresh nonwaiting work', async () => {
    const pool = new CapacityHold({ maxConcurrent: 1, holdCeilingMs: 60_000 });
    const first = pool.tryAcquire();
    if (!first) throw new Error('original slot missing');
    const waiting = pool.acquire({ mayWait: true });
    try {
      expect(pool.waiting).toBe(1);
      expect(pool.tryAcquire()).toBeNull();
      pool.release(first);
      // The lease is assigned synchronously before the original waiting promise resumes.
      expect(pool.tryAcquire()).toBeNull();
      const older = await waiting;
      if (typeof older === 'string') throw new Error('older original slot missing');
      pool.release(older);
      expect(pool.running).toBe(0);
    } finally {
      pool.release(first);
      pool.drain();
      const outstanding = await waiting;
      if (typeof outstanding !== 'string') pool.release(outstanding);
    }
  });

  it('cannot settle the original selected lease with a copy, foreign pool or duplicate release', () => {
    const pool = new CapacityHold({ maxConcurrent: 2, holdCeilingMs: 60_000 });
    const foreign = new CapacityHold({ maxConcurrent: 1, holdCeilingMs: 60_000 });
    const first = pool.tryAcquire();
    const second = pool.tryAcquire();
    const other = foreign.tryAcquire();
    if (!first || !second || !other) throw new Error('original configured slots missing');
    try {
      pool.release({ ...first });
      pool.release(other);
      expect(pool.running).toBe(2);
      pool.release(first);
      pool.release(first);
      expect(pool.running).toBe(1);
      expect(foreign.running).toBe(1);
    } finally {
      pool.release(first);
      pool.release(second);
      foreign.release(other);
      pool.drain();
      foreign.drain();
    }
  });
});
