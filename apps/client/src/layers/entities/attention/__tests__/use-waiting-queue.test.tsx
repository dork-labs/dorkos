/**
 * @vitest-environment jsdom
 */
/**
 * A failed read is "could not check", and "Try again" reads exactly the failed
 * ones again (DOR-2578).
 *
 * Seeded defects: drop a read's error from `isAnyError` and the first case
 * reads as an empty, quiet queue; drop the `status === 'error'` predicate from
 * `retryFailed` and the healthy approvals read is repeated too.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';

// No live stream here: the queue's reads are what is under test.
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useEventSubscription: () => {} };
});

import { TransportProvider } from '@/layers/shared/model';
import { useWaitingQueue } from '../model/use-waiting-queue';

/** The two extension reads are plain `fetch` calls, answered empty here. */
function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  const body = url.endsWith('/extension-decisions')
    ? { decisions: [], offers: [] }
    : { approvals: [] };
  return Promise.resolve(new Response(JSON.stringify(body)));
}

function setup() {
  const transport = createMockTransport({
    listPendingInteractions: vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ interactions: [] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  return { transport, wrapper };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useWaitingQueue — failed reads', () => {
  it('reports a failed read as could-not-check, not as an empty queue', async () => {
    const { wrapper } = setup();

    const { result } = renderHook(() => useWaitingQueue(), { wrapper });

    await waitFor(() => expect(result.current.isAnyError).toBe(true));
    expect(result.current.items).toHaveLength(0);
    // The approvals read itself was fine, so the bell's approvals card stays away.
    expect(result.current.isError).toBe(false);
  });

  it('reads only the failed queues again when asked', async () => {
    const { transport, wrapper } = setup();
    const { result } = renderHook(() => useWaitingQueue(), { wrapper });
    await waitFor(() => expect(result.current.isAnyError).toBe(true));
    await waitFor(() => expect(transport.listPendingApprovals).toHaveBeenCalledTimes(1));

    act(() => result.current.retryFailed());

    await waitFor(() => expect(result.current.isAnyError).toBe(false));
    expect(transport.listPendingInteractions).toHaveBeenCalledTimes(2);
    expect(transport.listPendingApprovals).toHaveBeenCalledTimes(1);
  });
});
