/**
 * Coming back to the tab does not re-read what the app already holds (DOR-2896).
 *
 * Driven through the app's REAL client config and TanStack's own focus manager,
 * the same `visibilitychange` path a browser takes, so the test fails if the
 * default ever flips back rather than only if one constant changes.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { QueryClient, QueryObserver, focusManager } from '@tanstack/react-query';
import { createQueryClientConfig } from '../query-client';
import { QUERY_TIMING } from '../constants';

/** Mount `count` observers on stale queries and count the fetches each makes. */
async function mountStaleQueries(client: QueryClient, count: number, opts = {}) {
  const fetches = vi.fn(async () => 'value');
  const unsubscribes: Array<() => void> = [];
  for (let i = 0; i < count; i++) {
    const observer = new QueryObserver(client, { queryKey: ['q', i], queryFn: fetches, ...opts });
    unsubscribes.push(observer.subscribe(() => {}));
  }
  await vi.waitFor(() => expect(fetches).toHaveBeenCalledTimes(count));
  return { fetches, unmount: () => unsubscribes.forEach((u) => u()) };
}

/** Hide the tab, then show it again, the way a browser reports it. */
function leaveAndComeBack(): void {
  focusManager.setFocused(false);
  focusManager.setFocused(true);
}

describe('query client focus policy', () => {
  afterEach(() => {
    focusManager.setFocused(undefined);
    vi.useRealTimers();
  });

  it('sends no request for mounted queries when the tab is shown again', async () => {
    const client = new QueryClient(createQueryClientConfig());
    client.mount();
    const { fetches, unmount } = await mountStaleQueries(client, 25);
    fetches.mockClear();
    // Older than the default stale time: before DOR-2896 each one re-read here.
    vi.useFakeTimers({ now: Date.now() + QUERY_TIMING.DEFAULT_STALE_TIME_MS + 1_000 });

    leaveAndComeBack();
    await vi.advanceTimersByTimeAsync(10);

    expect(fetches).not.toHaveBeenCalled();
    unmount();
    client.unmount();
  });

  it('still re-reads a query that opted back in', async () => {
    const client = new QueryClient(createQueryClientConfig());
    client.mount();
    const { fetches, unmount } = await mountStaleQueries(client, 1, {
      refetchOnWindowFocus: true,
      staleTime: 0,
    });
    fetches.mockClear();

    leaveAndComeBack();

    await vi.waitFor(() => expect(fetches).toHaveBeenCalledTimes(1));
    unmount();
    client.unmount();
  });
});
