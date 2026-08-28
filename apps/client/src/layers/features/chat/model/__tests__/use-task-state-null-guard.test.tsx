/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { useTaskState } from '../use-task-state';

// Suppress useAppStore selectedCwd selector
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...original,
    useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
      const state = { selectedCwd: '/test/cwd' };
      return selector ? selector(state) : state;
    },
    // The session's own reads take their directory from the URL, not the
    // store (DOR-1444); mirrored here so this harness keeps meaning what it
    // did when both came from `selectedCwd`.
    useSafeSearch: () => ({ dir: '/test/cwd' }),
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

describe('useTaskState — null sessionId guard', () => {
  let mockTransport: ReturnType<typeof createMockTransport>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTransport = createMockTransport();
  });

  it('does not call getTasks when sessionId is null', () => {
    renderHook(() => useTaskState(null), { wrapper: createWrapper(mockTransport) });
    expect(mockTransport.getTasks).not.toHaveBeenCalled();
  });

  it('returns empty tasks when sessionId is null', () => {
    const { result } = renderHook(() => useTaskState(null), {
      wrapper: createWrapper(mockTransport),
    });
    expect(result.current.tasks).toHaveLength(0);
  });

  it('calls getTasks when sessionId is a non-empty string', async () => {
    mockTransport.getTasks = vi.fn().mockResolvedValue({ tasks: [] });
    renderHook(() => useTaskState('session-abc'), { wrapper: createWrapper(mockTransport) });
    // TanStack Query fires async — give it a tick
    await new Promise((r) => setTimeout(r, 0));
    expect(mockTransport.getTasks).toHaveBeenCalledWith('session-abc', expect.anything());
  });
});
