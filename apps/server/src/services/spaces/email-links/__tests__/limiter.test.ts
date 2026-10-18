import { describe, expect, it } from 'vitest';
import { createAttemptLimiter } from '../../limits/attempt-limiter.js';
import { RateLimited } from '../../http.js';
import { callerLimitKey, EmailLinkLimiter } from '../limiter.js';

describe('callerLimitKey', () => {
  it('keeps an IPv4 address and counts an IPv6 address by its /64', () => {
    // Purpose: fails if one IPv6 host could rotate through its /64 for a fresh budget per address,
    // or if two different /64s shared one budget.
    expect(callerLimitKey('192.0.2.7')).toBe('192.0.2.7');
    expect(callerLimitKey('::ffff:192.0.2.7')).toBe('192.0.2.7');
    const a = callerLimitKey('2001:db8:1:2::1');
    expect(a).toBe('2001:0db8:0001:0002::/64');
    expect(callerLimitKey('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe(a);
    expect(callerLimitKey('2001:0DB8:0001:0002:0:0:0:9%eth0')).toBe(a);
    expect(callerLimitKey('2001:db8:1:3::1')).not.toBe(a);
    expect(callerLimitKey('::1')).toBe('0000:0000:0000:0000::/64');
    expect(callerLimitKey('fe80::1:2:3:4')).toBe('fe80:0000:0000:0000::/64');
  });
});

describe('EmailLinkLimiter', () => {
  function clock() {
    let now = 1_000_000;
    return { now: () => now, advance: (ms: number) => (now += ms) };
  }

  it('refuses past the minute and past the hour, with Retry-After', () => {
    // Purpose: fails if either rolling window lets one more through, or a refusal says nothing
    // about when to try again.
    const time = clock();
    const limiter = new EmailLinkLimiter(100, time.now);
    for (let i = 0; i < 5; i++) limiter.spend('ip', { perMinute: 5, perHour: 20 });
    expect(() => limiter.spend('ip', { perMinute: 5, perHour: 20 })).toThrow(RateLimited);
    for (let round = 0; round < 3; round++) {
      time.advance(60_000);
      for (let i = 0; i < 5; i++) limiter.spend('ip', { perMinute: 5, perHour: 20 });
    }
    time.advance(60_000);
    try {
      limiter.spend('ip', { perMinute: 5, perHour: 20 });
      throw new Error('the 21st request in an hour was allowed');
    } catch (cause) {
      expect(cause).toBeInstanceOf(RateLimited);
      // The first of the 20 frees up 56 minutes from now.
      expect((cause as RateLimited).retryAfterSeconds).toBe(56 * 60);
    }
    time.advance(56 * 60_000);
    expect(() => limiter.spend('ip', { perMinute: 5, perHour: 20 })).not.toThrow();
  });

  it('stays within its bound, dropping idle keys first', () => {
    // Purpose: fails if the store grows without bound, or evicts a live key while idle ones remain.
    const time = clock();
    const limiter = new EmailLinkLimiter(3, time.now);
    limiter.spend('old', { perMinute: 1 });
    time.advance(61 * 60_000);
    limiter.spend('live', { perMinute: 1 });
    limiter.spend('b', { perMinute: 1 });
    limiter.spend('c', { perMinute: 1 });
    expect(limiter.size).toBe(3);
    expect(() => limiter.spend('live', { perMinute: 1 })).toThrow(RateLimited);
  });

  it('is not evicted by the shared attempt map filling up, and does not evict it (T23)', () => {
    // Purpose: fails if mailed-link budgets and the shared budgets (password guesses, invite
    // previews) lived in one store, where spraying keys into one evicts the other's.
    const shared = createAttemptLimiter(10_000);
    const links = new EmailLinkLimiter();
    for (let i = 0; i < 5; i++) links.spend('email-link:192.0.2.1', { perMinute: 5 });
    for (let i = 0; i < 3; i++) shared.limitAttempts('reauth-account:victim', 3);
    for (let i = 0; i <= 10_001; i++) shared.limitAttempts(`invite-preview-peer:${i}`, 20);
    expect(() => links.spend('email-link:192.0.2.1', { perMinute: 5 })).toThrow(RateLimited);

    const fresh = createAttemptLimiter(10_000);
    for (let i = 0; i < 3; i++) fresh.limitAttempts('reauth-account:victim', 3);
    const small = new EmailLinkLimiter(1_000);
    for (let i = 0; i <= 2_000; i++) small.spend(`email-link:${i}`, { perMinute: 5 });
    expect(() => fresh.limitAttempts('reauth-account:victim', 3)).toThrow(RateLimited);
    expect(small.size).toBeLessThanOrEqual(1_000);
  });
});
