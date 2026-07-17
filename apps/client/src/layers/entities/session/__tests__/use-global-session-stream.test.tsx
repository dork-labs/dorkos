/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Session } from '@dorkos/shared/types';

// Keep the effect from opening a real global stream — we only exercise the
// store → query-cache bridge, not the SSE transport.
vi.mock('@/layers/shared/lib/transport', () => ({
  streamManager: { connectList: vi.fn() },
}));
vi.mock('../model/session-stream-binding', () => ({
  initSessionStreamBinding: vi.fn(),
  resetSessionStreamBinding: vi.fn(),
}));

import { useGlobalSessionStream } from '../model/use-global-session-stream';
import { useSessionListStore } from '../model/session-list-store';

function makeSession(id: string): Session {
  return {
    id,
    title: `Session ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
    permissionMode: 'default',
    runtime: 'claude-code',
    cwd: '/projects/api',
  };
}

describe('useGlobalSessionStream — recent-sessions invalidation', () => {
  beforeEach(() => {
    // Reset the singleton store so no leaked sessions trigger an initial reconcile.
    useSessionListStore.setState({ sessions: {}, rekeys: {} });
  });

  it('invalidates the Recent-sessions query on a session lifecycle event', () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useGlobalSessionStream(), { wrapper });
    // Ignore any invalidations from mount; assert only the lifecycle-driven one.
    invalidateSpy.mockClear();

    act(() => {
      useSessionListStore.getState().upsertSession(makeSession('a1'));
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['sessions', 'recent'] });
  });
});
