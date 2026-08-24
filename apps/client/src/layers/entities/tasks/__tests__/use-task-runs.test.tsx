/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { createMockRun } from '@dorkos/test-utils';
import type { ListTaskRunsQuery } from '@dorkos/shared/types';
import {
  useTaskRuns,
  useInfiniteTaskRuns,
  useTaskRun,
  useCancelTaskRun,
} from '../model/use-task-runs';

function createWrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

/**
 * An infinite query needs its pages to survive between fetches, so this wrapper
 * keeps the default `gcTime` rather than the zero the single-shot tests use —
 * at `gcTime: 0` a page is collected the moment it has no observer and the
 * accumulated list resets to one page.
 */
function createInfiniteWrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('useInfiniteTaskRuns', () => {
  const PAGE_SIZE = 2;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** A paginated server whose run list the test can rewrite between fetches. */
  function paginatedTransport(runs = [createMockRun({ id: 'run-1' })]) {
    const store = { runs };
    const listTaskRuns = vi.fn((opts?: Partial<ListTaskRunsQuery>) => {
      const offset = opts?.offset ?? 0;
      const limit = opts?.limit ?? 50;
      return Promise.resolve(store.runs.slice(offset, offset + limit));
    });
    return { transport: createMockTransport({ listTaskRuns }), store, listTaskRuns };
  }

  it('asks for the first page at offset 0', async () => {
    const { transport, listTaskRuns } = paginatedTransport();

    const { result } = renderHook(
      () => useInfiniteTaskRuns({ scheduleId: 'sched-1', limit: PAGE_SIZE }),
      { wrapper: createInfiniteWrapper(transport) }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(listTaskRuns).toHaveBeenCalledWith({
      scheduleId: 'sched-1',
      limit: PAGE_SIZE,
      offset: 0,
    });
  });

  it('walks the offset forward while pages come back full, then stops', async () => {
    const { transport, listTaskRuns } = paginatedTransport([
      createMockRun({ id: 'run-1' }),
      createMockRun({ id: 'run-2' }),
      createMockRun({ id: 'run-3' }),
    ]);

    const { result } = renderHook(() => useInfiniteTaskRuns({ limit: PAGE_SIZE }), {
      wrapper: createInfiniteWrapper(transport),
    });

    // A full page means there may be more behind it.
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));

    act(() => {
      void result.current.fetchNextPage();
    });

    await waitFor(() => expect(result.current.data!.pages).toHaveLength(2));
    expect(listTaskRuns).toHaveBeenLastCalledWith({ limit: PAGE_SIZE, offset: PAGE_SIZE });
    expect(result.current.data!.pages.flat().map((r) => r.id)).toEqual(['run-1', 'run-2', 'run-3']);
    // A short page is the last one — nothing left to ask for.
    expect(result.current.hasNextPage).toBe(false);
  });

  it('refetches EVERY loaded page, so an earlier page cannot go stale', async () => {
    // This is the whole reason the panel uses an infinite query instead of
    // concatenating pages into component state: a run goes `running` →
    // `completed` while it is on screen, and page one has to hear about it.
    const { transport, store } = paginatedTransport([
      createMockRun({ id: 'run-1', status: 'running' }),
      createMockRun({ id: 'run-2', status: 'completed' }),
      createMockRun({ id: 'run-3', status: 'completed' }),
    ]);

    const { result } = renderHook(() => useInfiniteTaskRuns({ limit: PAGE_SIZE }), {
      wrapper: createInfiniteWrapper(transport),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    act(() => {
      void result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.data!.pages).toHaveLength(2));

    store.runs = store.runs.map((run) =>
      run.id === 'run-1' ? { ...run, status: 'completed' as const } : run
    );
    act(() => {
      void result.current.refetch();
    });

    // The run on the FIRST page is the one that moved.
    await waitFor(() =>
      expect(result.current.data!.pages.flat().find((r) => r.id === 'run-1')!.status).toBe(
        'completed'
      )
    );
    // ...and page two is still there, not dropped by the refetch.
    expect(result.current.data!.pages).toHaveLength(2);
    expect(result.current.data!.pages.flat()).toHaveLength(3);
  });

  it('is skipped entirely when disabled', () => {
    const { transport, listTaskRuns } = paginatedTransport();

    renderHook(() => useInfiniteTaskRuns({ limit: PAGE_SIZE }, false), {
      wrapper: createInfiniteWrapper(transport),
    });

    expect(listTaskRuns).not.toHaveBeenCalled();
  });
});

describe('useTaskRuns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches runs via transport.listTaskRuns', async () => {
    const runs = [createMockRun({ id: 'run-1' }), createMockRun({ id: 'run-2' })];
    const transport = createMockTransport({
      listTaskRuns: vi.fn().mockResolvedValue(runs),
    });

    const { result } = renderHook(() => useTaskRuns(), { wrapper: createWrapper(transport) });

    await waitFor(() => {
      expect(result.current.data).toHaveLength(2);
    });

    expect(result.current.data![0].id).toBe('run-1');
    expect(result.current.data![1].id).toBe('run-2');
    expect(transport.listTaskRuns).toHaveBeenCalledWith(undefined);
  });

  it('passes filter options to transport.listTaskRuns', async () => {
    const transport = createMockTransport({
      listTaskRuns: vi.fn().mockResolvedValue([]),
    });
    const opts = { taskId: 'task-1', limit: 10 };

    const { result } = renderHook(() => useTaskRuns(opts), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(transport.listTaskRuns).toHaveBeenCalledWith(opts);
  });

  it('returns loading state initially', () => {
    const transport = createMockTransport({
      listTaskRuns: vi.fn().mockReturnValue(new Promise(() => {})),
    });

    const { result } = renderHook(() => useTaskRuns(), { wrapper: createWrapper(transport) });

    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeUndefined();
  });

  it('polls every 10 seconds when a run is active', async () => {
    vi.useFakeTimers();
    try {
      const runs = [createMockRun({ id: 'run-1', status: 'running' })];
      const transport = createMockTransport({
        listTaskRuns: vi.fn().mockResolvedValue(runs),
      });

      renderHook(() => useTaskRuns(), { wrapper: createWrapper(transport) });

      // Wait for initial fetch
      await vi.advanceTimersByTimeAsync(0);
      const initialCallCount = (transport.listTaskRuns as ReturnType<typeof vi.fn>).mock.calls
        .length;

      // Advance past the refetch interval
      await vi.advanceTimersByTimeAsync(10_000);

      expect(
        (transport.listTaskRuns as ReturnType<typeof vi.fn>).mock.calls.length
      ).toBeGreaterThan(initialCallCount);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops polling when no runs are active', async () => {
    vi.useFakeTimers();
    try {
      const transport = createMockTransport({
        listTaskRuns: vi.fn().mockResolvedValue([]),
      });

      renderHook(() => useTaskRuns(), { wrapper: createWrapper(transport) });

      // Wait for initial fetch
      await vi.advanceTimersByTimeAsync(0);
      const initialCallCount = (transport.listTaskRuns as ReturnType<typeof vi.fn>).mock.calls
        .length;

      // Advance well past the refetch interval — should not trigger a refetch
      await vi.advanceTimersByTimeAsync(10_000);

      expect((transport.listTaskRuns as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
        initialCallCount
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useTaskRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches a single run by ID', async () => {
    const run = createMockRun({ id: 'run-42', status: 'running' });
    const transport = createMockTransport({
      getTaskRun: vi.fn().mockResolvedValue(run),
    });

    const { result } = renderHook(() => useTaskRun('run-42'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });

    expect(result.current.data!.id).toBe('run-42');
    expect(result.current.data!.status).toBe('running');
    expect(transport.getTaskRun).toHaveBeenCalledWith('run-42');
  });

  it('is disabled when id is null', () => {
    const getTaskRun = vi.fn();
    const transport = createMockTransport({ getTaskRun });

    const { result } = renderHook(() => useTaskRun(null), {
      wrapper: createWrapper(transport),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(getTaskRun).not.toHaveBeenCalled();
  });

  it('refetches when id changes from null to a value', async () => {
    const run = createMockRun({ id: 'run-99' });
    const transport = createMockTransport({
      getTaskRun: vi.fn().mockResolvedValue(run),
    });

    let runId: string | null = null;
    const { result, rerender } = renderHook(() => useTaskRun(runId), {
      wrapper: createWrapper(transport),
    });

    // Initially disabled
    expect(result.current.fetchStatus).toBe('idle');
    expect(transport.getTaskRun).not.toHaveBeenCalled();

    // Enable by setting id
    runId = 'run-99';
    rerender();

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });

    expect(transport.getTaskRun).toHaveBeenCalledWith('run-99');
  });
});

describe('useCancelTaskRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls transport.cancelTaskRun with the run ID', async () => {
    const transport = createMockTransport({
      cancelTaskRun: vi.fn().mockResolvedValue({ success: true, state: 'stopping' }),
    });

    const { result } = renderHook(() => useCancelTaskRun(), {
      wrapper: createWrapper(transport),
    });

    await act(async () => {
      result.current.mutate('run-to-cancel');
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(transport.cancelTaskRun).toHaveBeenCalledWith('run-to-cancel');
  });

  it('invalidates task run queries on success', async () => {
    const runs = [createMockRun({ id: 'run-1', status: 'running' })];
    const transport = createMockTransport({
      listTaskRuns: vi.fn().mockResolvedValue(runs),
      cancelTaskRun: vi.fn().mockResolvedValue({ success: true, state: 'stopping' }),
    });

    const wrapper = createWrapper(transport);

    // Render both hooks in the same query client context
    const { result: runsResult } = renderHook(() => useTaskRuns(), { wrapper });
    const { result: cancelResult } = renderHook(() => useCancelTaskRun(), { wrapper });

    // Wait for initial runs fetch
    await waitFor(() => {
      expect(runsResult.current.data).toBeDefined();
    });

    const callsBefore = (transport.listTaskRuns as ReturnType<typeof vi.fn>).mock.calls.length;

    // Cancel a run
    await act(async () => {
      cancelResult.current.mutate('run-1');
    });

    await waitFor(() => {
      expect(cancelResult.current.isSuccess).toBe(true);
    });

    // listTaskRuns should have been called again due to query invalidation
    await waitFor(() => {
      expect(
        (transport.listTaskRuns as ReturnType<typeof vi.fn>).mock.calls.length
      ).toBeGreaterThan(callsBefore);
    });
  });

  it('handles cancel failure', async () => {
    const transport = createMockTransport({
      cancelTaskRun: vi.fn().mockRejectedValue(new Error('Run not found')),
    });

    const { result } = renderHook(() => useCancelTaskRun(), {
      wrapper: createWrapper(transport),
    });

    await act(async () => {
      result.current.mutate('nonexistent-run');
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBeInstanceOf(Error);
  });
});
