/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { RecentSessionsResponse, Session } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';

/**
 * Generic-event handlers the hook registered, keyed by event name, so a test can
 * deliver a global-stream event without an SSE connection.
 */
const eventHandlers = new Map<string, (data: unknown) => void>();

// Keep the effect from opening a real global stream — we only exercise the
// store → query-cache bridge, not the SSE transport.
vi.mock('@/layers/shared/lib/transport', () => ({
  streamManager: {
    connectList: vi.fn(),
    subscribeEvent: vi.fn((name: string, handler: (data: unknown) => void) => {
      eventHandlers.set(name, handler);
      return () => eventHandlers.delete(name);
    }),
  },
}));
vi.mock('../model/session-stream-binding', () => ({
  initSessionStreamBinding: vi.fn(),
  resetSessionStreamBinding: vi.fn(),
}));
// `useSessions` reads the active session id from the router search params; there
// is no router here (the same stub `use-sessions.test.tsx` uses).
vi.mock('../model/use-session-id', () => ({
  useSessionId: () => [null, vi.fn()] as const,
}));

import { useAppStore } from '@/layers/shared/model';
import { useGlobalSessionStream } from '../model/use-global-session-stream';
import { useRecentSessions } from '../model/use-recent-sessions';
import { useSessions } from '../model/use-sessions';
import { useSessionListStore } from '../model/session-list-store';
import { sessionKeys } from '../api/query-keys';

function makeSession(id: string): Session {
  return {
    id,
    title: `Session ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
    permissionMode: 'default',
    runtime: 'claude-code',
    cwd: '/projects/api',
  };
}

const envelope: RecentSessionsResponse = {
  sessions: [makeSession('existing')],
  agentActivity: { '/projects/api': '2026-03-01T00:00:00.000Z' },
};

describe('useGlobalSessionStream — recent-sessions invalidation', () => {
  beforeEach(() => {
    // Reset the singleton store so no leaked sessions trigger an initial reconcile.
    useSessionListStore.setState({ sessions: {}, rekeys: {} });
    vi.clearAllMocks();
  });

  it('refetches the Recent-sessions query on a session lifecycle event', async () => {
    // Mounts the real Recent query rather than spying on an invalidation key:
    // asserting the key the bridge passes could only ever agree with itself,
    // and the whole failure mode here is a prefix that stops matching the
    // reader's key.
    //
    // Red when: the bridge's invalidation prefix and the Recent query's key
    // drift apart — the sidebar's Recent section then goes stale for 30s at a
    // time with no other symptom.
    const transport = createMockTransport({
      listRecentSessions: vi.fn().mockResolvedValue(envelope),
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );

    const { result } = renderHook(
      () => ({ recent: useRecentSessions(), stream: useGlobalSessionStream() }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.recent.isSuccess).toBe(true));
    expect(transport.listRecentSessions).toHaveBeenCalledTimes(1);

    act(() => {
      useSessionListStore.getState().upsertSession(makeSession('a1'));
    });

    await waitFor(() => expect(transport.listRecentSessions).toHaveBeenCalledTimes(2));
  });
});

/**
 * A Claude account switch changes WHICH stores DorkOS reads, and the restarted
 * watcher only ever upserts — it never announces the sessions it stopped
 * watching as removed. So the server says "the whole list is stale" once
 * (`session_list_invalidated`, spec `claude-code-accounts` D5) and the client has
 * to drop what it holds. Without this the cockpit shows the union of the old and
 * new account sets until a manual reload.
 */
describe('useGlobalSessionStream — session_list_invalidated', () => {
  beforeEach(() => {
    useSessionListStore.setState({ sessions: {}, rekeys: {} });
    useAppStore.setState({ selectedCwd: '/projects/api' });
    eventHandlers.clear();
    vi.clearAllMocks();
  });

  it('drops the held session list and refetches it from the server', async () => {
    // The account switch happens between these two answers: the old account's
    // session is gone from the server's union, and only a refetch can learn that.
    const listSessions = vi
      .fn()
      .mockResolvedValueOnce({ sessions: [makeSession('from-old-account')] })
      .mockResolvedValue({ sessions: [makeSession('from-new-account')] });
    const transport = createMockTransport({ listSessions });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );

    const { result } = renderHook(
      () => ({ list: useSessions(), stream: useGlobalSessionStream() }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.list.sessions).toHaveLength(1));
    expect(result.current.list.sessions[0]!.id).toBe('from-old-account');

    // The live store is holding a row from the account that is no longer read.
    act(() => {
      useSessionListStore.getState().upsertSession(makeSession('from-old-account'));
    });
    expect(Object.keys(useSessionListStore.getState().sessions)).toEqual(['from-old-account']);

    act(() => {
      eventHandlers.get('session_list_invalidated')?.({ changedAt: '2026-07-29T00:00:00.000Z' });
    });

    // Red when the client ignores the event: the list keeps the old account's
    // session and the store keeps holding it.
    await waitFor(() => expect(result.current.list.sessions[0]?.id).toBe('from-new-account'));
    expect(useSessionListStore.getState().sessions).toEqual({});
  });
});

/**
 * The Activity tab's week line (DOR-1039) counts sessions across EVERY agent, so
 * it goes stale when a session appears or disappears — and only then. A
 * streaming turn upserts the same session many times a second, and a fan-out per
 * upsert would re-read every agent's transcripts for a number that cannot have
 * moved.
 */
describe('useGlobalSessionStream — daily-counts invalidation', () => {
  beforeEach(() => {
    useSessionListStore.setState({ sessions: {}, rekeys: {} });
    vi.clearAllMocks();
  });

  /**
   * Mount a reader of the week-count query beside the bridge. It stands in for
   * `widgets/activity`'s `useSessionActivity`, which this layer must not import
   * (FSD: entities never reach up into widgets) — both read under the same key
   * factory, which is the contract the bridge has to keep matching.
   */
  function mountWeekCount() {
    const getSessionDailyCounts = vi
      .fn()
      .mockResolvedValue({ days: 7, dailyCounts: [0, 0, 0, 0, 0, 0, 1], warnings: [] });
    const transport = createMockTransport({ getSessionDailyCounts });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
    const rendered = renderHook(
      () => ({
        week: useQuery({
          queryKey: sessionKeys.dailyCounts(7),
          queryFn: () => transport.getSessionDailyCounts(7),
        }),
        stream: useGlobalSessionStream(),
      }),
      { wrapper }
    );
    return { getSessionDailyCounts, ...rendered };
  }

  it('recounts the week when a session appears', async () => {
    // Red when: the bridge's invalidation prefix and the week query's key drift
    // apart — the count then sits still while the feed under it moves.
    const { getSessionDailyCounts, result } = mountWeekCount();
    await waitFor(() => expect(result.current.week.isSuccess).toBe(true));
    expect(getSessionDailyCounts).toHaveBeenCalledTimes(1);

    act(() => {
      useSessionListStore.getState().upsertSession(makeSession('brand-new'));
    });

    await waitFor(() => expect(getSessionDailyCounts).toHaveBeenCalledTimes(2));
  });

  it('does not recount while a session it already knows about keeps streaming', async () => {
    const { getSessionDailyCounts, result } = mountWeekCount();
    await waitFor(() => expect(result.current.week.isSuccess).toBe(true));

    act(() => {
      useSessionListStore.getState().upsertSession(makeSession('a1'));
    });
    await waitFor(() => expect(getSessionDailyCounts).toHaveBeenCalledTimes(2));

    // The same session, updated the way a streaming turn updates it.
    act(() => {
      for (let i = 0; i < 5; i++) {
        useSessionListStore
          .getState()
          .upsertSession({ ...makeSession('a1'), updatedAt: `2026-03-01T00:00:0${i}.000Z` });
      }
    });

    // Red when: every upsert invalidates the count — a fleet of streaming
    // sessions then re-reads every agent's transcript directory continuously.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getSessionDailyCounts).toHaveBeenCalledTimes(2);
  });
});
