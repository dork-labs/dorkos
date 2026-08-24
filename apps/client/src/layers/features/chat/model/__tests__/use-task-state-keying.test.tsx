/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
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

function createWrapper(transport: ReturnType<typeof createMockTransport>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('useTaskState — create/update keying (DOR-1441)', () => {
  let mockTransport: ReturnType<typeof createMockTransport>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTransport = createMockTransport();
    mockTransport.getTasks = vi.fn().mockResolvedValue({ tasks: [] });
  });

  it('re-keys a created task from its provisional id to the SDK-confirmed real id', () => {
    const { result } = renderHook(() => useTaskState('session-1'), {
      wrapper: createWrapper(mockTransport),
    });

    act(() => {
      result.current.handleTaskEvent({
        action: 'create',
        task: { id: 'pending:tu1', subject: 'One', status: 'pending' },
      } as TaskUpdateEvent);
    });
    expect(result.current.taskMap.has('pending:tu1')).toBe(true);

    act(() => {
      result.current.handleTaskEvent({
        action: 'id_assigned',
        task: { id: '1', subject: '', status: 'pending' },
        previousId: 'pending:tu1',
      } as TaskUpdateEvent);
    });

    expect(result.current.taskMap.has('pending:tu1')).toBe(false);
    expect(result.current.taskMap.get('1')).toMatchObject({ id: '1', subject: 'One' });
  });

  it('a later create can never clobber a re-keyed task (dense sequential real ids)', () => {
    const { result } = renderHook(() => useTaskState('session-1'), {
      wrapper: createWrapper(mockTransport),
    });

    act(() => {
      result.current.handleTaskEvent({
        action: 'create',
        task: { id: 'pending:tu1', subject: 'One', status: 'pending' },
      } as TaskUpdateEvent);
      result.current.handleTaskEvent({
        action: 'id_assigned',
        task: { id: '2', subject: '', status: 'pending' },
        previousId: 'pending:tu1',
      } as TaskUpdateEvent);
      result.current.handleTaskEvent({
        action: 'update',
        task: { id: '2', subject: '', status: 'in_progress' },
      } as TaskUpdateEvent);
      // A second, unrelated create — provisional keys are per-tool_use, so it
      // can never collide with "2" no matter what real id it is later given.
      result.current.handleTaskEvent({
        action: 'create',
        task: { id: 'pending:tu2', subject: 'Two', status: 'pending' },
      } as TaskUpdateEvent);
    });

    expect(result.current.taskMap.get('2')).toMatchObject({
      subject: 'One',
      status: 'in_progress',
    });
    expect(result.current.taskMap.get('pending:tu2')).toMatchObject({ subject: 'Two' });
    expect(result.current.taskMap.size).toBe(2);
  });

  it('update only matches the exact SDK id — a status-only update never no-ops or wrong-hits', () => {
    const { result } = renderHook(() => useTaskState('session-1'), {
      wrapper: createWrapper(mockTransport),
    });

    act(() => {
      result.current.handleTaskEvent({
        action: 'create',
        task: { id: 'pending:a', subject: 'Alpha', status: 'pending' },
      } as TaskUpdateEvent);
      result.current.handleTaskEvent({
        action: 'id_assigned',
        task: { id: '1', subject: '', status: 'pending' },
        previousId: 'pending:a',
      } as TaskUpdateEvent);
      result.current.handleTaskEvent({
        action: 'create',
        task: { id: 'pending:b', subject: 'Beta', status: 'pending' },
      } as TaskUpdateEvent);
      result.current.handleTaskEvent({
        action: 'id_assigned',
        task: { id: '2', subject: '', status: 'pending' },
        previousId: 'pending:b',
      } as TaskUpdateEvent);
      // Status-only update (no subject) — the common real-world shape.
      result.current.handleTaskEvent({
        action: 'update',
        task: { id: '2', subject: '', status: 'completed' },
      } as TaskUpdateEvent);
    });

    expect(result.current.taskMap.get('1')).toMatchObject({ subject: 'Alpha', status: 'pending' });
    expect(result.current.taskMap.get('2')).toMatchObject({ subject: 'Beta', status: 'completed' });
  });

  it('drops a pending create whose tool call failed', () => {
    const { result } = renderHook(() => useTaskState('session-1'), {
      wrapper: createWrapper(mockTransport),
    });

    act(() => {
      result.current.handleTaskEvent({
        action: 'create',
        task: { id: 'pending:tu1', subject: 'Never happens', status: 'pending' },
      } as TaskUpdateEvent);
      result.current.handleTaskEvent({
        action: 'remove',
        task: { id: 'pending:tu1', subject: '', status: 'pending' },
      } as TaskUpdateEvent);
    });

    expect(result.current.taskMap.size).toBe(0);
  });

  it('does not fall back when an update carries an unknown id (no heuristic matching)', () => {
    const { result } = renderHook(() => useTaskState('session-1'), {
      wrapper: createWrapper(mockTransport),
    });

    act(() => {
      result.current.handleTaskEvent({
        action: 'create',
        task: { id: 'pending:tu1', subject: 'Only task', status: 'pending' },
      } as TaskUpdateEvent);
      result.current.handleTaskEvent({
        action: 'id_assigned',
        task: { id: '1', subject: '', status: 'pending' },
        previousId: 'pending:tu1',
      } as TaskUpdateEvent);
      result.current.handleTaskEvent({
        action: 'update',
        task: { id: '9', subject: '', status: 'completed' },
      } as TaskUpdateEvent);
    });

    expect(result.current.tasks).toHaveLength(1);
    expect(result.current.tasks[0]).toMatchObject({ subject: 'Only task', status: 'pending' });
  });
});
