/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

import type { ConnectionState } from '@dorkos/shared/types';

import type { SSEConnectionOptions } from '@/layers/shared/lib/transport/sse-connection';

// Capture the onStateChange callback so tests can invoke it
let capturedOnStateChange: ((state: ConnectionState, attempts: number) => void) | null = null;
let capturedEventHandlers: Record<string, (data: unknown) => void> = {};

const mockConnect = vi.fn();
const mockDisconnect = vi.fn();
const mockDestroy = vi.fn();
const mockEnableVisibilityOptimization = vi.fn();

vi.mock('@/layers/shared/lib/transport', () => ({
  SSEConnection: vi.fn().mockImplementation((_url: string, options: SSEConnectionOptions) => {
    capturedOnStateChange = options.onStateChange ?? null;
    capturedEventHandlers = options.eventHandlers ?? {};
    return {
      connect: mockConnect,
      disconnect: mockDisconnect,
      destroy: mockDestroy,
      enableVisibilityOptimization: mockEnableVisibilityOptimization,
    };
  }),
}));

// Import after mock is set up
import { useSSEConnection } from '../use-sse-connection';
import { SSEConnection } from '@/layers/shared/lib/transport';

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  capturedOnStateChange = null;
  capturedEventHandlers = {};
});

describe('useSSEConnection', () => {
  const defaultHandlers = { sync_update: vi.fn() };

  it('does not create a connection when url is null', () => {
    const { result } = renderHook(() => useSSEConnection(null, { eventHandlers: defaultHandlers }));

    expect(SSEConnection).not.toHaveBeenCalled();
    expect(result.current.connectionState).toBe('connected');
    expect(result.current.failedAttempts).toBe(0);
    expect(result.current.lastEventAt).toBeNull();
  });

  it('creates a connection and calls connect on mount', () => {
    renderHook(() => useSSEConnection('http://localhost/sse', { eventHandlers: defaultHandlers }));

    expect(SSEConnection).toHaveBeenCalledTimes(1);
    expect(SSEConnection).toHaveBeenCalledWith(
      'http://localhost/sse',
      expect.objectContaining({
        eventHandlers: expect.any(Object),
        onStateChange: expect.any(Function),
      })
    );
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it('enables visibility optimization by default', () => {
    renderHook(() => useSSEConnection('http://localhost/sse', { eventHandlers: defaultHandlers }));

    expect(mockEnableVisibilityOptimization).toHaveBeenCalledTimes(1);
  });

  it('does not enable visibility optimization when disabled', () => {
    renderHook(() =>
      useSSEConnection('http://localhost/sse', {
        eventHandlers: defaultHandlers,
        visibilityOptimization: false,
      })
    );

    expect(mockEnableVisibilityOptimization).not.toHaveBeenCalled();
  });

  it('destroys the connection on unmount', () => {
    const { unmount } = renderHook(() =>
      useSSEConnection('http://localhost/sse', { eventHandlers: defaultHandlers })
    );

    unmount();
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });

  it('destroys old connection and creates new one when URL changes', () => {
    const { rerender } = renderHook(
      ({ url }) => useSSEConnection(url, { eventHandlers: defaultHandlers }),
      { initialProps: { url: 'http://localhost/sse-1' as string | null } }
    );

    expect(SSEConnection).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenCalledTimes(1);

    rerender({ url: 'http://localhost/sse-2' });

    // Old connection destroyed, new one created
    expect(mockDestroy).toHaveBeenCalledTimes(1);
    expect(SSEConnection).toHaveBeenCalledTimes(2);
    expect(mockConnect).toHaveBeenCalledTimes(2);
  });

  it('cleans up when URL changes from valid to null', () => {
    const { rerender, result } = renderHook(
      ({ url }) => useSSEConnection(url, { eventHandlers: defaultHandlers }),
      { initialProps: { url: 'http://localhost/sse' as string | null } }
    );

    // Simulate the connection reporting a state change before we null the URL
    act(() => {
      capturedOnStateChange?.('connected', 0);
    });
    expect(result.current.connectionState).toBe('connected');

    rerender({ url: null });

    // Should destroy and reset — 'connected' means "no connection needed, nothing wrong"
    expect(mockDestroy).toHaveBeenCalledTimes(1);
    expect(result.current.connectionState).toBe('connected');
    expect(result.current.failedAttempts).toBe(0);
    expect(result.current.lastEventAt).toBeNull();
  });

  it('updates connectionState and failedAttempts when onStateChange fires', () => {
    const { result } = renderHook(() =>
      useSSEConnection('http://localhost/sse', { eventHandlers: defaultHandlers })
    );

    act(() => {
      capturedOnStateChange?.('connected', 0);
    });
    expect(result.current.connectionState).toBe('connected');
    expect(result.current.failedAttempts).toBe(0);

    act(() => {
      capturedOnStateChange?.('reconnecting', 2);
    });
    expect(result.current.connectionState).toBe('reconnecting');
    expect(result.current.failedAttempts).toBe(2);

    act(() => {
      capturedOnStateChange?.('disconnected', 5);
    });
    expect(result.current.connectionState).toBe('disconnected');
    expect(result.current.failedAttempts).toBe(5);
  });

  it('updates lastEventAt when a delegate event handler fires', () => {
    const handler = vi.fn();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1700000000000);

    const { result } = renderHook(() =>
      useSSEConnection('http://localhost/sse', {
        eventHandlers: { sync_update: handler },
      })
    );

    expect(result.current.lastEventAt).toBeNull();

    // Fire the delegate handler that SSEConnection received
    act(() => {
      capturedEventHandlers['sync_update']?.({ type: 'test' });
    });

    expect(result.current.lastEventAt).toBe(1700000000000);
    expect(handler).toHaveBeenCalledWith({ type: 'test' });

    nowSpy.mockRestore();
  });

  it('does not reconnect when eventHandlers identity changes', () => {
    type Props = { handlers: Record<string, (data: unknown) => void> };
    const { rerender } = renderHook<ReturnType<typeof useSSEConnection>, Props>(
      ({ handlers }) => useSSEConnection('http://localhost/sse', { eventHandlers: handlers }),
      { initialProps: { handlers: { sync_update: vi.fn() } } }
    );

    expect(SSEConnection).toHaveBeenCalledTimes(1);

    // Re-render with a new handler object (different identity, same shape)
    rerender({ handlers: { sync_update: vi.fn() } });

    // Should NOT recreate the connection — handlers are ref-stabilized
    expect(SSEConnection).toHaveBeenCalledTimes(1);
    expect(mockDestroy).not.toHaveBeenCalled();
  });

  it('uses latest handler via ref even after re-render', () => {
    const firstHandler = vi.fn();
    const secondHandler = vi.fn();

    type Props = { handlers: Record<string, (data: unknown) => void> };
    const { rerender } = renderHook<ReturnType<typeof useSSEConnection>, Props>(
      ({ handlers }) => useSSEConnection('http://localhost/sse', { eventHandlers: handlers }),
      { initialProps: { handlers: { sync_update: firstHandler } } }
    );

    // Re-render with new handler
    rerender({ handlers: { sync_update: secondHandler } });

    // Fire the delegate — it should call the LATEST handler via ref
    act(() => {
      capturedEventHandlers['sync_update']?.({ type: 'test' });
    });

    expect(secondHandler).toHaveBeenCalledWith({ type: 'test' });
    expect(firstHandler).not.toHaveBeenCalled();
  });

  it('passes heartbeatTimeoutMs to SSEConnection', () => {
    renderHook(() =>
      useSSEConnection('http://localhost/sse', {
        eventHandlers: defaultHandlers,
        heartbeatTimeoutMs: 10000,
      })
    );

    expect(SSEConnection).toHaveBeenCalledWith(
      'http://localhost/sse',
      expect.objectContaining({ heartbeatTimeoutMs: 10000 })
    );
  });

  it('recreates connection when heartbeatTimeoutMs changes', () => {
    const { rerender } = renderHook(
      ({ timeout }) =>
        useSSEConnection('http://localhost/sse', {
          eventHandlers: defaultHandlers,
          heartbeatTimeoutMs: timeout,
        }),
      { initialProps: { timeout: 10000 } }
    );

    expect(SSEConnection).toHaveBeenCalledTimes(1);

    rerender({ timeout: 20000 });

    expect(mockDestroy).toHaveBeenCalledTimes(1);
    expect(SSEConnection).toHaveBeenCalledTimes(2);
  });

  it('recreates connection when visibilityOptimization changes', () => {
    const { rerender } = renderHook(
      ({ vis }) =>
        useSSEConnection('http://localhost/sse', {
          eventHandlers: defaultHandlers,
          visibilityOptimization: vis,
        }),
      { initialProps: { vis: true } }
    );

    expect(SSEConnection).toHaveBeenCalledTimes(1);

    rerender({ vis: false });

    expect(mockDestroy).toHaveBeenCalledTimes(1);
    expect(SSEConnection).toHaveBeenCalledTimes(2);
    // Second call should NOT enable visibility optimization
    expect(mockEnableVisibilityOptimization).toHaveBeenCalledTimes(1);
  });
});
