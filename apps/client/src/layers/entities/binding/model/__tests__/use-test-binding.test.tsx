/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useTestBinding } from '../use-test-binding';

function createWrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('useTestBinding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls transport.testBinding with the provided binding id', async () => {
    const mockResult = {
      ok: true,
      resolved: true,
      latencyMs: 42,
      wouldDeliverTo: 'agent-1',
      details: 'Routing succeeded. No agent was invoked.',
    };
    const transport = createMockTransport({
      testBinding: vi.fn().mockResolvedValue(mockResult),
    });

    const { result } = renderHook(() => useTestBinding(), {
      wrapper: createWrapper(transport),
    });

    result.current.mutate('binding-123');

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(transport.testBinding).toHaveBeenCalledWith('binding-123');
    expect(result.current.data).toEqual(mockResult);
  });

  it('handles test failure result (ok=false)', async () => {
    const mockResult = {
      ok: false,
      resolved: false,
      latencyMs: 10,
      reason: 'Agent not found in mesh registry',
    };
    const transport = createMockTransport({
      testBinding: vi.fn().mockResolvedValue(mockResult),
    });

    const { result } = renderHook(() => useTestBinding(), {
      wrapper: createWrapper(transport),
    });

    result.current.mutate('binding-456');

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data?.ok).toBe(false);
    expect(result.current.data?.resolved).toBe(false);
    expect(result.current.data?.reason).toBe('Agent not found in mesh registry');
  });

  it('exposes error state on network failure', async () => {
    const transport = createMockTransport({
      testBinding: vi.fn().mockRejectedValue(new Error('Network error')),
    });

    const { result } = renderHook(() => useTestBinding(), {
      wrapper: createWrapper(transport),
    });

    result.current.mutate('binding-789');

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('Network error');
  });
});
