/**
 * @vitest-environment jsdom
 *
 * Send → display → persist tests for the trigger-only POST contract
 * (spec chat-stream-reconnection, Phase 5 / DOR-74).
 *
 * Drives `useChatSession` with a mock Transport and a stubbed shared
 * `streamManager`, simulating `/events` by writing the per-session stream store
 * directly. Asserts: the optimistic user message renders immediately on submit;
 * `postMessage` is called; a canonical-id rekey re-attaches the durable stream,
 * rewrites the URL exactly once (replace), and migrates the optimistic message;
 * and the turn_end reconcile reloads canonical history while clearing the
 * optimistic message.
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { SessionEvent, SessionSnapshot, SessionStatus } from '@dorkos/shared/session-stream';

// Stub the shared StreamManager so attach/connect never opens a real fetch in
// jsdom; the binding stays real (wires listeners) but we drive the store
// directly to simulate `/events`. Preserve the module's other transport exports
// (HttpTransport, SSEConnection) so `@/layers/shared/lib` re-exports still load.
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

import { useChatSession } from '../model/use-chat-session';
import {
  useSessionChatStore,
  useSessionListStore,
  useSessionStreamStore,
} from '@/layers/entities/session';
import { resetSessionStreamBinding } from '@/layers/entities/session';
import { TIMING } from '@/layers/shared/lib';
import { streamManager } from '@/layers/shared/lib/transport';
import { TransportProvider } from '@/layers/shared/model';
import { resetUuidCounter } from './chat-session-test-helpers';

const attachSession = vi.mocked(streamManager.attachSession);

function createWrapper(transport: Transport, queryClient?: QueryClient) {
  const client =
    queryClient ??
    new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

/** A status_change event flipping lifecycle (drives the settle transition). */
function statusChange(seq: number, lifecycle: 'streaming' | 'idle'): SessionEvent {
  return { seq, type: 'status_change', status: { lifecycle, permissionMode: 'default' } };
}

/** A cold-connect snapshot carrying the given lifecycle (CLI-B9 tests). */
function snapshotWith(lifecycle: SessionStatus['lifecycle'], cursor: number): SessionSnapshot {
  return {
    messages: [],
    inProgressTurn: null,
    status: {
      contextUsage: null,
      cost: null,
      usage: null,
      cacheStats: null,
      model: null,
      permissionMode: 'default',
      todoCounts: null,
      runningSubagentCount: 0,
      lifecycle,
      lastError: null,
    },
    pendingInteractions: [],
    cursor,
  };
}

describe('useChatSession — send (trigger-only POST → /events)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetUuidCounter();
    useSessionChatStore.setState({ sessions: {}, sessionAccessOrder: [] });
    useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [] });
    useSessionListStore.setState({
      sessions: {},
      statuses: {},
      statusCwds: {},
      unseen: {},
      rekeys: {},
    });
    resetSessionStreamBinding();
  });

  it('DOR-74 dual-id elimination + restore send: calls postMessage and renders the optimistic user message immediately', async () => {
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));
    const transport = createMockTransport({ postMessage });

    const { result } = renderHook(() => useChatSession('s1'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => expect(result.current.status).toBe('idle'));

    act(() => {
      result.current.setInput('Hello');
    });
    await waitFor(() => expect(result.current.input).toBe('Hello'));
    await act(async () => {
      await result.current.handleSubmit();
    });

    // postMessage was triggered for the target session.
    expect(postMessage).toHaveBeenCalledWith('s1', 'Hello', '/test/cwd', expect.any(Object));
    // The optimistic user message renders immediately (no snapshot, no /events yet).
    await waitFor(() => {
      expect(result.current.messages.some((m) => m.content === 'Hello' && m.role === 'user')).toBe(
        true
      );
    });
    // The durable stream is attached to the target session before/around the POST,
    // scoped to the session's cwd so the snapshot resolves the correct JSONL project.
    expect(attachSession).toHaveBeenCalledWith('s1', '/test/cwd');
    // Input cleared.
    expect(result.current.input).toBe('');
  });

  it('DOR-74 dual-id elimination + restore send: on a different canonical id, re-attaches and rewrites the URL exactly once (replace)', async () => {
    const postMessage = vi.fn().mockResolvedValue({ sessionId: 'sdk-canonical' });
    const transport = createMockTransport({ postMessage });
    const onSessionIdChangeReplace = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    const { result } = renderHook(
      () => useChatSession('client-uuid', { onSessionIdChangeReplace }),
      { wrapper: createWrapper(transport, queryClient) }
    );

    await waitFor(() => expect(result.current.status).toBe('idle'));

    act(() => {
      result.current.setInput('First message');
    });
    await waitFor(() => expect(result.current.input).toBe('First message'));
    await act(async () => {
      await result.current.handleSubmit();
    });

    // URL rewritten to the canonical id exactly once, in place.
    expect(onSessionIdChangeReplace).toHaveBeenCalledTimes(1);
    expect(onSessionIdChangeReplace).toHaveBeenCalledWith('sdk-canonical');
    // Durable stream re-attached to the canonical id (same cwd).
    expect(attachSession).toHaveBeenCalledWith('sdk-canonical', '/test/cwd');
    // Optimistic message moved to the canonical key; cleared on the old key.
    const store = useSessionStreamStore.getState();
    expect(store.getSession('sdk-canonical').optimisticUserMessage?.content).toBe('First message');
    expect(store.getSession('client-uuid').optimisticUserMessage).toBeNull();
    // Sidebar cache: the canonical row replaced the client-UUID row — no ghost
    // duplicate entry pointing at the dead id (nothing refetches it away now
    // that the sessions poll is gone).
    const sessions = queryClient.getQueryData<{ id: string }[]>(['sessions', '/test/cwd']) ?? [];
    expect(sessions.some((s) => s.id === 'sdk-canonical')).toBe(true);
    expect(sessions.some((s) => s.id === 'client-uuid')).toBe(false);
  });

  it('on a SESSION_LOCKED error, drops the optimistic message and restores input', async () => {
    const lockError = Object.assign(new Error('Session locked'), { code: 'SESSION_LOCKED' });
    const postMessage = vi.fn().mockRejectedValue(lockError);
    const transport = createMockTransport({ postMessage });

    const { result } = renderHook(() => useChatSession('s1'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => expect(result.current.status).toBe('idle'));

    act(() => {
      result.current.setInput('Hello');
    });
    await waitFor(() => expect(result.current.input).toBe('Hello'));
    await act(async () => {
      await result.current.handleSubmit();
    });

    // Input restored, optimistic message cleared, session marked busy.
    await waitFor(() => expect(result.current.input).toBe('Hello'));
    expect(useSessionStreamStore.getState().getSession('s1').optimisticUserMessage).toBeNull();
    expect(result.current.sessionBusy).toBe(true);
  });

  it('reconciles on turn_end: reloads canonical history and clears the optimistic message', async () => {
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));
    // History reload returns the now-persisted user + assistant turn.
    const getMessages = vi.fn().mockResolvedValue({
      messages: [
        { id: 'u1', role: 'user', content: 'Hello', timestamp: '2026-01-01T00:00:00Z' },
        { id: 'a1', role: 'assistant', content: 'Hi there', timestamp: '2026-01-01T00:00:01Z' },
      ],
    });
    const transport = createMockTransport({ postMessage, getMessages });

    const { result } = renderHook(() => useChatSession('s1'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => expect(result.current.status).toBe('idle'));

    act(() => {
      result.current.setInput('Hello');
    });
    await waitFor(() => expect(result.current.input).toBe('Hello'));
    await act(async () => {
      await result.current.handleSubmit();
    });

    // Simulate the live turn over /events: stream starts, then settles.
    act(() => {
      const store = useSessionStreamStore.getState();
      store.applyEvent('s1', { seq: 1, type: 'turn_start' });
      store.applyEvent('s1', statusChange(2, 'streaming'));
    });
    await waitFor(() => expect(result.current.status).toBe('streaming'));

    // Clear the getMessages calls made during initial mount so we assert the
    // reconcile reload specifically.
    getMessages.mockClear();

    // Real server event shape: the success path ends with `turn_end` and NO
    // trailing `status_change` carrying `lifecycle` (the normalizer emits none).
    // The client must settle the lifecycle to idle FROM `turn_end` itself.
    act(() => {
      const store = useSessionStreamStore.getState();
      store.applyEvent('s1', { seq: 3, type: 'text_delta', text: 'Hi there' });
      store.applyEvent('s1', { seq: 4, type: 'turn_end' });
    });

    // turn_end alone settles the session to idle — otherwise the user could never
    // send a second message and the reconcile would never fire (regression guard).
    await waitFor(() => expect(result.current.status).toBe('idle'));

    // turn_end reconcile reloads history and folds it into the stream store.
    await waitFor(() => expect(getMessages).toHaveBeenCalledWith('s1', '/test/cwd'));
    await waitFor(() => {
      const store = useSessionStreamStore.getState().getSession('s1');
      expect(store.messages.map((m) => m.content)).toEqual(['Hello', 'Hi there']);
      expect(store.optimisticUserMessage).toBeNull();
    });
    // No duplicate render: the reloaded history replaces the in-progress turn, so
    // BOTH the user message and the assistant reply appear exactly once (the
    // trailing in-progress bubble was cleared on reconcile).
    expect(result.current.messages.filter((m) => m.content === 'Hello')).toHaveLength(1);
    expect(result.current.messages.filter((m) => m.content === 'Hi there')).toHaveLength(1);
  });

  it('reconcile does not clobber a newer queued send (DOR-81 flush race): keeps its optimistic message and the new turn', async () => {
    // Real failure mode: the queue auto-flush fires on the SAME settle edge as
    // the reconcile, so by the time the history reload resolves, a NEW optimistic
    // message is set and the next turn may already be streaming. The stale reload
    // must not clear that message nor wipe the new turn's events.
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));
    let resolveReload!: (value: { messages: unknown[] }) => void;
    const getMessages = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveReload = resolve;
        })
    );
    const transport = createMockTransport({ postMessage, getMessages });

    const { result } = renderHook(() => useChatSession('s1'), {
      wrapper: createWrapper(transport),
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    act(() => {
      result.current.setInput('Hello');
    });
    await waitFor(() => expect(result.current.input).toBe('Hello'));
    await act(async () => {
      await result.current.handleSubmit();
    });

    // Turn 1 streams, then settles via turn_end — the reconcile dispatches a
    // (deliberately unresolved) history reload.
    act(() => {
      const store = useSessionStreamStore.getState();
      store.applyEvent('s1', { seq: 1, type: 'turn_start' });
      store.applyEvent('s1', statusChange(2, 'streaming'));
    });
    await waitFor(() => expect(result.current.status).toBe('streaming'));
    getMessages.mockClear();
    act(() => {
      const store = useSessionStreamStore.getState();
      store.applyEvent('s1', { seq: 3, type: 'text_delta', text: 'Hi there' });
      store.applyEvent('s1', { seq: 4, type: 'turn_end' });
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    await waitFor(() => expect(getMessages).toHaveBeenCalledWith('s1', '/test/cwd'));

    // While the reload is in flight: the queue flush sets a NEW optimistic
    // message and turn 2 starts streaming.
    act(() => {
      const store = useSessionStreamStore.getState();
      store.setOptimisticUserMessage('s1', { id: 'opt-queued', content: 'Queued message' });
      store.applyEvent('s1', { seq: 5, type: 'turn_start' });
      store.applyEvent('s1', { seq: 6, type: 'text_delta', text: 'Second reply' });
    });
    await waitFor(() => expect(result.current.status).toBe('streaming'));

    // The stale turn-1 reload resolves now.
    await act(async () => {
      resolveReload({
        messages: [
          { id: 'u1', role: 'user', content: 'Hello', timestamp: '2026-01-01T00:00:00Z' },
          { id: 'a1', role: 'assistant', content: 'Hi there', timestamp: '2026-01-01T00:00:01Z' },
        ],
      });
    });

    await waitFor(() => {
      const session = useSessionStreamStore.getState().getSession('s1');
      // History folded in…
      expect(session.messages.map((m) => m.content)).toEqual(['Hello', 'Hi there']);
      // …but the queued send's optimistic message and turn 2's events survive.
      expect(session.optimisticUserMessage).toEqual({
        id: 'opt-queued',
        content: 'Queued message',
      });
      expect(session.inProgressTurn.map((e) => e.type)).toEqual(['turn_start', 'text_delta']);
    });
    // Everything renders: turn 1 (history), the queued message, turn 2's reply.
    expect(result.current.messages.filter((m) => m.content === 'Queued message')).toHaveLength(1);
    expect(result.current.messages.filter((m) => m.content === 'Second reply')).toHaveLength(1);
  });

  it('passes the launch runtime hint on the session-creating first send only (DOR-180)', async () => {
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));
    const transport = createMockTransport({ postMessage });
    // Default gcTime (not 0): the sessions list cache must survive between the
    // two sends, as it does in the real app where the sidebar observes it.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { result } = renderHook(() => useChatSession('s1', { launchRuntime: 'opencode' }), {
      wrapper: createWrapper(transport, queryClient),
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    act(() => {
      result.current.setInput('Hello');
    });
    await waitFor(() => expect(result.current.input).toBe('Hello'));
    await act(async () => {
      await result.current.handleSubmit();
    });

    // First (session-creating) send carries the hint.
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][3]).toMatchObject({ runtime: 'opencode' });
    // The optimistic sidebar row is seeded with the SELECTED runtime, not a
    // hardcoded placeholder.
    const sessions = queryClient.getQueryData<{ id: string; runtime: string }[]>([
      'sessions',
      '/test/cwd',
    ]);
    expect(sessions?.find((s) => s.id === 's1')?.runtime).toBe('opencode');

    // Settle the turn so a second send is allowed.
    act(() => {
      const store = useSessionStreamStore.getState();
      store.applyEvent('s1', { seq: 1, type: 'turn_start' });
      store.applyEvent('s1', { seq: 2, type: 'turn_end' });
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    act(() => {
      result.current.setInput('Second');
    });
    await waitFor(() => expect(result.current.input).toBe('Second'));
    await act(async () => {
      await result.current.handleSubmit();
    });

    // Subsequent sends must NOT resend the hint (persistSessionRuntime is
    // first-write-wins server-side; resending is harmless but noise).
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage.mock.calls[1][3]).not.toHaveProperty('runtime');
  });

  it('omits the runtime hint when no launch runtime is selected', async () => {
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));
    const transport = createMockTransport({ postMessage });

    const { result } = renderHook(() => useChatSession('s1'), {
      wrapper: createWrapper(transport),
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    act(() => {
      result.current.setInput('Hello');
    });
    await waitFor(() => expect(result.current.input).toBe('Hello'));
    await act(async () => {
      await result.current.handleSubmit();
    });

    // No explicit selection → no hint, so the server's own resolution
    // (agent manifest, then default) stays in charge.
    expect(postMessage.mock.calls[0][3]).not.toHaveProperty('runtime');
  });

  it('seeds the optimistic session row with the server default runtime when none is selected', async () => {
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));
    const getCapabilities = vi.fn().mockResolvedValue({
      capabilities: {},
      defaultRuntime: 'opencode',
    });
    const transport = createMockTransport({ postMessage, getCapabilities });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    const { result } = renderHook(() => useChatSession('s1'), {
      wrapper: createWrapper(transport, queryClient),
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    // Wait for the capabilities query so the default runtime is known.
    await waitFor(() =>
      expect(queryClient.getQueryData(['capabilities'])).toMatchObject({
        defaultRuntime: 'opencode',
      })
    );

    act(() => {
      result.current.setInput('Hello');
    });
    await waitFor(() => expect(result.current.input).toBe('Hello'));
    await act(async () => {
      await result.current.handleSubmit();
    });

    const sessions = queryClient.getQueryData<{ id: string; runtime: string }[]>([
      'sessions',
      '/test/cwd',
    ]);
    expect(sessions?.find((s) => s.id === 's1')?.runtime).toBe('opencode');
    // Default alone is NOT an explicit selection — still no hint on the wire.
    expect(postMessage.mock.calls[0][3]).not.toHaveProperty('runtime');
  });

  it('stop() interrupts the session', async () => {
    const interruptSession = vi.fn().mockResolvedValue({ ok: true });
    const transport = createMockTransport({ interruptSession });

    const { result } = renderHook(() => useChatSession('s1'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => expect(result.current.status).toBe('idle'));

    act(() => {
      result.current.stop();
    });

    expect(interruptSession).toHaveBeenCalledWith('s1');
  });

  it('holds status at streaming through the trigger round-trip (CLI-B7 double-submit window)', async () => {
    // Real failure mode: POST is a 202 trigger, so the lifecycle still says
    // idle for a full RTT + turn spin-up after Enter — a second Enter in that
    // window double-submitted instead of queueing.
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));
    const transport = createMockTransport({ postMessage });

    const { result } = renderHook(() => useChatSession('s1'), {
      wrapper: createWrapper(transport),
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    act(() => {
      result.current.setInput('Hello');
    });
    await waitFor(() => expect(result.current.input).toBe('Hello'));
    await act(async () => {
      await result.current.handleSubmit();
    });

    // POST resolved, but no server frame has arrived — the latch must already
    // read as streaming (the composer's queue path keys off this).
    expect(result.current.status).toBe('streaming');

    // turn_start hands over to the genuine server lifecycle seamlessly.
    act(() => {
      const store = useSessionStreamStore.getState();
      store.applyEvent('s1', { seq: 1, type: 'turn_start' });
      store.applyEvent('s1', statusChange(2, 'streaming'));
    });
    expect(result.current.status).toBe('streaming');
    expect(useSessionStreamStore.getState().getSession('s1').triggerPending).toBe(false);
  });

  it('releases the trigger latch when the POST fails', async () => {
    const postMessage = vi.fn().mockRejectedValue(new Error('boom'));
    const transport = createMockTransport({ postMessage });

    const { result } = renderHook(() => useChatSession('s1'), {
      wrapper: createWrapper(transport),
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    act(() => {
      result.current.setInput('Hello');
    });
    await waitFor(() => expect(result.current.input).toBe('Hello'));
    await act(async () => {
      await result.current.handleSubmit();
    });

    // Failed trigger: latch released so the user can retry immediately.
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.error?.retryable).toBe(true);
  });

  it('the trigger watchdog follows a post-202 rekey and clears the MIGRATED latch', async () => {
    // Real failure mode (NF-2 review follow-up): the 202 returns the request
    // UUID (the common Claude path), so the watchdog latches that id — but the
    // retire announce then migrates the latch to the canonical id. A watchdog
    // still watching the retired id would never clear a latch whose turn died
    // without delivering canonical-id events, wedging the composer in queue
    // mode until a refresh.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const postMessage = vi
        .fn()
        .mockImplementation((sessionId: string) => Promise.resolve({ sessionId })); // identity 202
      const transport = createMockTransport({ postMessage });

      const { result } = renderHook(() => useChatSession('request-uuid'), {
        wrapper: createWrapper(transport),
      });
      await waitFor(() => expect(result.current.status).toBe('idle'));

      act(() => {
        result.current.setInput('Hello');
      });
      await waitFor(() => expect(result.current.input).toBe('Hello'));
      await act(async () => {
        await result.current.handleSubmit();
      });
      expect(useSessionStreamStore.getState().getSession('request-uuid').triggerPending).toBe(true);

      // The retire announce lands: the list store records the rekey and the
      // binding migrates the latch to the canonical id (simulated directly —
      // the harness stubs the StreamManager the real binding hangs off).
      act(() => {
        useSessionListStore.getState().applyListEvent({
          type: 'session_status',
          sessionId: 'canonical-id',
          retiredSessionId: 'request-uuid',
          status: {
            contextUsage: null,
            cost: null,
            usage: null,
            cacheStats: null,
            model: null,
            permissionMode: 'default',
            todoCounts: null,
            runningSubagentCount: 0,
            lifecycle: 'streaming',
            lastError: null,
          },
        });
        useSessionStreamStore.getState().migrateSessionContinuity('request-uuid', 'canonical-id');
      });
      expect(useSessionStreamStore.getState().getSession('canonical-id').triggerPending).toBe(true);

      // No turn ever materializes under the canonical id; the watchdog fires
      // and must clear the latch WHERE IT NOW LIVES.
      act(() => {
        vi.advanceTimersByTime(TIMING.TRIGGER_PENDING_TIMEOUT_MS + 1);
      });
      expect(useSessionStreamStore.getState().getSession('canonical-id').triggerPending).toBe(
        false
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('a snapshot-discovered settle does NOT fire the settle effects (CLI-B9 spurious settle)', async () => {
    // Real failure mode: switching back to a session that settled in the
    // background re-hydrates via a cold snapshot (stale 'streaming' → snapshot
    // 'idle'). That is a discovery of an old settle, not a live one — firing
    // the settle effects replayed the notification sound and a redundant
    // history reload on every switch-back.
    const getMessages = vi.fn().mockResolvedValue({ messages: [] });
    const onStreamingDone = vi.fn();
    const transport = createMockTransport({ getMessages });

    const { result } = renderHook(() => useChatSession('s1', { onStreamingDone }), {
      wrapper: createWrapper(transport),
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    // The stale projection a switch-away leaves behind: hydrated mid-turn.
    act(() => {
      useSessionStreamStore.getState().applySnapshot('s1', snapshotWith('streaming', 5));
    });
    await waitFor(() => expect(result.current.status).toBe('streaming'));
    getMessages.mockClear();

    // Switch-back: the cold snapshot reports the turn settled long ago.
    act(() => {
      useSessionStreamStore.getState().applySnapshot('s1', snapshotWith('idle', 9));
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    // No sound, no redundant reload — the snapshot itself carried fresh history.
    expect(onStreamingDone).not.toHaveBeenCalled();
    expect(getMessages).not.toHaveBeenCalled();

    // A subsequent LIVE settle still fires normally (baseline correctly re-armed).
    act(() => {
      const store = useSessionStreamStore.getState();
      store.applyEvent('s1', { seq: 10, type: 'turn_start' });
      store.applyEvent('s1', statusChange(11, 'streaming'));
    });
    await waitFor(() => expect(result.current.status).toBe('streaming'));
    act(() => {
      useSessionStreamStore.getState().applyEvent('s1', { seq: 12, type: 'turn_end' });
    });
    await waitFor(() => expect(onStreamingDone).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getMessages).toHaveBeenCalledWith('s1', '/test/cwd'));
  });
});
