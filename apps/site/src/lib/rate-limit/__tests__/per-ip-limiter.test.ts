import { describe, expect, it } from 'vitest';

import { createPerIpLimiter } from '../per-ip-limiter';

const WINDOW_MS = 60_000;
const LIMIT = 3;

function request(headers: Record<string, string> = {}): Request {
  return new Request('https://dorkos.ai/api/anything', { method: 'POST', headers });
}

function spend(
  limiter: ReturnType<typeof createPerIpLimiter>,
  headers: Record<string, string>,
  times: number,
  now: number
): void {
  for (let i = 0; i < times; i += 1) limiter.consume(request(headers), now);
}

describe('createPerIpLimiter', () => {
  const now = 1_700_000_000_000;

  it('allows up to the limit for one IP, then denies with a retry window', () => {
    const limiter = createPerIpLimiter({ limit: LIMIT, windowMs: WINDOW_MS });
    const ip = { 'x-real-ip': '203.0.113.5' };

    for (let i = 0; i < LIMIT; i += 1) {
      expect(limiter.consume(request(ip), now).allowed).toBe(true);
    }

    const denied = limiter.consume(request(ip), now);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(WINDOW_MS / 1000);
  });

  it('lets an IP back in once its window has passed', () => {
    const limiter = createPerIpLimiter({ limit: LIMIT, windowMs: WINDOW_MS });
    const ip = { 'x-real-ip': '203.0.113.5' };
    spend(limiter, ip, LIMIT + 1, now);
    expect(limiter.consume(request(ip), now).allowed).toBe(false);

    expect(limiter.consume(request(ip), now + WINDOW_MS).allowed).toBe(true);
  });

  it("does not charge one IP for another IP's requests", () => {
    const limiter = createPerIpLimiter({ limit: LIMIT, windowMs: WINDOW_MS });
    spend(limiter, { 'x-real-ip': '203.0.113.5' }, LIMIT + 1, now);

    expect(limiter.consume(request({ 'x-real-ip': '203.0.113.6' }), now).allowed).toBe(true);
  });

  it('prefers x-real-ip over x-forwarded-for, so both headers name one bucket', () => {
    const limiter = createPerIpLimiter({ limit: LIMIT, windowMs: WINDOW_MS });
    // Same real IP, a different forwarded-for each time: if the limiter read the
    // wrong header these would be separate buckets and never run out.
    for (let i = 0; i < LIMIT; i += 1) {
      const headers = { 'x-real-ip': '198.51.100.9', 'x-forwarded-for': `203.0.113.${i}` };
      expect(limiter.consume(request(headers), now).allowed).toBe(true);
    }
    const headers = { 'x-real-ip': '198.51.100.9', 'x-forwarded-for': '203.0.113.250' };
    expect(limiter.consume(request(headers), now).allowed).toBe(false);
  });

  it('drops a forged hop list into the shared unknown bucket, so rotating it buys nothing', () => {
    const limiter = createPerIpLimiter({ limit: LIMIT, windowMs: WINDOW_MS });
    const forged = (hop: number): Record<string, string> => ({
      'x-forwarded-for': `9.9.9.${hop}, 203.0.113.99`,
    });

    for (let i = 0; i < LIMIT; i += 1) {
      expect(limiter.consume(request(forged(i)), now).allowed).toBe(true);
    }
    expect(limiter.consume(request(forged(99)), now).allowed).toBe(false);
    // A brand-new leading hop still lands in the same exhausted bucket.
    expect(limiter.consume(request(forged(100)), now).allowed).toBe(false);
    // An honest single-value header keeps its own allowance.
    expect(limiter.consume(request({ 'x-real-ip': '203.0.113.77' }), now).allowed).toBe(true);
  });

  it("gives every instance its own state, so one route cannot spend another route's", () => {
    const routeA = createPerIpLimiter({ limit: LIMIT, windowMs: WINDOW_MS });
    const routeB = createPerIpLimiter({ limit: LIMIT, windowMs: WINDOW_MS });
    const ip = { 'x-real-ip': '203.0.113.5' };

    spend(routeA, ip, LIMIT + 1, now);
    expect(routeA.consume(request(ip), now).allowed).toBe(false);

    expect(routeB.consume(request(ip), now).allowed).toBe(true);
  });

  it('forgets every window on reset', () => {
    const limiter = createPerIpLimiter({ limit: LIMIT, windowMs: WINDOW_MS });
    const ip = { 'x-real-ip': '203.0.113.5' };
    spend(limiter, ip, LIMIT + 1, now);
    expect(limiter.consume(request(ip), now).allowed).toBe(false);

    limiter.reset();
    expect(limiter.consume(request(ip), now).allowed).toBe(true);
  });
});
