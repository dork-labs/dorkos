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
import type { RefreshVerdict } from '../agent-mcp-token-refresher.js';

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

/** The URL every token in this suite is minted for, unless a case varies it. */
const URL_A = 'https://mcp.example/mcp';

/**
 * A refresh that produced no token. `transient` rather than `terminal` because
 * these tests are about the CACHE, which evicts either way — the distinction only
 * decides what a caller may do with the STORED credential (DOR-981).
 */
const FAILED_REFRESH: RefreshVerdict = { token: null, kind: 'transient' };

/** Build a cached token with an absolute expiry (refresh scheduling off unless asked). */
function cached(
  accessToken: string,
  expiresAt: number,
  refreshable = false,
  serverUrl: string | undefined = URL_A
): CachedToken {
  return { accessToken, expiresAt, refreshable, serverUrl };
}

describe('McpAccessTokenCache', () => {
  it('returns the current access token synchronously while it is live', () => {
    const clock = makeClock(0);
    const cache = new McpAccessTokenCache({ now: clock.now });

    cache.store(AGENT, SERVER, cached('token-A', 3_600_000), async () => FAILED_REFRESH);

    // Reverting `getAccessToken` to always return undefined reddens this — the
    // injection path would then never see a token.
    expect(cache.getAccessToken(AGENT, SERVER, URL_A)).toBe('token-A');
    // A different (agentId, serverName) is a miss, not a wrong-token hit.
    expect(cache.getAccessToken('other-agent', SERVER, URL_A)).toBeUndefined();
    expect(cache.getAccessToken(AGENT, 'other-server', URL_A)).toBeUndefined();
  });

  it('reads an expired token as absent (withhold — the safe default)', () => {
    const clock = makeClock(0);
    const cache = new McpAccessTokenCache({ now: clock.now });

    cache.store(AGENT, SERVER, cached('token-A', 100_000), async () => FAILED_REFRESH);
    clock.set(100_001); // one ms past the absolute expiry

    // Reverting the `now() < expiresAt` guard to always-return-the-token reddens
    // this: injection would then attach a stale, expired bearer.
    expect(cache.getAccessToken(AGENT, SERVER, URL_A)).toBeUndefined();
  });

  it('schedules the refresh before expiry (skewed early), not at it', () => {
    const clock = makeClock(0);
    const { scheduler, captured } = makeCapturingScheduler();
    const cache = new McpAccessTokenCache({ now: clock.now, scheduler });

    cache.store(AGENT, SERVER, cached('token-A', 100_000, true), async () => FAILED_REFRESH);

    // Absolute expiry 100_000, refreshed 60_000 early → a 40_000 delay. Reverting
    // the REFRESH_SKEW subtraction makes this 100_000 and reddens the assertion.
    expect(captured).toEqual([{ delay: 40_000 }]);
  });

  it('background refresh replaces an about-to-expire token with the fresh one', async () => {
    const clock = makeClock(0);
    const cache = new McpAccessTokenCache({ now: clock.now });

    // The refresh returns token-B, which lives well past token-A's expiry.
    const refresh = async (): Promise<RefreshVerdict> => ({
      token: cached('token-B', 140_000),
      kind: 'ok',
    });
    cache.store(AGENT, SERVER, cached('token-A', 100_000), refresh);
    expect(cache.getAccessToken(AGENT, SERVER, URL_A)).toBe('token-A');

    clock.set(40_000);
    const replaced = await cache.refreshNow(AGENT, SERVER);
    expect(replaced).toBe(true);

    // token-B is now live, and stays live past token-A's 100_000 expiry — proving
    // the replacement, not a re-read of A. Reverting the `this.store(...next...)`
    // line in refreshNow leaves token-A cached and reddens both assertions.
    expect(cache.getAccessToken(AGENT, SERVER, URL_A)).toBe('token-B');
    clock.set(100_001);
    expect(cache.getAccessToken(AGENT, SERVER, URL_A)).toBe('token-B');
  });

  it('evicts the token when a refresh fails (degrade to needs-auth, never a stale token)', async () => {
    const clock = makeClock(0);
    const cache = new McpAccessTokenCache({ now: clock.now });

    cache.store(AGENT, SERVER, cached('token-A', 100_000), async () => FAILED_REFRESH);
    clock.set(40_000);
    const replaced = await cache.refreshNow(AGENT, SERVER);

    expect(replaced).toBe(false);
    // Reverting the `evict` on a null refresh would leave token-A readable until
    // its own expiry, injecting a token the server may already have rotated.
    expect(cache.getAccessToken(AGENT, SERVER, URL_A)).toBeUndefined();
  });
});

describe('McpAccessTokenCache — URL binding (DOR-986)', () => {
  const URL_B = 'https://other.example/mcp';

  it('withholds a token when the caller asks for a different server URL', () => {
    const cache = new McpAccessTokenCache({ now: () => 0 });
    cache.store(AGENT, SERVER, cached('token-A', 100_000), async () => FAILED_REFRESH);

    // Same (agentId, serverName) — the old key — but the row now points elsewhere.
    // Dropping the `entry.serverUrl !== serverUrl` guard hands the old server's
    // bearer to the new one and reddens this.
    expect(cache.getAccessToken(AGENT, SERVER, URL_B)).toBeUndefined();
    // And it discriminates: the URL it WAS minted for still resolves...
    const fresh = new McpAccessTokenCache({ now: () => 0 });
    fresh.store(AGENT, SERVER, cached('token-A', 100_000), async () => FAILED_REFRESH);
    expect(fresh.getAccessToken(AGENT, SERVER, URL_A)).toBe('token-A');
  });

  it('evicts on a URL mismatch, so the stale token stops being refreshed too', () => {
    const { scheduler, captured } = makeCapturingScheduler();
    const cache = new McpAccessTokenCache({ now: () => 0, scheduler });
    cache.store(AGENT, SERVER, cached('token-A', 100_000, true), async () => FAILED_REFRESH);
    expect(captured).toHaveLength(1);

    cache.getAccessToken(AGENT, SERVER, URL_B);

    // Evicted, not merely withheld: asking again with the ORIGINAL url is now a
    // miss. Reverting the `evict` call to a bare `return undefined` reddens this.
    expect(cache.getAccessToken(AGENT, SERVER, URL_A)).toBeUndefined();
  });

  it('never hands out a token stored without a URL binding at all', () => {
    const cache = new McpAccessTokenCache({ now: () => 0 });
    // A record written before the binding existed: no URL at all, so no URL matches.
    const unbound: CachedToken = {
      accessToken: 'legacy',
      expiresAt: 100_000,
      refreshable: false,
      serverUrl: undefined,
    };
    cache.store(AGENT, SERVER, unbound, async () => FAILED_REFRESH);

    expect(cache.getAccessToken(AGENT, SERVER, URL_A)).toBeUndefined();
  });
});

describe('McpAccessTokenCache — tokens with no declared lifetime (DOR-986)', () => {
  it('schedules a periodic refresh instead of leaving it unrefreshed forever', () => {
    const { scheduler, captured } = makeCapturingScheduler();
    const cache = new McpAccessTokenCache({ now: () => 0, scheduler });

    // RFC 6749 makes `expires_in` optional; no expiry reaches the cache as
    // POSITIVE_INFINITY. Reverting to the old
    // `if (expiresAt !== INFINITY && refreshable)` guard schedules nothing and
    // reddens this — the token would then never be refreshed for the whole
    // process lifetime.
    cache.store(
      AGENT,
      SERVER,
      cached('token-A', Number.POSITIVE_INFINITY, true),
      async () => FAILED_REFRESH
    );

    expect(captured).toEqual([{ delay: 3_600_000 }]);
  });

  it('still schedules nothing when there is no refresh token to use', () => {
    const { scheduler, captured } = makeCapturingScheduler();
    const cache = new McpAccessTokenCache({ now: () => 0, scheduler });

    // The discriminator for the case above: unrefreshable means unschedulable,
    // whatever the expiry. A periodic refresh with no refresh token would just
    // fail on a timer forever.
    cache.store(
      AGENT,
      SERVER,
      cached('token-A', Number.POSITIVE_INFINITY, false),
      async () => FAILED_REFRESH
    );

    expect(captured).toEqual([]);
  });
});

describe('McpAccessTokenCache.evictAgent (DOR-986)', () => {
  it('drops every one of an agent’s tokens and their timers, leaving other agents alone', () => {
    const { scheduler, captured } = makeCapturingScheduler();
    const cache = new McpAccessTokenCache({ now: () => 0, scheduler });
    cache.store(AGENT, SERVER, cached('a1', 100_000, true), async () => FAILED_REFRESH);
    cache.store(AGENT, 'other-server', cached('a2', 100_000, true), async () => FAILED_REFRESH);
    cache.store('agent-2', SERVER, cached('b1', 100_000, true), async () => FAILED_REFRESH);
    expect(captured).toHaveLength(3);

    cache.evictAgent(AGENT);

    // Reverting evictAgent to a no-op leaves a deleted agent's bearer live and
    // refreshing; the third assertion is the discriminator against evicting all.
    expect(cache.getAccessToken(AGENT, SERVER, URL_A)).toBeUndefined();
    expect(cache.getAccessToken(AGENT, 'other-server', URL_A)).toBeUndefined();
    expect(cache.getAccessToken('agent-2', SERVER, URL_A)).toBe('b1');
  });
});
