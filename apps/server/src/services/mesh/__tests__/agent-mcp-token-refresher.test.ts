/**
 * {@link McpTokenRefresher} (DOR-986): the two rules that decide how often a
 * managed server's token endpoint is called — never twice at once for the same
 * target, and not given up on after a single transport blip.
 *
 * Every assertion names the revert that reddens it (REVIEW.md).
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';

import {
  McpTokenRefresher,
  withRequestTimeout,
  OAUTH_REQUEST_TIMEOUT_MS,
  type RefreshAttemptOutcome,
} from '../agent-mcp-token-refresher.js';
import type { CachedToken } from '../agent-mcp-access-token-cache.js';

const KEY = 'agent-1\0granola';

/** A silent logger so a deliberate failure does not print during the run. */
const quiet = { warn: (): void => {} };

/** A cached token stand-in. */
function token(accessToken: string): CachedToken {
  return {
    accessToken,
    expiresAt: Number.POSITIVE_INFINITY,
    refreshable: true,
    serverUrl: 'https://mcp.example/mcp',
  };
}

/** A refresher whose backoff never actually waits, recording the delays it asked for. */
function makeRefresher(): { refresher: McpTokenRefresher; delays: number[] } {
  const delays: number[] = [];
  const refresher = new McpTokenRefresher({
    logger: quiet,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  return { refresher, delays };
}

/** A deferred promise, for holding an attempt open while a second caller arrives. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('McpTokenRefresher — one refresh at a time', () => {
  it('joins a refresh already in flight instead of starting a second one', async () => {
    const { refresher } = makeRefresher();
    const gate = deferred<RefreshAttemptOutcome>();
    const attempt = vi.fn(() => gate.promise);

    const first = refresher.refresh(KEY, attempt);
    const second = refresher.refresh(KEY, attempt);
    gate.resolve({ kind: 'ok', token: token('fresh') });

    expect((await first).token?.accessToken).toBe('fresh');
    expect((await second).token?.accessToken).toBe('fresh');
    // Reverting the in-flight map (calling `attempt` per caller) makes this 2 —
    // two refresh-token presentations a rotating issuer reads as a replay.
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh refresh once the previous one has settled', async () => {
    const { refresher } = makeRefresher();
    const attempt = vi.fn(async (): Promise<RefreshAttemptOutcome> => ({
      kind: 'ok',
      token: token('fresh'),
    }));

    await refresher.refresh(KEY, attempt);
    await refresher.refresh(KEY, attempt);

    // The discriminator against a map that never clears: joining forever would
    // mean a token is refreshed exactly once per process.
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('holds an exclusive operation until the in-flight refresh has finished', async () => {
    const { refresher } = makeRefresher();
    const gate = deferred<RefreshAttemptOutcome>();
    const order: string[] = [];

    const refreshing = refresher.refresh(KEY, async () => {
      order.push('refresh-start');
      const outcome = await gate.promise;
      order.push('refresh-end');
      return outcome;
    });
    const signin = refresher.exclusive(KEY, async () => {
      order.push('signin');
    });

    gate.resolve({ kind: 'ok', token: token('fresh') });
    await Promise.all([refreshing, signin]);

    // Reverting `exclusive` to run immediately interleaves them as
    // ['refresh-start', 'signin', 'refresh-end'] — sign-in and refresh presenting
    // the same refresh token at once, which is what revokes a grant family.
    expect(order).toEqual(['refresh-start', 'refresh-end', 'signin']);
  });

  it('does not let a failed operation poison the next one queued behind it', async () => {
    const { refresher } = makeRefresher();
    const boom = refresher.exclusive(KEY, () => Promise.reject(new Error('boom')));
    const after = refresher.exclusive(KEY, async () => 'ran');

    await expect(boom).rejects.toThrow('boom');
    // Chaining with a bare `.then(run)` would reject this one too, wedging the
    // key: every later sign-in and refresh for the server would fail forever.
    expect(await after).toBe('ran');
  });
});

describe('withRequestTimeout', () => {
  it('abandons a request the server accepts but never answers', async () => {
    // A token endpoint that hangs is worse than one that is down: every operation
    // for that server queues behind the one holding its lock, so an unbounded
    // request wedges sign-in and refresh for as long as the socket stays open.
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });

    // Removing the signal from `withRequestTimeout` leaves this promise pending
    // and the test times out — which is the wedge, reproduced.
    await expect(withRequestTimeout(hanging, 5)('https://mcp.test.local/token')).rejects.toThrow(
      'aborted'
    );
  });

  it('leaves a caller’s own signal working', async () => {
    const controller = new AbortController();
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });

    // The discriminator against replacing the caller's signal outright: the
    // timeout is a ceiling added to whatever the caller already asked for.
    const inFlight = withRequestTimeout(hanging, OAUTH_REQUEST_TIMEOUT_MS)(
      'https://mcp.test.local/token',
      { signal: controller.signal }
    );
    controller.abort();
    await expect(inFlight).rejects.toThrow('aborted');
  });
});

describe('McpTokenRefresher — when to give up', () => {
  it('retries a transient failure with growing backoff before dropping the token', async () => {
    const { refresher, delays } = makeRefresher();
    const attempt = vi.fn(async (): Promise<RefreshAttemptOutcome> => ({
      kind: 'transient',
      reason: 'offline',
    }));

    // Exhausted, not refused — and the difference is load-bearing: only a
    // `terminal` verdict may cost the operator their STORED grant (DOR-981).
    expect(await refresher.refresh(KEY, attempt)).toEqual({ token: null, kind: 'transient' });
    // Reverting to evict-on-first-failure makes this 1 call and no delays — the
    // boot-while-offline case that killed every OAuth server until a restart.
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([1000, 2000]);
  });

  it('recovers when a retry succeeds, returning the fresh token', async () => {
    const { refresher } = makeRefresher();
    const outcomes: RefreshAttemptOutcome[] = [
      { kind: 'transient', reason: 'offline' },
      { kind: 'ok', token: token('recovered') },
    ];
    const attempt = vi.fn(async () => outcomes.shift()!);

    expect((await refresher.refresh(KEY, attempt)).token?.accessToken).toBe('recovered');
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('does not retry a terminal verdict — a revoked grant will not un-revoke', async () => {
    const { refresher, delays } = makeRefresher();
    const attempt = vi.fn(async (): Promise<RefreshAttemptOutcome> => ({
      kind: 'terminal',
      reason: 'invalid_grant',
    }));

    expect(await refresher.refresh(KEY, attempt)).toEqual({ token: null, kind: 'terminal' });
    // The discriminator against retrying everything: treating terminal as
    // transient makes this 3 calls and two pointless waits.
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });
});
