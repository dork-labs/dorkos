// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const handlers = new Map<string, (data: unknown) => void>();

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useEventSubscription: (event: string, handler: (data: unknown) => void) => {
      handlers.set(event, handler);
    },
  };
});

import { CONFIG_WRITE_MUTATION_KEY, configKeys } from '@/layers/shared/model';
import { useConfigSync } from '../model/use-config-sync';

const COALESCE_MS = 500;

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    queryClient,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  };
}

beforeEach(() => {
  handlers.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.clearAllMocks();
});

describe('useConfigSync', () => {
  it('subscribes to config_changed and nothing else', () => {
    const { wrapper } = createWrapper();
    renderHook(() => useConfigSync(COALESCE_MS), { wrapper });

    expect([...handlers.keys()]).toEqual(['config_changed']);
  });

  it('re-reads the config after the window', () => {
    const { queryClient, wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    renderHook(() => useConfigSync(COALESCE_MS), { wrapper });

    handlers.get('config_changed')!({ sections: ['ui'], changedAt: '2026-09-15T00:00:00Z' });
    expect(invalidateSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(COALESCE_MS);

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: configKeys.current() });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  it('re-reads on ANY section — settings are one object behind one key', () => {
    const { queryClient, wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    renderHook(() => useConfigSync(COALESCE_MS), { wrapper });

    handlers.get('config_changed')!({ sections: ['runtimes'], changedAt: 'now' });
    vi.advanceTimersByTime(COALESCE_MS);

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: configKeys.current() });
  });

  it('coalesces a drag burst into one re-read', () => {
    const { queryClient, wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    renderHook(() => useConfigSync(COALESCE_MS), { wrapper });

    for (let i = 0; i < 5; i++) {
      handlers.get('config_changed')!({ sections: ['ui'], changedAt: `t${i}` });
      vi.advanceTimersByTime(100);
    }
    expect(invalidateSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(COALESCE_MS);

    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  it('stands down while this window has a config write in flight', () => {
    // The real failure this prevents: the sidebar's write is optimistic, a drag
    // is a rapid sequence of them, and a refetch fired by an earlier write's
    // broadcast answers with a state the later writes have moved past — so the
    // tail of the gesture appears to revert.
    const { queryClient, wrapper } = createWrapper();
    renderHook(() => useConfigSync(COALESCE_MS), { wrapper });

    // A mutation that never settles inside this test, tagged the way every
    // config write in the entity layer is.
    void queryClient
      .getMutationCache()
      .build(queryClient, {
        mutationKey: [...CONFIG_WRITE_MUTATION_KEY],
        mutationFn: () => new Promise<void>(() => {}),
      })
      .execute(undefined);
    expect(queryClient.isMutating({ mutationKey: CONFIG_WRITE_MUTATION_KEY })).toBe(1);

    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    handlers.get('config_changed')!({ sections: ['ui'], changedAt: 'now' });
    vi.advanceTimersByTime(COALESCE_MS);

    // Nothing — and nothing is owed, because the mutation's own `onSettled`
    // invalidates the same key when the burst ends.
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('DEFERS the re-read rather than dropping it — it lands once the write settles', async () => {
    // The bug this pins, found in adversarial review: the first cut cleared the
    // pending keys before asking the veto, so a vetoed flush threw them away.
    // Three config mutations invalidate on `onSuccess` ALONE
    // (`useUpdateConfig`, `useAgentContextConfig`, `useMeshScanRoots`), so a
    // REFUSED write re-reads nothing — and a dropped broadcast from another
    // window would then leave this one showing a value nothing ever corrects.
    const { queryClient, wrapper } = createWrapper();
    renderHook(() => useConfigSync(COALESCE_MS), { wrapper });

    // Built before `execute`, so the settle handle exists whatever order the
    // mutation cache calls things in.
    let settle!: () => void;
    const refused = new Promise<void>((_resolve, reject) => {
      settle = () => reject(new Error('refused'));
    });
    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationKey: [...CONFIG_WRITE_MUTATION_KEY],
      // REJECTING, not resolving: this is the refused write whose own handler
      // will not invalidate anything.
      mutationFn: () => refused,
    });
    void mutation.execute(undefined).catch(() => {});
    expect(queryClient.isMutating({ mutationKey: CONFIG_WRITE_MUTATION_KEY })).toBe(1);

    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    handlers.get('config_changed')!({ sections: ['ui'], changedAt: 'now' });

    // Vetoed: nothing yet, even well past the window.
    vi.advanceTimersByTime(COALESCE_MS * 3);
    expect(invalidateSpy).not.toHaveBeenCalled();

    // The write settles (refused). Now the held keys must flush on the next
    // re-armed window — this is the assertion the old code failed.
    settle!();
    await vi.waitFor(() =>
      expect(queryClient.isMutating({ mutationKey: CONFIG_WRITE_MUTATION_KEY })).toBe(0)
    );
    vi.advanceTimersByTime(COALESCE_MS);

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: configKeys.current() });
  });

  it('cancels a pending flush on unmount', () => {
    const { queryClient, wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { unmount } = renderHook(() => useConfigSync(COALESCE_MS), { wrapper });

    handlers.get('config_changed')!({ sections: ['ui'], changedAt: 'now' });
    unmount();
    vi.advanceTimersByTime(COALESCE_MS);

    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
