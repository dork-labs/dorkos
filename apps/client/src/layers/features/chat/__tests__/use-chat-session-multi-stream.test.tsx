/**
 * @vitest-environment jsdom
 *
 * Multi-session streaming acceptance tests.
 *
 * Verifies the Phase 1 integration between useChatSession and StreamManager:
 * - Two sessions can stream concurrently without interfering with each other
 * - Switching sessions does NOT abort the background stream
 * - stop() delegates to streamManager.abort(sessionId)
 * - streamManager.isStreaming() reflects the correct state per session
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useChatSession } from '../model/use-chat-session';
import { streamManager } from '../model/stream-manager';
import { useSessionChatStore } from '@/layers/entities/session';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { StreamEvent } from '@dorkos/shared/types';
import { MockEventSource, resetUuidCounter } from './chat-session-test-helpers';

// ---------------------------------------------------------------------------
// App store mock (required by useChatSession)
// ---------------------------------------------------------------------------

vi.mock('@/layers/shared/model', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/layers/shared/model');
  const mockState = {
    selectedCwd: '/test/cwd',
    enableCrossClientSync: false,
    enableMessagePolling: false,
  };
  const useAppStore = Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) =>
      selector ? selector(mockState) : mockState,
    { getState: () => mockState }
  );
  return {
    ...actual,
    useAppStore,
    useSSEConnection: () => ({
      connectionState: 'connected' as const,
      failedAttempts: 0,
      lastEventAt: null,
    }),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createWrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

/** Create a transport whose sendMessage blocks until resolve() is called. */
function createBlockingTransport(onEvent?: (type: string, data: unknown) => void) {
  let resolveStream!: () => void;
  let onEventCallback: ((event: StreamEvent) => void) | null = null;
  const sendMessage = vi.fn(
    (
      _sessionId: string,
      _content: string,
      cb: (event: StreamEvent) => void,
      signal?: AbortSignal
    ) => {
      onEventCallback = cb;
      return new Promise<void>((resolve, reject) => {
        resolveStream = resolve;
        signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    }
  );
  const transport = createMockTransport({ sendMessage });
  const fire = (events: StreamEvent[]) => {
    for (const e of events) {
      onEventCallback?.(e);
      onEvent?.(e.type, e.data);
    }
  };
  return { transport, resolve: () => resolveStream(), fire };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useChatSession — multi-session streaming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetUuidCounter();
    MockEventSource.instances = [];
    // Reset store and streamManager between tests
    useSessionChatStore.setState({ sessions: {}, sessionAccessOrder: [] });
    streamManager.abortAll();
  });

  it('two sessions stream concurrently without interfering', async () => {
    const { transport: t1, resolve: r1, fire: fire1 } = createBlockingTransport();
    const { transport: t2, resolve: r2, fire: fire2 } = createBlockingTransport();

    const { result: hook1 } = renderHook(() => useChatSession('session-a'), {
      wrapper: createWrapper(t1),
    });
    const { result: hook2 } = renderHook(() => useChatSession('session-b'), {
      wrapper: createWrapper(t2),
    });

    await waitFor(() => expect(hook1.current.status).toBe('idle'));
    await waitFor(() => expect(hook2.current.status).toBe('idle'));

    // Start streaming on session A
    act(() => {
      hook1.current.setInput('Hello from A');
    });
    act(() => {
      hook1.current.handleSubmit();
    });
    await waitFor(() => expect(hook1.current.status).toBe('streaming'));

    // Start streaming on session B concurrently
    act(() => {
      hook2.current.setInput('Hello from B');
    });
    act(() => {
      hook2.current.handleSubmit();
    });
    await waitFor(() => expect(hook2.current.status).toBe('streaming'));

    // Both sessions are active in the manager
    expect(streamManager.isStreaming('session-a')).toBe(true);
    expect(streamManager.isStreaming('session-b')).toBe(true);

    // Fire events on session A — should not affect session B
    act(() => {
      fire1([{ type: 'text_delta', data: { text: 'Reply A' } } as StreamEvent]);
    });

    // Session A gets the message, session B remains with only user message
    expect(hook1.current.messages.find((m) => m.role === 'assistant')?.content).toBe('Reply A');
    expect(hook2.current.messages.find((m) => m.role === 'assistant')).toBeUndefined();

    // Fire events on session B
    act(() => {
      fire2([{ type: 'text_delta', data: { text: 'Reply B' } } as StreamEvent]);
    });

    expect(hook2.current.messages.find((m) => m.role === 'assistant')?.content).toBe('Reply B');

    // Resolve both streams
    await act(async () => {
      r1();
    });
    await act(async () => {
      r2();
    });

    await waitFor(() => expect(hook1.current.status).toBe('idle'));
    await waitFor(() => expect(hook2.current.status).toBe('idle'));
  });

  it('switching sessions does NOT abort the background stream', async () => {
    const { transport, resolve } = createBlockingTransport();

    // Session A starts streaming
    const { result: hookA } = renderHook(() => useChatSession('session-a'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => expect(hookA.current.status).toBe('idle'));

    act(() => {
      hookA.current.setInput('A message');
    });
    act(() => {
      hookA.current.handleSubmit();
    });
    await waitFor(() => expect(hookA.current.status).toBe('streaming'));
    expect(streamManager.isStreaming('session-a')).toBe(true);

    // Render session B (simulates navigation — session A hook stays mounted)
    const { result: hookB } = renderHook(() => useChatSession('session-b'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => expect(hookB.current.status).toBe('idle'));

    // Session A stream must still be active — switching did NOT abort it
    expect(streamManager.isStreaming('session-a')).toBe(true);

    // Clean up
    await act(async () => {
      resolve();
    });
  });

  it('stop() delegates to streamManager.abort() and sets status to idle', async () => {
    const { transport } = createBlockingTransport();

    const { result } = renderHook(() => useChatSession('session-a'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => expect(result.current.status).toBe('idle'));

    act(() => {
      result.current.setInput('test');
    });
    act(() => {
      result.current.handleSubmit();
    });
    await waitFor(() => expect(result.current.status).toBe('streaming'));

    expect(streamManager.isStreaming('session-a')).toBe(true);

    await act(async () => {
      result.current.stop();
    });

    expect(result.current.status).toBe('idle');
    expect(streamManager.isStreaming('session-a')).toBe(false);
  });

  it('streamManager.isStreaming() tracks active sessions accurately', async () => {
    const { transport: t1, resolve: r1 } = createBlockingTransport();

    const { result } = renderHook(() => useChatSession('session-a'), {
      wrapper: createWrapper(t1),
    });

    await waitFor(() => expect(result.current.status).toBe('idle'));

    expect(streamManager.isStreaming('session-a')).toBe(false);

    act(() => {
      result.current.setInput('ping');
    });
    act(() => {
      result.current.handleSubmit();
    });
    await waitFor(() => expect(result.current.status).toBe('streaming'));

    expect(streamManager.isStreaming('session-a')).toBe(true);

    await act(async () => {
      r1();
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    expect(streamManager.isStreaming('session-a')).toBe(false);
  });

  it('initSession is called when sessionId changes', async () => {
    const initSpy = vi.spyOn(useSessionChatStore.getState(), 'initSession');
    const transport = createMockTransport();

    const { rerender } = renderHook(({ sid }: { sid: string }) => useChatSession(sid), {
      wrapper: createWrapper(transport),
      initialProps: { sid: 'session-x' },
    });

    await waitFor(() => expect(initSpy).toHaveBeenCalledWith('session-x'));

    rerender({ sid: 'session-y' });

    await waitFor(() => expect(initSpy).toHaveBeenCalledWith('session-y'));

    initSpy.mockRestore();
  });
});
