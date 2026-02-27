/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useDeadLetters } from '../model/use-dead-letters';

const mockDeadLetters = [
  {
    endpointHash: 'h1',
    messageId: 'msg-1',
    reason: 'hop_limit',
    envelope: {},
    failedAt: '2026-02-27T10:00:00Z',
  },
  {
    endpointHash: 'h2',
    messageId: 'msg-2',
    reason: 'ttl_expired',
    envelope: {},
    failedAt: '2026-02-27T10:05:00Z',
  },
];

function createWrapper(overrides = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
  });
  const transport = createMockTransport({
    listRelayDeadLetters: vi.fn().mockResolvedValue(mockDeadLetters),
    ...overrides,
  });
  return {
    transport,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    ),
  };
}

describe('useDeadLetters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches dead letters from transport.listRelayDeadLetters', async () => {
    const { wrapper, transport } = createWrapper();

    const { result } = renderHook(() => useDeadLetters(), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toHaveLength(2);
    expect(result.current.data![0].messageId).toBe('msg-1');
    expect(transport.listRelayDeadLetters).toHaveBeenCalledTimes(1);
    expect(transport.listRelayDeadLetters).toHaveBeenCalledWith(undefined);
  });

  it('passes filters to transport.listRelayDeadLetters', async () => {
    const { wrapper, transport } = createWrapper({
      listRelayDeadLetters: vi.fn().mockResolvedValue([mockDeadLetters[0]]),
    });

    const filters = { endpointHash: 'abc123' };
    const { result } = renderHook(() => useDeadLetters(filters), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(transport.listRelayDeadLetters).toHaveBeenCalledWith(filters);
    expect(result.current.data).toHaveLength(1);
  });

  it('skips fetching when enabled is false', () => {
    const { wrapper, transport } = createWrapper();

    const { result } = renderHook(() => useDeadLetters(undefined, false), { wrapper });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.fetchStatus).toBe('idle');
    expect(transport.listRelayDeadLetters).not.toHaveBeenCalled();
  });

  it('returns empty array when no dead letters exist', async () => {
    const { wrapper } = createWrapper({
      listRelayDeadLetters: vi.fn().mockResolvedValue([]),
    });

    const { result } = renderHook(() => useDeadLetters(), { wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual([]);
  });
});
