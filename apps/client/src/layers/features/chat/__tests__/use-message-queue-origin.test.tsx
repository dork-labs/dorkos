/**
 * @vitest-environment jsdom
 *
 * DOR-81 wrong-session queue flush — the compose-next queue must be pinned to
 * the session it was composed in. A message queued in session A can never flush
 * into session B after a switch (or a phantom streaming→idle right after a
 * switch), and a message queued under a throwaway client UUID survives the
 * create-on-first-message rekey to the SDK-canonical id (DOR-74).
 *
 * Two test layers, mirroring the existing chat suites:
 *  - `useMessageQueue` driven directly with a mock `onFlush` + the per-session
 *    store, to assert origin-pinning, reset-on-switch, and the cross-session
 *    defense-in-depth (via `useSessionSubmit.submitContent`).
 *  - `useChatSession` end-to-end (mock Transport + stubbed streamManager) for
 *    the rekey-survival path.
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';

// Stub the shared StreamManager so attach/connect never opens a real fetch in
// jsdom; we drive the per-session store directly to simulate `/events`.
vi.mock('@/layers/shared/lib/transport', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/layers/shared/lib/transport');
  return {
    ...actual,
    streamManager: {
      connectList: vi.fn(),
      setListeners: vi.fn(),
      attachSession: vi.fn(),
      detachSession: vi.fn(),
      getAttachedSessionId: vi.fn().mockReturnValue(null),
      subscribeListConnectionState: vi.fn().mockReturnValue(() => {}),
    },
  };
});

vi.mock('@/layers/shared/model', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/layers/shared/model');
  const mockState = { selectedCwd: '/test/cwd', enableMessagePolling: false };
  const useAppStore = Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) =>
      selector ? selector(mockState) : mockState,
    { getState: () => mockState }
  );
  return { ...actual, useAppStore };
});

import { useMessageQueue } from '../model/use-message-queue';
import { useChatSession } from '../model/use-chat-session';
import type { ChatStatus } from '../model/chat-types';
import {
  useSessionStreamStore,
  useSessionChatStore,
  resetSessionStreamBinding,
} from '@/layers/entities/session';
import { TransportProvider } from '@/layers/shared/model';
import { resetUuidCounter } from './chat-session-test-helpers';

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

const baseQueueOptions = {
  status: 'idle' as ChatStatus,
  sessionBusy: false,
  selectedCwd: '/test/cwd',
};

beforeEach(() => {
  vi.clearAllMocks();
  resetUuidCounter();
  useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [] });
  useSessionChatStore.setState({ sessions: {}, sessionAccessOrder: [] });
  resetSessionStreamBinding();
});

describe('useMessageQueue — origin pinning (DOR-81 wrong-session queue flush)', () => {
  it('a message queued in A is NOT flushed by the streaming→idle edge in B; it stays pinned to A', () => {
    const onFlush = vi.fn();
    // Start mounted on session A, mid-stream.
    const { result, rerender } = renderHook(
      ({ sessionId, status }) =>
        useMessageQueue({ ...baseQueueOptions, sessionId, status, onFlush }),
      { initialProps: { sessionId: 'A', status: 'streaming' as ChatStatus } }
    );

    act(() => {
      result.current.addToQueue('message for A');
    });
    expect(useSessionStreamStore.getState().getSession('A').queuedMessages).toHaveLength(1);

    // Switch to session B WHILE A is still streaming. B then settles to idle —
    // a streaming→idle edge that must NOT flush A's queued message.
    rerender({ sessionId: 'B', status: 'streaming' as ChatStatus });
    rerender({ sessionId: 'B', status: 'idle' as ChatStatus });

    // No flush happened — the reset-on-switch tracker swallowed B's phantom edge,
    // and B's own queue is empty anyway.
    expect(onFlush).not.toHaveBeenCalled();
    // A's message is still pinned to A, untouched.
    expect(useSessionStreamStore.getState().getSession('A').queuedMessages).toHaveLength(1);
    expect(useSessionStreamStore.getState().getSession('A').queuedMessages[0]!.content).toBe(
      'message for A'
    );
  });

  it("A's queued message flushes to A — with A's origin id — when A next goes idle", () => {
    const onFlush = vi.fn();
    const { result, rerender } = renderHook(
      ({ status }) => useMessageQueue({ ...baseQueueOptions, sessionId: 'A', status, onFlush }),
      { initialProps: { status: 'streaming' as ChatStatus } }
    );

    act(() => {
      result.current.addToQueue('message for A');
    });

    rerender({ status: 'idle' as ChatStatus });

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith(expect.stringContaining('message for A'), 'A');
    // Flushed item was dequeued from A.
    expect(useSessionStreamStore.getState().getSession('A').queuedMessages).toHaveLength(0);
  });

  it('resets the streaming→idle tracker on session switch (phantom edge cannot flush)', () => {
    const onFlush = vi.fn();
    // Mounted on A, streaming, with a queued message.
    const { result, rerender } = renderHook(
      ({ sessionId, status }) =>
        useMessageQueue({ ...baseQueueOptions, sessionId, status, onFlush }),
      { initialProps: { sessionId: 'A', status: 'streaming' as ChatStatus } }
    );
    act(() => {
      result.current.addToQueue('queued in A');
    });

    // Move A's queue into B's slot manually to prove that even if B HAD a queued
    // item, the reset-on-switch prevents the very-next idle from flushing it
    // (the prevStatus tracker was reset to 'idle', so streaming→idle is not seen).
    act(() => {
      useSessionStreamStore.getState().enqueueMessage('B', 'queued in B');
    });

    rerender({ sessionId: 'B', status: 'idle' as ChatStatus });

    // The switch reset the tracker (prev was 'streaming' for A, now reset), so the
    // first idle on B is not treated as a streaming→idle edge.
    expect(onFlush).not.toHaveBeenCalled();
    expect(useSessionStreamStore.getState().getSession('B').queuedMessages).toHaveLength(1);
  });
});

describe('useSessionSubmit.submitContent — cross-session defense-in-depth (DOR-81)', () => {
  it('rejects (drops + logs) a queued message whose origin session != active session', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));
    const transport = createMockTransport({ postMessage });

    const { result } = renderHook(() => useChatSession('active-session'), {
      wrapper: createWrapper(transport),
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    // Flush a message whose origin is a DIFFERENT session than the active one.
    await act(async () => {
      result.current.submitContent('stale queued message', 'other-session');
    });

    // The submit path refused to deliver it — postMessage never fired.
    expect(postMessage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('other-session'));
    warn.mockRestore();
  });

  it('delivers a queued message whose origin matches the active session', async () => {
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));
    const transport = createMockTransport({ postMessage });

    const { result } = renderHook(() => useChatSession('active-session'), {
      wrapper: createWrapper(transport),
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    await act(async () => {
      result.current.submitContent('queued message', 'active-session');
    });

    expect(postMessage).toHaveBeenCalledWith(
      'active-session',
      'queued message',
      '/test/cwd',
      expect.any(Object)
    );
  });
});

describe('useChatSession — queued message survives the canonical-id rekey (DOR-81 / DOR-74)', () => {
  it('a message queued under the client UUID is moved to the canonical id, not lost', async () => {
    const postMessage = vi.fn().mockResolvedValue({ sessionId: 'sdk-canonical' });
    const transport = createMockTransport({ postMessage });
    const onSessionIdChangeReplace = vi.fn();

    const { result } = renderHook(
      () => useChatSession('client-uuid', { onSessionIdChangeReplace }),
      { wrapper: createWrapper(transport) }
    );
    await waitFor(() => expect(result.current.status).toBe('idle'));

    // Queue a message under the throwaway client UUID (as if composed during the
    // first turn, before the canonical id is known).
    act(() => {
      useSessionStreamStore.getState().enqueueMessage('client-uuid', 'follow-up');
    });

    // Trigger the first send → create-on-first-message rekey to 'sdk-canonical'.
    act(() => {
      result.current.setInput('First message');
    });
    await waitFor(() => expect(result.current.input).toBe('First message'));
    await act(async () => {
      await result.current.handleSubmit();
    });

    // URL rewritten to canonical id, and the queue MOVED to the canonical key.
    expect(onSessionIdChangeReplace).toHaveBeenCalledWith('sdk-canonical');
    const store = useSessionStreamStore.getState();
    expect(store.getSession('sdk-canonical').queuedMessages.map((m) => m.content)).toEqual([
      'follow-up',
    ]);
    // The throwaway client UUID no longer holds the queued message.
    expect(store.getSession('client-uuid').queuedMessages).toHaveLength(0);
  });
});
