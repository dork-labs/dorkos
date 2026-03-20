/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { useAdapterEvents } from '../use-adapter-events';

describe('useAdapterEvents', () => {
  let queryClient: QueryClient;
  let mockTransport: ReturnType<typeof createMockTransport>;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockTransport = createMockTransport();
  });

  function wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={mockTransport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }

  it('fetches events when adapterId is provided', async () => {
    const mockEvents = {
      events: [
        {
          id: 'event-1',
          subject: 'adapter.connected',
          status: 'delivered',
          sentAt: '2026-03-11T10:00:00Z',
          metadata: null,
        },
      ],
    };
    mockTransport.getAdapterEvents = vi.fn().mockResolvedValue(mockEvents);

    const { result } = renderHook(() => useAdapterEvents('telegram-1'), { wrapper });

    await waitFor(() => {
      expect(result.current.data).toEqual(mockEvents);
    });

    expect(mockTransport.getAdapterEvents).toHaveBeenCalledWith('telegram-1');
  });

  it('does not fetch when adapterId is null', () => {
    mockTransport.getAdapterEvents = vi.fn();

    renderHook(() => useAdapterEvents(null), { wrapper });

    expect(mockTransport.getAdapterEvents).not.toHaveBeenCalled();
  });

  it('uses correct query key structure', async () => {
    mockTransport.getAdapterEvents = vi.fn().mockResolvedValue({ events: [] });

    renderHook(() => useAdapterEvents('telegram-1'), { wrapper });

    await waitFor(() => {
      expect(mockTransport.getAdapterEvents).toHaveBeenCalled();
    });

    // Verify query is cached under the expected key
    const queryState = queryClient.getQueryState(['relay', 'adapters', 'telegram-1', 'events']);
    expect(queryState).toBeDefined();
  });
});
