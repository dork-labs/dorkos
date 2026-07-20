// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// Capture every (eventName → handler) pair the hook registers, without an SSE
// connection — the same seam use-commands-sync.test uses.
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

import { usePulseFreshness, ACTIVITY_GENERATING_EVENTS } from '../model/use-pulse-freshness';

const COALESCE_MS = 1_200;

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

describe('usePulseFreshness', () => {
  it('subscribes to exactly the activity-generating events — and nothing else', () => {
    const { wrapper } = createWrapper();
    renderHook(() => usePulseFreshness(COALESCE_MS), { wrapper });

    expect([...handlers.keys()].sort()).toEqual([...ACTIVITY_GENERATING_EVENTS].sort());
    // Session lifecycle and unrelated broadcasts are deliberately NOT subscribed
    // (activity is not session-derived; tunnel/commands have their own hooks).
    expect(handlers.has('session_upserted')).toBe(false);
    expect(handlers.has('session_removed')).toBe(false);
    expect(handlers.has('tunnel_status')).toBe(false);
    expect(handlers.has('commands_changed')).toBe(false);
  });

  it('invalidates both activity caches after the coalesce window when a relevant event fires', () => {
    const { queryClient, wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    renderHook(() => usePulseFreshness(COALESCE_MS), { wrapper });

    handlers.get('relay_message')!(undefined);

    // Nothing yet — the flush is debounced.
    expect(invalidateSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(COALESCE_MS);

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['dashboard-activity'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['activity'] });
    // Exactly the two activity caches — no third.
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
  });

  it('coalesces a burst of events into a single flush', () => {
    const { queryClient, wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    renderHook(() => usePulseFreshness(COALESCE_MS), { wrapper });

    // A flurry across several event types, none a full window apart.
    handlers.get('relay_message')!(undefined);
    vi.advanceTimersByTime(300);
    handlers.get('relay_flow')!(undefined);
    vi.advanceTimersByTime(300);
    handlers.get('relay_adapters_changed')!(undefined);
    vi.advanceTimersByTime(300);
    handlers.get('extension_reloaded')!(undefined);

    // Still nothing — each event pushed the trailing flush out.
    expect(invalidateSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(COALESCE_MS);

    // One flush = two invalidations (the two activity caches), not one per event.
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
  });

  it('does not invalidate when no subscribed event fires', () => {
    const { queryClient, wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    renderHook(() => usePulseFreshness(COALESCE_MS), { wrapper });

    vi.advanceTimersByTime(COALESCE_MS * 3);

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('cancels a pending flush on unmount', () => {
    const { queryClient, wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { unmount } = renderHook(() => usePulseFreshness(COALESCE_MS), { wrapper });

    handlers.get('relay_message')!(undefined);
    unmount();
    vi.advanceTimersByTime(COALESCE_MS);

    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
