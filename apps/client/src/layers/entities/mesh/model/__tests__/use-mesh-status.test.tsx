// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useMeshStatus } from '../use-mesh-status';

function createWrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
  });
  return {
    queryClient,
    Wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    ),
  };
}

const mockStatus = {
  totalAgents: 5,
  activeCount: 3,
  inactiveCount: 1,
  staleCount: 1,
  byRuntime: { 'claude-code': 3, custom: 2 },
  byProject: { 'project-a': 4, 'project-b': 1 },
  lastScanTime: '2026-02-25T00:00:00Z',
};

describe('useMeshStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls transport.getMeshStatus and returns data', async () => {
    const transport = createMockTransport({
      getMeshStatus: vi.fn().mockResolvedValue(mockStatus),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useMeshStatus(), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(mockStatus);
    expect(transport.getMeshStatus).toHaveBeenCalledTimes(1);
  });

  it('skips fetching when enabled is false', () => {
    const transport = createMockTransport({
      getMeshStatus: vi.fn().mockResolvedValue(mockStatus),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useMeshStatus(false), { wrapper: Wrapper });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.fetchStatus).toBe('idle');
    expect(transport.getMeshStatus).not.toHaveBeenCalled();
  });

  it('exposes error state on transport failure', async () => {
    const transport = createMockTransport({
      getMeshStatus: vi.fn().mockRejectedValue(new Error('Status fetch failed')),
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useMeshStatus(), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBeInstanceOf(Error);
  });

  it('is pending before the query resolves', () => {
    const transport = createMockTransport({
      getMeshStatus: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
    });
    const { Wrapper } = createWrapper(transport);

    const { result } = renderHook(() => useMeshStatus(), { wrapper: Wrapper });

    expect(result.current.isPending).toBe(true);
    expect(result.current.data).toBeUndefined();
  });
});
