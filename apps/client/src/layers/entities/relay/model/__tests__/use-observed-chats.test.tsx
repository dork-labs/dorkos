/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { useObservedChats } from '../use-observed-chats';

describe('useObservedChats', () => {
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

  it('fetches observed chats when adapterId is provided', async () => {
    const mockChats = [
      {
        chatId: '111',
        displayName: 'Alice',
        channelType: 'dm' as const,
        lastMessageAt: '2026-03-10T12:00:00.000Z',
        messageCount: 5,
      },
    ];
    mockTransport.getObservedChats = vi.fn().mockResolvedValue(mockChats);

    const { result } = renderHook(() => useObservedChats('telegram-1'), { wrapper });

    await waitFor(() => {
      expect(result.current.data).toEqual(mockChats);
    });

    expect(mockTransport.getObservedChats).toHaveBeenCalledWith('telegram-1');
  });

  it('does not fetch when adapterId is undefined', () => {
    mockTransport.getObservedChats = vi.fn();

    renderHook(() => useObservedChats(undefined), { wrapper });

    expect(mockTransport.getObservedChats).not.toHaveBeenCalled();
  });

  it('uses correct query key structure', async () => {
    mockTransport.getObservedChats = vi.fn().mockResolvedValue([]);

    renderHook(() => useObservedChats('telegram-1'), { wrapper });

    await waitFor(() => {
      expect(mockTransport.getObservedChats).toHaveBeenCalled();
    });

    const queryState = queryClient.getQueryState(['relay', 'observed-chats', 'telegram-1']);
    expect(queryState).toBeDefined();
  });

  it('returns empty array by default from mock transport', async () => {
    const { result } = renderHook(() => useObservedChats('telegram-1'), { wrapper });

    await waitFor(() => {
      expect(result.current.data).toEqual([]);
    });
  });
});
