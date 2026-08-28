/**
 * @vitest-environment jsdom
 *
 * What a session-scoped query must know before it goes out — and, since
 * DOR-1444, what it no longer has to.
 *
 * The original rule (DOR-495) was that every per-session endpoint is scoped by
 * BOTH the session id and the working directory, so a query that waited only
 * for the id fired once into the gap before the directory resolved, was refused
 * as outside the server's root, and fired again correctly a moment later — two
 * requests per navigation, one guaranteed to fail, plus a console error each
 * time.
 *
 * The server now resolves a session's own directory when a request omits it, so
 * "no directory" stopped being an incomplete question and became an answerable
 * one. What still must not happen is the DOUBLE fetch, and that is now
 * prevented at the source: `useSessionScopedCwd` reads the URL, which is
 * available on the first render, so the answer never changes underneath a
 * query. The tests below therefore pin ONE request rather than a delayed one.
 *
 * `useSessionDetail` is the exception and still waits for the store, because it
 * is keyed into a shared cache other writers patch by directory — see its own
 * note. Its test is unchanged.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// `useSessionScopedCwd` reads the URL through `useSafeSearch`, which needs a
// router. Only the search params are stubbed; every other export (the transport
// provider, the app store) stays real.
const urlSearch: { dir?: string } = {};
vi.mock('@/layers/shared/model', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/layers/shared/model');
  return { ...actual, useSafeSearch: () => urlSearch };
});

import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider, useAppStore, useTransport } from '@/layers/shared/model';
import {
  useSessionDetail,
  useSessionChatStore,
  type SessionScopedCwd,
} from '@/layers/entities/session';
import { useTaskState } from '../model/use-task-state';
import { useSessionHistory } from '../model/use-session-history';

const SESSION_ID = 's1';
const CWD = '/projects/api';

function createHarness() {
  const transport = createMockTransport({
    getSession: vi.fn().mockResolvedValue({
      id: SESSION_ID,
      title: 'A session',
      createdAt: '2026-03-01T00:00:00.000Z',
      updatedAt: '2026-03-01T00:00:00.000Z',
      permissionMode: 'default',
      runtime: 'claude-code',
      cwd: CWD,
    }),
    getTasks: vi.fn().mockResolvedValue({ tasks: [] }),
    getMessages: vi.fn().mockResolvedValue({ messages: [] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return { transport, wrapper };
}

beforeEach(() => {
  // The app's real starting state: a session id is known (it came in on the
  // URL) but the working directory has not resolved yet.
  delete urlSearch.dir;
  useAppStore.setState({ selectedCwd: null });
  useSessionChatStore.setState({ sessions: {}, sessionAccessOrder: [] });
});

describe('session-scoped queries and the working directory', () => {
  it('the session detail row is not requested until the directory resolves', async () => {
    // Red when: the `enabled` gate drops the directory — `getSession` is called
    // once with `undefined`, which the server rejects, and then again correctly.
    const { transport, wrapper } = createHarness();
    const { result } = renderHook(() => useSessionDetail(SESSION_ID), { wrapper });

    expect(transport.getSession).not.toHaveBeenCalled();

    act(() => {
      useAppStore.setState({ selectedCwd: CWD });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(transport.getSession).toHaveBeenCalledTimes(1);
    expect(transport.getSession).toHaveBeenCalledWith(SESSION_ID, CWD);
  });

  it("the session's tasks are requested once, without a directory nothing named", async () => {
    // No `?dir=` on the URL (no router in this harness), so the request goes out
    // with no directory and the server resolves the session's own. The thing
    // that must NOT happen is a second request when `selectedCwd` later fills
    // with the server default — that re-fetch is the DOR-1444 bug, and it is
    // what makes this assertion about the COUNT rather than the timing.
    const { transport, wrapper } = createHarness();
    renderHook(() => useTaskState(SESSION_ID, false), { wrapper });

    await waitFor(() => expect(transport.getTasks).toHaveBeenCalledTimes(1));
    expect(transport.getTasks).toHaveBeenCalledWith(SESSION_ID, undefined);

    act(() => {
      useAppStore.setState({ selectedCwd: CWD });
    });

    // Red when: the task query reads `selectedCwd` again — the store filling in
    // re-keys the query and refetches the DEFAULT directory's tasks.
    await waitFor(() => expect(transport.getTasks).toHaveBeenCalledTimes(1));
    expect(transport.getTasks).not.toHaveBeenCalledWith(SESSION_ID, CWD);
  });

  it('the message history goes out with no directory when nothing named one', async () => {
    const { transport, wrapper } = createHarness();
    function Probe({ sessionCwd }: { sessionCwd: SessionScopedCwd }) {
      return useSessionHistory({
        sessionId: SESSION_ID,
        sid: SESSION_ID,
        transport: useTransport(),
        sessionCwd,
        enableMessagePolling: false,
        isStreaming: false,
        setMessages: () => {},
      });
    }
    renderHook(() => Probe({ sessionCwd: { cwd: null, resolved: true } }), { wrapper });

    // Red when: a null directory is treated as "still loading" — the history
    // never arrives for a session URL that omitted `&dir=`, which is the blank
    // "Start a conversation" the second window showed (DOR-1444).
    await waitFor(() => expect(transport.getMessages).toHaveBeenCalledTimes(1));
    expect(transport.getMessages).toHaveBeenCalledWith(SESSION_ID, undefined);
  });

  it('the message history still waits while the directory is UNSETTLED', async () => {
    // The embedded host, where the directory does arrive asynchronously and
    // DOR-495's double-fetch is still real.
    const { transport, wrapper } = createHarness();
    function Probe({ sessionCwd }: { sessionCwd: SessionScopedCwd }) {
      return useSessionHistory({
        sessionId: SESSION_ID,
        sid: SESSION_ID,
        transport: useTransport(),
        sessionCwd,
        enableMessagePolling: false,
        isStreaming: false,
        setMessages: () => {},
      });
    }
    const { rerender } = renderHook(
      ({ scoped }: { scoped: SessionScopedCwd }) => Probe({ sessionCwd: scoped }),
      { wrapper, initialProps: { scoped: { cwd: null, resolved: false } as SessionScopedCwd } }
    );

    expect(transport.getMessages).not.toHaveBeenCalled();

    rerender({ scoped: { cwd: CWD, resolved: true } });

    await waitFor(() => expect(transport.getMessages).toHaveBeenCalledTimes(1));
    expect(transport.getMessages).toHaveBeenCalledWith(SESSION_ID, CWD);
  });
});
