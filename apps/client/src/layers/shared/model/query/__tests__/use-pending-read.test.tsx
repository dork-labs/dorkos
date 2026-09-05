/**
 * @vitest-environment jsdom
 *
 * The one answer to "has this read answered yet?" (DOR-1646).
 *
 * Two surfaces worked this out separately — the onboarding overlay
 * (DOR-1365 §3.2) and `/team` (DOR-1419) — and both got it wrong first. The
 * behaviour is pinned here so a third caller inherits it rather than
 * rediscovering it: while the persisted cache is restoring, the queries are
 * PAUSED, `isLoading` reads false with no data, and anything gated on it
 * renders its empty state over an install that has plenty.
 */
import { describe, it, expect } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import type { Persister } from '@tanstack/react-query-persist-client';
import { usePendingRead } from '../use-pending-read';

/**
 * A persister whose restore never settles until released — the window this hook
 * exists for, held open rather than raced.
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

describe('usePendingRead', () => {
  it('stays pending through the cache restore, even when the query says it is not', async () => {
    const { persister, release } = heldPersister();
    const queryClient = new QueryClient();
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <PersistQueryClientProvider client={queryClient} persistOptions={{ persister }}>
          {children}
        </PersistQueryClientProvider>
      );
    }

    // `false` is exactly what a PAUSED query reports: pending, but not fetching.
    const { result } = renderHook(() => usePendingRead(false), { wrapper: Wrapper });

    expect(result.current).toBe(true);
    release();
    await waitFor(() => expect(result.current).toBe(false));
  });

  it('is the query’s own answer wherever there is no persister', () => {
    // The Obsidian embed and every test harness without one. Nothing is paused,
    // so nothing is added.
    const loading = renderHook(() => usePendingRead(true));
    expect(loading.result.current).toBe(true);

    const settled = renderHook(() => usePendingRead(false));
    expect(settled.result.current).toBe(false);
  });
});
