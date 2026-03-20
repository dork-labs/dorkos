// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// Mock BroadcastChannel
vi.mock('@/layers/shared/lib', () => ({
  createChannel: vi.fn(() => ({
    postMessage: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    close: vi.fn(),
  })),
}));

// Mock EventSource
const mockEventSource = {
  addEventListener: vi.fn(),
  close: vi.fn(),
};

beforeAll(() => {
  // @ts-expect-error -- mock EventSource globally
  globalThis.EventSource = vi.fn(() => mockEventSource);
});

import { useTunnelSync, broadcastTunnelChange } from '../model/use-tunnel-sync';
import { createChannel } from '@/layers/shared/lib';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
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

  it('creates EventSource for SSE stream', () => {
    renderHook(() => useTunnelSync(), { wrapper: createWrapper() });

    expect(globalThis.EventSource).toHaveBeenCalledWith('/api/tunnel/stream');
  });

  it('cleans up on unmount', () => {
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
    expect(mockEventSource.close).toHaveBeenCalled();
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
