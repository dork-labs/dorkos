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

import {
  usePulseFreshness,
  PULSE_FRESHNESS_EVENTS,
  EVENT_CACHE_INVALIDATIONS,
} from '../model/use-pulse-freshness';

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
  it('subscribes to exactly the freshness events — and nothing else', () => {
    const { wrapper } = createWrapper();
    renderHook(() => usePulseFreshness(COALESCE_MS), { wrapper });

    expect([...handlers.keys()].sort()).toEqual([...PULSE_FRESHNESS_EVENTS].sort());
    // Session lifecycle and unrelated broadcasts are deliberately NOT subscribed
    // (attention's stalled sessions ride the list stream; tunnel/commands have
    // their own hooks).
    expect(handlers.has('session_upserted')).toBe(false);
    expect(handlers.has('session_removed')).toBe(false);
    expect(handlers.has('tunnel_status')).toBe(false);
    expect(handlers.has('commands_changed')).toBe(false);
  });

  it('invalidates both activity caches after the coalesce window on an activity event', () => {
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

  describe('DOR-403 attention transitions', () => {
    it('task_run_failed refreshes the failed-runs cache AND the activity caches', () => {
      const { queryClient, wrapper } = createWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
      renderHook(() => usePulseFreshness(COALESCE_MS), { wrapper });

      handlers.get('task_run_failed')!(undefined);
      expect(invalidateSpy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(COALESCE_MS);

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'runs'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['dashboard-activity'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['activity'] });
      expect(invalidateSpy).toHaveBeenCalledTimes(3);
    });

    it('relay_dead_letter refreshes only the dead-letters cache', () => {
      const { queryClient, wrapper } = createWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
      renderHook(() => usePulseFreshness(COALESCE_MS), { wrapper });

      handlers.get('relay_dead_letter')!(undefined);
      vi.advanceTimersByTime(COALESCE_MS);

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['relay', 'dead-letters'] });
      expect(invalidateSpy).toHaveBeenCalledTimes(1);
    });

    it('mesh_liveness_changed refreshes only the mesh-status cache', () => {
      const { queryClient, wrapper } = createWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
      renderHook(() => usePulseFreshness(COALESCE_MS), { wrapper });

      handlers.get('mesh_liveness_changed')!(undefined);
      vi.advanceTimersByTime(COALESCE_MS);

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['mesh', 'status'] });
      expect(invalidateSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('coalesces a burst of events into a single flush of the union of caches', () => {
    const { queryClient, wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    renderHook(() => usePulseFreshness(COALESCE_MS), { wrapper });

    // A flurry across several event types, none a full window apart. The union of
    // touched caches: activity ×2 (relay_message + task_run_failed), tasks/runs,
    // dead-letters — de-duplicated to four distinct caches.
    handlers.get('relay_message')!(undefined);
    vi.advanceTimersByTime(300);
    handlers.get('task_run_failed')!(undefined);
    vi.advanceTimersByTime(300);
    handlers.get('relay_dead_letter')!(undefined);

    // Still nothing — each event pushed the trailing flush out.
    expect(invalidateSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(COALESCE_MS);

    // Four distinct caches: dashboard-activity, activity, tasks/runs, dead-letters.
    expect(invalidateSpy).toHaveBeenCalledTimes(4);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['dashboard-activity'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['activity'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', 'runs'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['relay', 'dead-letters'] });
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

  it('every subscribed event maps to at least one cache', () => {
    for (const event of PULSE_FRESHNESS_EVENTS) {
      expect(EVENT_CACHE_INVALIDATIONS[event].length).toBeGreaterThan(0);
    }
  });
});
