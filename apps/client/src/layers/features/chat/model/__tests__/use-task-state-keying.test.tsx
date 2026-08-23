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

  it('resolves a TaskUpdate whose SDK id diverges from the local create counter via subject fallback', () => {
    const { result } = renderHook(() => useTaskState('session-1'), {
      wrapper: createWrapper(mockTransport),
    });

    act(() => {
      result.current.handleTaskEvent({
        action: 'create',
        task: { id: '', subject: 'First task', status: 'pending' },
      } as TaskUpdateEvent);
      result.current.handleTaskEvent({
        action: 'create',
        task: { id: '', subject: 'Second task', status: 'pending' },
      } as TaskUpdateEvent);
      // Non-sequential SDK id ("9") — the local counter only minted "1"/"2" —
      // but the update carries the subject, so the fallback should find it.
      result.current.handleTaskEvent({
        action: 'update',
        task: { id: '9', subject: 'Second task', status: 'completed' },
      } as TaskUpdateEvent);
    });

    const moved = result.current.tasks.find((t) => t.subject === 'Second task');
    expect(moved).toMatchObject({ id: '9', status: 'completed' });
    expect(result.current.taskMap.has('9')).toBe(true);

    // Re-keyed under the real id: a later id-only update (no subject, the
    // common case) now resolves directly without the fallback.
    act(() => {
      result.current.handleTaskEvent({
        action: 'update',
        task: { id: '9', subject: '', status: 'in_progress' },
      } as TaskUpdateEvent);
    });
    expect(result.current.taskMap.get('9')).toMatchObject({ status: 'in_progress' });
  });

  it('does not fall back when the update carries no subject and the id is unknown', () => {
    const { result } = renderHook(() => useTaskState('session-1'), {
      wrapper: createWrapper(mockTransport),
    });

    act(() => {
      result.current.handleTaskEvent({
        action: 'create',
        task: { id: '', subject: 'Only task', status: 'pending' },
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
