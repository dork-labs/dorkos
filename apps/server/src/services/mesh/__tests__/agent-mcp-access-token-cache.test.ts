/**
 * The synchronous access-token cache (DOR-942): the current token is readable
 * without awaiting, an expired token reads as absent (safe default), the refresh
 * is scheduled ahead of expiry, and the background refresh replaces an
 * about-to-expire token before it lapses. Every cached token carries an ABSOLUTE
 * expiry, so it is judged the same whether just minted or loaded after a restart.
 *
 * Every assertion is paired with the revert that reddens it (see the inline
 * notes) — a passing test is not evidence on its own (REVIEW.md).
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';

import {
  McpAccessTokenCache,
  type CachedToken,
  type TimerScheduler,
} from '../agent-mcp-access-token-cache.js';

const AGENT = 'agent-1';
const SERVER = 'granola';

/** A controllable clock the cache reads for both expiry and scheduling. */
function makeClock(start = 0): { now: () => number; set: (t: number) => void } {
  let t = start;
  return { now: () => t, set: (next) => (t = next) };
}

/** A scheduler that captures the scheduled delay instead of using real timers. */
function makeCapturingScheduler(): { scheduler: TimerScheduler; captured: { delay: number }[] } {
  const captured: { delay: number }[] = [];
  const scheduler: TimerScheduler = {
    set(_fn, delayMs) {
      captured.push({ delay: delayMs });
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
    clear() {},
  };
  return { scheduler, captured };
}

/** Build a cached token with an absolute expiry (refresh scheduling off unless asked). */
function cached(accessToken: string, expiresAt: number, refreshable = false): CachedToken {
  return { accessToken, expiresAt, refreshable };
}

describe('McpAccessTokenCache', () => {
  it('returns the current access token synchronously while it is live', () => {
    const clock = makeClock(0);
    const cache = new McpAccessTokenCache({ now: clock.now });

    cache.store(AGENT, SERVER, cached('token-A', 3_600_000), async () => null);

    // Reverting `getAccessToken` to always return undefined reddens this — the
    // injection path would then never see a token.
    expect(cache.getAccessToken(AGENT, SERVER)).toBe('token-A');
    // A different (agentId, serverName) is a miss, not a wrong-token hit.
    expect(cache.getAccessToken('other-agent', SERVER)).toBeUndefined();
    expect(cache.getAccessToken(AGENT, 'other-server')).toBeUndefined();
  });

  it('reads an expired token as absent (withhold — the safe default)', () => {
    const clock = makeClock(0);
    const cache = new McpAccessTokenCache({ now: clock.now });

    cache.store(AGENT, SERVER, cached('token-A', 100_000), async () => null);
    clock.set(100_001); // one ms past the absolute expiry

    // Reverting the `now() < expiresAt` guard to always-return-the-token reddens
    // this: injection would then attach a stale, expired bearer.
    expect(cache.getAccessToken(AGENT, SERVER)).toBeUndefined();
  });

  it('schedules the refresh before expiry (skewed early), not at it', () => {
    const clock = makeClock(0);
    const { scheduler, captured } = makeCapturingScheduler();
    const cache = new McpAccessTokenCache({ now: clock.now, scheduler });

    cache.store(AGENT, SERVER, cached('token-A', 100_000, true), async () => null);

    // Absolute expiry 100_000, refreshed 60_000 early → a 40_000 delay. Reverting
    // the REFRESH_SKEW subtraction makes this 100_000 and reddens the assertion.
    expect(captured).toEqual([{ delay: 40_000 }]);
  });

  it('background refresh replaces an about-to-expire token with the fresh one', async () => {
    const clock = makeClock(0);
    const cache = new McpAccessTokenCache({ now: clock.now });

    // The refresh returns token-B, which lives well past token-A's expiry.
    const refresh = async (): Promise<CachedToken> => cached('token-B', 140_000);
    cache.store(AGENT, SERVER, cached('token-A', 100_000), refresh);
    expect(cache.getAccessToken(AGENT, SERVER)).toBe('token-A');

    clock.set(40_000);
    const replaced = await cache.refreshNow(AGENT, SERVER);
    expect(replaced).toBe(true);

    // token-B is now live, and stays live past token-A's 100_000 expiry — proving
    // the replacement, not a re-read of A. Reverting the `this.store(...next...)`
    // line in refreshNow leaves token-A cached and reddens both assertions.
    expect(cache.getAccessToken(AGENT, SERVER)).toBe('token-B');
    clock.set(100_001);
    expect(cache.getAccessToken(AGENT, SERVER)).toBe('token-B');
  });

  it('evicts the token when a refresh fails (degrade to needs-auth, never a stale token)', async () => {
    const clock = makeClock(0);
    const cache = new McpAccessTokenCache({ now: clock.now });

    cache.store(AGENT, SERVER, cached('token-A', 100_000), async () => null);
    clock.set(40_000);
    const replaced = await cache.refreshNow(AGENT, SERVER);

    expect(replaced).toBe(false);
    // Reverting the `evict` on a null refresh would leave token-A readable until
    // its own expiry, injecting a token the server may already have rotated.
    expect(cache.getAccessToken(AGENT, SERVER)).toBeUndefined();
  });
});
