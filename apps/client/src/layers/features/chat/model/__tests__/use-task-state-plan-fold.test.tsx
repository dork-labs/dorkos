/**
 * The to-do panel's open/closed rule: the plan follows the turn that writes it.
 *
 * Ten task rows plus a progress header sit between the transcript and the
 * composer, so a finished plan left open is a screenful of history in the place
 * a person is trying to type (DOR-1759, batch 13.2).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SessionLifecycle } from '@dorkos/shared/session-stream';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useTaskState } from '../use-task-state';

/** What the session stream says this session is doing, per case. */
let mockLifecycle: SessionLifecycle | undefined = 'idle';

vi.mock('@/layers/entities/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session')>()),
  useSessionStreamLifecycle: () => mockLifecycle,
}));

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...original,
    useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
      const state = { selectedCwd: '/test/cwd', enableMessagePolling: false };
      return selector ? selector(state) : state;
    },
    // The session's own reads take their directory from the URL, not the store
    // (DOR-1444).
    useSafeSearch: () => ({ dir: '/test/cwd' }),
  };
});

function createWrapper() {
  const transport = createMockTransport({ getTasks: vi.fn().mockResolvedValue({ tasks: [] }) });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  mockLifecycle = 'idle';
});

describe('useTaskState — when the plan is open', () => {
  it('folds the plan away when the turn that wrote it ends', () => {
    mockLifecycle = 'streaming';
    const { result, rerender } = renderHook(() => useTaskState('s1'), { wrapper: createWrapper() });
    expect(result.current.isCollapsed).toBe(false);

    mockLifecycle = 'idle';
    rerender();

    expect(result.current.isCollapsed).toBe(true);
  });

  it('keeps the plan open while the agent is parked on a question', () => {
    mockLifecycle = 'streaming';
    const { result, rerender } = renderHook(() => useTaskState('s1'), { wrapper: createWrapper() });

    mockLifecycle = 'blocked';
    rerender();

    expect(result.current.isCollapsed).toBe(false);
  });

  it('arrives folded on a session whose turn ended before this window opened', () => {
    mockLifecycle = 'idle';
    const { result } = renderHook(() => useTaskState('s1'), { wrapper: createWrapper() });
    expect(result.current.isCollapsed).toBe(true);
  });

  it('leaves a plan opened by hand open until the next turn ends', () => {
    const { result, rerender } = renderHook(() => useTaskState('s1'), { wrapper: createWrapper() });
    act(() => result.current.toggleCollapse());
    expect(result.current.isCollapsed).toBe(false);

    // Still idle: nothing has happened that would close it again.
    rerender();
    expect(result.current.isCollapsed).toBe(false);
  });

  it('does not re-open a plan the person put away', () => {
    mockLifecycle = 'streaming';
    const { result, rerender } = renderHook(() => useTaskState('s1'), { wrapper: createWrapper() });
    act(() => result.current.toggleCollapse());
    expect(result.current.isCollapsed).toBe(true);

    mockLifecycle = 'idle';
    rerender();
    mockLifecycle = 'streaming';
    rerender();

    expect(result.current.isCollapsed).toBe(true);
  });
});
