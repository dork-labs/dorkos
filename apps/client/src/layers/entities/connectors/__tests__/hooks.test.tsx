/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type {
  ConnectorProviderStatus,
  PublicConnectedAccount,
  SessionConnectorAttachResult,
} from '@dorkos/shared/connector-provider';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import {
  useConnectorProviders,
  useConnectorToolkits,
  useConnectorAccounts,
  useDisconnectConnectorAccount,
  useSaveConnectorCredential,
  useDeleteConnectorCredential,
  useSessionConnectors,
  useAttachSessionConnector,
  useDetachSessionConnector,
} from '../index';

const providerStatus: ConnectorProviderStatus = {
  type: 'composio',
  configured: false,
  registered: false,
  custody: 'managed',
  disclosure:
    "Composio stores your connected accounts' login access in its own secure vault, not on your computer.",
};

const account: PublicConnectedAccount = {
  id: 'acct-1' as PublicConnectedAccount['id'],
  toolkit: 'gmail',
  label: 'work',
  status: 'active',
  custody: 'managed',
  disclosure: 'Connecting work takes you to that service to sign in.',
};

const attachResult: SessionConnectorAttachResult = {
  account: {
    accountId: 'acct-1' as PublicConnectedAccount['id'],
    toolkit: 'gmail',
    label: 'work',
    status: 'active',
    serverName: 'gmail-work',
    exposed: true,
  },
  disclosure: 'Connecting work takes you to that service to sign in.',
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

describe('useConnectorToolkits', () => {
  it('returns the aggregated toolkits with warnings', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorToolkits).mockResolvedValue({
      toolkits: [{ slug: 'gmail', displayName: 'Gmail', authKind: 'oauth2' }],
      warnings: [{ provider: 'nango', message: 'nango timed out after 5000ms' }],
    });

    const { result } = renderHook(() => useConnectorToolkits(), {
      wrapper: createWrapper(transport).wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.toolkits[0].slug).toBe('gmail');
    expect(result.current.data?.warnings).toHaveLength(1);
  });
});

describe('useConnectorAccounts', () => {
  it('passes the toolkit filter through to the transport', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorAccounts).mockResolvedValue({
      accounts: [account],
      warnings: [],
    });

    const { result } = renderHook(() => useConnectorAccounts('gmail'), {
      wrapper: createWrapper(transport).wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(transport.getConnectorAccounts).toHaveBeenCalledWith('gmail');
    expect(result.current.data?.accounts[0].label).toBe('work');
  });
});

describe('useSaveConnectorCredential', () => {
  it('saves the key and refetches providers, toolkits, and accounts', async () => {
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
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['connectors', 'providers'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['connectors', 'toolkits'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['connectors', 'accounts'] });
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
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['connectors', 'providers'] });
  });
});

describe('useDisconnectConnectorAccount', () => {
  it('disconnects and refetches accounts plus every session surface', async () => {
    const transport = createMockTransport();
    const { queryClient, wrapper } = createWrapper(transport);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useDisconnectConnectorAccount(), { wrapper });
    result.current.mutate({ accountId: 'acct-1' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(transport.disconnectConnectorAccount).toHaveBeenCalledWith('acct-1');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['connectors', 'accounts'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['connectors', 'session'] });
  });
});

describe('useSessionConnectors', () => {
  it('holds the query until a session id exists', () => {
    const transport = createMockTransport();
    renderHook(() => useSessionConnectors(null), {
      wrapper: createWrapper(transport).wrapper,
    });
    expect(transport.getSessionConnectors).not.toHaveBeenCalled();
  });

  it('fetches the session surface with warnings', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getSessionConnectors).mockResolvedValue({
      accounts: [attachResult.account],
      warnings: [{ accountId: attachResult.account.accountId, label: 'work', reason: 'expired' }],
    });

    const { result } = renderHook(() => useSessionConnectors('sess-1'), {
      wrapper: createWrapper(transport).wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(transport.getSessionConnectors).toHaveBeenCalledWith('sess-1');
    expect(result.current.data?.warnings[0].reason).toBe('expired');
  });
});

describe('useAttachSessionConnector', () => {
  it('attaches, returns the disclosure-carrying receipt, and refetches the session', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.attachSessionConnector).mockResolvedValue(attachResult);
    const { queryClient, wrapper } = createWrapper(transport);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useAttachSessionConnector(), { wrapper });
    result.current.mutate({ sessionId: 'sess-1', accountId: 'acct-1' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(transport.attachSessionConnector).toHaveBeenCalledWith('sess-1', 'acct-1');
    expect(result.current.data?.disclosure).toContain('sign in');
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['connectors', 'session', 'sess-1'],
    });
  });
});

describe('useDetachSessionConnector', () => {
  it('detaches and refetches the session surface', async () => {
    const transport = createMockTransport();
    const { queryClient, wrapper } = createWrapper(transport);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useDetachSessionConnector(), { wrapper });
    result.current.mutate({ sessionId: 'sess-1', accountId: 'acct-1' });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(transport.detachSessionConnector).toHaveBeenCalledWith('sess-1', 'acct-1');
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['connectors', 'session', 'sess-1'],
    });
  });
});
