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
import { useRelayAdapters, useToggleAdapter } from '../model/use-relay-adapters';
import type { AdapterListItem } from '@dorkos/shared/transport';

const mockAdapterItem: AdapterListItem = {
  config: {
    id: 'tg-main',
    type: 'telegram',
    enabled: true,
    config: { token: 'xxx', mode: 'polling' },
  },
  status: {
    id: 'tg-main',
    type: 'telegram',
    displayName: 'Main Telegram',
    state: 'connected',
    messageCount: { inbound: 42, outbound: 18 },
    errorCount: 0,
  },
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

describe('useRelayAdapters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches adapter list from transport.listRelayAdapters', async () => {
    const transport = createMockTransport({
      listRelayAdapters: vi.fn().mockResolvedValue([mockAdapterItem]),
    });

    const { result } = renderHook(() => useRelayAdapters(), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toHaveLength(1);
    expect(result.current.data![0].config.id).toBe('tg-main');
    expect(result.current.data![0].status.displayName).toBe('Main Telegram');
    expect(transport.listRelayAdapters).toHaveBeenCalledTimes(1);
  });

  it('returns undefined data while loading', () => {
    const transport = createMockTransport({
      // Never resolves — keeps the hook in loading state
      listRelayAdapters: vi.fn().mockReturnValue(new Promise(() => {})),
    });

    const { result } = renderHook(() => useRelayAdapters(), {
      wrapper: createWrapper(transport),
    });

    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(true);
  });

  it('skips fetching when enabled is false', () => {
    const transport = createMockTransport({
      listRelayAdapters: vi.fn().mockResolvedValue([mockAdapterItem]),
    });

    const { result } = renderHook(() => useRelayAdapters(false), {
      wrapper: createWrapper(transport),
    });

    // Query is disabled — should not be loading and transport should not be called
    expect(result.current.isLoading).toBe(false);
    expect(result.current.fetchStatus).toBe('idle');
    expect(transport.listRelayAdapters).not.toHaveBeenCalled();
  });

  it('exposes error state on transport failure', async () => {
    const transport = createMockTransport({
      listRelayAdapters: vi.fn().mockRejectedValue(new Error('Adapter fetch failed')),
    });

    const { result } = renderHook(() => useRelayAdapters(), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBeInstanceOf(Error);
  });
});

describe('useToggleAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls transport.toggleRelayAdapter with id and enabled flag', async () => {
    const transport = createMockTransport({
      toggleRelayAdapter: vi.fn().mockResolvedValue({ ok: true }),
    });

    const { result } = renderHook(() => useToggleAdapter(), {
      wrapper: createWrapper(transport),
    });

    result.current.mutate({ id: 'tg-main', enabled: false });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(transport.toggleRelayAdapter).toHaveBeenCalledWith('tg-main', false);
    expect(result.current.data).toEqual({ ok: true });
  });

  it('invalidates the adapter query on success', async () => {
    const transport = createMockTransport({
      listRelayAdapters: vi.fn().mockResolvedValue([mockAdapterItem]),
      toggleRelayAdapter: vi.fn().mockResolvedValue({ ok: true }),
    });

    const wrapper = createWrapper(transport);

    // Prime the adapters cache first
    const { result: adaptersResult } = renderHook(() => useRelayAdapters(), { wrapper });
    await waitFor(() => {
      expect(adaptersResult.current.isSuccess).toBe(true);
    });

    const { result } = renderHook(() => useToggleAdapter(), { wrapper });

    result.current.mutate({ id: 'tg-main', enabled: false });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    // Cache invalidation triggers a refetch — listRelayAdapters called a second time
    await waitFor(() => {
      expect(transport.listRelayAdapters).toHaveBeenCalledTimes(2);
    });
  });

  it('exposes error state on transport failure', async () => {
    const transport = createMockTransport({
      toggleRelayAdapter: vi.fn().mockRejectedValue(new Error('Toggle failed')),
    });

    const { result } = renderHook(() => useToggleAdapter(), {
      wrapper: createWrapper(transport),
    });

    result.current.mutate({ id: 'tg-main', enabled: true });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBeInstanceOf(Error);
  });
});
