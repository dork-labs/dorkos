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

describe('another window', () => {
  it("moves this window's reading position when it opens Activity", () => {
    useActivitySeenStore.setState({ lastSeenAt: '2026-10-01T00:00:00.000Z' });
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'dorkos:lastVisitedActivity',
          newValue: '2026-10-09T12:00:00.000Z',
        })
      );
    });
    expect(useActivitySeenStore.getState().lastSeenAt).toBe('2026-10-09T12:00:00.000Z');
  });

  it('ignores other keys', () => {
    useActivitySeenStore.setState({ lastSeenAt: '2026-10-01T00:00:00.000Z' });
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'other', newValue: 'x' }));
    });
    expect(useActivitySeenStore.getState().lastSeenAt).toBe('2026-10-01T00:00:00.000Z');
  });
});

describe('useNewActivityCount', () => {
  it('says there are more when one read could not count them all', async () => {
    useActivitySeenStore.setState({ lastSeenAt: '2026-10-09T10:00:00.000Z' });
    vi.mocked(transport.listActivityEvents).mockResolvedValue({
      items: items(100),
      nextCursor: 'next',
    });
    const { result } = renderHook(() => useNewActivityCount(), { wrapper });
    await waitFor(() => expect(result.current).toEqual({ count: 100, more: true }));
  });

  it('counts nothing before your first visit, and asks nothing', () => {
    const { result } = renderHook(() => useNewActivityCount(), { wrapper });
    expect(result.current.count).toBe(0);
    expect(transport.listActivityEvents).not.toHaveBeenCalled();
  });

  it('counts the events since you last looked', async () => {
    useActivitySeenStore.setState({ lastSeenAt: '2026-10-09T10:00:00.000Z' });
    const { result } = renderHook(() => useNewActivityCount(), { wrapper });
    await waitFor(() => expect(result.current).toEqual({ count: 3, more: false }));
    expect(transport.listActivityEvents).toHaveBeenCalledWith(
      expect.objectContaining({ since: '2026-10-09T10:00:00.000Z' })
    );
  });

  it('counts nothing while the Activity page is on screen', async () => {
    useActivitySeenStore.setState({ lastSeenAt: '2026-10-09T10:00:00.000Z' });
    const { result } = renderHook(() => useNewActivityCount(), { wrapper });
    await waitFor(() => expect(result.current).toEqual({ count: 3, more: false }));
    act(() => useActivitySeenStore.getState().setViewing(true));
    expect(result.current.count).toBe(0);
  });
});
