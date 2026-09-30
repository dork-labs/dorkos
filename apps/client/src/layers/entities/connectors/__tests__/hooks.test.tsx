/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { ConnectorProviderStatus } from '@dorkos/shared/connector-provider';
import type { ConnectorAppConnections } from '@dorkos/shared/connector-resource-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import {
  useConnectorConnection,
  useConnectorAppConnections,
  useConnectorCatalog,
  useConnectorProviders,
  useSaveConnectorCredential,
  useDeleteConnectorCredential,
} from '../index';
import { PROVIDERS_RECHECK_POLL_MS } from '../model/use-connector-providers';

const providerStatus: ConnectorProviderStatus = {
  type: 'composio',
  providerInstanceId: 'cpi_composio' as ConnectorProviderStatus['providerInstanceId'],
  configured: false,
  registered: false,
  custody: 'managed',
  disclosure:
    "Composio stores your connected accounts' login access in its own secure vault, not on your computer.",
};

function createWrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return { queryClient, wrapper };
}

beforeEach(() => {
  vi.clearAllMocks();
});

const APP_CONNECTIONS: ConnectorAppConnections = {
  ways: [{ kind: 'own_key', type: 'composio', status: 'ready' }],
  newApps: {
    status: 'ready',
    way: { kind: 'own_key', type: 'composio', status: 'ready' },
  },
};

describe('useConnectorProviders', () => {
  it('reads the statuses again only while DorkOS has a key re-check scheduled', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const checking = {
        ...providerStatus,
        configured: true,
        error: 'DorkOS couldn’t check this key just now. It checks again on its own.',
        recheckAt: '2026-09-29T00:00:30.000Z',
      };
      const stopped = {
        ...providerStatus,
        configured: true,
        error:
          'DorkOS couldn’t check this key and has stopped trying on its own. Save it again to check it now.',
      };
      const transport = createMockTransport();
      vi.mocked(transport.getConnectorProviders)
        .mockResolvedValueOnce({ providers: [checking], appConnections: APP_CONNECTIONS })
        .mockResolvedValue({ providers: [stopped], appConnections: APP_CONNECTIONS });
      const { result } = renderHook(() => useConnectorProviders(), {
        wrapper: createWrapper(transport).wrapper,
      });
      await waitFor(() => expect(result.current.data?.[0]?.error).toBe(checking.error));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(PROVIDERS_RECHECK_POLL_MS);
      });
      await waitFor(() => expect(result.current.data?.[0]?.error).toBe(stopped.error));

      // Nothing is scheduled any more, so it stops reading.
      const calls = vi.mocked(transport.getConnectorProviders).mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PROVIDERS_RECHECK_POLL_MS * 3);
      });
      expect(vi.mocked(transport.getConnectorProviders).mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fetches provider statuses via transport.getConnectorProviders', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorProviders).mockResolvedValue({
      providers: [providerStatus],
      appConnections: APP_CONNECTIONS,
    });

    const { result } = renderHook(() => useConnectorProviders(), {
      wrapper: createWrapper(transport).wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([providerStatus]);
  });

  it('reads which way new apps use from the same response, in one request', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorProviders).mockResolvedValue({
      providers: [providerStatus],
      appConnections: APP_CONNECTIONS,
    });
    const { wrapper } = createWrapper(transport);

    const { result } = renderHook(
      () => ({ providers: useConnectorProviders(), apps: useConnectorAppConnections() }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.apps.isSuccess).toBe(true));
    expect(result.current.apps.data).toEqual(APP_CONNECTIONS);
    expect(result.current.providers.data).toEqual([providerStatus]);
    expect(transport.getConnectorProviders).toHaveBeenCalledTimes(1);
  });

  it('exposes error state on transport failure', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorProviders).mockRejectedValue(new Error('Server unreachable'));

    const { result } = renderHook(() => useConnectorProviders(), {
      wrapper: createWrapper(transport).wrapper,
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('Server unreachable');
  });
});

describe('useSaveConnectorCredential', () => {
  it('saves the key and sweeps the whole connector cache', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.putConnectorCredential).mockResolvedValue({
      ...providerStatus,
      configured: true,
      registered: true,
    });
    const { queryClient, wrapper } = createWrapper(transport);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useSaveConnectorCredential(), { wrapper });
    result.current.mutate({ provider: 'composio', secret: 'sk-test' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(transport.putConnectorCredential).toHaveBeenCalledWith('composio', 'sk-test');
    expect(result.current.data?.registered).toBe(true);
    // The whole domain prefix: a newly registered provider changes providers,
    // toolkits, accounts, AND cached recommendations (a stale recommendation
    // naming a gone provider would 404 the next Connect).
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['connectors'] });
  });
});

describe('useDeleteConnectorCredential', () => {
  it('deletes the key and refetches the provider scope', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.deleteConnectorCredential).mockResolvedValue(providerStatus);
    const { queryClient, wrapper } = createWrapper(transport);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useDeleteConnectorCredential(), { wrapper });
    result.current.mutate({ provider: 'composio' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(transport.deleteConnectorCredential).toHaveBeenCalledWith('composio');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['connectors'] });
  });
});

describe('useConnectorConnection', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A disconnected account's detail, carrying only the readiness reason the hook reads. */
  function detailWith(reason: 'disconnect_finishing' | 'disconnect_stuck' | 'disconnected') {
    return {
      connection: { lifecycle: 'disconnected', readiness: { state: 'gone', reason } },
    } as unknown as Awaited<ReturnType<Transport['getConnectorConnection']>>;
  }

  it('does not re-read a sign-out DorkOS can’t finish: nothing is retrying', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorConnection).mockResolvedValue(detailWith('disconnect_stuck'));
    const { wrapper } = createWrapper(transport);
    const { result } = renderHook(() => useConnectorConnection('c-1'), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    await vi.advanceTimersByTimeAsync(120_000);
    expect(transport.getConnectorConnection).toHaveBeenCalledTimes(1);
  });

  it('re-reads a disconnected account while DorkOS finishes its sign-out, and stops once it settles', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorConnection)
      .mockResolvedValueOnce(detailWith('disconnect_finishing'))
      .mockResolvedValueOnce(detailWith('disconnect_finishing'))
      .mockResolvedValue(detailWith('disconnected'));
    const { wrapper } = createWrapper(transport);
    const { result } = renderHook(() => useConnectorConnection('c-1'), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(transport.getConnectorConnection).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(14_000);
    expect(transport.getConnectorConnection).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await waitFor(() => expect(transport.getConnectorConnection).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(15_000);
    await waitFor(() =>
      expect(result.current.data?.connection.readiness.reason).toBe('disconnected')
    );
    expect(transport.getConnectorConnection).toHaveBeenCalledTimes(3);

    // Settled: no more reads, however long the panel stays open.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(transport.getConnectorConnection).toHaveBeenCalledTimes(3);
  });
});

describe('useConnectorCatalog', () => {
  const page = { services: [], warnings: [] };

  it('reuses a catalog page on the next mount instead of fetching it again', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorCatalog).mockResolvedValue(page);
    const { wrapper } = createWrapper(transport);

    const first = renderHook(() => useConnectorCatalog('gmail'), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    first.unmount();
    const second = renderHook(() => useConnectorCatalog('gmail'), { wrapper });
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));

    expect(transport.getConnectorCatalog).toHaveBeenCalledTimes(1);
  });

  it('asks again on the next mount when a page came back with a warning', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorCatalog).mockResolvedValue({
      services: [],
      warnings: [{ code: 'catalog_provider_unavailable', message: 'Composio is unavailable.' }],
    });
    const { wrapper } = createWrapper(transport);

    const first = renderHook(() => useConnectorCatalog('gmail'), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    first.unmount();
    const second = renderHook(() => useConnectorCatalog('gmail'), { wrapper });

    await waitFor(() => expect(transport.getConnectorCatalog).toHaveBeenCalledTimes(2));
    expect(second.result.current.isSuccess).toBe(true);
  });

  it('asks again on the next mount when only a later page carried a warning', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorCatalog)
      .mockResolvedValueOnce({ services: [], warnings: [], nextCursor: 'page-2' })
      .mockResolvedValue({
        services: [],
        warnings: [{ code: 'catalog_provider_unavailable', message: 'Composio is unavailable.' }],
      });
    const { wrapper } = createWrapper(transport);

    const first = renderHook(() => useConnectorCatalog(''), { wrapper });
    await waitFor(() => expect(first.result.current.hasNextPage).toBe(true));
    await act(async () => {
      await first.result.current.fetchNextPage();
    });
    await waitFor(() => expect(first.result.current.data?.pages).toHaveLength(2));
    expect(transport.getConnectorCatalog).toHaveBeenCalledTimes(2);
    first.unmount();
    renderHook(() => useConnectorCatalog(''), { wrapper });

    // An infinite query refetches every loaded page, starting from the first.
    await waitFor(() =>
      expect(vi.mocked(transport.getConnectorCatalog).mock.calls.length).toBeGreaterThan(2)
    );
  });

  it('fetches again once a saved key sweeps the connector scope', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorCatalog).mockResolvedValue(page);
    vi.mocked(transport.putConnectorCredential).mockResolvedValue({
      ...providerStatus,
      configured: true,
      registered: true,
    });
    const { wrapper } = createWrapper(transport);

    const catalog = renderHook(() => useConnectorCatalog(''), { wrapper });
    await waitFor(() => expect(catalog.result.current.isSuccess).toBe(true));
    const save = renderHook(() => useSaveConnectorCredential(), { wrapper });
    save.result.current.mutate({ provider: 'composio', secret: 'sk-test' });

    await waitFor(() => expect(transport.getConnectorCatalog).toHaveBeenCalledTimes(2));
  });
});
