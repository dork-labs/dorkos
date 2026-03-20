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
import { useRuns, useRun, useCancelRun } from '../model/use-runs';

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

describe('useRuns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches runs via transport.listRuns', async () => {
    const runs = [createMockRun({ id: 'run-1' }), createMockRun({ id: 'run-2' })];
    const transport = createMockTransport({
      listRuns: vi.fn().mockResolvedValue(runs),
    });

    const { result } = renderHook(() => useRuns(), { wrapper: createWrapper(transport) });

    await waitFor(() => {
      expect(result.current.data).toHaveLength(2);
    });

    expect(result.current.data![0].id).toBe('run-1');
    expect(result.current.data![1].id).toBe('run-2');
    expect(transport.listRuns).toHaveBeenCalledWith(undefined);
  });

  it('passes filter options to transport.listRuns', async () => {
    const transport = createMockTransport({
      listRuns: vi.fn().mockResolvedValue([]),
    });
    const opts = { scheduleId: 'sched-1', limit: 10 };

    const { result } = renderHook(() => useRuns(opts), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(transport.listRuns).toHaveBeenCalledWith(opts);
  });

  it('returns loading state initially', () => {
    const transport = createMockTransport({
      listRuns: vi.fn().mockReturnValue(new Promise(() => {})),
    });

    const { result } = renderHook(() => useRuns(), { wrapper: createWrapper(transport) });

    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeUndefined();
  });

  it('polls every 10 seconds when a run is active', async () => {
    vi.useFakeTimers();
    try {
      const runs = [createMockRun({ id: 'run-1', status: 'running' })];
      const transport = createMockTransport({
        listRuns: vi.fn().mockResolvedValue(runs),
      });

      renderHook(() => useRuns(), { wrapper: createWrapper(transport) });

      // Wait for initial fetch
      await vi.advanceTimersByTimeAsync(0);
      const initialCallCount = (transport.listRuns as ReturnType<typeof vi.fn>).mock.calls.length;

      // Advance past the refetch interval
      await vi.advanceTimersByTimeAsync(10_000);

      expect((transport.listRuns as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
        initialCallCount
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops polling when no runs are active', async () => {
    vi.useFakeTimers();
    try {
      const transport = createMockTransport({
        listRuns: vi.fn().mockResolvedValue([]),
      });

      renderHook(() => useRuns(), { wrapper: createWrapper(transport) });

      // Wait for initial fetch
      await vi.advanceTimersByTimeAsync(0);
      const initialCallCount = (transport.listRuns as ReturnType<typeof vi.fn>).mock.calls.length;

      // Advance well past the refetch interval — should not trigger a refetch
      await vi.advanceTimersByTimeAsync(10_000);

      expect((transport.listRuns as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
        initialCallCount
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches a single run by ID', async () => {
    const run = createMockRun({ id: 'run-42', status: 'running' });
    const transport = createMockTransport({
      getRun: vi.fn().mockResolvedValue(run),
    });

    const { result } = renderHook(() => useRun('run-42'), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });

    expect(result.current.data!.id).toBe('run-42');
    expect(result.current.data!.status).toBe('running');
    expect(transport.getRun).toHaveBeenCalledWith('run-42');
  });

  it('is disabled when id is null', () => {
    const transport = createMockTransport();

    const { result } = renderHook(() => useRun(null), {
      wrapper: createWrapper(transport),
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(transport.getRun).not.toHaveBeenCalled();
  });

  it('refetches when id changes from null to a value', async () => {
    const run = createMockRun({ id: 'run-99' });
    const transport = createMockTransport({
      getRun: vi.fn().mockResolvedValue(run),
    });

    let runId: string | null = null;
    const { result, rerender } = renderHook(() => useRun(runId), {
      wrapper: createWrapper(transport),
    });

    // Initially disabled
    expect(result.current.fetchStatus).toBe('idle');
    expect(transport.getRun).not.toHaveBeenCalled();

    // Enable by setting id
    runId = 'run-99';
    rerender();

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });

    expect(transport.getRun).toHaveBeenCalledWith('run-99');
  });
});

describe('useCancelRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls transport.cancelRun with the run ID', async () => {
    const transport = createMockTransport({
      cancelRun: vi.fn().mockResolvedValue({ success: true }),
    });

    const { result } = renderHook(() => useCancelRun(), {
      wrapper: createWrapper(transport),
    });

    await act(async () => {
      result.current.mutate('run-to-cancel');
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(transport.cancelRun).toHaveBeenCalledWith('run-to-cancel');
  });

  it('invalidates runs queries on success', async () => {
    const runs = [createMockRun({ id: 'run-1', status: 'running' })];
    const transport = createMockTransport({
      listRuns: vi.fn().mockResolvedValue(runs),
      cancelRun: vi.fn().mockResolvedValue({ success: true }),
    });

    const wrapper = createWrapper(transport);

    // Render both hooks in the same query client context
    const { result: runsResult } = renderHook(() => useRuns(), { wrapper });
    const { result: cancelResult } = renderHook(() => useCancelRun(), { wrapper });

    // Wait for initial runs fetch
    await waitFor(() => {
      expect(runsResult.current.data).toBeDefined();
    });

    const callsBefore = (transport.listRuns as ReturnType<typeof vi.fn>).mock.calls.length;

    // Cancel a run
    await act(async () => {
      cancelResult.current.mutate('run-1');
    });

    await waitFor(() => {
      expect(cancelResult.current.isSuccess).toBe(true);
    });

    // listRuns should have been called again due to query invalidation
    await waitFor(() => {
      expect((transport.listRuns as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
        callsBefore
      );
    });
  });

  it('handles cancel failure', async () => {
    const transport = createMockTransport({
      cancelRun: vi.fn().mockRejectedValue(new Error('Run not found')),
    });

    const { result } = renderHook(() => useCancelRun(), {
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
