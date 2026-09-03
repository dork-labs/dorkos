// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ServerConfig } from '@dorkos/shared/types';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';

// Partially mock @/layers/shared/lib — preserve all real exports, override createChannel only
vi.mock('@/layers/shared/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/lib')>();
  return {
    ...actual,
    createChannel: vi.fn(() => ({
      postMessage: vi.fn(),
      onMessage: vi.fn(() => () => {}),
      close: vi.fn(),
    })),
  };
});

// Mock useEventSubscription from the shared model barrel
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useEventSubscription: vi.fn(),
  };
});

import { useTunnelSync, broadcastTunnelChange } from '../model/use-tunnel-sync';
import { resetRemoteAccessStore, useRemoteAccessStore } from '../model/remote-access-store';
import { createChannel } from '@/layers/shared/lib';
import { useEventSubscription, TransportProvider } from '@/layers/shared/model';

beforeEach(() => {
  resetRemoteAccessStore();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** The tunnel block a config read answers with, or none at all. */
function createWrapper(tunnel?: Record<string, unknown>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const transport = createMockTransport({
    getConfig: vi.fn(() => Promise.resolve({ tunnel } as unknown as ServerConfig)),
  }) as Transport;
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('useTunnelSync', () => {
  it('subscribes to BroadcastChannel on mount', () => {
    const mockOnMessage = vi.fn(() => () => {});
    vi.mocked(createChannel).mockReturnValue({
      postMessage: vi.fn(),
      onMessage: mockOnMessage,
      close: vi.fn(),
    });

    renderHook(() => useTunnelSync(), { wrapper: createWrapper() });

    expect(createChannel).toHaveBeenCalledWith('dorkos-tunnel');
    expect(mockOnMessage).toHaveBeenCalled();
  });

  it('subscribes to tunnel_status via useEventSubscription', () => {
    renderHook(() => useTunnelSync(), { wrapper: createWrapper() });

    expect(useEventSubscription).toHaveBeenCalledWith('tunnel_status', expect.any(Function));
  });

  it('cleans up BroadcastChannel on unmount', () => {
    const mockClose = vi.fn();
    const mockUnsub = vi.fn();
    vi.mocked(createChannel).mockReturnValue({
      postMessage: vi.fn(),
      onMessage: vi.fn(() => mockUnsub),
      close: mockClose,
    });

    const { unmount } = renderHook(() => useTunnelSync(), { wrapper: createWrapper() });
    unmount();

    expect(mockUnsub).toHaveBeenCalled();
    expect(mockClose).toHaveBeenCalled();
  });

  it('reduces the server report into the shared store, so ⌘K can read it', async () => {
    // The shell's guarantee (DOR-1743). `useRemoteAccessSnapshot` has no query
    // of its own, so without this its answer would depend on whether some other
    // component happened to be mounted on the current route.
    renderHook(() => useTunnelSync(), {
      wrapper: createWrapper({
        connected: true,
        isRunning: true,
        url: 'https://abc.ngrok.app',
        tokenConfigured: true,
      }),
    });

    await waitFor(() => expect(useRemoteAccessStore.getState().state).toBe('connected'));
    expect(useRemoteAccessStore.getState().url).toBe('https://abc.ngrok.app');
    expect(useRemoteAccessStore.getState().tokenConfigured).toBe(true);
  });
});

describe('broadcastTunnelChange', () => {
  it('creates a channel, posts a message, and closes it', () => {
    const mockPost = vi.fn();
    const mockCloseChannel = vi.fn();
    vi.mocked(createChannel).mockReturnValue({
      postMessage: mockPost,
      onMessage: vi.fn(() => () => {}),
      close: mockCloseChannel,
    });

    broadcastTunnelChange();

    expect(createChannel).toHaveBeenCalledWith('dorkos-tunnel');
    expect(mockPost).toHaveBeenCalledWith({ type: 'tunnel_changed' });
    expect(mockCloseChannel).toHaveBeenCalled();
  });
});
