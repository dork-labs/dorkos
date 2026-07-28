/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RecentSessionsResponse } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useRecentSessions } from '../model/use-recent-sessions';
import { sessionKeys } from '../api/query-keys';

const envelope: RecentSessionsResponse = {
  sessions: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Recent one',
      createdAt: '2026-03-01T00:00:00.000Z',
      updatedAt: '2026-03-01T00:00:00.000Z',
      permissionMode: 'default',
      runtime: 'claude-code',
      cwd: '/projects/api',
    },
  ],
  agentActivity: { '/projects/api': '2026-03-01T00:00:00.000Z' },
  warnings: [],
};

function createHarness() {
  const transport = createMockTransport({
    listRecentSessions: vi.fn().mockResolvedValue(envelope),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return { transport, queryClient, wrapper };
}

describe('useRecentSessions', () => {
  it('calls transport.listRecentSessions with the given limit and exposes the envelope', async () => {
    const { transport, wrapper } = createHarness();

    const { result } = renderHook(() => useRecentSessions(5), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(transport.listRecentSessions).toHaveBeenCalledWith(5);
    expect(result.current.data).toEqual(envelope);
  });

  it('defaults the limit to 10', async () => {
    const { transport, wrapper } = createHarness();

    const { result } = renderHook(() => useRecentSessions(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(transport.listRecentSessions).toHaveBeenCalledWith(10);
  });

  it('holds each page for 30s before it will refetch', async () => {
    const { queryClient, wrapper } = createHarness();

    const { result } = renderHook(() => useRecentSessions(7), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const query = queryClient.getQueryCache().find({ queryKey: sessionKeys.recent(7) });
    expect(query).toBeDefined();
    expect(query!.observers[0]!.options.staleTime).toBe(30_000);
  });

  it('does not park its envelope under the per-directory session lists', () => {
    // Everything under the list prefix is rewritten as a `Session[]` by the
    // retired-session sweep, and this query's value is an envelope object. It
    // lived under that prefix once and the sweep threw on it (DOR-497).
    //
    // Red when: the recent-sessions key moves back under the list prefix.
    const listPrefix = [...sessionKeys.listRoot];
    expect(sessionKeys.recent(10).slice(0, listPrefix.length)).not.toEqual(listPrefix);
    expect(sessionKeys.recentRoot.slice(0, listPrefix.length)).not.toEqual(listPrefix);
  });
});
