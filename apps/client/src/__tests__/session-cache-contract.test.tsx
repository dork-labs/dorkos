/**
 * @vitest-environment jsdom
 *
 * The session list has one writer that everybody reads and several readers that
 * nobody writes for. This file mounts the REAL writer and calls the REAL
 * readers, so the only thing that can make it pass is the two of them landing
 * on the same cache entry.
 *
 * Seeding the cache by hand would prove nothing: a test that writes the key its
 * own reader reads builds the world in which the code works. That is exactly
 * how a banner read `['session', id]` for months while the app wrote
 * `['session', id, cwd]` (DOR-482) — the reader's own test was the only thing
 * that ever filled the short key. So there is no `setQueryData` for the session
 * list anywhere below; every entry gets there the way it gets there in the app.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Session } from '@dorkos/shared/types';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import {
  useSessions,
  useRecentSessions,
  useRenameSession,
  useGlobalSessionStream,
  useSessionListStore,
  resolveSessionForCwd,
} from '@/layers/entities/session';
import { sessionRouteLoader } from '../router';

const CWD = '/projects/api';

// The global stream's `connectList()` must not open a real SSE fetch in jsdom.
// Everything else about the bridge stays real — it is the writer under test.
vi.mock('@/layers/shared/lib/transport', () => ({
  streamManager: {
    connectList: vi.fn(),
    setListeners: vi.fn(),
    attachSession: vi.fn(),
    getAttachedSessionId: vi.fn().mockReturnValue(null),
    subscribeListConnectionState: vi.fn().mockReturnValue(() => {}),
  },
}));

vi.mock('@/layers/entities/session/model/use-session-id', () => ({
  useSessionId: () => [null, vi.fn()] as const,
}));

vi.mock('@/layers/shared/model/app-store', () => ({
  useAppStore: () => ({ selectedCwd: CWD }),
}));

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'listed-1',
    title: 'From the server',
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T12:00:00.000Z',
    permissionMode: 'default',
    runtime: 'claude-code',
    cwd: CWD,
    ...overrides,
  };
}

const AGENT_ACTIVITY = { [CWD]: '2026-03-01T12:00:00.000Z' };

function createHarness(sessions: Session[] = [makeSession()], overrides: Partial<Transport> = {}) {
  const transport = createMockTransport({
    listSessions: vi.fn().mockResolvedValue({ sessions }),
    listRecentSessions: vi.fn().mockResolvedValue({ sessions, agentActivity: AGENT_ACTIVITY }),
    ...overrides,
  }) as Transport;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return { transport, queryClient, wrapper };
}

/** Run the `/session` loader and report the session id it redirects to. */
function loaderRedirectSession(queryClient: QueryClient, dir: string | undefined): string | null {
  try {
    sessionRouteLoader({
      context: { queryClient },
      deps: { dir, session: undefined, runtime: undefined, prompt: undefined },
    });
    return null;
  } catch (thrown: unknown) {
    return (thrown as { options: { search: { session: string } } }).options.search.session;
  }
}

/** The status frame a retire announce carries, with everything else empty. */
function retireAnnounce(retiredSessionId: string, sessionId: string) {
  return {
    type: 'session_status',
    sessionId,
    retiredSessionId,
    status: {
      contextUsage: null,
      cost: null,
      usage: null,
      cacheStats: null,
      model: null,
      permissionMode: 'default',
      todoCounts: null,
      runningSubagentCount: 0,
      lifecycle: 'streaming',
      lastError: null,
    },
  } as const;
}

beforeEach(() => {
  vi.clearAllMocks();
  useSessionListStore.setState({ sessions: {}, rekeys: {} });
});

describe('session list: one writer, many readers', () => {
  it('the /session loader auto-selects the session the list query fetched', async () => {
    // Red when: the loader and `useSessions` build the list key differently —
    // the loader finds nothing and mints a random UUID instead.
    const { queryClient, wrapper } = createHarness();
    const { result } = renderHook(() => useSessions(), { wrapper });
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));

    expect(loaderRedirectSession(queryClient, CWD)).toBe('listed-1');
  });

  it('a navigation reuses the session the list query fetched', async () => {
    // Red when: `resolveSessionForCwd` and `useSessions` disagree on the key —
    // every agent switch would open a brand-new empty session instead.
    const { queryClient, wrapper } = createHarness();
    const { result } = renderHook(() => useSessions(), { wrapper });
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));

    expect(resolveSessionForCwd(queryClient, CWD)).toBe('listed-1');
  });

  it('an optimistic rename shows up in the list every other surface reads', async () => {
    // Red when: the rename mutation writes a key `useSessions` does not read —
    // the sidebar row would keep the old title until a full refetch.
    //
    // The PATCH is left in flight on purpose: settling it refetches the list
    // and would hide whether the optimistic write ever landed in the right
    // place.
    const { wrapper } = createHarness(undefined, {
      updateSession: vi.fn().mockReturnValue(new Promise(() => {})),
    });
    const { result } = renderHook(() => ({ list: useSessions(), rename: useRenameSession(CWD) }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.list.sessions).toHaveLength(1));

    act(() => {
      result.current.rename.mutate({ sessionId: 'listed-1', title: 'Renamed' });
    });

    await waitFor(() => expect(result.current.list.sessions[0].title).toBe('Renamed'));
  });

  it('a session started elsewhere arrives in the list the sidebar reads', async () => {
    // Red when: the `/api/events` bridge writes a key `useSessions` does not
    // read — a session started from the CLI would never appear without a refresh.
    const { wrapper } = createHarness();
    const { result } = renderHook(
      () => ({ list: useSessions(), stream: useGlobalSessionStream() }),
      {
        wrapper,
      }
    );
    await waitFor(() => expect(result.current.list.sessions).toHaveLength(1));

    act(() => {
      useSessionListStore.getState().applyListEvent({
        type: 'session_upserted',
        session: makeSession({ id: 'cli-1', updatedAt: '2026-03-02T00:00:00.000Z' }),
      });
    });

    await waitFor(() =>
      expect(result.current.list.sessions.map((s) => s.id)).toEqual(['cli-1', 'listed-1'])
    );
  });
});

describe('session list: what may live under the list prefix', () => {
  it('a retire announce re-ids the placeholder row in the list', async () => {
    // Red when: the retired-session sweep stops reaching the list cache — the
    // rail keeps a dead duplicate row pointing at an id the server retired.
    const { wrapper } = createHarness([makeSession({ id: 'client-uuid' })]);
    const { result } = renderHook(
      () => ({ list: useSessions(), stream: useGlobalSessionStream() }),
      {
        wrapper,
      }
    );
    await waitFor(() => expect(result.current.list.sessions).toHaveLength(1));

    act(() => {
      useSessionListStore.getState().applyListEvent(retireAnnounce('client-uuid', 'canonical'));
    });

    await waitFor(() => expect(result.current.list.sessions[0].id).toBe('canonical'));
  });

  it('a retire announce leaves the cross-agent Recent list alone', async () => {
    // The sweep rewrites every entry under the list prefix as a `Session[]`.
    // Recent sessions are an envelope object, so parking them under that prefix
    // made the sweep call `.some()` on a plain object and throw (DOR-497).
    //
    // Red when: the recent-sessions key moves back under the list prefix — the
    // retire throws, and the envelope it should never have touched comes back
    // mangled.
    const { wrapper } = createHarness([makeSession({ id: 'client-uuid' })]);
    const { result } = renderHook(
      () => ({
        list: useSessions(),
        recent: useRecentSessions(),
        stream: useGlobalSessionStream(),
      }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.recent.isSuccess).toBe(true));

    expect(() =>
      act(() => {
        useSessionListStore.getState().applyListEvent(retireAnnounce('client-uuid', 'canonical'));
      })
    ).not.toThrow();

    expect(result.current.recent.data?.agentActivity).toEqual(AGENT_ACTIVITY);
    expect(result.current.recent.data?.sessions.map((s) => s.id)).toEqual(['client-uuid']);
  });
});
