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
import { renderHook, render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Session } from '@dorkos/shared/types';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import {
  useSessions,
  useRecentSessions,
  useRenameSession,
  useGlobalSessionStream,
  useSessionListStore,
  useSessionDetail,
  useSessionStatus,
  useSessionSettingsOverridesStore,
  resolveSessionForCwd,
  SessionRow,
} from '@/layers/entities/session';
import { sessionRouteLoader } from '../router';

// Hoisted so the `app-store` mock factory below — which vitest lifts above every
// top-level statement — can read it without touching the temporal dead zone.
const { CWD } = vi.hoisted(() => ({ CWD: '/projects/api' }));

// The global stream's `connectList()` must not open a real SSE fetch in jsdom.
// Everything else about the bridge stays real — it is the writer under test.
vi.mock('@/layers/shared/lib/transport', () => ({
  streamManager: {
    connectList: vi.fn(),
    setListeners: vi.fn(),
    attachSession: vi.fn(),
    getAttachedSessionId: vi.fn().mockReturnValue(null),
    subscribeListConnectionState: vi.fn().mockReturnValue(() => {}),
    // The bridge also listens for `session_list_invalidated` (a Claude account
    // switch); these cases drive the store directly and never fire it.
    subscribeEvent: vi.fn().mockReturnValue(() => {}),
  },
}));

vi.mock('@/layers/entities/session/model/use-session-id', () => ({
  useSessionId: () => [null, vi.fn()] as const,
}));

// Both call styles are in use: `useSessions` destructures the whole store,
// `useSessionDetail` passes a selector. A mock that answers only the first hands
// the selector caller the state object where it expects a cwd string, which
// empties the detail key and quietly disables the very query under test.
vi.mock('@/layers/shared/model/app-store', () => {
  const state = { selectedCwd: CWD };
  return {
    useAppStore: <T,>(select?: (s: typeof state) => T) => (select ? select(state) : state),
  };
});

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
  useSessionSettingsOverridesStore.setState({ bySession: {} });
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

/**
 * The rail's bypass shield, against the two caches that both claim to know a
 * session's permission mode.
 *
 * A row reads the detail cache first and its own list row second. The detail
 * entry belongs to whichever session the person last had open, and a row holds
 * it open forever without ever refetching it — so the two can disagree, and the
 * older one used to win. Every case below therefore mounts the REAL writers and
 * lets each cache fill the way it fills in the app: seeding the detail key by
 * hand is precisely the move that made the first round of these tests pass while
 * the rail went quiet about a bypassing session (DOR-496).
 */
describe('session permission mode: the fresher answer wins', () => {
  /** What the chat panel mounts while a session is open — the one fetch that fills the detail cache. */
  function OpenSession({ sessionId }: { sessionId: string }) {
    const { data } = useSessionDetail(sessionId);
    return <span data-testid="open-session-mode">{data?.permissionMode ?? 'pending'}</span>;
  }

  /** The status line's real writer: applies optimism, PATCHes, writes the detail cache back. */
  function StatusLine({ sessionId }: { sessionId: string }) {
    const { updateSession } = useSessionStatus(sessionId, null, false);
    return (
      <button
        type="button"
        onClick={() => void updateSession({ permissionMode: 'bypassPermissions' })}
      >
        Switch to bypass
      </button>
    );
  }

  /** The sidebar rail, rendered from the same list cache the app renders it from. */
  function Rail({ openSessionId }: { openSessionId: string | null }) {
    useGlobalSessionStream();
    const { sessions } = useSessions();
    return (
      <TooltipProvider>
        {openSessionId !== null && (
          <>
            <OpenSession sessionId={openSessionId} />
            <StatusLine sessionId={openSessionId} />
          </>
        )}
        {sessions.map((session) => (
          <SessionRow
            key={session.id}
            variant="full"
            session={session}
            isActive={false}
            onClick={() => {}}
          />
        ))}
      </TooltipProvider>
    );
  }

  it('warns when a session starts bypassing after the person moved on from it', async () => {
    // Red when: the row prefers a detail row nothing refreshes over the list row
    // the `/api/events` bridge just wrote. The shield sits in the always-visible
    // header, so a bypassing session loses its warning in the rail at a glance —
    // the inverse of the property this indicator exists for (DOR-496).
    const getSession = vi.fn().mockResolvedValue(makeSession({ permissionMode: 'default' }));
    const { wrapper } = createHarness([makeSession({ permissionMode: 'default' })], { getSession });

    const { rerender } = render(<Rail openSessionId="listed-1" />, { wrapper });
    await waitFor(() =>
      expect(screen.getByTestId('open-session-mode')).toHaveTextContent('default')
    );
    expect(screen.queryByLabelText('Permissions bypassed')).not.toBeInTheDocument();

    // The person moves on. Their detail row stays in the cache: the rail's own
    // read keeps a live observer on it, so it is never collected — and it is
    // gated off from fetching, so it is never refreshed either.
    rerender(<Rail openSessionId={null} />);

    // The mode changes somewhere else — another window, a dispatched task — and
    // reaches this client the only way live list changes ever do.
    act(() => {
      useSessionListStore.getState().applyListEvent({
        type: 'session_upserted',
        session: makeSession({
          permissionMode: 'bypassPermissions',
          updatedAt: '2026-03-02T00:00:00.000Z',
        }),
      });
    });

    expect(await screen.findByLabelText('Permissions bypassed')).toBeInTheDocument();
  });

  it('warns about a bypass only the runtime profile can name', async () => {
    // The same staleness read through the row's other half. A row judges the mode
    // by what its runtime declared the mode DOES whenever the capability map has
    // landed, and by the mode's name only until then. `dontAsk` is the live case:
    // no hardcoded name list knows it, so the profile is the only thing that can
    // say it never asks. Both halves read the SAME mode string, so both inherit
    // the same stale answer — red here means a fix that satisfies the four names
    // DorkOS hardcodes would still leave this one silent.
    const getSession = vi.fn().mockResolvedValue(makeSession({ permissionMode: 'default' }));
    const { wrapper } = createHarness([makeSession({ permissionMode: 'default' })], {
      getSession,
      getCapabilities: vi.fn().mockResolvedValue({
        defaultRuntime: 'claude-code',
        capabilities: {
          'claude-code': {
            type: 'claude-code',
            permissionModes: {
              supported: true,
              values: [
                {
                  id: 'default',
                  label: 'Default',
                  stop: 'ask',
                  asks: 'always',
                  reach: 'edit',
                  promise: 'Asks before it edits a file or runs a command.',
                },
                {
                  id: 'dontAsk',
                  label: "Don't Ask",
                  stop: 'autonomy',
                  asks: 'never',
                  reach: 'everything',
                  promise: 'Runs everything without asking.',
                },
              ],
            },
            features: {},
          },
        },
      }),
    });

    const { rerender } = render(<Rail openSessionId="listed-1" />, { wrapper });
    await waitFor(() =>
      expect(screen.getByTestId('open-session-mode')).toHaveTextContent('default')
    );
    rerender(<Rail openSessionId={null} />);

    act(() => {
      useSessionListStore.getState().applyListEvent({
        type: 'session_upserted',
        session: makeSession({
          permissionMode: 'dontAsk',
          updatedAt: '2026-03-02T00:00:00.000Z',
        }),
      });
    });

    expect(await screen.findByLabelText('Permissions bypassed')).toBeInTheDocument();
  });

  it('warns about a session the person has never opened, without fetching it', async () => {
    // The reason the detail row outranks the caller's fallback in the first
    // place: a detail-only answer would report `'default'` — a specific claim —
    // for every session nobody has opened. Red when a fix trades this bug for
    // that one, or when a rail of rows starts costing a request per row.
    const getSession = vi.fn();
    const { wrapper } = createHarness([makeSession({ permissionMode: 'bypassPermissions' })], {
      getSession,
    });

    render(<Rail openSessionId={null} />, { wrapper });

    expect(await screen.findByLabelText('Permissions bypassed')).toBeInTheDocument();
    expect(getSession).not.toHaveBeenCalled();
  });

  it('warns the moment the person switches the open session to bypass', async () => {
    // The other direction: the PATCH answer is the freshest thing anyone holds,
    // and the list row will not hear about it until the runtime's watcher fires.
    // Red when a fix makes the caller's list row outrank the detail cache — the
    // rail would then go quiet about a bypass the person just switched on.
    const getSession = vi.fn().mockResolvedValue(makeSession({ permissionMode: 'default' }));
    const updateSession = vi
      .fn()
      .mockResolvedValue(makeSession({ permissionMode: 'bypassPermissions' }));
    const { wrapper } = createHarness([makeSession({ permissionMode: 'default' })], {
      getSession,
      updateSession,
    });

    render(<Rail openSessionId="listed-1" />, { wrapper });
    await waitFor(() =>
      expect(screen.getByTestId('open-session-mode')).toHaveTextContent('default')
    );

    await userEvent.click(screen.getByRole('button', { name: 'Switch to bypass' }));

    expect(await screen.findByLabelText('Permissions bypassed')).toBeInTheDocument();
    // Not merely the optimistic flash: the row must still warn once the PATCH
    // has settled and the optimistic override has been dropped.
    await waitFor(() =>
      expect(useSessionSettingsOverridesStore.getState().bySession['listed-1']).toBeUndefined()
    );
    expect(screen.getByLabelText('Permissions bypassed')).toBeInTheDocument();
  });
});
