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
import { useBindings } from '../model/use-bindings';
import { useCreateBinding } from '../model/use-create-binding';
import { useDeleteBinding } from '../model/use-delete-binding';
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';

const mockBinding: AdapterBinding = {
  id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  adapterId: 'telegram-main',
  agentId: 'agent-1',
  agentDir: '/home/user/agents/alpha',
  sessionStrategy: 'per-chat',
  label: 'Main bot',
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

describe('useBindings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches bindings via transport.getBindings', async () => {
    const transport = createMockTransport({
      getBindings: vi.fn().mockResolvedValue([mockBinding]),
    });

    const { result } = renderHook(() => useBindings(), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toHaveLength(1);
    expect(result.current.data![0].id).toBe(mockBinding.id);
    expect(result.current.data![0].adapterId).toBe('telegram-main');
    expect(transport.getBindings).toHaveBeenCalledTimes(1);
  });

  it('returns undefined data while loading', () => {
    const transport = createMockTransport({
      getBindings: vi.fn().mockReturnValue(new Promise(() => {})),
    });

    const { result } = renderHook(() => useBindings(), {
      wrapper: createWrapper(transport),
    });

    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(true);
  });

  it('exposes error state on transport failure', async () => {
    const transport = createMockTransport({
      getBindings: vi.fn().mockRejectedValue(new Error('Bindings fetch failed')),
    });

    const { result } = renderHook(() => useBindings(), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBeInstanceOf(Error);
  });
});

describe('useCreateBinding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls transport.createBinding with the provided input', async () => {
    const transport = createMockTransport({
      createBinding: vi.fn().mockResolvedValue(mockBinding),
    });

    const { result } = renderHook(() => useCreateBinding(), {
      wrapper: createWrapper(transport),
    });

    result.current.mutate({
      adapterId: 'telegram-main',
      agentId: 'agent-1',
      agentDir: '/home/user/agents/alpha',
      sessionStrategy: 'per-chat',
      label: 'Main bot',
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(transport.createBinding).toHaveBeenCalledWith({
      adapterId: 'telegram-main',
      agentId: 'agent-1',
      agentDir: '/home/user/agents/alpha',
      sessionStrategy: 'per-chat',
      label: 'Main bot',
    });
    expect(result.current.data).toEqual(mockBinding);
  });

  it('invalidates bindings query on success', async () => {
    const transport = createMockTransport({
      getBindings: vi.fn().mockResolvedValue([mockBinding]),
      createBinding: vi.fn().mockResolvedValue(mockBinding),
    });

    const wrapper = createWrapper(transport);

    // Prime the bindings cache first
    const { result: bindingsResult } = renderHook(() => useBindings(), { wrapper });
    await waitFor(() => {
      expect(bindingsResult.current.isSuccess).toBe(true);
    });

    const { result } = renderHook(() => useCreateBinding(), { wrapper });

    result.current.mutate({
      adapterId: 'telegram-main',
      agentId: 'agent-1',
      agentDir: '/home/user/agents/alpha',
      sessionStrategy: 'per-chat',
      label: '',
    });

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
      createBinding: vi.fn().mockRejectedValue(new Error('Create failed')),
    });

    const { result } = renderHook(() => useCreateBinding(), {
      wrapper: createWrapper(transport),
    });

    result.current.mutate({
      adapterId: 'telegram-main',
      agentId: 'agent-1',
      agentDir: '/home/user/agents/alpha',
      sessionStrategy: 'per-chat',
      label: '',
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBeInstanceOf(Error);
  });
});

describe('useDeleteBinding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls transport.deleteBinding with the provided id', async () => {
    const transport = createMockTransport({
      deleteBinding: vi.fn().mockResolvedValue(undefined),
    });

    const { result } = renderHook(() => useDeleteBinding(), {
      wrapper: createWrapper(transport),
    });

    result.current.mutate('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(transport.deleteBinding).toHaveBeenCalledWith('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
  });

  it('invalidates bindings query on success', async () => {
    const transport = createMockTransport({
      getBindings: vi.fn().mockResolvedValue([mockBinding]),
      deleteBinding: vi.fn().mockResolvedValue(undefined),
    });

    const wrapper = createWrapper(transport);

    // Prime the bindings cache first
    const { result: bindingsResult } = renderHook(() => useBindings(), { wrapper });
    await waitFor(() => {
      expect(bindingsResult.current.isSuccess).toBe(true);
    });

    const { result } = renderHook(() => useDeleteBinding(), { wrapper });

    result.current.mutate(mockBinding.id);

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
      deleteBinding: vi.fn().mockRejectedValue(new Error('Delete failed')),
    });

    const { result } = renderHook(() => useDeleteBinding(), {
      wrapper: createWrapper(transport),
    });

    result.current.mutate('some-id');

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBeInstanceOf(Error);
  });
});
