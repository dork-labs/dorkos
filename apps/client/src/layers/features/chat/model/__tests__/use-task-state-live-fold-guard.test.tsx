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

describe('useTaskState — live-fold survives a same-session empty history response (DOR-1632)', () => {
  let mockTransport: ReturnType<typeof createMockTransport>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTransport = createMockTransport();
  });

  it('keeps a live-folded task when the initial history fetch resolves empty afterward, for the same session', async () => {
    // The history fetch resolves empty AFTER we've already folded a live
    // event locally — a real race: the live stream got there first.
    mockTransport.getTasks = vi.fn().mockResolvedValue({ tasks: [] });

    const { result } = renderHook(() => useTaskState('session-1'), {
      wrapper: createWrapper(mockTransport),
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

  it('resets state on a genuine session change even when the new session has no history yet', async () => {
    mockTransport.getTasks = vi.fn().mockResolvedValue({ tasks: [] });

    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) => useTaskState(sessionId),
      { wrapper: createWrapper(mockTransport), initialProps: { sessionId: 'session-1' } }
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
