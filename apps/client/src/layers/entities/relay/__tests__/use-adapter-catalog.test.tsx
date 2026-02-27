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
import type { CatalogEntry } from '@dorkos/shared/relay-schemas';
import {
  useAdapterCatalog,
  useAddAdapter,
  useRemoveAdapter,
  useUpdateAdapterConfig,
  useTestAdapterConnection,
} from '../model/use-adapter-catalog';

const mockCatalogEntry: CatalogEntry = {
  manifest: {
    type: 'telegram',
    displayName: 'Telegram',
    description: 'Telegram bot adapter',
    category: 'messaging',
    builtin: false,
    multiInstance: true,
    configFields: [{ key: 'token', label: 'Bot Token', type: 'password', required: true }],
  },
  instances: [
    {
      id: 'tg-main',
      enabled: true,
      status: {
        id: 'tg-main',
        type: 'telegram',
        displayName: 'Main Telegram',
        state: 'connected',
        messageCount: { inbound: 10, outbound: 5 },
        errorCount: 0,
      },
    },
  ],
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

describe('useAdapterCatalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches catalog from transport.getAdapterCatalog', async () => {
    const transport = createMockTransport({
      getAdapterCatalog: vi.fn().mockResolvedValue([mockCatalogEntry]),
    });

    const { result } = renderHook(() => useAdapterCatalog(), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toHaveLength(1);
    expect(result.current.data![0].manifest.type).toBe('telegram');
    expect(transport.getAdapterCatalog).toHaveBeenCalledTimes(1);
  });

  it('skips fetching when enabled is false', () => {
    const transport = createMockTransport({
      getAdapterCatalog: vi.fn().mockResolvedValue([mockCatalogEntry]),
    });

    const { result } = renderHook(() => useAdapterCatalog(false), {
      wrapper: createWrapper(transport),
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.fetchStatus).toBe('idle');
    expect(transport.getAdapterCatalog).not.toHaveBeenCalled();
  });
});

describe('useAddAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls transport.addRelayAdapter with type, id, and config', async () => {
    const transport = createMockTransport({
      addRelayAdapter: vi.fn().mockResolvedValue({ ok: true }),
    });

    const { result } = renderHook(() => useAddAdapter(), {
      wrapper: createWrapper(transport),
    });

    result.current.mutate({ type: 'telegram', id: 'tg-new', config: { token: 'abc' } });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(transport.addRelayAdapter).toHaveBeenCalledWith('telegram', 'tg-new', { token: 'abc' });
  });

  it('invalidates catalog and adapters queries on success', async () => {
    const transport = createMockTransport({
      getAdapterCatalog: vi.fn().mockResolvedValue([mockCatalogEntry]),
      addRelayAdapter: vi.fn().mockResolvedValue({ ok: true }),
    });

    const wrapper = createWrapper(transport);

    // Prime the catalog cache
    const { result: catalogResult } = renderHook(() => useAdapterCatalog(), { wrapper });
    await waitFor(() => {
      expect(catalogResult.current.isSuccess).toBe(true);
    });

    const { result } = renderHook(() => useAddAdapter(), { wrapper });

    result.current.mutate({ type: 'telegram', id: 'tg-new', config: { token: 'abc' } });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    // Invalidation triggers a refetch
    await waitFor(() => {
      // Both CATALOG_KEY and ADAPTERS_KEY invalidations trigger refetches (prefix match),
      // so catalog is fetched at least twice (initial + invalidation(s)).
      expect(vi.mocked(transport.getAdapterCatalog).mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});

describe('useRemoveAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls transport.removeRelayAdapter with id', async () => {
    const transport = createMockTransport({
      removeRelayAdapter: vi.fn().mockResolvedValue({ ok: true }),
    });

    const { result } = renderHook(() => useRemoveAdapter(), {
      wrapper: createWrapper(transport),
    });

    result.current.mutate('tg-main');

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(transport.removeRelayAdapter).toHaveBeenCalledWith('tg-main');
  });

  it('invalidates catalog and adapters queries on success', async () => {
    const transport = createMockTransport({
      getAdapterCatalog: vi.fn().mockResolvedValue([mockCatalogEntry]),
      removeRelayAdapter: vi.fn().mockResolvedValue({ ok: true }),
    });

    const wrapper = createWrapper(transport);

    const { result: catalogResult } = renderHook(() => useAdapterCatalog(), { wrapper });
    await waitFor(() => {
      expect(catalogResult.current.isSuccess).toBe(true);
    });

    const { result } = renderHook(() => useRemoveAdapter(), { wrapper });

    result.current.mutate('tg-main');

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    await waitFor(() => {
      expect(vi.mocked(transport.getAdapterCatalog).mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});

describe('useUpdateAdapterConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls transport.updateRelayAdapterConfig with id and config', async () => {
    const transport = createMockTransport({
      updateRelayAdapterConfig: vi.fn().mockResolvedValue({ ok: true }),
    });

    const { result } = renderHook(() => useUpdateAdapterConfig(), {
      wrapper: createWrapper(transport),
    });

    result.current.mutate({ id: 'tg-main', config: { token: 'new-token' } });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(transport.updateRelayAdapterConfig).toHaveBeenCalledWith('tg-main', { token: 'new-token' });
  });

  it('invalidates catalog and adapters queries on success', async () => {
    const transport = createMockTransport({
      getAdapterCatalog: vi.fn().mockResolvedValue([mockCatalogEntry]),
      updateRelayAdapterConfig: vi.fn().mockResolvedValue({ ok: true }),
    });

    const wrapper = createWrapper(transport);

    const { result: catalogResult } = renderHook(() => useAdapterCatalog(), { wrapper });
    await waitFor(() => {
      expect(catalogResult.current.isSuccess).toBe(true);
    });

    const { result } = renderHook(() => useUpdateAdapterConfig(), { wrapper });

    result.current.mutate({ id: 'tg-main', config: { token: 'new-token' } });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    await waitFor(() => {
      expect(vi.mocked(transport.getAdapterCatalog).mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});

describe('useTestAdapterConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls transport.testRelayAdapterConnection with type and config', async () => {
    const transport = createMockTransport({
      testRelayAdapterConnection: vi.fn().mockResolvedValue({ ok: true }),
    });

    const { result } = renderHook(() => useTestAdapterConnection(), {
      wrapper: createWrapper(transport),
    });

    result.current.mutate({ type: 'telegram', config: { token: 'test-token' } });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(transport.testRelayAdapterConnection).toHaveBeenCalledWith('telegram', { token: 'test-token' });
  });

  it('does NOT invalidate any queries on success', async () => {
    const transport = createMockTransport({
      getAdapterCatalog: vi.fn().mockResolvedValue([mockCatalogEntry]),
      testRelayAdapterConnection: vi.fn().mockResolvedValue({ ok: true }),
    });

    const wrapper = createWrapper(transport);

    // Prime the catalog cache
    const { result: catalogResult } = renderHook(() => useAdapterCatalog(), { wrapper });
    await waitFor(() => {
      expect(catalogResult.current.isSuccess).toBe(true);
    });

    const { result } = renderHook(() => useTestAdapterConnection(), { wrapper });

    result.current.mutate({ type: 'telegram', config: { token: 'test-token' } });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    // Catalog should NOT have been refetched — still only 1 call from initial load
    expect(transport.getAdapterCatalog).toHaveBeenCalledTimes(1);
  });
});
