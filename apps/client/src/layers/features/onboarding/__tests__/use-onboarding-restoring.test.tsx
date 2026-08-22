/**
 * A returning user must never be shown the first-run wizard while the persisted
 * cache is still being restored (spec `sidebar-simplification` D6, task 3.2).
 *
 * **The bug this pins was shipped-and-caught in one session.** Adding
 * `PersistQueryClientProvider` made every query PAUSE during restore, and a
 * paused query reports `isLoading: false` — `isLoading` is `isPending &&
 * isFetching`, and a paused query is not fetching. So `useOnboarding` had
 * `isLoading === false` with `config === undefined`, computed
 * `shouldShowOnboarding` from an empty config, and got `true`.
 * `useOnboardingOverlayVisible` latches the first `true` forever, so the wizard
 * stayed up over an install that had dismissed onboarding long ago — and wrote a
 * fresh `startedAt` on the way past. Measured in a browser: `startedAt` one
 * second AFTER the `dismissedAt` the same load should have read.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import type { Persister } from '@tanstack/react-query-persist-client';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider } from '@/layers/shared/model';
import { useOnboarding } from '../model/use-onboarding';

/** A config for an install that finished with onboarding a long time ago. */
const DISMISSED_CONFIG = {
  onboarding: {
    completedSteps: [],
    skippedSteps: [],
    startedAt: null,
    dismissedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    runtimeDefaultSetAt: null,
  },
};

/**
 * A persister whose restore never settles until released.
 *
 * That window is the whole subject: it is short in production and impossible to
 * poll for, so it is held open here rather than raced.
 */
function heldPersister(): { persister: Persister; release: () => void } {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release: () => release(),
    persister: {
      persistClient: () => Promise.resolve(),
      removeClient: () => Promise.resolve(),
      restoreClient: async () => {
        await held;
        return undefined;
      },
    },
  };
}

describe('onboarding while the persisted cache is restoring', () => {
  it('does not decide a returning user is new before the cache has answered', async () => {
    const { persister, release } = heldPersister();
    const transport = createMockTransport();
    transport.getConfig = vi.fn().mockResolvedValue(DISMISSED_CONFIG);
    const queryClient = new QueryClient();

    const { result } = renderHook(() => useOnboarding(), {
      wrapper: ({ children }) => (
        <TransportProvider transport={transport as unknown as Transport}>
          <PersistQueryClientProvider client={queryClient} persistOptions={{ persister }}>
            {children}
          </PersistQueryClientProvider>
        </TransportProvider>
      ),
    });

    // Mid-restore: nothing has been read, so nothing may be concluded. Before
    // the fix this was `true` — computed from an empty config — and the overlay
    // latched on it.
    expect(result.current.isLoading).toBe(true);
    expect(result.current.shouldShowOnboarding).toBe(false);

    release();

    // And once the config really arrives, the answer is the config's.
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.shouldShowOnboarding).toBe(false);
    expect(result.current.isOnboardingDismissed).toBe(true);
  });
});
