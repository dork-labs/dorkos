/**
 * @vitest-environment jsdom
 *
 * Direct tests for the trailing-edge invalidation coalescer (DOR-2070).
 *
 * The `*Sync` hooks that use it cover the happy path; these pin the two veto
 * edges nothing else reaches: an unmount while a veto has re-armed the timer,
 * and a second event arriving while a flush is deferred.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCoalescedInvalidation } from '../use-coalesced-invalidation';

const WINDOW_MS = 100;

/** Render the hook under a fresh client, with `shouldFlush` read from `veto`. */
function setup() {
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
  const veto = { active: false };
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  const hook = renderHook(
    () => useCoalescedInvalidation({ coalesceMs: WINDOW_MS, shouldFlush: () => !veto.active }),
    { wrapper: Wrapper }
  );
  /** The query keys invalidated so far, in call order. */
  const invalidatedKeys = () => invalidate.mock.calls.map(([filters]) => filters?.queryKey);
  return { hook, invalidate, invalidatedKeys, veto };
}

describe('useCoalescedInvalidation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('collapses a burst into one invalidation per distinct key', () => {
    const { hook, invalidatedKeys } = setup();

    act(() => {
      hook.result.current([{ queryKey: ['agents'] }]);
      hook.result.current([{ queryKey: ['agents'] }, { queryKey: ['sessions'], exact: true }]);
    });
    act(() => {
      vi.advanceTimersByTime(WINDOW_MS);
    });

    expect(invalidatedKeys()).toEqual([['agents'], ['sessions']]);
  });

  it('holds the keys through a veto and flushes them once it lifts', () => {
    const { hook, invalidatedKeys, veto } = setup();
    veto.active = true;

    act(() => {
      hook.result.current([{ queryKey: ['agents'] }]);
    });
    act(() => {
      vi.advanceTimersByTime(WINDOW_MS * 3);
    });
    expect(invalidatedKeys()).toEqual([]);

    veto.active = false;
    act(() => {
      vi.advanceTimersByTime(WINDOW_MS);
    });
    expect(invalidatedKeys()).toEqual([['agents']]);
  });

  it('fires nothing after unmount while a veto has re-armed the timer', () => {
    const { hook, invalidate, veto } = setup();
    veto.active = true;

    act(() => {
      hook.result.current([{ queryKey: ['agents'] }]);
    });
    // The first flush is refused, so the hook re-arms a timer of its own —
    // the one the unmount cleanup has to find and clear.
    act(() => {
      vi.advanceTimersByTime(WINDOW_MS);
    });
    expect(vi.getTimerCount()).toBe(1);

    veto.active = false;
    hook.unmount();
    act(() => {
      vi.advanceTimersByTime(WINDOW_MS * 10);
    });

    expect(invalidate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('merges an event that arrives during a veto with the keys already held', () => {
    const { hook, invalidatedKeys, veto } = setup();
    veto.active = true;

    act(() => {
      hook.result.current([{ queryKey: ['agents'] }]);
    });
    act(() => {
      vi.advanceTimersByTime(WINDOW_MS);
    });
    // A second broadcast lands while the first is deferred.
    act(() => {
      hook.result.current([{ queryKey: ['sessions'], exact: true }]);
    });

    veto.active = false;
    act(() => {
      vi.advanceTimersByTime(WINDOW_MS);
    });

    expect(invalidatedKeys()).toEqual([['agents'], ['sessions']]);
  });
});
