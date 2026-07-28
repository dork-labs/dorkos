/**
 * @vitest-environment jsdom
 *
 * Every per-session endpoint is scoped by BOTH the session id and the working
 * directory, and the working directory arrives a moment after the first render.
 * A query that waits only for the session id fires once into that gap with no
 * directory, the server refuses it as outside its root, and the query fires
 * again correctly once the directory lands — two requests per navigation, one
 * of them guaranteed to fail, plus a console error each time (DOR-495).
 *
 * All three session-scoped queries are checked in one place because they are
 * the same query written three times, and the bug was in all three. Two of them
 * live in this slice; the third is reached through the session entity's barrel.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider, useAppStore, useTransport } from '@/layers/shared/model';
import { useSessionDetail, useSessionChatStore } from '@/layers/entities/session';
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
  useAppStore.setState({ selectedCwd: null });
  useSessionChatStore.setState({ sessions: {}, sessionAccessOrder: [] });
});

describe('session-scoped queries wait for the working directory', () => {
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

  it("the session's tasks are not requested until the directory resolves", async () => {
    // Red when: the `enabled` gate drops the directory — same two-request shape.
    const { transport, wrapper } = createHarness();
    renderHook(() => useTaskState(SESSION_ID, false), { wrapper });

    expect(transport.getTasks).not.toHaveBeenCalled();

    act(() => {
      useAppStore.setState({ selectedCwd: CWD });
    });

    await waitFor(() => expect(transport.getTasks).toHaveBeenCalledTimes(1));
    expect(transport.getTasks).toHaveBeenCalledWith(SESSION_ID, CWD);
  });

  it('the message history is not requested until the directory resolves', async () => {
    // Red when: the `enabled` gate drops the directory — same two-request shape.
    const { transport, wrapper } = createHarness();
    function Probe({ selectedCwd }: { selectedCwd: string | null }) {
      return useSessionHistory({
        sessionId: SESSION_ID,
        sid: SESSION_ID,
        transport: useTransport(),
        selectedCwd,
        enableMessagePolling: false,
        isStreaming: false,
        setMessages: () => {},
      });
    }
    const { rerender } = renderHook(
      ({ cwd }: { cwd: string | null }) => Probe({ selectedCwd: cwd }),
      {
        wrapper,
        initialProps: { cwd: null as string | null },
      }
    );

    expect(transport.getMessages).not.toHaveBeenCalled();

    rerender({ cwd: CWD });

    await waitFor(() => expect(transport.getMessages).toHaveBeenCalledTimes(1));
    expect(transport.getMessages).toHaveBeenCalledWith(SESSION_ID, CWD);
  });
});
