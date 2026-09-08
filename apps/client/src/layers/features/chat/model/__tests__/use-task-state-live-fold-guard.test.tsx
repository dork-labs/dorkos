/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import {
  QueryClient,
  QueryClientProvider,
  notifyManager,
  defaultScheduler,
} from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import type { TaskUpdateEvent } from '@dorkos/shared/types';
import { useTaskState } from '../use-task-state';

let selectedCwd = '/test/cwd';

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...original,
    useSafeSearch: () => ({ dir: selectedCwd }),
    useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
      const state = { selectedCwd };
      return selector ? selector(state) : state;
    },
  };
});

function createWrapper(
  transport: ReturnType<typeof createMockTransport>,
  queryClient: QueryClient
) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

type History = Awaited<ReturnType<ReturnType<typeof createMockTransport>['getTasks']>>;

function deferredHistory() {
  let resolve!: (value: History) => void;
  const promise = new Promise<History>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settleHistory(
  queryClient: QueryClient,
  history: ReturnType<typeof deferredHistory>,
  value: History
) {
  await act(async () => {
    // The existing request is deduplicated; this awaits its actual completion.
    const completed = queryClient.refetchQueries({ queryKey: ['tasks', 'session-1'] });
    history.resolve(value);
    await completed;
  });
}

describe('useTaskState — history completion order (DOR-1920)', () => {
  let mockTransport: ReturnType<typeof createMockTransport>;

  beforeEach(() => {
    vi.clearAllMocks();
    selectedCwd = '/test/cwd';
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    // Deliver query notifications at the promise boundary, not a guessed timer.
    notifyManager.setScheduler(queueMicrotask);
    mockTransport = createMockTransport();
  });

  afterEach(() => {
    notifyManager.setScheduler(defaultScheduler);
    vi.restoreAllMocks();
  });

  it('keeps a live-folded task when the initial history fetch resolves empty afterward, for the same session', async () => {
    // The history fetch resolves empty AFTER we've already folded a live
    // event locally — a real race: the fetch was already in flight (issued
    // at mount) when the live event landed, and network latency let it
    // settle later. Its empty answer predates the fold and must be ignored.
    const history = deferredHistory();
    mockTransport.getTasks = vi.fn().mockReturnValue(history.promise);
    const queryClient = createQueryClient();

    const { result } = renderHook(() => useTaskState('session-1'), {
      wrapper: createWrapper(mockTransport, queryClient),
    });

    act(() => {
      result.current.handleTaskEvent({
        action: 'create',
        task: { id: 'pending:tu1', subject: 'Live task', status: 'pending' },
      } as TaskUpdateEvent);
    });
    expect(result.current.taskMap.has('pending:tu1')).toBe(true);

    // Both issuance and the later live fold saw the exact same clock instant.
    expect(mockTransport.getTasks).toHaveBeenCalledOnce();
    await settleHistory(queryClient, history, { tasks: [] });

    expect(result.current.taskMap.has('pending:tu1')).toBe(true);
  });

  it('a refetch AFTER a live event resolves empty and DOES clear — an authoritative clear has no live signal of its own', async () => {
    // A cleared todo list emits no live event on either runtime (opencode's
    // mapTodos / claude-code's buildTodoWriteEvent both emit nothing for an
    // empty list), so the history fetch is the ONLY way this hook ever
    // learns a list was cleared. use-turn-end-reconcile.ts delivers exactly
    // this: it invalidates the query AFTER the turn (and every live fold in
    // it) has already settled, so the resulting refetch must be honored.
    //
    const queryClient = createQueryClient();
    mockTransport.getTasks = vi
      .fn()
      .mockResolvedValueOnce({
        tasks: [{ id: 'hist-1', subject: 'From history', status: 'pending' }],
      })
      .mockResolvedValueOnce({ tasks: [] });

    const { result } = renderHook(() => useTaskState('session-1'), {
      wrapper: createWrapper(mockTransport, queryClient),
    });

    // Let the initial history fetch settle first, so the live event below
    // is unambiguously the newest thing that has happened.
    await waitFor(() => expect(result.current.taskMap.has('hist-1')).toBe(true));

    act(() => {
      result.current.handleTaskEvent({
        action: 'create',
        task: { id: 'pending:tu1', subject: 'Live task', status: 'pending' },
      } as TaskUpdateEvent);
    });
    expect(result.current.taskMap.has('pending:tu1')).toBe(true);

    // A turn-end-style invalidation: issued strictly after the live fold
    // above, so its empty answer cannot be dismissed as a stale race.
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['tasks', 'session-1'] });
    });

    await waitFor(() => expect(result.current.taskMap.has('pending:tu1')).toBe(false));
    expect(result.current.taskMap.has('hist-1')).toBe(false);
  });

  it('clears a live task when a later completed history response is identically empty', async () => {
    const queryClient = createQueryClient();
    const initial = deferredHistory();
    const later = deferredHistory();
    mockTransport.getTasks = vi
      .fn()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(later.promise);
    const { result } = renderHook(() => useTaskState('session-1'), {
      wrapper: createWrapper(mockTransport, queryClient),
    });
    await settleHistory(queryClient, initial, { tasks: [] });
    act(() =>
      result.current.handleTaskEvent({
        action: 'create',
        task: { id: 'live', subject: 'Live task', status: 'pending' },
      } as TaskUpdateEvent)
    );
    expect(result.current.taskMap.has('live')).toBe(true);
    let refetch!: Promise<void>;
    act(() => {
      refetch = queryClient.invalidateQueries({ queryKey: ['tasks', 'session-1'] });
    });
    expect(mockTransport.getTasks).toHaveBeenCalledTimes(2);
    expect(result.current.taskMap.has('live')).toBe(true);
    await act(async () => {
      later.resolve({ tasks: [] });
      await refetch;
    });
    expect(result.current.taskMap.size).toBe(0);
  });

  it('does not relabel a completed older response when another fetch starts before React applies it', async () => {
    const queryClient = createQueryClient();
    const older = deferredHistory();
    const newer = deferredHistory();
    mockTransport.getTasks = vi
      .fn()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const notifications: Array<() => void> = [];
    notifyManager.setScheduler((callback) => notifications.push(callback));
    const { result } = renderHook(() => useTaskState('session-1'), {
      wrapper: createWrapper(mockTransport, queryClient),
    });
    act(() =>
      result.current.handleTaskEvent({
        action: 'create',
        task: { id: 'live', subject: 'Live task', status: 'pending' },
      } as TaskUpdateEvent)
    );
    await settleHistory(queryClient, older, { tasks: [] });
    let refetch!: Promise<void>;
    act(() => {
      refetch = queryClient.invalidateQueries({ queryKey: ['tasks', 'session-1'] });
    });
    expect(mockTransport.getTasks).toHaveBeenCalledTimes(2);
    // The older completion is delivered while the newer request remains held.
    act(() => {
      while (notifications.length) notifications.shift()!();
    });
    expect(result.current.taskMap.has('live')).toBe(true);
    await act(async () => {
      newer.resolve({ tasks: [] });
      await refetch;
    });
    act(() => {
      while (notifications.length) notifications.shift()!();
    });
    expect(result.current.taskMap.size).toBe(0);
  });

  it.each([
    {
      name: 'create',
      events: [{ action: 'create', task: { id: 'b', subject: 'Live B', status: 'pending' } }],
      expected: ['a', 'b'],
      subject: 'History A',
    },
    {
      name: 'update',
      events: [
        { action: 'update', task: { id: 'a', subject: 'Updated A', status: 'in_progress' } },
      ],
      expected: ['a'],
      subject: 'Updated A',
    },
    {
      name: 'id assignment',
      events: [
        {
          action: 'id_assigned',
          previousId: 'a',
          task: { id: 'real-a', subject: 'History A', status: 'pending' },
        },
      ],
      expected: ['real-a'],
      subject: 'History A',
    },
    {
      name: 'remove',
      events: [{ action: 'remove', task: { id: 'a', subject: 'History A', status: 'pending' } }],
      expected: [],
      subject: undefined,
    },
  ])(
    'hydrates prior history before replaying a newer $name delta',
    async ({ events, expected, subject }) => {
      const queryClient = createQueryClient();
      const history = deferredHistory();
      mockTransport.getTasks = vi.fn().mockReturnValue(history.promise);
      const { result } = renderHook(() => useTaskState('session-1'), {
        wrapper: createWrapper(mockTransport, queryClient),
      });
      act(() => {
        for (const event of events) result.current.handleTaskEvent(event as TaskUpdateEvent);
      });
      await settleHistory(queryClient, history, {
        tasks: [{ id: 'a', subject: 'History A', status: 'pending' }],
      });
      expect([...result.current.taskMap.keys()]).toEqual(expected);
      if (subject) expect(result.current.tasks[0]?.subject).toBe(subject);
    }
  );

  it('lets a newer full live snapshot replace prior history and deltas', async () => {
    const queryClient = createQueryClient();
    const history = deferredHistory();
    mockTransport.getTasks = vi.fn().mockReturnValue(history.promise);
    const { result } = renderHook(() => useTaskState('session-1'), {
      wrapper: createWrapper(mockTransport, queryClient),
    });
    const task = { id: 'snapshot', subject: 'Full list', status: 'pending' as const };
    act(() => {
      result.current.handleTaskEvent({ action: 'create', task: { ...task, id: 'delta' } });
      result.current.handleTaskEvent({ action: 'snapshot', task, tasks: [task] });
    });
    await settleHistory(queryClient, history, {
      tasks: [{ id: 'history', subject: 'Old list', status: 'pending' }],
    });
    expect([...result.current.taskMap.keys()]).toEqual(['snapshot']);
  });

  it('does not replay a delta again after an authoritative completion covered it', async () => {
    const queryClient = createQueryClient();
    mockTransport.getTasks = vi.fn().mockResolvedValue({ tasks: [] });
    const { result } = renderHook(() => useTaskState('session-1'), {
      wrapper: createWrapper(mockTransport, queryClient),
    });
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['tasks', 'session-1'] });
    });
    act(() =>
      result.current.handleTaskEvent({
        action: 'create',
        task: { id: 'live', subject: 'Live task', status: 'pending' },
      })
    );
    expect(result.current.taskMap.has('live')).toBe(true);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['tasks', 'session-1'] });
    });
    expect(result.current.taskMap.size).toBe(0);
    mockTransport.getTasks = vi
      .fn()
      .mockResolvedValue({ tasks: [{ id: 'later', subject: 'Later task', status: 'pending' }] });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['tasks', 'session-1'] });
    });
    expect([...result.current.taskMap.keys()]).toEqual(['later']);
  });

  it('keeps ordering across remounts sharing one outstanding cached query', async () => {
    const queryClient = createQueryClient();
    const history = deferredHistory();
    mockTransport.getTasks = vi.fn().mockReturnValue(history.promise);
    const wrapper = createWrapper(mockTransport, queryClient);
    const first = renderHook(() => useTaskState('session-1'), { wrapper });
    expect(mockTransport.getTasks).toHaveBeenCalledOnce();
    first.unmount();
    const second = renderHook(() => useTaskState('session-1'), { wrapper });
    // The new observer reused the original in-flight query rather than issuing
    // one in its own lifetime. Its live event must still compare after issuance.
    expect(mockTransport.getTasks).toHaveBeenCalledOnce();
    act(() =>
      second.result.current.handleTaskEvent({
        action: 'create',
        task: { id: 'live', subject: 'Live task', status: 'pending' },
      })
    );
    await settleHistory(queryClient, history, {
      tasks: [{ id: 'history', subject: 'Prior task', status: 'pending' }],
    });
    expect([...second.result.current.taskMap.keys()]).toEqual(['history', 'live']);
  });

  it.each(['session', 'directory'])('resets live replay on a genuine %s change', async (scope) => {
    const queryClient = createQueryClient();
    mockTransport.getTasks = vi.fn().mockResolvedValue({ tasks: [] });

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) => useTaskState(sessionId),
      {
        wrapper: createWrapper(mockTransport, queryClient),
        initialProps: { sessionId: 'session-1' },
      }
    );

    act(() => {
      result.current.handleTaskEvent({
        action: 'create',
        task: { id: 'pending:tu1', subject: 'Session 1 task', status: 'pending' },
      } as TaskUpdateEvent);
    });
    expect(result.current.taskMap.has('pending:tu1')).toBe(true);

    if (scope === 'directory') selectedCwd = '/other/cwd';
    const nextSession = scope === 'session' ? 'session-2' : 'session-1';
    rerender({ sessionId: nextSession });

    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['tasks', nextSession, selectedCwd] });
    });

    expect(mockTransport.getTasks).toHaveBeenCalledWith(nextSession, selectedCwd);
    expect(result.current.taskMap.has('pending:tu1')).toBe(false);
  });
});
