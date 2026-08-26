import { describe, expect, it } from 'vitest';

import { createFixedWindowLimiter } from '../fixed-window';

const WINDOW_MS = 10 * 60 * 1000;
const START = 1_700_000_000_000;

function limiter(overrides: { limit?: number; windowMs?: number; maxKeys?: number } = {}) {
  return createFixedWindowLimiter({
    limit: overrides.limit ?? 3,
    windowMs: overrides.windowMs ?? WINDOW_MS,
    maxKeys: overrides.maxKeys,
  });
}

describe('createFixedWindowLimiter', () => {
  it('allows exactly `limit` requests inside one window', () => {
    const rl = limiter({ limit: 3 });
    const verdicts = [0, 1, 2].map((i) => rl.consume('1.2.3.4', START + i));
    expect(verdicts.map((v) => v.allowed)).toEqual([true, true, true]);
    expect(verdicts.every((v) => v.retryAfterSeconds === 0)).toBe(true);
  });

  it('denies the request past the limit and reports the seconds left', () => {
    const rl = limiter({ limit: 3 });
    for (let i = 0; i < 3; i += 1) rl.consume('1.2.3.4', START);

    const fourth = rl.consume('1.2.3.4', START + 60_000);
    expect(fourth.allowed).toBe(false);
    // Window opened at START, so 10min - 1min = 9min remain.
    expect(fourth.retryAfterSeconds).toBe(540);
  });

  it('keeps denying while the window is open', () => {
    const rl = limiter({ limit: 1 });
    expect(rl.consume('1.2.3.4', START).allowed).toBe(true);
    expect(rl.consume('1.2.3.4', START + 1).allowed).toBe(false);
    expect(rl.consume('1.2.3.4', START + WINDOW_MS - 1).allowed).toBe(false);
  });

  it('rounds the wait up, never down to a zero-second retry', () => {
    const rl = limiter({ limit: 1 });
    rl.consume('1.2.3.4', START);
    expect(rl.consume('1.2.3.4', START + WINDOW_MS - 10).retryAfterSeconds).toBe(1);
  });

  it('opens a fresh window once the old one expires', () => {
    const rl = limiter({ limit: 2 });
    rl.consume('1.2.3.4', START);
    rl.consume('1.2.3.4', START);
    expect(rl.consume('1.2.3.4', START).allowed).toBe(false);

    expect(rl.consume('1.2.3.4', START + WINDOW_MS).allowed).toBe(true);
    expect(rl.consume('1.2.3.4', START + WINDOW_MS).allowed).toBe(true);
    expect(rl.consume('1.2.3.4', START + WINDOW_MS).allowed).toBe(false);
  });

  it('meters each key independently', () => {
    const rl = limiter({ limit: 1 });
    expect(rl.consume('1.1.1.1', START).allowed).toBe(true);
    expect(rl.consume('1.1.1.1', START).allowed).toBe(false);
    expect(rl.consume('2.2.2.2', START).allowed).toBe(true);
  });

  it('prunes expired keys instead of growing without bound', () => {
    const rl = limiter({ limit: 1, maxKeys: 3 });
    rl.consume('a', START);
    rl.consume('b', START);
    rl.consume('c', START);
    expect(rl.size()).toBe(3);

    // Every tracked window has expired by now, so admitting a new key drops them.
    rl.consume('d', START + WINDOW_MS);
    expect(rl.size()).toBe(1);
    // And the pruning did not cost the newcomer its own allowance.
    expect(rl.consume('d', START + WINDOW_MS).allowed).toBe(false);
  });

  it('evicts the oldest live window when every tracked key is still inside one', () => {
    const rl = limiter({ limit: 1, maxKeys: 3 });
    rl.consume('oldest', START);
    rl.consume('middle', START + 1000);
    rl.consume('newest', START + 2000);

    rl.consume('newcomer', START + 3000);
    expect(rl.size()).toBe(3);
    // `oldest` was forgotten, so it starts over; `newest` is still metered.
    expect(rl.consume('oldest', START + 3000).allowed).toBe(true);
    expect(rl.consume('newest', START + 3000).allowed).toBe(false);
  });

  it('forgets every window on reset', () => {
    const rl = limiter({ limit: 1 });
    rl.consume('1.2.3.4', START);
    expect(rl.consume('1.2.3.4', START).allowed).toBe(false);

    rl.reset();
    expect(rl.size()).toBe(0);
    expect(rl.consume('1.2.3.4', START).allowed).toBe(true);
  });

  it('defaults the clock to now when no timestamp is passed', () => {
    const rl = limiter({ limit: 1, windowMs: 50_000 });
    expect(rl.consume('1.2.3.4').allowed).toBe(true);
    const denied = rl.consume('1.2.3.4');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(50);
  });
});
