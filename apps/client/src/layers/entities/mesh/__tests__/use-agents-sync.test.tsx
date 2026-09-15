// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// Capture every (eventName → handler) pair the hook registers, without an SSE
// connection — the same seam use-pulse-freshness.test uses.
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

import { useAgentsSync, AGENT_IDENTITY_CACHES } from '../model/use-agents-sync';

const COALESCE_MS = 400;

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

describe('useAgentsSync', () => {
  it('subscribes to agents_changed and nothing else', () => {
    const { wrapper } = createWrapper();
    renderHook(() => useAgentsSync(COALESCE_MS), { wrapper });

    expect([...handlers.keys()]).toEqual(['agents_changed']);
  });

  it('invalidates exactly the three agent-identity caches after the window', () => {
    const { queryClient, wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    renderHook(() => useAgentsSync(COALESCE_MS), { wrapper });

    handlers.get('agents_changed')!({ kind: 'registered', agentId: '01JK' });

    // Nothing yet — the flush is debounced.
    expect(invalidateSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(COALESCE_MS);

    // `['mesh']` and `['agents']` are PREFIXES: the sidebar's rows
    // (`['mesh','agent-paths']`) and the manifest caches
    // (`['agents','byPath',…]`, `['agents','resolved',…]`) sit under them.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['mesh'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['agents'] });
    // `['team']` is a prefix too: `entities/team` nests one member's rooms under
    // it on purpose, and the three mesh mutations that sweep the roster already
    // sweep it the same way.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['team'] });
    expect(invalidateSpy).toHaveBeenCalledTimes(3);
  });

  it('coalesces a burst — a scan adopting six agents costs one pass', () => {
    const { queryClient, wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    renderHook(() => useAgentsSync(COALESCE_MS), { wrapper });

    for (let i = 0; i < 6; i++) {
      handlers.get('agents_changed')!({ kind: 'registered', agentId: `0${i}` });
      vi.advanceTimersByTime(100);
    }
    expect(invalidateSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(COALESCE_MS);

    expect(invalidateSpy).toHaveBeenCalledTimes(AGENT_IDENTITY_CACHES.length);
  });

  it('does not invalidate when nothing fires', () => {
    const { queryClient, wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    renderHook(() => useAgentsSync(COALESCE_MS), { wrapper });

    vi.advanceTimersByTime(COALESCE_MS * 3);

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('cancels a pending flush on unmount', () => {
    const { queryClient, wrapper } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { unmount } = renderHook(() => useAgentsSync(COALESCE_MS), { wrapper });

    handlers.get('agents_changed')!({ kind: 'removed', agentId: '01JK' });
    unmount();
    vi.advanceTimersByTime(COALESCE_MS);

    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
