/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { ConnectorProviderStatus } from '@dorkos/shared/connector-provider';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import {
  useConnectorProviders,
  useSaveConnectorCredential,
  useDeleteConnectorCredential,
} from '../index';

const providerStatus: ConnectorProviderStatus = {
  type: 'composio',
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

describe('useConnectorProviders', () => {
  it('fetches provider statuses via transport.getConnectorProviders', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorProviders).mockResolvedValue([providerStatus]);

    const { result } = renderHook(() => useConnectorProviders(), {
      wrapper: createWrapper(transport).wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([providerStatus]);
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
