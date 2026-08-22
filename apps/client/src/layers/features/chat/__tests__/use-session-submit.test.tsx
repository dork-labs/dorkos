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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { SessionEvent, SessionSnapshot, SessionStatus } from '@dorkos/shared/session-stream';

// Stub the shared StreamManager so attach/connect never opens a real fetch in
// jsdom; the binding stays real (wires listeners) but we drive the store
// directly to simulate `/events`. Preserve the module's other transport exports
// (HttpTransport, WSConnection) so `@/layers/shared/lib` re-exports still load.
vi.mock('@/layers/shared/lib/transport', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/layers/shared/lib/transport');
  return {
    ...actual,
    streamManager: {
      connectList: vi.fn(),
      setListeners: vi.fn(),
      attachSession: vi.fn(),
      detachSession: vi.fn(),
      releaseSession: vi.fn(),
      getAttachedSessionId: vi.fn().mockReturnValue(null),
      subscribeListConnectionState: vi.fn().mockReturnValue(() => {}),
    },
  };
});

/**
 * The app-store slice the send path reads. Hoisted so a test can set a field —
 * `pendingAccount`, the status bar's pre-launch billing pick — before rendering,
 * the way the real store would already be holding one.
 */
const mockAppState = vi.hoisted(() => ({
  selectedCwd: '/test/cwd' as string | null,
  enableMessagePolling: false,
  pendingAccount: null as string | null,
}));

vi.mock('@/layers/shared/model', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/layers/shared/model');
  const useAppStore = Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) =>
      selector ? selector(mockAppState) : mockAppState,
    { getState: () => mockAppState }
  );
  return { ...actual, useAppStore };
});

import { useChatSession } from '../model/use-chat-session';
import {
  useSessionChatStore,
  useSessionListStore,
  useSessionStreamStore,
  sessionKeys,
} from '@/layers/entities/session';
import { resetSessionStreamBinding } from '@/layers/entities/session';
import { TIMING } from '@/layers/shared/lib';
import { streamManager } from '@/layers/shared/lib/transport';
import { TransportProvider, useAgentBirthStore } from '@/layers/shared/model';
import { __resetFiredKickoffsForTest } from '../model/kickoff/use-auto-kickoff';
import { wrapKickoff } from '@dorkos/shared/kickoff';
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
    queuedMessages: [],
    cursor,
  };
}

describe('useChatSession — send (trigger-only POST → /events)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetUuidCounter();
    mockAppState.pendingAccount = null;
    useSessionChatStore.setState({ sessions: {}, sessionAccessOrder: [] });
    useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [] });
    useSessionListStore.setState({
      sessions: {},
      statuses: {},
      statusCwds: {},
      unseen: {},
      rekeys: {},
    });
    useAgentBirthStore.setState({ records: {} });
    __resetFiredKickoffsForTest();
    resetSessionStreamBinding();
  });

  // Unmount each test's hook so a leaked useChatSession instance can't react to
  // the next test's store writes (e.g. steal an auto-kickoff fire).
  afterEach(cleanup);

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
    const sessions =
      queryClient.getQueryData<{ id: string }[]>(sessionKeys.list('/test/cwd')) ?? [];
    expect(sessions.some((s) => s.id === 'sdk-canonical')).toBe(true);
    expect(sessions.some((s) => s.id === 'client-uuid')).toBe(false);
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
    const sessions = queryClient.getQueryData<{ id: string; runtime: string }[]>(
      sessionKeys.list('/test/cwd')
    );
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

  it('passes the billing-account hint on the session-creating first send only', async () => {
    // The status bar's pick is "this session only" (spec
    // `billing-account-ladder`). After launch the account is a fact on disk, so
    // a later send carrying it would ask for something impossible.
    mockAppState.pendingAccount = 'acme-corp';
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));
    const transport = createMockTransport({ postMessage });
    // Default gcTime: the sessions list cache must survive between the two
    // sends, which is what tells the second one the session already exists.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useChatSession('s1'), {
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

    // The registry ID, never a path — that is what the server resolves the hint
    // against (ADR 260821-205324).
    expect(postMessage.mock.calls[0][3]).toMatchObject({ account: 'acme-corp' });

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

    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage.mock.calls[1][3]).not.toHaveProperty('account');
  });

  it('omits the billing-account hint when no account was picked', async () => {
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

    // Omitted entirely rather than sent as null: an absent hint is what hands
    // the ladder back to the server (the agent's account, then the default).
    expect(postMessage.mock.calls[0][3]).not.toHaveProperty('account');
  });

  it('carries Ask DorkBot\u2019s background on the first send and on no send after it (BC-48)', async () => {
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));
    const transport = createMockTransport({ postMessage });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // The provider owns "at most once"; the send path just asks on every turn.
    const takeSeedContext = vi
      .fn<() => string | undefined>()
      .mockReturnValueOnce('They were on the marketplace. They have 3 agents registered.')
      .mockReturnValue(undefined);

    const { result } = renderHook(() => useChatSession('s1', { takeSeedContext }), {
      wrapper: createWrapper(transport, queryClient),
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    act(() => {
      result.current.setInput('why is my agent stuck?');
    });
    await waitFor(() => expect(result.current.input).toBe('why is my agent stuck?'));
    await act(async () => {
      await result.current.handleSubmit();
    });

    // The background reaches the server as its OWN field, never folded into the
    // message and never into the neutral client-signal bag.
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][1]).toBe('why is my agent stuck?');
    expect(postMessage.mock.calls[0][3]).toMatchObject({
      seedContext: 'They were on the marketplace. They have 3 agents registered.',
    });

    // Settle the turn so a second send is allowed.
    act(() => {
      const store = useSessionStreamStore.getState();
      store.applyEvent('s1', { seq: 1, type: 'turn_start' });
      store.applyEvent('s1', { seq: 2, type: 'turn_end' });
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    act(() => {
      result.current.setInput('and the second one?');
    });
    await waitFor(() => expect(result.current.input).toBe('and the second one?'));
    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage.mock.calls[1][3]).not.toHaveProperty('seedContext');
    // Asked on both, answered on one \u2014 which is what makes the absence above a
    // property of the provider rather than of a send path that stopped asking.
    expect(takeSeedContext).toHaveBeenCalledTimes(2);
  });

  it('sends no seedContext at all when no surface supplied one', async () => {
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

    expect(postMessage.mock.calls[0][3]).not.toHaveProperty('seedContext');
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

    const sessions = queryClient.getQueryData<{ id: string; runtime: string }[]>(
      sessionKeys.list('/test/cwd')
    );
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

  it('stop() hands back the messages the server took off the queue, in order', async () => {
    const cancelledQueued = [
      { id: 'm1', content: 'one', disposition: 'queue', enqueuedAt: 1, enqueuedBy: 'me' },
      { id: 'm2', content: 'two', disposition: 'queue', enqueuedAt: 2, enqueuedBy: 'me' },
    ];
    const interruptSession = vi.fn().mockResolvedValue({ ok: true, cancelledQueued });
    const transport = createMockTransport({ interruptSession });

    const { result } = renderHook(() => useChatSession('s1'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => expect(result.current.status).toBe('idle'));

    let returned: unknown;
    await act(async () => {
      returned = await result.current.stop();
    });

    expect(returned).toEqual(cancelledQueued);
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

  it('does not latch the trigger while an attachment uploads', async () => {
    // The latch used to be set BEFORE the upload ran, so for the whole upload
    // the status read `streaming`: the button turned into a red Stop that
    // called interruptSession on a session with no turn (the .catch() swallowed
    // it, so the click did nothing), and a hung upload wedged the composer in
    // queue mode forever — the watchdog that releases the latch is only armed
    // after the POST.
    let releaseUpload: (value: string) => void = () => {};
    const upload = new Promise<string>((resolve) => {
      releaseUpload = resolve;
    });
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));
    const transport = createMockTransport({ postMessage });

    const { result } = renderHook(() => useChatSession('s1', { transformContent: () => upload }), {
      wrapper: createWrapper(transport),
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    act(() => {
      result.current.setInput('what is in this screenshot?');
    });
    await waitFor(() => expect(result.current.input).toBe('what is in this screenshot?'));

    let submitted!: Promise<void>;
    await act(async () => {
      submitted = result.current.handleSubmit();
      await Promise.resolve();
    });

    // Mid-upload: nothing has been triggered yet.
    expect(postMessage).not.toHaveBeenCalled();
    expect(useSessionStreamStore.getState().getSession('s1').triggerPending).toBe(false);
    expect(result.current.status).toBe('idle');

    await act(async () => {
      releaseUpload('read the file, then: what is in this screenshot?');
      await submitted;
    });

    expect(postMessage).toHaveBeenCalledWith(
      's1',
      'read the file, then: what is in this screenshot?',
      '/test/cwd',
      expect.anything()
    );
    expect(useSessionStreamStore.getState().getSession('s1').triggerPending).toBe(true);
  });

  it('attaches the durable stream BEFORE the upload, not after it', async () => {
    // `attachSession` re-targets the ONE active-session connection, and the only
    // other caller is an effect keyed on (sessionId, cwd) that fires once per
    // switch. Behind the upload await, a session switch made DURING the upload
    // gets silently undone: B attaches, the upload resolves, and this drags the
    // connection back to A — leaving B on screen with no live stream and nothing
    // to re-fire until the session or cwd changes again.
    let releaseUpload: (value: string) => void = () => {};
    const upload = new Promise<string>((resolve) => {
      releaseUpload = resolve;
    });
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));
    const transport = createMockTransport({ postMessage });

    const { result } = renderHook(() => useChatSession('s1', { transformContent: () => upload }), {
      wrapper: createWrapper(transport),
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    act(() => {
      result.current.setInput('here are the files');
    });
    await waitFor(() => expect(result.current.input).toBe('here are the files'));

    attachSession.mockClear();
    let submitted!: Promise<void>;
    await act(async () => {
      submitted = result.current.handleSubmit();
      await Promise.resolve();
    });

    // Still mid-upload — nothing has been POSTed — and the attach has already
    // happened, so no later resolution can re-target away from a switch.
    expect(postMessage).not.toHaveBeenCalled();
    expect(attachSession).toHaveBeenCalledWith('s1', '/test/cwd');

    await act(async () => {
      releaseUpload('here are the files');
      await submitted;
    });
  });

  it('an upload failure leaves the typed message in the composer', async () => {
    // The input was cleared before the try, with nothing to put the words back
    // — so an ordinary send whose attachment failed destroyed the message.
    const postMessage = vi.fn();
    const transport = createMockTransport({ postMessage });

    const { result } = renderHook(
      () =>
        useChatSession('s1', {
          transformContent: () =>
            Promise.reject(
              new Error('photo.png did not upload. Retry it or remove it, then send again.')
            ),
        }),
      { wrapper: createWrapper(transport) }
    );
    await waitFor(() => expect(result.current.status).toBe('idle'));

    act(() => {
      result.current.setInput('what is in this screenshot?');
    });
    await waitFor(() => expect(result.current.input).toBe('what is in this screenshot?'));

    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(postMessage).not.toHaveBeenCalled();
    expect(result.current.input).toBe('what is in this screenshot?');
    expect(useSessionStreamStore.getState().getSession('s1').triggerPending).toBe(false);
    expect(result.current.error?.message).toContain('did not upload');
    // The words are still in the box, so Enter is the retry. A Retry button
    // here would resend the PREVIOUS user message instead.
    expect(result.current.error?.retryable).toBe(false);
  });

  it('a failed KICKOFF raises no error banner (no dead Retry) and marks the greeting failed', async () => {
    // The birth session's auto-first-turn: the person typed nothing, so a
    // "Could not send message" banner with a Retry (which would find no user
    // message to resend) would be dishonest AND dead. The failure instead
    // surfaces via the empty session's honest greeting-failed line.
    const kickoff = wrapKickoff('introduce yourself from SOUL.md');
    useAgentBirthStore.getState().register('s1', {
      name: 'aurora',
      displayName: 'Aurora',
      agentId: 'agent_aurora',
      bornAt: '2026-07-20T00:00:00.000Z',
      path: '/test/cwd',
      runtime: 'claude-code',
      kickoffMessage: kickoff,
    });
    const postMessage = vi.fn().mockRejectedValue(new Error('network down'));
    const transport = createMockTransport({ postMessage });

    const { result } = renderHook(() => useChatSession('s1'), {
      wrapper: createWrapper(transport),
    });

    // useAutoKickoff fires the kickoff, it fails, retries once, fails again.
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));
    expect(postMessage).toHaveBeenCalledWith('s1', kickoff, '/test/cwd', expect.any(Object));

    // No banner, no dead Retry — the composer stays a normal empty session.
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.error).toBeNull();
    // The honest greeting-failed line's data source is set.
    await waitFor(() =>
      expect(useAgentBirthStore.getState().records['s1'].greetingFailed).toBe(true)
    );

    // The kickoff was never rendered as a user bubble either.
    expect(result.current.messages.some((m) => m.role === 'user')).toBe(false);
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
