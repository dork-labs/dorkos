/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { PublicConnectedAccount } from '@dorkos/shared/connector-provider';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useConnectFlow } from '../index';

const startResponse = {
  flowId: 'flow-1',
  authorizeUrl: 'https://vendor.example/authorize/gmail',
  disclosure:
    'Connecting gmail takes you to that service to sign in. Composio stores your connected ' +
    "accounts' login access in its own secure vault, not on your computer.",
};

const connectedAccount: PublicConnectedAccount = {
  id: 'acct-1' as PublicConnectedAccount['id'],
  toolkit: 'gmail',
  label: 'work',
  status: 'active',
  custody: 'managed',
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

describe('useConnectFlow', () => {
  it('starts idle with no URL and no disclosure', () => {
    const transport = createMockTransport();
    const { result } = renderHook(() => useConnectFlow(), {
      wrapper: createWrapper(transport).wrapper,
    });
    expect(result.current.state.step).toBe('idle');
    expect(result.current.state.authorizeUrl).toBeNull();
    expect(result.current.state.disclosure).toBeNull();
  });

  it('surfaces the disclosure WITH the auth URL and does not poll until the person opens it', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.startConnectorFlow).mockResolvedValue(startResponse);

    const { result } = renderHook(() => useConnectFlow(), {
      wrapper: createWrapper(transport).wrapper,
    });

    act(() => {
      result.current.start({ provider: 'composio', toolkit: 'gmail', label: 'work' });
    });

    await waitFor(() => expect(result.current.state.step).toBe('disclosure'));
    // The consent ordering invariant: when the URL first exists, the
    // server-composed disclosure is already on the state beside it — a UI
    // rendering this step shows the sentence with (never after) the link.
    expect(result.current.state.disclosure).toBe(startResponse.disclosure);
    expect(result.current.state.authorizeUrl).toBe(startResponse.authorizeUrl);
    expect(transport.startConnectorFlow).toHaveBeenCalledWith('composio', {
      toolkit: 'gmail',
      label: 'work',
    });
    // Polling must not begin while the person is still reading the disclosure.
    expect(transport.pollConnectorFlow).not.toHaveBeenCalled();
  });

  it('polls after authOpened and lands on connected with the new account', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.startConnectorFlow).mockResolvedValue(startResponse);
    vi.mocked(transport.pollConnectorFlow).mockResolvedValue({
      status: 'connected',
      account: connectedAccount,
    });
    const { queryClient, wrapper } = createWrapper(transport);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useConnectFlow(), { wrapper });

    act(() => {
      result.current.start({ provider: 'composio', toolkit: 'gmail' });
    });
    await waitFor(() => expect(result.current.state.step).toBe('disclosure'));

    act(() => {
      result.current.authOpened();
    });

    await waitFor(() => expect(result.current.state.step).toBe('connected'));
    expect(transport.pollConnectorFlow).toHaveBeenCalledWith('flow-1');
    expect(result.current.state.account).toEqual(connectedAccount);
    // The new account appears without a reload.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['connectors', 'accounts'] });
  });

  it('lands on failed with the server error when the flow fails', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.startConnectorFlow).mockResolvedValue(startResponse);
    vi.mocked(transport.pollConnectorFlow).mockResolvedValue({
      status: 'failed',
      error: 'The vendor rejected the connection.',
    });

    const { result } = renderHook(() => useConnectFlow(), {
      wrapper: createWrapper(transport).wrapper,
    });

    act(() => {
      result.current.start({ provider: 'composio', toolkit: 'gmail' });
    });
    await waitFor(() => expect(result.current.state.step).toBe('disclosure'));
    act(() => {
      result.current.authOpened();
    });

    await waitFor(() => expect(result.current.state.step).toBe('failed'));
    expect(result.current.state.error).toBe('The vendor rejected the connection.');
  });

  it('fails the flow when the start request is rejected', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.startConnectorFlow).mockRejectedValue(new Error("Unknown toolkit 'gmial'"));

    const { result } = renderHook(() => useConnectFlow(), {
      wrapper: createWrapper(transport).wrapper,
    });

    act(() => {
      result.current.start({ provider: 'composio', toolkit: 'gmial' });
    });

    await waitFor(() => expect(result.current.state.step).toBe('failed'));
    expect(result.current.state.error).toBe("Unknown toolkit 'gmial'");
    expect(result.current.state.authorizeUrl).toBeNull();
  });

  it('authOpened is a no-op outside the disclosure step', () => {
    const transport = createMockTransport();
    const { result } = renderHook(() => useConnectFlow(), {
      wrapper: createWrapper(transport).wrapper,
    });
    act(() => {
      result.current.authOpened();
    });
    expect(result.current.state.step).toBe('idle');
    expect(transport.pollConnectorFlow).not.toHaveBeenCalled();
  });

  it('reset returns the machine to idle', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.startConnectorFlow).mockResolvedValue(startResponse);

    const { result } = renderHook(() => useConnectFlow(), {
      wrapper: createWrapper(transport).wrapper,
    });
    act(() => {
      result.current.start({ provider: 'composio', toolkit: 'gmail' });
    });
    await waitFor(() => expect(result.current.state.step).toBe('disclosure'));

    act(() => {
      result.current.reset();
    });
    expect(result.current.state).toMatchObject({
      step: 'idle',
      authorizeUrl: null,
      disclosure: null,
      account: null,
      error: null,
    });
  });
});
