/**
 * @vitest-environment jsdom
 *
 * Subscribe-first hydration tests for `useChatSession` (spec
 * chat-stream-reconnection, Phase 3 / #9).
 *
 * Drives the per-session stream store directly (the mechanism the StreamManager
 * binding uses in production) and asserts the hook's server-derived render
 * fields — messages, status, pending interactions — reflect the hydrated
 * snapshot and subsequent live events, and that switching sessionId shows the
 * other session's hydrated state.
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { SessionSnapshot, SessionEvent } from '@dorkos/shared/session-stream';
import { TransportProvider } from '@/layers/shared/model';
import { useSessionChatStore, useSessionStreamStore } from '@/layers/entities/session';
import { useChatSession } from '../model/use-chat-session';
import { MockEventSource, resetUuidCounter } from './chat-session-test-helpers';

vi.mock('@/layers/shared/model', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/layers/shared/model');
  const mockState = {
    selectedCwd: '/test/cwd',
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

/** A cold snapshot with one completed exchange and hydrated context usage. */
function makeSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    messages: [
      { id: 'h1', role: 'user', content: 'Hi', timestamp: '2026-01-01T00:00:00Z' },
      { id: 'h2', role: 'assistant', content: 'Hello', timestamp: '2026-01-01T00:00:01Z' },
    ],
    inProgressTurn: null,
    status: {
      contextUsage: {
        totalTokens: 40_000,
        maxTokens: 200_000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      cost: 0.1,
      usage: null,
      cacheStats: null,
      model: 'claude-opus-4-6',
      permissionMode: 'default',
      todoCounts: null,
      runningSubagentCount: 0,
      lifecycle: 'idle',
      lastError: null,
    },
    pendingInteractions: [],
    cursor: 5,
    ...overrides,
  };
}

describe('useChatSession — hydration (Phase 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetUuidCounter();
    MockEventSource.instances = [];
    useSessionChatStore.setState({ sessions: {}, sessionAccessOrder: [] });
    useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [] });
  });

  it('renders messages and non-null status from a hydrated snapshot on cold mount', async () => {
    const transport = createMockTransport();
    const { result } = renderHook(() => useChatSession('s1'), {
      wrapper: createWrapper(transport),
    });

    act(() => {
      useSessionStreamStore.getState().applySnapshot('s1', makeSnapshot());
    });

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(2);
    });
    expect(result.current.messages.map((m) => m.content)).toEqual(['Hi', 'Hello']);
    // Context usage is hydrated on the stream store — non-null immediately.
    const streamStatus = useSessionStreamStore.getState().getSession('s1').status;
    expect(streamStatus?.contextUsage?.totalTokens).toBe(40_000);
    expect(result.current.status).toBe('idle');
  });

  it('updates rendered messages + status when a live event applies', async () => {
    const transport = createMockTransport();
    const { result } = renderHook(() => useChatSession('s1'), {
      wrapper: createWrapper(transport),
    });

    act(() => {
      useSessionStreamStore.getState().applySnapshot('s1', makeSnapshot());
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(2));

    const events: SessionEvent[] = [
      { seq: 6, type: 'turn_start' },
      {
        seq: 7,
        type: 'status_change',
        status: { lifecycle: 'streaming', permissionMode: 'default' },
      },
      { seq: 8, type: 'text_delta', text: 'Streaming reply' },
    ];
    act(() => {
      for (const event of events) useSessionStreamStore.getState().applyEvent('s1', event);
    });

    await waitFor(() => {
      expect(result.current.status).toBe('streaming');
    });
    expect(result.current.messages).toHaveLength(3);
    expect(result.current.messages[2].role).toBe('assistant');
    expect(result.current.messages[2].content).toBe('Streaming reply');
  });

  it('surfaces a recovered approval interaction from the snapshot in-progress turn', async () => {
    const transport = createMockTransport();
    const approval: SessionEvent = {
      seq: 4,
      type: 'approval_required',
      id: 'tc1',
      toolName: 'Bash',
      input: 'ls',
      startedAt: 1000,
      remainingMs: 20000,
      hasSuggestions: false,
    };
    const { result } = renderHook(() => useChatSession('s1'), {
      wrapper: createWrapper(transport),
    });

    act(() => {
      useSessionStreamStore
        .getState()
        .applySnapshot(
          's1',
          makeSnapshot({ inProgressTurn: [{ seq: 3, type: 'turn_start' }, approval] })
        );
    });

    await waitFor(() => {
      expect(result.current.pendingInteractions).toHaveLength(1);
    });
    expect(result.current.activeInteraction?.toolCallId).toBe('tc1');
    expect(result.current.waitingType).toBe('approval');
    expect(result.current.isWaitingForUser).toBe(true);
  });

  it('surfaces a recovered approval from snapshot pendingInteractions when the turn is gone', async () => {
    // Real failure mode: a session blocked after turn_end clears its
    // inProgressTurn, so the recoverable approval lives ONLY in
    // snapshot.pendingInteractions. The render path must still surface it (a
    // refreshed blocked session must show the Approve/Deny card — DOR-73 recovery).
    const transport = createMockTransport();
    const { result } = renderHook(() => useChatSession('s1'), {
      wrapper: createWrapper(transport),
    });

    act(() => {
      useSessionStreamStore.getState().applySnapshot(
        's1',
        makeSnapshot({
          inProgressTurn: null,
          status: {
            ...makeSnapshot().status,
            lifecycle: 'blocked',
          },
          pendingInteractions: [
            {
              type: 'approval',
              id: 'rec-1',
              startedAt: 1000,
              remainingMs: 20000,
              toolName: 'Bash',
              input: 'ls',
              hasSuggestions: false,
            },
          ],
        })
      );
    });

    await waitFor(() => {
      expect(result.current.pendingInteractions).toHaveLength(1);
    });
    expect(result.current.activeInteraction?.toolCallId).toBe('rec-1');
    expect(result.current.activeInteraction?.interactiveType).toBe('approval');
    expect(result.current.waitingType).toBe('approval');
    expect(result.current.isWaitingForUser).toBe(true);
    // The card renders on a trailing assistant bubble carrying the pending part.
    const carrier = result.current.messages.at(-1);
    expect(carrier?.role).toBe('assistant');
    expect(carrier?.toolCalls?.some((tc) => tc.toolCallId === 'rec-1')).toBe(true);
  });

  it('does not duplicate an interaction present in BOTH inProgressTurn and pendingInteractions', async () => {
    // Real failure mode: an interaction recovered into pendingInteractions AND
    // still live in the in-progress turn must render exactly once (dedup by id);
    // the turn's part wins (it has the live ordering).
    const transport = createMockTransport();
    const approvalEvent: SessionEvent = {
      seq: 4,
      type: 'approval_required',
      id: 'dup-1',
      toolName: 'Bash',
      input: 'ls',
      startedAt: 1000,
      remainingMs: 20000,
      hasSuggestions: false,
    };
    const { result } = renderHook(() => useChatSession('s1'), {
      wrapper: createWrapper(transport),
    });

    act(() => {
      useSessionStreamStore.getState().applySnapshot(
        's1',
        makeSnapshot({
          inProgressTurn: [{ seq: 3, type: 'turn_start' }, approvalEvent],
          status: { ...makeSnapshot().status, lifecycle: 'blocked' },
          pendingInteractions: [
            {
              type: 'approval',
              id: 'dup-1',
              startedAt: 1000,
              remainingMs: 20000,
              toolName: 'Bash',
              input: 'ls',
              hasSuggestions: false,
            },
          ],
        })
      );
    });

    await waitFor(() => {
      expect(result.current.pendingInteractions).toHaveLength(1);
    });
    expect(result.current.activeInteraction?.toolCallId).toBe('dup-1');
  });

  it('shows each session its own hydrated state across a sessionId switch', async () => {
    const transport = createMockTransport();
    act(() => {
      useSessionStreamStore.getState().applySnapshot('s1', makeSnapshot());
      useSessionStreamStore.getState().applySnapshot(
        's2',
        makeSnapshot({
          messages: [
            { id: 'b1', role: 'user', content: 'Other session', timestamp: '2026-01-02T00:00:00Z' },
          ],
        })
      );
    });

    const { result, rerender } = renderHook(({ id }: { id: string }) => useChatSession(id), {
      wrapper: createWrapper(transport),
      initialProps: { id: 's1' },
    });

    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    expect(result.current.messages[0].content).toBe('Hi');

    rerender({ id: 's2' });
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.messages[0].content).toBe('Other session');
  });
});
