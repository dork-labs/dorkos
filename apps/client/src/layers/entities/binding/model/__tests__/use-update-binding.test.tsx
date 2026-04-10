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
import { useUpdateBinding } from '../use-update-binding';
import { useBindings } from '../use-bindings';
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';

const mockBinding: AdapterBinding = {
  id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  adapterId: 'telegram-main',
  agentId: 'agent-1',
  sessionStrategy: 'per-chat',
  label: 'Main bot',
  permissionMode: 'acceptEdits',
  enabled: true,
  canInitiate: false,
  canReply: true,
  canReceive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

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

describe('useUpdateBinding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls transport.updateBinding with the provided id and updates', async () => {
    const updatedBinding = {
      ...mockBinding,
      label: 'updated',
      updatedAt: '2026-02-01T00:00:00.000Z',
    };
    const transport = createMockTransport({
      updateBinding: vi.fn().mockResolvedValue(updatedBinding),
    });

    const { result } = renderHook(() => useUpdateBinding(), {
      wrapper: createWrapper(transport),
    });

    result.current.mutate({ id: mockBinding.id, updates: { label: 'updated' } });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(transport.updateBinding).toHaveBeenCalledWith(mockBinding.id, { label: 'updated' });
    expect(result.current.data).toEqual(updatedBinding);
  });

  it('invalidates bindings query on success', async () => {
    const updatedBinding = { ...mockBinding, sessionStrategy: 'stateless' as const };
    const transport = createMockTransport({
      getBindings: vi.fn().mockResolvedValue([mockBinding]),
      updateBinding: vi.fn().mockResolvedValue(updatedBinding),
    });

    const wrapper = createWrapper(transport);

    // Prime the bindings cache first
    const { result: bindingsResult } = renderHook(() => useBindings(), { wrapper });
    await waitFor(() => {
      expect(bindingsResult.current.isSuccess).toBe(true);
    });

    const { result } = renderHook(() => useUpdateBinding(), { wrapper });

    result.current.mutate({ id: mockBinding.id, updates: { sessionStrategy: 'stateless' } });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    // Invalidation triggers a refetch — getBindings called a second time
    await waitFor(() => {
      expect(transport.getBindings).toHaveBeenCalledTimes(2);
    });
  });

  it('exposes error state on transport failure', async () => {
    const transport = createMockTransport({
      updateBinding: vi.fn().mockRejectedValue(new Error('Update failed')),
    });

    const { result } = renderHook(() => useUpdateBinding(), {
      wrapper: createWrapper(transport),
    });

    result.current.mutate({ id: 'some-id', updates: { label: 'test' } });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBeInstanceOf(Error);
  });
});
