/**
 * The synchronous access-token cache (DOR-942): the current token is readable
 * without awaiting, an expired token reads as absent (safe default), and the
 * background refresh replaces an about-to-expire token before it lapses.
 *
 * Every assertion is paired with the revert that reddens it (see the inline
 * notes) — a passing test is not evidence on its own (REVIEW.md).
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

import { McpAccessTokenCache, type TimerScheduler } from '../agent-mcp-access-token-cache.js';

const AGENT = 'agent-1';
const SERVER = 'granola';

/** A controllable clock the cache reads for both expiry and scheduling. */
function makeClock(start = 0): { now: () => number; set: (t: number) => void } {
  let t = start;
  return { now: () => t, set: (next) => (t = next) };
}

/** A scheduler that captures the scheduled callback + delay instead of using real timers. */
function makeCapturingScheduler(): {
  scheduler: TimerScheduler;
  captured: { delay: number }[];
} {
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

/** Build an OAuth token set (only the fields the cache reads matter). */
function tokens(accessToken: string, expiresIn: number, refreshToken = 'refresh-x'): OAuthTokens {
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: expiresIn,
    refresh_token: refreshToken,
  };
}

describe('McpAccessTokenCache', () => {
  it('returns the current access token synchronously while it is live', () => {
    const clock = makeClock(0);
    const cache = new McpAccessTokenCache({ now: clock.now });

    cache.store(AGENT, SERVER, tokens('token-A', 3600), async () => null);

    // Reverting `mergeOAuthHeaders`/`getAccessToken` to always return undefined
    // reddens this — the injection path would then never see a token.
    expect(cache.getAccessToken(AGENT, SERVER)).toBe('token-A');
    // A different (agentId, serverName) is a miss, not a wrong-token hit.
    expect(cache.getAccessToken('other-agent', SERVER)).toBeUndefined();
    expect(cache.getAccessToken(AGENT, 'other-server')).toBeUndefined();
  });

  it('reads an expired token as absent (withhold — the safe default)', () => {
    const clock = makeClock(0);
    const cache = new McpAccessTokenCache({ now: clock.now });

    cache.store(AGENT, SERVER, tokens('token-A', 100), async () => null);
    clock.set(100_001); // one ms past expiry

    // Reverting the `now() < expiresAt` guard to always-return-the-token reddens
    // this: injection would then attach a stale, expired bearer.
    expect(cache.getAccessToken(AGENT, SERVER)).toBeUndefined();
  });

  it('schedules the refresh before expiry (skewed early), not at it', () => {
    const clock = makeClock(0);
    const { scheduler, captured } = makeCapturingScheduler();
    const cache = new McpAccessTokenCache({ now: clock.now, scheduler });

    cache.store(AGENT, SERVER, tokens('token-A', 100), async () => null);

    // 100s lifetime, refreshed 60s early → a 40s delay. Reverting the REFRESH_SKEW
    // subtraction makes this 100_000 and reddens the assertion.
    expect(captured).toEqual([{ delay: 40_000 }]);
  });

  it('background refresh replaces an about-to-expire token with the fresh one', async () => {
    const clock = makeClock(0);
    const cache = new McpAccessTokenCache({ now: clock.now });

    // The refresh fires at the skew boundary (t=40_000) and returns token-B.
    const refresh = async (): Promise<OAuthTokens> => tokens('token-B', 100);
    cache.store(AGENT, SERVER, tokens('token-A', 100), refresh);
    expect(cache.getAccessToken(AGENT, SERVER)).toBe('token-A');

    clock.set(40_000);
    const replaced = await cache.refreshNow(AGENT, SERVER);
    expect(replaced).toBe(true);

    // token-B is now live; and it stays live past token-A's original 100s expiry,
    // proving the replacement (not merely a re-read of A). Reverting the
    // `this.store(...next...)` line in refreshNow leaves token-A cached and reddens
    // BOTH the value and the past-expiry assertions.
    expect(cache.getAccessToken(AGENT, SERVER)).toBe('token-B');
    clock.set(100_001);
    expect(cache.getAccessToken(AGENT, SERVER)).toBe('token-B');
  });

  it('evicts the token when a refresh fails (degrade to needs-auth, never a stale token)', async () => {
    const clock = makeClock(0);
    const cache = new McpAccessTokenCache({ now: clock.now });

    cache.store(AGENT, SERVER, tokens('token-A', 100), async () => null);
    clock.set(40_000);
    const replaced = await cache.refreshNow(AGENT, SERVER);

    expect(replaced).toBe(false);
    // Reverting the `evict` on a null refresh would leave token-A readable until
    // its own expiry, injecting a token the server may already have rotated.
    expect(cache.getAccessToken(AGENT, SERVER)).toBeUndefined();
  });
});
