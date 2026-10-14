/**
 * Keeping a live credits token without anybody pressing a button: minted at
 * startup when linked, minted again before each one expires, dropped on
 * unlink, and never minted by saving a credits choice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import tokenFixture from '@dork-labs/cloud-api/fixtures/v1/inference/token.json' with { type: 'json' };

const state = vi.hoisted(() => ({
  token: 'ik' as string | null,
  mints: 0,
  attempts: 0,
  refusing: false,
  outage: false,
  /** When set, the next mint hangs until released (with `true` to fail it). */
  hold: null as null | { release: (fail: boolean) => void },
  holdNext: false,
  expiresInMs: 60 * 60_000,
  listeners: new Set<(change: { paths: readonly string[] }) => void>(),
}));

vi.mock('../../config-manager.js', () => ({
  configManager: {
    onChange: (listener: (change: { paths: readonly string[] }) => void) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
  },
}));

vi.mock('../v1-client.js', () => ({
  isCloudLinked: () => state.token !== null,
  readCloudInstanceToken: () => state.token,
  // A refused mint answers 404, as an unknown instance does.
  problemOf: () => (state.refusing ? { status: 404, code: 'instance_not_found' } : null),
  resolveCloudIdentity: async () => ({ instanceId: 'instance-1', accountKey: null }),
  captureCloudV1Context: () =>
    state.token === null
      ? null
      : {
          isCurrent: () => true,
          client: {
            post: async () => {
              state.attempts += 1;
              if (state.holdNext) {
                state.holdNext = false;
                const fail = await new Promise<boolean>((resolve) => {
                  state.hold = { release: resolve };
                });
                if (fail) throw new Error('503 Service Unavailable');
              }
              if (state.refusing) throw new Error('404 Not Found');
              // No answer: a 5xx or a timeout, which says nothing about the account.
              if (state.outage) throw new Error('503 Service Unavailable');
              state.mints += 1;
              return {
                ...tokenFixture,
                token: `minted-${state.mints}`,
                expiresAt: new Date(Date.now() + state.expiresInMs).toISOString(),
              };
            },
          },
        },
}));

import {
  heldCreditsToken,
  startCreditsLifecycle,
  stopCreditsLifecycle,
  __setCreditsStateForTests,
} from '../credits-inference.js';

/** Settle what `fn` starts, on the real loop. */
async function act(fn: () => void): Promise<void> {
  fn();
  for (let turn = 0; turn < 10; turn++) await Promise.resolve();
}

function emit(paths: readonly string[]): void {
  for (const listener of state.listeners) listener({ paths });
}

describe('the credits token lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.token = 'ik';
    state.mints = 0;
    state.attempts = 0;
    state.refusing = false;
    state.outage = false;
    state.hold = null;
    state.holdNext = false;
    state.expiresInMs = 60 * 60_000;
    __setCreditsStateForTests({ token: null });
  });

  afterEach(() => {
    stopCreditsLifecycle();
    vi.useRealTimers();
    __setCreditsStateForTests({ token: null });
  });

  it('mints at startup, so a restart never drops a session set to credits', async () => {
    startCreditsLifecycle();
    await vi.waitFor(() => expect(heldCreditsToken()?.token).toBe('minted-1'));
  });

  it('mints a fresh token before the held one expires', async () => {
    startCreditsLifecycle();
    await vi.waitFor(() => expect(state.mints).toBe(1));
    // Five minutes before the hour is when the refresh is due.
    await vi.advanceTimersByTimeAsync(54 * 60_000);
    expect(state.mints).toBe(1);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(state.mints).toBe(2);
    expect(heldCreditsToken()?.token).toBe('minted-2');
  });

  it('mints nothing at startup on a computer that is not linked', async () => {
    state.token = null;
    startCreditsLifecycle();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(state.mints).toBe(0);
  });

  it('drops the token on unlink, and mints again on a new link', async () => {
    startCreditsLifecycle();
    await vi.waitFor(() => expect(state.mints).toBe(1));
    state.token = null;
    emit(['cloud']);
    expect(heldCreditsToken()).toBeNull();
    state.token = 'ik-2';
    emit(['cloud']);
    await vi.waitFor(() => expect(heldCreditsToken()?.token).toBe('minted-2'));
  });

  it('does not mint when only a credits choice is saved', async () => {
    startCreditsLifecycle();
    await vi.waitFor(() => expect(state.mints).toBe(1));
    emit(['cloud']);
    emit(['cloud']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.mints).toBe(1);
  });

  it('waits longer after each refused mint instead of asking every minute (DOR-2903)', async () => {
    state.refusing = true;
    startCreditsLifecycle();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    // 1, 2, 4, 8, 16, 32 minutes apart: 6 tries in the hour, where it was 61.
    expect(state.attempts).toBeLessThanOrEqual(7);
    expect(state.attempts).toBeGreaterThan(3);
  });

  it('starts the waits over once a mint succeeds', async () => {
    state.refusing = true;
    startCreditsLifecycle();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    state.refusing = false;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(heldCreditsToken()?.token).toBe('minted-1');
    // The held token's refresh fails, and the first retry comes a minute later
    // again, not where the earlier waits left off.
    state.refusing = true;
    const beforeRefresh = state.attempts;
    while (state.attempts === beforeRefresh) await vi.advanceTimersByTimeAsync(1_000);
    const refreshed = state.attempts;
    await vi.advanceTimersByTimeAsync(59_000);
    expect(state.attempts).toBe(refreshed);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(state.attempts).toBe(refreshed + 1);
  });

  it('starts the waits over on a new link, replacing a long wait left from the old one', async () => {
    state.refusing = true;
    startCreditsLifecycle();
    // Tries at 0, 1, 3, 7, 15 and 31 min; the next is not due until 63.
    await vi.advanceTimersByTimeAsync(32 * 60_000);
    state.token = 'ik-2';
    emit(['cloud']);
    await vi.advanceTimersByTimeAsync(1_000);
    const afterRelink = state.attempts;
    await vi.advanceTimersByTimeAsync(61_000);
    expect(state.attempts).toBe(afterRelink + 1);
  });

  it('keeps trying when a refresh gets no answer, before the held token runs out (DOR-2915)', async () => {
    startCreditsLifecycle();
    await vi.waitFor(() => expect(state.mints).toBe(1));
    state.outage = true;
    // The refresh is due five minutes before the hour, and fails.
    await vi.advanceTimersByTimeAsync(55 * 60_000 + 1_000);
    const failed = state.attempts;
    expect(failed).toBe(2);
    expect(heldCreditsToken()?.token).toBe('minted-1');
    // A retry comes a minute later, and the outage is over by then.
    state.outage = false;
    await vi.advanceTimersByTimeAsync(61_000);
    expect(state.attempts).toBe(failed + 1);
    expect(state.mints).toBe(2);
    expect(heldCreditsToken()?.token).toBe('minted-2');
  });

  it('keeps trying when a new link’s first mint gets no answer, though an old token is held (DOR-2915)', async () => {
    startCreditsLifecycle();
    await vi.waitFor(() => expect(state.mints).toBe(1));
    state.outage = true;
    state.token = 'ik-2';
    emit(['cloud']);
    await vi.advanceTimersByTimeAsync(1_000);
    const failed = state.attempts;
    expect(failed).toBe(2);
    state.outage = false;
    await vi.advanceTimersByTimeAsync(61_000);
    expect(state.attempts).toBe(failed + 1);
    expect(heldCreditsToken()?.token).toBe('minted-2');
  });

  it('does not let a stale failed mint replace a newer token’s refresh (DOR-2915)', async () => {
    startCreditsLifecycle();
    await vi.waitFor(() => expect(state.mints).toBe(1));
    // The refresh at 55 minutes goes out and hangs.
    state.holdNext = true;
    await vi.advanceTimersByTimeAsync(55 * 60_000 + 1_000);
    expect(state.hold).not.toBeNull();
    // Unlinked (the token revoked) and linked again; the new link mints fine.
    __setCreditsStateForTests({ token: null });
    state.token = 'ik-2';
    emit(['cloud']);
    await vi.waitFor(() => expect(heldCreditsToken()?.token).toBe('minted-2'));
    const attempts = state.attempts;
    // The stale refresh now fails. Its retry would replace minted-2's refresh.
    await act(() => state.hold!.release(true));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(state.attempts).toBe(attempts);
    // minted-2's own refresh still comes, five minutes before it expires.
    await vi.advanceTimersByTimeAsync(51 * 60_000);
    expect(state.attempts).toBe(attempts + 1);
  });
});
