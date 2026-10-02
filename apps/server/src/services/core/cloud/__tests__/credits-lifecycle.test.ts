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
  problemOf: () => null,
  resolveCloudIdentity: async () => ({ instanceId: 'instance-1', accountKey: null }),
  captureCloudV1Context: () =>
    state.token === null
      ? null
      : {
          isCurrent: () => true,
          client: {
            post: async () => {
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

function emit(paths: readonly string[]): void {
  for (const listener of state.listeners) listener({ paths });
}

describe('the credits token lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.token = 'ik';
    state.mints = 0;
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
});
