/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SessionDailyCountsResponse } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';
import { sessionKeys } from '@/layers/entities/session';
import { TransportProvider } from '@/layers/shared/model';
import { useSessionActivity, ACTIVITY_WINDOW_DAYS } from '../model/use-session-activity';

function createHarness(response: SessionDailyCountsResponse) {
  const transport = createMockTransport({
    getSessionDailyCounts: vi.fn().mockResolvedValue(response),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return { transport, queryClient, wrapper };
}

describe('useSessionActivity', () => {
  it('asks the server for a machine-wide week and exposes the counts', async () => {
    const { transport, wrapper } = createHarness({
      days: 7,
      dailyCounts: [1, 0, 0, 2, 0, 0, 3],
      warnings: [],
    });

    const { result } = renderHook(() => useSessionActivity(), { wrapper });

    await waitFor(() => expect(result.current).not.toBeNull());
    expect(transport.getSessionDailyCounts).toHaveBeenCalledWith(ACTIVITY_WINDOW_DAYS);
    expect(result.current).toEqual({ dailyCounts: [1, 0, 0, 2, 0, 0, 3], degraded: false });
  });

  it('answers null until the server has answered', () => {
    const { wrapper } = createHarness({ days: 7, dailyCounts: [0, 0, 0, 0, 0, 0, 0] });

    const { result } = renderHook(() => useSessionActivity(), { wrapper });

    // First render: the query is in flight. Zeroes here would be a claim about
    // a week nobody has counted yet.
    expect(result.current).toBeNull();
  });

  it('marks the week degraded when a runtime could not be read', async () => {
    const { wrapper } = createHarness({
      days: 7,
      dailyCounts: [0, 0, 0, 0, 0, 0, 4],
      warnings: [{ runtime: 'codex', message: 'timed out' }],
    });

    const { result } = renderHook(() => useSessionActivity(), { wrapper });

    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current?.degraded).toBe(true);
  });

  it('treats an empty window as no answer, not as a quiet week', async () => {
    // What the embedded (Obsidian) transport returns: no agent roster, so
    // nothing machine-wide to count.
    const { transport, wrapper } = createHarness({ days: 0, dailyCounts: [], warnings: [] });

    const { result } = renderHook(() => useSessionActivity(), { wrapper });

    await waitFor(() => expect(transport.getSessionDailyCounts).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it('caches under the shared session key, which is what the live bridge invalidates', async () => {
    // Red when: this hook's key and `sessionKeys.dailyCounts` drift apart. The
    // global-stream bridge invalidates that prefix when a session appears, and
    // a hand-written key would leave the count frozen under a live feed.
    const { queryClient, wrapper } = createHarness({
      days: 7,
      dailyCounts: [0, 0, 0, 0, 0, 0, 1],
      warnings: [],
    });

    const { result } = renderHook(() => useSessionActivity(), { wrapper });
    await waitFor(() => expect(result.current).not.toBeNull());

    const query = queryClient
      .getQueryCache()
      .find({ queryKey: sessionKeys.dailyCounts(ACTIVITY_WINDOW_DAYS) });
    expect(query).toBeDefined();
  });
});
