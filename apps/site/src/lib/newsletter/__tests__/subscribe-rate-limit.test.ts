import { beforeEach, describe, expect, it } from 'vitest';

import {
  SUBSCRIBE_RATE_LIMIT,
  SUBSCRIBE_RATE_WINDOW_MS,
  consumeSubscribeQuota,
  resetSubscribeRateLimit,
} from '../subscribe-rate-limit';

function subscribeRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://dorkos.ai/api/newsletter/subscribe', { method: 'POST', headers });
}

beforeEach(() => resetSubscribeRateLimit());

describe('subscribe rate-limit policy', () => {
  // A deliberate pin on the chosen policy: five per ten minutes. Loosening it is
  // a product decision, so it should fail here and be re-argued, not drift.
  it('is five attempts per ten minutes', () => {
    expect(SUBSCRIBE_RATE_LIMIT).toBe(5);
    expect(SUBSCRIBE_RATE_WINDOW_MS).toBe(600_000);
  });
});

describe('consumeSubscribeQuota', () => {
  const now = 1_700_000_000_000;
  const ip = { 'x-forwarded-for': '203.0.113.5' };

  it('allows the first `SUBSCRIBE_RATE_LIMIT` attempts from one IP', () => {
    for (let i = 0; i < SUBSCRIBE_RATE_LIMIT; i += 1) {
      expect(consumeSubscribeQuota(subscribeRequest(ip), now).allowed).toBe(true);
    }
  });

  it('denies the next attempt with a retry window inside ten minutes', () => {
    for (let i = 0; i < SUBSCRIBE_RATE_LIMIT; i += 1)
      consumeSubscribeQuota(subscribeRequest(ip), now);

    const denied = consumeSubscribeQuota(subscribeRequest(ip), now);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(SUBSCRIBE_RATE_WINDOW_MS / 1000);
  });

  it('lets the same IP back in once its window has passed', () => {
    for (let i = 0; i <= SUBSCRIBE_RATE_LIMIT; i += 1)
      consumeSubscribeQuota(subscribeRequest(ip), now);
    expect(consumeSubscribeQuota(subscribeRequest(ip), now).allowed).toBe(false);

    const later = now + SUBSCRIBE_RATE_WINDOW_MS;
    expect(consumeSubscribeQuota(subscribeRequest(ip), later).allowed).toBe(true);
  });

  it("keeps one IP's spent quota off another IP", () => {
    for (let i = 0; i <= SUBSCRIBE_RATE_LIMIT; i += 1)
      consumeSubscribeQuota(subscribeRequest(ip), now);
    expect(consumeSubscribeQuota(subscribeRequest(ip), now).allowed).toBe(false);

    const other = { 'x-forwarded-for': '203.0.113.6' };
    expect(consumeSubscribeQuota(subscribeRequest(other), now).allowed).toBe(true);
  });
});
