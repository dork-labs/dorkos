/**
 * @vitest-environment jsdom
 */
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { ActivityItem } from '@dorkos/shared/activity-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { useActivitySeenStore, useNewActivityCount } from '../model/activity-seen';

const transport = createMockTransport();

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

const items = (n: number) => Array.from({ length: n }, () => ({}) as ActivityItem);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useActivitySeenStore.setState({ lastSeenAt: null, viewing: false });
  vi.mocked(transport.listActivityEvents).mockResolvedValue({ items: items(3), nextCursor: null });
});

describe('useActivitySeenStore', () => {
  it('keeps the moment where the Activity page has always kept it', () => {
    act(() => useActivitySeenStore.getState().markSeen());
    const seen = useActivitySeenStore.getState().lastSeenAt;
    expect(seen).not.toBeNull();
    expect(localStorage.getItem('dorkos:lastVisitedActivity')).toBe(seen);
  });
});

describe('useNewActivityCount', () => {
  it('counts nothing before your first visit, and asks nothing', () => {
    const { result } = renderHook(() => useNewActivityCount(), { wrapper });
    expect(result.current).toBe(0);
    expect(transport.listActivityEvents).not.toHaveBeenCalled();
  });

  it('counts the events since you last looked', async () => {
    useActivitySeenStore.setState({ lastSeenAt: '2026-10-09T10:00:00.000Z' });
    const { result } = renderHook(() => useNewActivityCount(), { wrapper });
    await waitFor(() => expect(result.current).toBe(3));
    expect(transport.listActivityEvents).toHaveBeenCalledWith(
      expect.objectContaining({ since: '2026-10-09T10:00:00.000Z' })
    );
  });

  it('counts nothing while the Activity page is on screen', async () => {
    useActivitySeenStore.setState({ lastSeenAt: '2026-10-09T10:00:00.000Z' });
    const { result } = renderHook(() => useNewActivityCount(), { wrapper });
    await waitFor(() => expect(result.current).toBe(3));
    act(() => useActivitySeenStore.getState().setViewing(true));
    expect(result.current).toBe(0);
  });
});
