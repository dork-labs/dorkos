// @vitest-environment jsdom
/**
 * Writing a message records the operator's interaction with the conversation
 * and its agent (DOR-1156).
 *
 * Today's order key is `max(userLastMessageAt, userLastOpenedAt)` (spec
 * `sidebar-now-today-library` BC-16). No route on the wire carries the first
 * half yet, so the second half is the whole key — and until this change the
 * only thing that ever wrote it was a click on a sidebar row. A person could
 * type into an agent all afternoon and Today would say they had never been
 * there.
 *
 * The rows those records produce are asserted end to end in
 * `src/__tests__/send-lands-in-today.test.tsx`; this file is about WHICH ids
 * get a record, which is where the rekey and the kickoff live.
 *
 * @module features/chat/__tests__/send-records-interaction
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { wrapKickoff } from '@dorkos/shared/kickoff';

vi.mock('@/layers/shared/lib/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/lib/transport')>()),
  streamManager: {
    connectList: vi.fn(),
    setListeners: vi.fn(),
    attachSession: vi.fn(),
    detachSession: vi.fn(),
    releaseSession: vi.fn(),
    getAttachedSessionId: vi.fn().mockReturnValue(null),
    subscribeListConnectionState: vi.fn().mockReturnValue(() => {}),
  },
}));

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  const appState = { selectedCwd: '/projects/alpha', enableMessagePolling: false };
  const useAppStore = Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) =>
      selector ? selector(appState) : appState,
    { getState: () => appState }
  );
  return { ...actual, useAppStore };
});

import { useChatSession } from '../model/use-chat-session';
import { useSessionRekeyRedirect } from '../model/use-session-stream';
import { __resetFiredKickoffsForTest } from '../model/kickoff/use-auto-kickoff';
import { interactionKey, useInteractionStore } from '@/layers/entities/interactions';
import {
  resetSessionStreamBinding,
  useSessionChatStore,
  useSessionListStore,
  useSessionStreamStore,
} from '@/layers/entities/session';
import { TransportProvider, useAgentBirthStore } from '@/layers/shared/model';

const CWD = '/projects/alpha';

function wrapper(transport: Transport) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

/** Every key the interaction store currently holds a record under. */
const recordedKeys = () => Object.keys(useInteractionStore.getState().opened).sort();

/** The use count under one key — zero when the operator has never opened it. */
function countOf(kind: 'session' | 'agent' | 'room', id: string): number {
  return useInteractionStore.getState().counts[interactionKey(kind, id)] ?? 0;
}

/** The record under one key, as epoch ms, or `null` when there is none. */
function recordedAt(kind: 'session' | 'agent' | 'room', id: string): number | null {
  const iso = useInteractionStore.getState().opened[interactionKey(kind, id)];
  return iso === undefined ? null : Date.parse(iso);
}

/** Apply the server's retire announce — the canonical id supersedes a request UUID. */
function announceRekey(retired: string, canonical: string): void {
  useSessionListStore.getState().applyListEvent({
    type: 'session_status',
    sessionId: canonical,
    retiredSessionId: retired,
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
}

function resetStores(): void {
  useInteractionStore.getState().reset();
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
}

describe('a send records the operator’s interaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });
  afterEach(cleanup);

  it('records the conversation AND its agent, mirroring what opening one does', async () => {
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));
    const { result } = renderHook(() => useChatSession('s1'), {
      wrapper: wrapper(createMockTransport({ postMessage })),
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    expect(recordedKeys()).toEqual([]);

    act(() => result.current.setInput('Do the thing.'));
    await waitFor(() => expect(result.current.input).toBe('Do the thing.'));
    await act(async () => {
      await result.current.handleSubmit();
    });

    // Both, and nothing else. `SidebarChrome.openSession` writes exactly this
    // pair, so one act moves the conversation's place in Today and the agent's
    // frecency together.
    expect(recordedKeys()).toEqual([`agent:${CWD}`, 'session:s1']);
  });

  it('records the timestamp as ISO-8601, which is the unit the model parses', async () => {
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));
    const { result } = renderHook(() => useChatSession('s1'), {
      wrapper: wrapper(createMockTransport({ postMessage })),
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));
    const before = Date.now();

    act(() => result.current.setInput('Hello'));
    await waitFor(() => expect(result.current.input).toBe('Hello'));
    await act(async () => {
      await result.current.handleSubmit();
    });

    // Epoch milliseconds would satisfy the `string` type, parse to NaN, and be
    // read as "never interacted with" — silently, on both sides. Asserting the
    // parsed instant is what makes the unit part of this test.
    const at = recordedAt('session', 's1');
    expect(at).not.toBeNull();
    expect(at as number).toBeGreaterThanOrEqual(before);
    expect(at as number).toBeLessThanOrEqual(Date.now());
  });

  it('records even when the trigger is refused — the person still wrote it', async () => {
    const postMessage = vi.fn().mockRejectedValue(new Error('the network is gone'));
    const { result } = renderHook(() => useChatSession('s1'), {
      wrapper: wrapper(createMockTransport({ postMessage })),
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    act(() => result.current.setInput('Into the void.'));
    await waitFor(() => expect(result.current.input).toBe('Into the void.'));
    await act(async () => {
      await result.current.handleSubmit();
    });

    // The ruling is about the operator's act, not the server's answer. The
    // record is also what keeps the conversation in Today so they can find it
    // again and retry.
    expect(recordedAt('session', 's1')).not.toBeNull();
  });

  it('records nothing for the newborn agent’s kickoff — nobody typed it', async () => {
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));
    useAgentBirthStore.getState().register('birth-session', {
      name: 'alpha',
      displayName: 'Alpha',
      agentId: 'agent_alpha',
      bornAt: new Date().toISOString(),
      path: CWD,
      runtime: 'claude-code',
      kickoffMessage: wrapKickoff('introduce yourself'),
    });

    renderHook(() => useChatSession('birth-session'), {
      wrapper: wrapper(createMockTransport({ postMessage })),
    });

    // The kickoff fires on its own; wait for the turn it triggers, then assert
    // the store never moved. Waiting on the POST is what stops this passing
    // because nothing happened at all.
    await waitFor(() => expect(postMessage).toHaveBeenCalled());
    expect(recordedKeys()).toEqual([]);
  });
});

describe('a rekeyed conversation keeps the interaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });
  afterEach(cleanup);

  it('carries the record onto the canonical id when the 202 resolves it', async () => {
    const postMessage = vi.fn().mockResolvedValue({ sessionId: 'sdk-canonical' });
    const { result } = renderHook(
      () => useChatSession('client-uuid', { onSessionIdChangeReplace: vi.fn() }),
      { wrapper: wrapper(createMockTransport({ postMessage })) }
    );
    await waitFor(() => expect(result.current.status).toBe('idle'));

    act(() => result.current.setInput('First message'));
    await waitFor(() => expect(result.current.input).toBe('First message'));
    await act(async () => {
      await result.current.handleSubmit();
    });

    // Today walks the session LIST, and `client-uuid` will never appear in one
    // again — so a record left only there is a conversation the operator
    // started and cannot find.
    expect(recordedAt('session', 'sdk-canonical')).not.toBeNull();
    expect(recordedAt('session', 'sdk-canonical')).toBe(recordedAt('session', 'client-uuid'));
  });

  it('carries it when the canonical id only arrives on the retire announce', () => {
    const at = Date.now() - 5_000;
    useInteractionStore.getState().recordOpened('session', 'request-uuid', at);

    renderHook(() => useSessionRekeyRedirect('request-uuid', vi.fn()));
    act(() => announceRekey('request-uuid', 'canonical-id'));

    // The same instant, not "now": the operator wrote five seconds ago, and a
    // refreshed timestamp would move the row for something the server did.
    expect(recordedAt('session', 'canonical-id')).toBe(at);
  });

  it('carries the use count, not just the instant', () => {
    // Three sends under the request UUID before the announce lands. The count
    // is half of what ⌘K ranks by (P3.3), so a carry that moved only the
    // timestamp would leave a conversation the operator used three times
    // looking like one they had opened once — with the real count stranded on
    // an id nothing reads.
    const at = Date.now() - 5_000;
    for (const n of [2, 1, 0]) {
      useInteractionStore.getState().recordOpened('session', 'request-uuid', at - n);
    }
    expect(countOf('session', 'request-uuid')).toBe(3);

    renderHook(() => useSessionRekeyRedirect('request-uuid', vi.fn()));
    act(() => announceRekey('request-uuid', 'canonical-id'));

    expect(countOf('session', 'canonical-id')).toBe(3);
  });

  it('takes the larger of every field, so a carry can never age or shrink a row', () => {
    const older = Date.now() - 10_000;
    const newer = Date.now() - 1_000;
    // The URL rekeyed, a second message was sent under the canonical id, and
    // only then does the announce arrive. `mergeUsage` max-takes both fields,
    // so the newer instant survives — overwriting would age the row by nine
    // seconds — and so does the larger count.
    useInteractionStore.getState().recordOpened('session', 'request-uuid', older);
    useInteractionStore.getState().recordOpened('session', 'canonical-id', newer);
    useInteractionStore.getState().recordOpened('session', 'canonical-id', newer);

    renderHook(() => useSessionRekeyRedirect('request-uuid', vi.fn()));
    act(() => announceRekey('request-uuid', 'canonical-id'));

    expect(recordedAt('session', 'canonical-id')).toBe(newer);
    expect(countOf('session', 'canonical-id')).toBe(2);
  });

  it('is idempotent — the same announce twice changes nothing', () => {
    // Both rekey routes can fire for one session (the 202 and the announce),
    // and two tabs can replay the same migration. `mergeUsage`'s max-take is
    // what makes that converge instead of double-counting.
    const at = Date.now() - 5_000;
    useInteractionStore.getState().recordOpened('session', 'request-uuid', at);

    renderHook(() => useSessionRekeyRedirect('request-uuid', vi.fn()));
    act(() => announceRekey('request-uuid', 'canonical-id'));
    const after = countOf('session', 'canonical-id');
    act(() => announceRekey('request-uuid', 'canonical-id'));

    expect(countOf('session', 'canonical-id')).toBe(after);
    expect(recordedAt('session', 'canonical-id')).toBe(at);
  });

  it('invents nothing for a conversation that was never written in', () => {
    renderHook(() => useSessionRekeyRedirect('request-uuid', vi.fn()));
    act(() => announceRekey('request-uuid', 'canonical-id'));

    // A rekey is the server's event, not the operator's. Watching a session
    // somebody else started must not put it in Today.
    expect(recordedKeys()).toEqual([]);
  });
});
