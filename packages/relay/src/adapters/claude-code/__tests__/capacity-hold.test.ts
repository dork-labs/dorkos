/**
 * The waiting line in front of a busy runtime.
 *
 * Every test here is one of the four ways a hold could betray the promise it
 * makes: the message is dropped anyway, the person is told twice, the wait
 * resumes the wrong delivery, or the hold outlives its window with nobody told.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CapacityHold, HOLD_ANNOUNCE_AFTER_MS, WAITING_PER_SLOT } from '../capacity-hold.js';

/** One slot, and a ceiling far longer than anything a test waits out by hand. */
function oneSlot(overrides: { holdCeilingMs?: number; announceAfterMs?: number } = {}) {
  return new CapacityHold({
    maxConcurrent: 1,
    holdCeilingMs: overrides.holdCeilingMs ?? 300_000,
    ...(overrides.announceAfterMs !== undefined
      ? { announceAfterMs: overrides.announceAfterMs }
      : {}),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('taking a slot', () => {
  it('hands out exactly as many slots as there are, and no more', async () => {
    const hold = new CapacityHold({ maxConcurrent: 2, holdCeilingMs: 300_000 });

    await expect(hold.acquire({ mayWait: false })).resolves.toBe('acquired');
    await expect(hold.acquire({ mayWait: false })).resolves.toBe('acquired');
    expect(hold.running).toBe(2);

    await expect(hold.acquire({ mayWait: false })).resolves.toBe('line_full');
    expect(hold.running).toBe(2);
  });

  it('refuses immediately for a delivery that may not wait', async () => {
    const hold = oneSlot();
    await hold.acquire({ mayWait: false });

    // No timer is advanced: an awaited caller must get its answer now, not in
    // five minutes. `mayWait: false` is what keeps a Tasks delivery — which the
    // publish pipeline awaits under its own ceiling — out of the line.
    await expect(hold.acquire({ mayWait: false })).resolves.toBe('line_full');
    expect(hold.waiting).toBe(0);
  });
});

describe('a message for a busy runtime is held, not dropped', () => {
  it('starts the held delivery when the slot is released', async () => {
    const hold = oneSlot();
    await hold.acquire({ mayWait: true });

    const held = hold.acquire({ mayWait: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(hold.waiting).toBe(1);

    hold.release();

    // Seeded defect: make `release()` decrement `active` and return without
    // draining the line. This resolves to nothing — the message is dropped
    // exactly as the old semaphore dropped it — and the assertion times out.
    await expect(held).resolves.toBe('acquired');
    expect(hold.running).toBe(1);
    expect(hold.waiting).toBe(0);
  });

  it('releases a slot even when the turn that held it threw', async () => {
    const hold = oneSlot();
    await hold.acquire({ mayWait: true });
    const held = hold.acquire({ mayWait: true });
    await vi.advanceTimersByTimeAsync(0);

    // The `finally` in the adapter, in the shape the adapter calls it.
    try {
      throw new Error('the turn exploded');
    } catch {
      hold.release();
    }

    await expect(held).resolves.toBe('acquired');
  });

  it('runs waiting deliveries oldest first', async () => {
    const hold = oneSlot();
    await hold.acquire({ mayWait: true });

    const order: string[] = [];
    const first = hold.acquire({ mayWait: true }).then((o) => order.push(`first:${o}`));
    await vi.advanceTimersByTimeAsync(0);
    const second = hold.acquire({ mayWait: true }).then((o) => order.push(`second:${o}`));
    await vi.advanceTimersByTimeAsync(0);

    hold.release();
    await vi.advanceTimersByTimeAsync(0);
    // Seeded defect: `this.line.pop()` instead of `this.line[0]`. The newest
    // message jumps the queue and the oldest can starve; `order` reads
    // `['second:acquired']` here.
    expect(order).toEqual(['first:acquired']);

    hold.release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:acquired', 'second:acquired']);
  });

  it('resumes each held delivery on its own promise, never another one', async () => {
    const hold = oneSlot();
    await hold.acquire({ mayWait: true });

    // Two chats, two different agents, both waiting on the same ceiling. The
    // line carries no identity of its own — each wait resolves ITS caller — so
    // the only way a hold could reach the wrong agent is a shared resolver.
    const settled: string[] = [];
    const alice = hold.acquire({ mayWait: true }).then((o) => settled.push(`alice:${o}`));
    await vi.advanceTimersByTimeAsync(0);
    const bob = hold.acquire({ mayWait: true }).then((o) => settled.push(`bob:${o}`));
    await vi.advanceTimersByTimeAsync(0);

    hold.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toEqual(['alice:acquired']);
    // Bob is still waiting: one release is one start, so nobody rode in on
    // somebody else's slot.
    expect(hold.waiting).toBe(1);

    hold.release();
    await Promise.all([alice, bob]);
    expect(settled).toEqual(['alice:acquired', 'bob:acquired']);
    expect(hold.running).toBe(1);
  });

  it('stops the line growing without limit when nothing ever frees', async () => {
    const hold = new CapacityHold({ maxConcurrent: 2, holdCeilingMs: 300_000 });
    await hold.acquire({ mayWait: true });
    await hold.acquire({ mayWait: true });

    const capacityOfLine = 2 * WAITING_PER_SLOT;
    for (let i = 0; i < capacityOfLine; i++) {
      void hold.acquire({ mayWait: true });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(hold.waiting).toBe(capacityOfLine);

    await expect(hold.acquire({ mayWait: true })).resolves.toBe('line_full');
    expect(hold.waiting).toBe(capacityOfLine);
  });
});

describe('telling the person their message is waiting', () => {
  it('says nothing at all about a hold that clears quickly', async () => {
    const hold = oneSlot();
    await hold.acquire({ mayWait: true });
    const onHeld = vi.fn();
    const held = hold.acquire({ mayWait: true, onHeld });

    await vi.advanceTimersByTimeAsync(HOLD_ANNOUNCE_AFTER_MS - 1);
    hold.release();
    await expect(held).resolves.toBe('acquired');

    // Seeded defect: call `onHeld()` at park time instead of on a timer. Every
    // sub-second hold then posts a line into a chat that is about to get its
    // answer anyway, and burns the notice damper for ten minutes.
    await vi.advanceTimersByTimeAsync(HOLD_ANNOUNCE_AFTER_MS);
    expect(onHeld).not.toHaveBeenCalled();
  });

  it('speaks once, and only once, for a hold that lasts', async () => {
    const hold = oneSlot();
    await hold.acquire({ mayWait: true });
    const onHeld = vi.fn();
    void hold.acquire({ mayWait: true, onHeld });

    await vi.advanceTimersByTimeAsync(HOLD_ANNOUNCE_AFTER_MS);
    expect(onHeld).toHaveBeenCalledTimes(1);

    // Seeded defect: `setInterval` instead of `setTimeout` for the announce.
    // The chat is told every ten seconds that its message is waiting.
    await vi.advanceTimersByTimeAsync(HOLD_ANNOUNCE_AFTER_MS * 5);
    expect(onHeld).toHaveBeenCalledTimes(1);
  });

  it('does not speak after the wait has already ended', async () => {
    const hold = oneSlot();
    await hold.acquire({ mayWait: true });
    const onHeld = vi.fn();
    const held = hold.acquire({ mayWait: true, onHeld });

    hold.release();
    await expect(held).resolves.toBe('acquired');

    // Seeded defect: drop the `clearTimeout(announce)` in `settle`. The turn is
    // running — has possibly already answered — and the chat is told it is
    // still waiting.
    await vi.advanceTimersByTimeAsync(HOLD_ANNOUNCE_AFTER_MS * 2);
    expect(onHeld).not.toHaveBeenCalled();
  });
});

describe('a hold that outlives its window', () => {
  it('gives up at the ceiling instead of waiting forever', async () => {
    const hold = oneSlot({ holdCeilingMs: 60_000 });
    await hold.acquire({ mayWait: true });
    const held = hold.acquire({ mayWait: true });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(hold.waiting).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    // Seeded defect: drop the ceiling timer. This never resolves, the chat is
    // never told anything, and the envelope is never dead-lettered — the
    // silent-forever failure this bound exists to prevent.
    await expect(held).resolves.toBe('held_too_long');
    expect(hold.waiting).toBe(0);
  });

  it('takes the shorter of the line ceiling and the one the caller passed', async () => {
    const hold = oneSlot({ holdCeilingMs: 60_000 });
    await hold.acquire({ mayWait: true });
    // A message with five seconds of life left may not wait a minute for a
    // slot: the turn takes its deadline from that same remaining time.
    const held = hold.acquire({ mayWait: true, ceilingMs: 5_000 });

    await vi.advanceTimersByTimeAsync(5_000);
    // Seeded defect: use `request.ceilingMs ?? this.holdCeilingMs` without the
    // `Math.min`. A caller passing a LONGER ceiling would then escape the
    // line's own bound, and this one would still be waiting here.
    await expect(held).resolves.toBe('held_too_long');
  });

  it('never lets a caller ceiling extend the line bound', async () => {
    const hold = oneSlot({ holdCeilingMs: 60_000 });
    await hold.acquire({ mayWait: true });
    const held = hold.acquire({ mayWait: true, ceilingMs: 10 * 60_000 });

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(held).resolves.toBe('held_too_long');
  });

  it('leaves the slot count untouched when a wait expires', async () => {
    const hold = oneSlot({ holdCeilingMs: 60_000 });
    await hold.acquire({ mayWait: true });
    const held = hold.acquire({ mayWait: true });

    await vi.advanceTimersByTimeAsync(60_000);
    await held;

    // An expiry takes no slot. If it did, the running turn's own `release()`
    // would drop the count below the truth and the ceiling would shrink by one
    // for the life of the process.
    expect(hold.running).toBe(1);
    hold.release();
    expect(hold.running).toBe(0);
  });

  it('ends every wait when the adapter stops', async () => {
    const hold = oneSlot();
    await hold.acquire({ mayWait: true });
    const first = hold.acquire({ mayWait: true });
    const second = hold.acquire({ mayWait: true });
    await vi.advanceTimersByTimeAsync(0);

    hold.drain();

    // A stop is the one thing that ends a hold without the message ever
    // running. It settles rather than hanging, so the delivery pipeline
    // dead-letters it and the chat gets a line — the alternative is a promise
    // dropped in silence.
    await expect(first).resolves.toBe('stopped');
    await expect(second).resolves.toBe('stopped');
    expect(hold.waiting).toBe(0);
  });
});
