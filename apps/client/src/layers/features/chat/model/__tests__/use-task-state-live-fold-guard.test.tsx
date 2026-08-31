/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import type { TaskUpdateEvent } from '@dorkos/shared/types';
import { useTaskState } from '../use-task-state';

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...original,
    useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
      const state = { selectedCwd: '/test/cwd' };
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

describe('useTaskState — the empty-history guard is judged by fetch timing, not scope alone (DOR-1632)', () => {
  let mockTransport: ReturnType<typeof createMockTransport>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTransport = createMockTransport();
  });

  it('keeps a live-folded task when the initial history fetch resolves empty afterward, for the same session', async () => {
    // The history fetch resolves empty AFTER we've already folded a live
    // event locally — a real race: the fetch was already in flight (issued
    // at mount) when the live event landed, and network latency let it
    // settle later. Its empty answer predates the fold and must be ignored.
    mockTransport.getTasks = vi.fn().mockResolvedValue({ tasks: [] });

    const { result } = renderHook(() => useTaskState('session-1'), {
      wrapper: createWrapper(mockTransport, createQueryClient()),
    });

    act(() => {
      result.current.handleTaskEvent({
        action: 'create',
        task: { id: 'pending:tu1', subject: 'Live task', status: 'pending' },
      } as TaskUpdateEvent);
    });
    expect(result.current.taskMap.has('pending:tu1')).toBe(true);

    // Let the (empty) history query actually resolve and its effect run.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

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
    // The two resolutions must differ (history task, then `[]`) rather than
    // both being empty: TanStack Query's structural sharing keeps the same
    // `data` reference across two structurally-equal results, so an
    // empty-to-empty refetch would never even re-run this hook's effect —
    // it would prove nothing about the guard under test.
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

  it('resets state on a genuine session change even when the new session has no history yet', async () => {
    mockTransport.getTasks = vi.fn().mockResolvedValue({ tasks: [] });

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) => useTaskState(sessionId),
      {
        wrapper: createWrapper(mockTransport, createQueryClient()),
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

    rerender({ sessionId: 'session-2' });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.taskMap.has('pending:tu1')).toBe(false);
  });
});
