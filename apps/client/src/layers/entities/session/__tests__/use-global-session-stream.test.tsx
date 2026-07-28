/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RecentSessionsResponse, Session } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';

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
import { useRecentSessions } from '../model/use-recent-sessions';
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

const envelope: RecentSessionsResponse = {
  sessions: [makeSession('existing')],
  agentActivity: { '/projects/api': '2026-03-01T00:00:00.000Z' },
};

describe('useGlobalSessionStream — recent-sessions invalidation', () => {
  beforeEach(() => {
    // Reset the singleton store so no leaked sessions trigger an initial reconcile.
    useSessionListStore.setState({ sessions: {}, rekeys: {} });
    vi.clearAllMocks();
  });

  it('refetches the Recent-sessions query on a session lifecycle event', async () => {
    // Mounts the real Recent query rather than spying on an invalidation key:
    // asserting the key the bridge passes could only ever agree with itself,
    // and the whole failure mode here is a prefix that stops matching the
    // reader's key.
    //
    // Red when: the bridge's invalidation prefix and the Recent query's key
    // drift apart — the sidebar's Recent section then goes stale for 30s at a
    // time with no other symptom.
    const transport = createMockTransport({
      listRecentSessions: vi.fn().mockResolvedValue(envelope),
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );

    const { result } = renderHook(
      () => ({ recent: useRecentSessions(), stream: useGlobalSessionStream() }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.recent.isSuccess).toBe(true));
    expect(transport.listRecentSessions).toHaveBeenCalledTimes(1);

    act(() => {
      useSessionListStore.getState().upsertSession(makeSession('a1'));
    });

    await waitFor(() => expect(transport.listRecentSessions).toHaveBeenCalledTimes(2));
  });
});
