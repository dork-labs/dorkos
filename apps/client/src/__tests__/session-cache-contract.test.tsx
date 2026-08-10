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
import { createQueryClientConfig } from '@/layers/shared/lib';
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
  sessionKeys,
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

/**
 * Run the `/session` loader and report the session id it redirects to.
 *
 * Awaited rather than called bare so it reads the answer the same way whether
 * the loader redirects synchronously or after asking the server — the shape of
 * the loader is not what any case here is about.
 */
async function loaderRedirectSession(
  context: { queryClient: QueryClient; transport: Transport },
  dir: string | undefined
): Promise<string | null> {
  try {
    await sessionRouteLoader({
      context,
      deps: {
        dir,
        session: undefined,
        runtime: undefined,
        prompt: undefined,
        send: undefined,
        seed: undefined,
      },
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
    const { queryClient, transport, wrapper } = createHarness();
    const { result } = renderHook(() => useSessions(), { wrapper });
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));

    expect(await loaderRedirectSession({ queryClient, transport }, CWD)).toBe('listed-1');
  });

  it('a navigation reuses the session the list query fetched', async () => {
    // Red when: `resolveSessionForCwd` and `useSessions` disagree on the key —
    // every agent switch would open a brand-new empty session instead.
    const { queryClient, transport, wrapper } = createHarness();
    const { result } = renderHook(() => useSessions(), { wrapper });
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));

    expect(await resolveSessionForCwd({ queryClient, transport }, CWD)).toEqual({
      sessionId: 'listed-1',
      isNew: false,
    });
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

/**
 * The window has never opened this agent, so nothing has ever filled its
 * per-directory cache entry. That is the ordinary case — a cockpit only
 * cold-loads the list for the agent it is pointed at — and it is
 * indistinguishable from "this agent has no conversations" if the only thing
 * anyone asks is the cache.
 */
describe('session resolution for an agent this window has never opened', () => {
  const OTHER_CWD = '/projects/web';

  /** A transport whose session list actually depends on which directory is asked for. */
  function createPerDirectoryHarness(byCwd: Record<string, Session[]>) {
    const listSessions = vi.fn((cwd?: string) =>
      Promise.resolve({ sessions: cwd ? (byCwd[cwd] ?? []) : [] })
    );
    return { listSessions, ...createHarness(undefined, { listSessions }) };
  }

  it('resolves the agent’s most recent conversation, not a brand-new one', async () => {
    // Red when: resolution answers from this window's query cache alone. A cache
    // MISS is read as "no conversations", so clicking an agent the window has not
    // already visited opens an empty chat and abandons the real one.
    const { queryClient, transport } = createPerDirectoryHarness({
      [OTHER_CWD]: [makeSession({ id: 'web-1', cwd: OTHER_CWD })],
    });

    const resolved = await resolveSessionForCwd({ queryClient, transport }, OTHER_CWD);

    expect(resolved).toEqual({ sessionId: 'web-1', isNew: false });
  });

  it('sends the /session loader to that same conversation', async () => {
    // The other door into the same decision: a bookmark, a pasted link, or any
    // navigation that names a directory without naming a session.
    const { queryClient, transport } = createPerDirectoryHarness({
      [OTHER_CWD]: [makeSession({ id: 'web-1', cwd: OTHER_CWD })],
    });

    expect(await loaderRedirectSession({ queryClient, transport }, OTHER_CWD)).toBe('web-1');
  });

  it('still starts a fresh conversation for an agent that genuinely has none', async () => {
    // The half of the behaviour that must survive the fix: first run has to keep
    // working, and it is the only case where minting an id is the right answer.
    const { queryClient, transport, listSessions } = createPerDirectoryHarness({});

    const resolved = await resolveSessionForCwd({ queryClient, transport }, OTHER_CWD);

    expect(resolved?.isNew).toBe(true);
    expect(resolved?.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(listSessions).toHaveBeenCalledWith(OTHER_CWD);
  });

  it('asks once and reuses the answer, so switching back is free', async () => {
    // The answer is cached under the same key `useSessions` reads, so the second
    // switch costs nothing and the chat paints from what is already there.
    const { queryClient, transport, listSessions } = createPerDirectoryHarness({
      [OTHER_CWD]: [makeSession({ id: 'web-1', cwd: OTHER_CWD })],
    });

    await resolveSessionForCwd({ queryClient, transport }, OTHER_CWD);
    await resolveSessionForCwd({ queryClient, transport }, OTHER_CWD);

    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData<Session[]>(sessionKeys.list(OTHER_CWD))).toHaveLength(1);
  });

  it('answers "I could not find out" when the server cannot be reached', async () => {
    // Red when: a failed lookup mints a fresh id. That opens a blank chat for an
    // agent that has work — DOR-928's own symptom, and indistinguishable from
    // it. "No sessions" and "could not ask" are different answers and only one
    // of them may start a new conversation.
    const { queryClient, transport } = createHarness(undefined, {
      listSessions: vi.fn().mockRejectedValue(new Error('offline')),
    });

    expect(await resolveSessionForCwd({ queryClient, transport }, OTHER_CWD)).toBeNull();
  });

  it('re-asks under the app’s real cache policy, not the test default', async () => {
    // Every other case here builds a bare QueryClient, whose `staleTime` is 0 —
    // so anything cached counts as stale and gets re-fetched, and the fix looks
    // right for a reason the app does not share. The app runs `staleTime: 30s`
    // (`createQueryClientConfig`), and the global-stream bridge writes an EMPTY
    // list whenever it removes the last session for a directory. Under the real
    // policy that empty entry is FRESH for the next 30 seconds, so a resolver
    // that lets freshness decide reproduces DOR-928 exactly.
    const transport = createMockTransport({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [makeSession({ id: 'still-there', cwd: OTHER_CWD })],
      }),
    }) as Transport;
    const queryClient = new QueryClient(createQueryClientConfig());
    queryClient.setQueryData<Session[]>(sessionKeys.list(OTHER_CWD), []);

    const resolved = await resolveSessionForCwd({ queryClient, transport }, OTHER_CWD);

    expect(resolved).toEqual({ sessionId: 'still-there', isNew: false });
  });

  it('re-asks rather than trusting a listing the server has disowned', async () => {
    // A Claude account switch fires `session_list_invalidated`, which invalidates
    // every per-directory list. The entries are marked, not dropped, so a
    // resolver that trusts any cached row resumes an id from the account that is
    // no longer signed in — and that id 404s.
    const { queryClient, transport, listSessions } = createPerDirectoryHarness({
      [OTHER_CWD]: [makeSession({ id: 'new-account-s1', cwd: OTHER_CWD })],
    });
    queryClient.setQueryData<Session[]>(sessionKeys.list(OTHER_CWD), [
      makeSession({ id: 'old-account-s1', cwd: OTHER_CWD }),
    ]);
    await queryClient.invalidateQueries({ queryKey: sessionKeys.listRoot });

    const resolved = await resolveSessionForCwd({ queryClient, transport }, OTHER_CWD);

    expect(resolved?.sessionId).toBe('new-account-s1');
    expect(listSessions).toHaveBeenCalledWith(OTHER_CWD);
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
    const { updateSession, permissionMode } = useSessionStatus(sessionId, null, false);
    return (
      <>
        <span data-testid="status-line-mode">{permissionMode}</span>
        <button
          type="button"
          onClick={() => void updateSession({ permissionMode: 'bypassPermissions' })}
        >
          Switch to bypass
        </button>
      </>
    );
  }

  /** The cross-agent Recent section — a second, independently-timed source of server rows. */
  function Recent() {
    const { data } = useRecentSessions();
    return <span data-testid="recent-count">{data?.sessions.length ?? 0}</span>;
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

  it('lets the later-fetched of two sources win, whichever arrives first', async () => {
    // The guard compares an incoming answer against the date on the entry, so
    // that date has to mean "when this data was true" for EVERY writer, not "when
    // somebody copied it". Here the Recent fetch starts second and answers second,
    // while the list fetch starts first and answers in between. If the list answer
    // dates the entry by its own arrival, the genuinely newer Recent answer — the
    // only one that knows the session has started bypassing — looks older than
    // what it is replacing and is dropped. Two fetches of ONE query cannot
    // interleave this way (TanStack dedupes them); these are two queries over the
    // same rows, and only the clock they are dated on can order them.
    let answerList!: (value: { sessions: Session[] }) => void;
    let answerRecent!: (value: {
      sessions: Session[];
      agentActivity: typeof AGENT_ACTIVITY;
    }) => void;
    const listSessions = vi
      .fn()
      .mockResolvedValueOnce({ sessions: [makeSession({ permissionMode: 'default' })] })
      .mockReturnValueOnce(
        new Promise<{ sessions: Session[] }>((resolve) => {
          answerList = resolve;
        })
      );
    const listRecentSessions = vi
      .fn()
      .mockResolvedValueOnce({
        sessions: [makeSession({ permissionMode: 'default' })],
        agentActivity: AGENT_ACTIVITY,
      })
      .mockReturnValueOnce(
        new Promise<{ sessions: Session[]; agentActivity: typeof AGENT_ACTIVITY }>((resolve) => {
          answerRecent = resolve;
        })
      );
    const { queryClient, wrapper } = createHarness(undefined, {
      listSessions,
      listRecentSessions,
      getSession: vi.fn().mockResolvedValue(makeSession({ permissionMode: 'default' })),
    });

    render(
      <>
        <Rail openSessionId="listed-1" />
        <Recent />
      </>,
      { wrapper }
    );
    await waitFor(() =>
      expect(screen.getByTestId('open-session-mode')).toHaveTextContent('default')
    );
    await waitFor(() => expect(screen.getByTestId('recent-count')).toHaveTextContent('1'));

    // Both refetch, list first. The gap is real time because the ordering under
    // test is between the two FETCH STARTS, and the clock they are compared on
    // has millisecond resolution.
    void queryClient.refetchQueries({ queryKey: sessionKeys.list(CWD) });
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 5));
    void queryClient.refetchQueries({ queryKey: sessionKeys.recentRoot });
    await waitFor(() => expect(listRecentSessions).toHaveBeenCalledTimes(2));

    answerList({ sessions: [makeSession({ permissionMode: 'default' })] });
    await waitFor(() =>
      expect(queryClient.isFetching({ queryKey: sessionKeys.list(CWD) })).toBe(0)
    );
    answerRecent({
      sessions: [makeSession({ permissionMode: 'bypassPermissions' })],
      agentActivity: AGENT_ACTIVITY,
    });
    await waitFor(() =>
      expect(queryClient.isFetching({ queryKey: sessionKeys.recentRoot })).toBe(0)
    );

    expect(await screen.findByLabelText('Permissions bypassed')).toBeInTheDocument();
  });

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

  it('keeps that bypass when a list answer older than the change lands after it', async () => {
    // Arrival order is not freshness. A list fetch already in flight when the
    // person turns the dial was built before the PATCH persisted, and lands after
    // the PATCH answer has written the detail row AND the convergence effect has
    // dropped the optimistic override that would have outranked it. Refreshing
    // the detail cache from whatever arrives last therefore reverts the session
    // to the mode it held a moment ago — the same defect as the first case here,
    // reached from the opposite side.
    //
    // The trigger is `refetchQueries` because that is what puts a list fetch in
    // flight in the app: window focus against the 30s staleTime, the SSE
    // reconnect broom, a Claude account switch.
    let answerSecondList!: (value: { sessions: Session[] }) => void;
    const secondList = new Promise<{ sessions: Session[] }>((resolve) => {
      answerSecondList = resolve;
    });
    const listSessions = vi
      .fn()
      .mockResolvedValueOnce({ sessions: [makeSession({ permissionMode: 'default' })] })
      .mockReturnValueOnce(secondList);
    const { queryClient, wrapper } = createHarness(undefined, {
      listSessions,
      getSession: vi.fn().mockResolvedValue(makeSession({ permissionMode: 'default' })),
      updateSession: vi
        .fn()
        .mockResolvedValue(makeSession({ permissionMode: 'bypassPermissions' })),
    });

    render(<Rail openSessionId="listed-1" />, { wrapper });
    await waitFor(() =>
      expect(screen.getByTestId('open-session-mode')).toHaveTextContent('default')
    );

    void queryClient.refetchQueries({ queryKey: sessionKeys.list(CWD) });
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2));

    // The person turns the dial while that fetch is still out.
    await userEvent.click(screen.getByRole('button', { name: 'Switch to bypass' }));
    await waitFor(() =>
      expect(useSessionSettingsOverridesStore.getState().bySession['listed-1']).toBeUndefined()
    );
    expect(screen.getByLabelText('Permissions bypassed')).toBeInTheDocument();

    // Now the older answer arrives. The sync is a synchronous call INSIDE the
    // query function, so waiting for the refetch to settle is a guarantee it has
    // already had its chance — no sleep, and no window where this passes because
    // the damage has not landed yet. That guarantee is the whole reason this
    // waits on `isFetching`: move the sync to `onSuccess` or any other
    // post-settle hook and the wait stops proving anything, so the wait has to
    // move with it.
    answerSecondList({ sessions: [makeSession({ permissionMode: 'default' })] });
    await waitFor(() =>
      expect(queryClient.isFetching({ queryKey: sessionKeys.list(CWD) })).toBe(0)
    );

    // The server is bypassing. Both surfaces that claim to know must still say so.
    await waitFor(() =>
      expect(screen.getByTestId('status-line-mode')).toHaveTextContent('bypassPermissions')
    );
    expect(screen.getByLabelText('Permissions bypassed')).toBeInTheDocument();
  });
});
