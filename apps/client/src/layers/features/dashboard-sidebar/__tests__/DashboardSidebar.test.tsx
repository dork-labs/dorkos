// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, cleanup, within, waitFor, act } from '@testing-library/react';
import {
  agentAuthorRef,
  type AuthorRef,
  type RoomSummary,
  type ThreadSummary,
} from '@dorkos/shared/room-schemas';
import { toast } from 'sonner';
import { resolveAgentVisual } from '@/layers/shared/lib';
import { useRoomOpenThreadStore } from '@/layers/entities/room';
import { DashboardSidebar } from '../ui/DashboardSidebar';
import { SidebarProvider, TooltipProvider } from '@/layers/shared/ui';
import type { SidebarPrefs, SidebarGroup, SidebarItemRef } from '@dorkos/shared/config-schema';

/** An agent member reference — `pinned`, `muted` and `items` all hold these. */
const agent = (path: string): SidebarItemRef => ({ kind: 'agent', path });
/** A room member reference. */
const roomRef = (roomId: string): SidebarItemRef => ({ kind: 'room', roomId });

/** A room as `GET /api/rooms` carries it. */
function room(overrides: Partial<RoomSummary> & Pick<RoomSummary, 'id' | 'kind'>): RoomSummary {
  return {
    slug: null,
    title: 'Untitled',
    topic: null,
    workspaceId: null,
    archived: false,
    ambientMaxEntries: 30,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActivityAt: '2026-07-20T10:00:00.000Z',
    unreadCount: 0,
    participants: null,
    ...overrides,
  };
}

const channel = (id: string, slug: string) => room({ id, kind: 'channel', slug, title: slug });

/**
 * A direct message with one agent in it. The `AuthorRef` deliberately carries
 * NO emoji and NO colour: the server only caches those for an agent that has one
 * stored on its manifest, and drawing this row from them is what DOR-582 was.
 */
function dmWith(id: string, agentPath: string, title: string): RoomSummary {
  const participants: AuthorRef[] = [
    { id: `${id}-you`, kind: 'human', displayName: 'You', handle: null },
    {
      id: `${id}-agent`,
      kind: 'agent',
      displayName: title,
      handle: null,
      agentRef: agentAuthorRef(agentPath),
    },
  ];
  return room({ id, kind: 'dm', title, participants });
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Navigating MOVES the location here, exactly as it does in the app. That is
// load-bearing: what stops a slow agent lookup from landing on top of a
// navigation that happened while it was out is the router's own location
// having moved, so a mock whose location never changes would test nothing.
let mockLocation: {
  pathname: string;
  search: Record<string, unknown>;
  state?: { inPlaceBase?: { pathname: string; search: Record<string, unknown> } };
} = {
  pathname: '/',
  search: {},
};
const mockNavigate = vi.fn((opts: { to?: string; search?: unknown }) => {
  const next =
    typeof opts.search === 'function'
      ? (opts.search as (p: Record<string, unknown>) => Record<string, unknown>)(
          mockLocation.search
        )
      : ((opts.search as Record<string, unknown>) ?? {});
  mockLocation = { pathname: opts.to ?? mockLocation.pathname, search: next };
  mockPathname = mockLocation.pathname;
});
let mockPathname = '/';
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  useRouter: () => ({
    state: {
      get location() {
        return mockLocation;
      },
    },
  }),
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: mockPathname } }),
  useSearch: () => ({}),
}));

const mockMeshPaths = vi.fn<() => string[]>(() => [
  '~/.dork/agents/dorkbot',
  '/projects/alpha',
  '/projects/beta',
]);
const mockSetGlobalPaletteOpen = vi.fn();
const mockUpdateSidebar = vi.fn<(updater: (prev: unknown) => unknown) => void>();
const mockSetRightPanelOpen = vi.fn();
const mockSetActiveRightPanelTab = vi.fn();
// `id` is required on a real `AgentManifest` and is what the agent's face is
// hashed from, so a fixture without one is not a manifest the app could ever
// receive — and leaving it out crashes the hash rather than failing an
// assertion.
const mockResolvedAgents = vi.fn<
  () => Record<string, { id: string; name: string; displayName?: string } | null>
>(() => ({}));
let mockSelectedCwd: string | null = null;

function makePrefs(overrides: Partial<SidebarPrefs> = {}): SidebarPrefs {
  return {
    pinned: [],
    groups: [],
    ungroupedSortMode: 'name',
    ungroupedCollapsed: false,
    recentsCollapsed: false,
    channelsCollapsed: false,
    dmsCollapsed: false,
    threadsCollapsed: false,
    groupsHintDismissed: false,
    muted: [],
    ungroupedDisplayFilter: 'all',
    ...overrides,
  };
}
const mockSidebarPrefs = vi.fn<() => SidebarPrefs>(() => makePrefs());

interface RecentResult {
  data:
    | { sessions: unknown[]; agentActivity: Record<string, string>; warnings?: unknown[] }
    | undefined;
  isLoading: boolean;
}
const mockRecent = vi.fn<() => RecentResult>(() => ({
  data: { sessions: [], agentActivity: {} },
  isLoading: false,
}));

const mockRooms = vi.fn<() => RoomSummary[]>(() => []);
const mockThreads = vi.fn<() => ThreadSummary[]>(() => []);
const mockTransport = {
  getConfig: vi.fn().mockResolvedValue({ agents: { defaultAgent: 'dorkbot' } }),
  listMeshAgentPaths: vi.fn(),
  resolveAgents: vi.fn().mockResolvedValue({}),
  listSessions: vi.fn().mockResolvedValue({ sessions: [] }),
  listRooms: vi.fn(() => Promise.resolve(mockRooms())),
  listThreads: vi.fn(() => Promise.resolve(mockThreads())),
};

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useTransport: () => mockTransport,
    useNow: () => Date.now(),
    useIsMobile: () => false,
    // The room list rides the global `/api/events` fan-out, which needs the
    // app-level EventStreamProvider. Nothing here is about that stream, so it
    // is stubbed rather than dragging the provider into every sidebar test.
    useEventSubscription: () => {},
    useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        setGlobalPaletteOpen: mockSetGlobalPaletteOpen,
        selectedCwd: mockSelectedCwd,
        setRightPanelOpen: mockSetRightPanelOpen,
        setActiveRightPanelTab: mockSetActiveRightPanelTab,
      }),
  };
});

vi.mock('@/layers/entities/config', () => {
  const passthrough = (prev: unknown) => prev;
  return {
    useConfig: () => ({ data: { agents: { defaultAgent: 'dorkbot' } } }),
    useSidebarPrefs: () => mockSidebarPrefs(),
    useUpdateSidebarPrefs: () => ({
      update: mockUpdateSidebar,
      updateAsync: vi.fn(),
      isPending: false,
      isError: false,
    }),
    pinItem: passthrough,
    unpinItem: passthrough,
    moveToGroup: passthrough,
    createGroup: (prev: unknown) => ({ next: prev, id: 'new-id' }),
    renameGroup: passthrough,
    deleteGroup: passthrough,
    setGroupSortMode: passthrough,
    setGroupCollapsed: passthrough,
    setRecentsCollapsed: passthrough,
    setUngroupedCollapsed: passthrough,
    setUngroupedSortMode: passthrough,
    setGroupsHintDismissed: passthrough,
  };
});

vi.mock('@/layers/features/agent-hub', () => ({
  useAgentHubStore: { getState: () => ({ openHub: vi.fn() }) },
}));

/** The fleet as `GET /api/mesh/agent-paths` returns it — id and path deliberately unequal. */
const meshFleet = () =>
  mockMeshPaths().map((p) => ({
    id: `mesh-id${p}`,
    name: p.split('/').pop() ?? 'agent',
    projectPath: p,
  }));

/**
 * Paths the sidebar LISTS but the roster join cannot name.
 *
 * The two are separate reads in production and can genuinely disagree — a
 * directory the sidebar draws from one payload while the fleet's registry has
 * no row for it. Empty unless a case says otherwise.
 */
const mockUnmappedPaths = vi.fn<() => string[]>(() => []);

vi.mock('@/layers/entities/mesh', () => ({
  useMeshAgentPaths: () => ({ data: { agents: meshFleet() } }),
  // The real join's SHAPE, not a stub of its answer: a row's profile link is
  // only correct if this returns the REGISTRY id for a path, and a mock keyed
  // path→path would hide exactly that.
  useMeshMemberIds: () =>
    new Map(
      meshFleet()
        .filter((a) => !mockUnmappedPaths().includes(a.projectPath))
        .map((a) => [a.projectPath, a.id])
    ),
}));

vi.mock('@/layers/entities/agent', async () => ({
  // The two naming helpers are pure and are what the sidebar's ORDER comes
  // from, so they are the real ones — a stub would make every sort assertion
  // below a test of the stub.
  ...(await vi.importActual<
    typeof import('@/layers/entities/agent/lib/disambiguate-display-names')
  >('@/layers/entities/agent/lib/disambiguate-display-names')),
  ...(await vi.importActual<typeof import('@/layers/entities/agent/lib/agent-choices')>(
    '@/layers/entities/agent/lib/agent-choices'
  )),
  useResolvedAgents: () => ({ data: mockResolvedAgents() }),
  useExecutionExceptions: () => mockExecutionExceptions(),
  useAgentVisual: () => ({ color: '#aaaaaa', emoji: '🤖' }),
  // The face is a control now, so the stub grows one: without it the row's
  // profile link has nothing to press and the id the sidebar hands down is
  // untestable from here (the join it comes from lives in this component).
  AgentIdentity: ({
    name,
    emoji,
    onAvatarClick,
    avatarLabel,
  }: {
    name: string;
    emoji: string;
    onAvatarClick?: () => void;
    avatarLabel?: string;
  }) => (
    <span>
      {onAvatarClick ? (
        <button type="button" aria-label={avatarLabel} onClick={onAvatarClick}>
          {emoji}
        </button>
      ) : (
        <span>{emoji}</span>
      )}
      <span>{name}</span>
    </span>
  ),
  AgentAvatar: ({ emoji }: { emoji: string }) => <span data-testid="avatar">{emoji}</span>,
}));

// DOR-329 fixtures carry no live sessions or recent-activity timestamps, so
// the real hook would classify every path 'inactive' and collapse it behind
// the DOR-339 reveal row. These pre-existing tests are about layout/sort, not
// attention filtering, so the default treats every agent as 'active' — the
// same "keep fixtures fresh" intent the spec calls for, applied at the mock
// instead of threading timestamps through every fixture. DOR-339 tests
// override this per-case via `mockAttentionMap.mockImplementation(...)`.
const mockAttentionMap = vi.fn((paths: string[], _broken?: string[]) =>
  Object.fromEntries(paths.map((p) => [p, 'active']))
);

/** Which agents' execution settings are broken. Empty unless a case says otherwise. */
const mockExecutionExceptions = vi.fn(() => ({
  exceptions: [],
  brokenPaths: [] as string[],
  defaultRuntime: 'claude-code',
}));

vi.mock('@/layers/entities/session', async (importOriginal) => ({
  // The query-key factory is the real one: a stub here would let the sidebar
  // read a cache key nothing in the app writes and never say so (DOR-497).
  sessionKeys: (await importOriginal<typeof import('@/layers/entities/session')>()).sessionKeys,
  // Real for the same reason: which session a click opens — and which of two
  // competing clicks wins — is the behaviour these cases assert, so a stub
  // would be asserting the stub.
  resolveSessionForCwd: (await importOriginal<typeof import('@/layers/entities/session')>())
    .resolveSessionForCwd,
  beginSessionNavigation: (await importOriginal<typeof import('@/layers/entities/session')>())
    .beginSessionNavigation,
  notifySessionLookupFailed: (await importOriginal<typeof import('@/layers/entities/session')>())
    .notifySessionLookupFailed,
  // Real too: it routes through `useSafeNavigate`, which resolves to the mocked
  // `useNavigate` here — so "New session" is exercised end to end rather than
  // against a stub that cannot be wrong.
  useStartNewSession: (await importOriginal<typeof import('@/layers/entities/session')>())
    .useStartNewSession,
  useAgentSessions: () => ({ sessions: [], activeSessionId: null, isLoading: false }),
  useSessionBorderState: () => ({ kind: 'idle', color: 'x', pulse: false, label: 'Idle' }),
  useAgentHottestStatus: () => ({ kind: 'idle', color: 'x', pulse: false, label: 'Idle' }),
  useAgentsAggregateStatus: () => false,
  useAgentAttentionMap: (paths: string[], broken?: string[]) => mockAttentionMap(paths, broken),
  usePulseMotion: () => ({ animate: undefined, transition: undefined }),
  useRenameSession: () => ({ mutate: vi.fn() }),
  useRecentSessions: () => mockRecent(),
  sessionDisplayTitle: (t: string) => t,
  SessionRow: () => null,
  SessionOriginMark: () => null,
  // Stubbed rather than imported: mirrors the real partition (session-origin-legibility)
  // without pulling the real module into this wholesale mock.
  partitionSessionsByOrigin: (sessions: Array<{ origin?: string }>) => ({
    conversations: sessions.filter((s) => !s.origin || s.origin === 'user'),
    automated: sessions.filter((s) => s.origin && s.origin !== 'user'),
  }),
}));

vi.mock('@/layers/features/feature-promos', () => ({ PromoSlot: () => null }));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <SidebarProvider>{ui}</SidebarProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function group(overrides: Partial<SidebarGroup> = {}): SidebarGroup {
  return {
    id: 'g1',
    name: 'Clients',
    items: [],
    sortMode: 'manual',
    collapsed: false,
    displayFilter: 'all',
    muted: false,
    kind: 'manual',
    ...overrides,
  };
}

/**
 * Every match for `text` OUTSIDE the "Jump back in" shortcut.
 *
 * That section is a recency shortcut and re-draws rooms that also live in their
 * own sections — the same multi-presence Pinned has always had. So every
 * assertion about WHERE a room is filed has to look past it, or it counts the
 * shortcut's copy as a second home.
 */
function allOutsideShortcut(text: string): HTMLElement[] {
  const shortcut =
    screen.queryByText('Jump back in')?.closest('[data-slot="sidebar-group"]') ?? null;
  return screen.queryAllByText(text).filter((el) => shortcut === null || !shortcut.contains(el));
}

/** The one match for `text` outside the "Jump back in" shortcut. */
function outsideShortcut(text: string): HTMLElement {
  const matches = allOutsideShortcut(text);
  expect(matches, `expected exactly one "${text}" outside the shortcut`).toHaveLength(1);
  return matches[0]!;
}

describe('DashboardSidebar', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    localStorage.clear();
    mockMeshPaths.mockReset();
    mockSidebarPrefs.mockReset();
    mockUpdateSidebar.mockReset();
    mockRecent.mockReset();
    mockNavigate.mockReset();
    mockResolvedAgents.mockReset();
    mockResolvedAgents.mockReturnValue({});
    mockMeshPaths.mockReturnValue(['~/.dork/agents/dorkbot', '/projects/alpha', '/projects/beta']);
    mockSidebarPrefs.mockReturnValue(makePrefs());
    mockRecent.mockReturnValue({ data: { sessions: [], agentActivity: {} }, isLoading: false });
    mockRooms.mockReset();
    mockRooms.mockReturnValue([]);
    mockTransport.listSessions.mockReset();
    mockTransport.listSessions.mockResolvedValue({ sessions: [] });
    vi.mocked(toast.error).mockReset();
    mockAttentionMap.mockReset();
    mockAttentionMap.mockImplementation((paths: string[]) =>
      Object.fromEntries(paths.map((p) => [p, 'active']))
    );
    mockSelectedCwd = null;
    mockPathname = '/';
    mockLocation = { pathname: '/', search: {} };
  });

  // --- Navigation ---

  it('renders Dashboard nav item', () => {
    renderWithProviders(<DashboardSidebar />);
    expect(screen.getAllByText('Dashboard').length).toBeGreaterThanOrEqual(1);
  });

  it('navigates to /team from the Team nav item', () => {
    renderWithProviders(<DashboardSidebar />);
    fireEvent.click(screen.getAllByText('Team')[0]);
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/team' });
  });

  it('renders default agent (dorkbot) and navigates on click', async () => {
    renderWithProviders(<DashboardSidebar />);
    fireEvent.click(screen.getAllByText('dorkbot')[0]);
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/session',
        search: expect.objectContaining({ dir: '~/.dork/agents/dorkbot' }),
      })
    );
  });

  // The reported bug, as a person meets it: the roster shows every agent from
  // the moment the cockpit loads, but only the agent this window has actually
  // opened has ever had its session list fetched. Clicking any other one used to
  // read that empty cache as "no conversations" and open a new empty chat.
  it('opens the most recent conversation of an agent this window has never opened', async () => {
    mockTransport.listSessions.mockImplementation((cwd?: string) =>
      Promise.resolve({
        sessions:
          cwd === '/projects/beta'
            ? [
                {
                  id: 'beta-session-1',
                  title: 'Ship the thing',
                  cwd: '/projects/beta',
                  createdAt: '2026-03-01T00:00:00.000Z',
                  updatedAt: '2026-03-01T12:00:00.000Z',
                  permissionMode: 'default',
                  runtime: 'claude-code',
                },
              ]
            : [],
      })
    );

    renderWithProviders(<DashboardSidebar />);
    fireEvent.click(screen.getAllByText('beta')[0]);

    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/session',
        search: { dir: '/projects/beta', session: 'beta-session-1' },
      })
    );
  });

  // Resolution is asynchronous, so two clicks are two races. Whichever REQUEST
  // finishes last used to win the URL, which is the opposite of what the person
  // asked for.
  it('lands on the agent you clicked last, not the one that answered last', async () => {
    const answer = (id: string) => ({
      sessions: [
        {
          id,
          title: 't',
          cwd: '/x',
          createdAt: '2026-03-01T00:00:00.000Z',
          updatedAt: '2026-03-01T00:00:00.000Z',
          permissionMode: 'default',
          runtime: 'claude-code',
        },
      ],
    });
    mockTransport.listSessions.mockImplementation((cwd?: string) =>
      cwd === '/projects/alpha'
        ? new Promise((resolve) => setTimeout(() => resolve(answer('alpha-s1')), 60))
        : Promise.resolve(answer('beta-s1'))
    );

    renderWithProviders(<DashboardSidebar />);
    fireEvent.click(screen.getAllByText('alpha')[0]); // slow
    fireEvent.click(screen.getAllByText('beta')[0]); // fast

    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
    // Real time, on purpose: the assertion is that the slow answer never
    // navigates, and a non-event cannot be awaited (.claude/rules/testing.md).
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: { dir: '/projects/beta', session: 'beta-s1' },
    });
  });

  // The ordering only the counter can save. Both lookups begin at the same
  // location, so the location cannot tell them apart: whichever ANSWERED first
  // would win, and here that is the agent clicked first.
  it('lands on the agent clicked last even when the one clicked first answers first', async () => {
    const answer = (id: string) => ({
      sessions: [
        {
          id,
          title: 't',
          cwd: '/x',
          createdAt: '2026-03-01T00:00:00.000Z',
          updatedAt: '2026-03-01T00:00:00.000Z',
          permissionMode: 'default',
          runtime: 'claude-code',
        },
      ],
    });
    mockTransport.listSessions.mockImplementation((cwd?: string) =>
      cwd === '/projects/alpha'
        ? Promise.resolve(answer('alpha-s1')) // clicked FIRST, answers FIRST
        : new Promise((resolve) => setTimeout(() => resolve(answer('beta-s1')), 60))
    );

    renderWithProviders(<DashboardSidebar />);
    fireEvent.click(screen.getAllByText('alpha')[0]);
    fireEvent.click(screen.getAllByText('beta')[0]);

    // Real time, on purpose: the claim includes that alpha never navigates.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: { dir: '/projects/beta', session: 'beta-s1' },
    });
  });

  // Opening a dialog rewrites the URL without going anywhere. Treating that as a
  // navigation cancels the lookup, and the click dies in silence — the failure
  // mode a person can least easily report.
  it('still opens the agent when a dialog rewrites the URL mid-lookup', async () => {
    mockTransport.listSessions.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                sessions: [
                  {
                    id: 'beta-s1',
                    title: 't',
                    cwd: '/projects/beta',
                    createdAt: '2026-03-01T00:00:00.000Z',
                    updatedAt: '2026-03-01T00:00:00.000Z',
                    permissionMode: 'default',
                    runtime: 'claude-code',
                  },
                ],
              }),
            60
          )
        )
    );

    renderWithProviders(<DashboardSidebar />);
    fireEvent.click(screen.getAllByText('beta')[0]);
    // ⌘, while the lookup is out — `?settings=` goes on, nothing moves. The dialog
    // declares the rewrite in place, stamping the destination it hangs off, so the
    // guard reads the click as still wanted rather than a departure (DOR-931).
    mockLocation = {
      pathname: mockLocation.pathname,
      search: { ...mockLocation.search, settings: 'general' },
      state: { inPlaceBase: { pathname: mockLocation.pathname, search: mockLocation.search } },
    };

    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/session',
        search: { dir: '/projects/beta', session: 'beta-s1' },
      })
    );
  });

  // The same race without a double click: a Recent row navigates immediately, so
  // an agent lookup still in flight would yank you off the session you just
  // opened.
  it('does not yank you away from a Recent session you opened mid-lookup', async () => {
    mockRecent.mockReturnValue({
      data: {
        sessions: [
          {
            id: 'recent-1',
            title: 'Earlier work',
            cwd: '/projects/beta',
            updatedAt: '2026-03-02T00:00:00.000Z',
            createdAt: '2026-03-01T00:00:00.000Z',
            runtime: 'claude-code',
            permissionMode: 'default',
          },
        ],
        agentActivity: {},
      },
      isLoading: false,
    });
    mockTransport.listSessions.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                sessions: [
                  {
                    id: 'alpha-s1',
                    title: 't',
                    cwd: '/projects/alpha',
                    createdAt: '2026-03-01T00:00:00.000Z',
                    updatedAt: '2026-03-01T00:00:00.000Z',
                    permissionMode: 'default',
                    runtime: 'claude-code',
                  },
                ],
              }),
            60
          )
        )
    );

    renderWithProviders(<DashboardSidebar />);
    fireEvent.click(screen.getAllByText('alpha')[0]); // slow agent lookup starts
    fireEvent.click(screen.getByText('Earlier work')); // arrives immediately

    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
    // Real time, on purpose — see above.
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: { dir: '/projects/beta', session: 'recent-1' },
    });
  });

  // The guard has to hold against navigations it knows nothing about. Opening a
  // channel is one of ~20 `navigate()` calls across the app that have no reason
  // to know an agent lookup is in flight, and it must not be possible for one to
  // land on top of them.
  it('does not drag you out of a channel you opened while an agent lookup was out', async () => {
    mockRooms.mockReturnValue([channel('c1', 'general')]);
    mockTransport.listSessions.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                sessions: [
                  {
                    id: 'alpha-s1',
                    title: 't',
                    cwd: '/projects/alpha',
                    createdAt: '2026-03-01T00:00:00.000Z',
                    updatedAt: '2026-03-01T00:00:00.000Z',
                    permissionMode: 'default',
                    runtime: 'claude-code',
                  },
                ],
              }),
            60
          )
        )
    );

    renderWithProviders(<DashboardSidebar />);
    await screen.findAllByText('#general');
    fireEvent.click(screen.getAllByText('alpha')[0]); // slow lookup starts
    fireEvent.click(outsideShortcut('#general')); // arrives immediately

    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
    // Real time, on purpose: the claim is that a SECOND navigation never
    // happens, and you cannot await an event that must not occur
    // (.claude/rules/testing.md).
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/channels', search: { id: 'c1' } });
  });

  // Moving between rooms is going somewhere, and the guard has to see it. Room
  // identity lives in `?id=`, which no session URL carries — so a key built from
  // only the params a SESSION uses collapses every room onto one destination and
  // reads a room change as standing still.
  it('does not throw you out of the second channel you opened mid-lookup', async () => {
    mockRooms.mockReturnValue([channel('c1', 'general'), channel('c2', 'random')]);
    mockTransport.listSessions.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                sessions: [
                  {
                    id: 'beta-s1',
                    title: 't',
                    cwd: '/projects/beta',
                    createdAt: '2026-03-01T00:00:00.000Z',
                    updatedAt: '2026-03-01T00:00:00.000Z',
                    permissionMode: 'default',
                    runtime: 'claude-code',
                  },
                ],
              }),
            60
          )
        )
    );

    renderWithProviders(<DashboardSidebar />);
    await screen.findAllByText('#general');
    fireEvent.click(outsideShortcut('#general')); // reading a room
    fireEvent.click(screen.getAllByText('beta')[0]); // slow agent lookup starts
    fireEvent.click(outsideShortcut('#random')); // and you move rooms

    // Real time, on purpose: the claim is that the lookup never lands.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(mockNavigate).toHaveBeenLastCalledWith({ to: '/channels', search: { id: 'c2' } });
    expect(mockNavigate).not.toHaveBeenCalledWith({
      to: '/session',
      search: { dir: '/projects/beta', session: 'beta-s1' },
    });
  });

  // The sidebar keeps its own copy of the overtaken-before-report ordering, and
  // an untested copy is one that can drift back.
  it('says nothing when a lookup both fails and was abandoned', async () => {
    mockRooms.mockReturnValue([channel('c1', 'general')]);
    let reject!: (reason: Error) => void;
    mockTransport.listSessions.mockReturnValue(
      new Promise((_resolve, rej) => {
        reject = rej;
      })
    );

    renderWithProviders(<DashboardSidebar />);
    await screen.findAllByText('#general');
    fireEvent.click(screen.getAllByText('beta')[0]);
    fireEvent.click(outsideShortcut('#general')); // they move on

    await act(async () => {
      reject(new Error('offline'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(toast.error).not.toHaveBeenCalled();
  });

  // Recovering into a blank chat is recovering into the very symptom this fix
  // exists to remove, and typing into that chat makes it real.
  it('says the lookup failed and leaves you where you are, rather than opening a blank chat', async () => {
    mockTransport.listSessions.mockRejectedValue(new Error('offline'));

    renderWithProviders(<DashboardSidebar />);
    fireEvent.click(screen.getAllByText('beta')[0]);

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('starts a new conversation for an agent that has none', async () => {
    renderWithProviders(<DashboardSidebar />);
    fireEvent.click(screen.getAllByText('beta')[0]);

    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: {
        dir: '/projects/beta',
        session: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
        ),
      },
    });
  });

  it('renders all agents from mesh (no cap)', () => {
    const paths = Array.from(
      { length: 15 },
      (_, i) => `/projects/agent-${String(i).padStart(2, '0')}`
    );
    mockMeshPaths.mockReturnValue(paths);
    renderWithProviders(<DashboardSidebar />);
    for (const p of paths) {
      expect(screen.getAllByText(p.split('/').pop()!).length).toBeGreaterThanOrEqual(1);
    }
  });

  // --- Sorting (ungrouped, default name mode) ---

  it('sorts ungrouped agents by directory name', () => {
    mockMeshPaths.mockReturnValue(['/projects/zebra', '/projects/alpha', '/projects/middle']);
    renderWithProviders(<DashboardSidebar />);
    const t = document.body.textContent ?? '';
    expect(t.indexOf('alpha')).toBeLessThan(t.indexOf('middle'));
    expect(t.indexOf('middle')).toBeLessThan(t.indexOf('zebra'));
  });

  it('sorts ungrouped agents by resolved display name, overriding path order', () => {
    mockMeshPaths.mockReturnValue(['/projects/zebra', '/projects/alpha']);
    mockResolvedAgents.mockReturnValue({
      '/projects/zebra': { id: 'zebra-id', name: 'zebra', displayName: 'Apple' },
      '/projects/alpha': { id: 'alpha-id', name: 'alpha', displayName: 'Zulu' },
    });
    renderWithProviders(<DashboardSidebar />);
    const t = document.body.textContent ?? '';
    expect(t.indexOf('Apple')).toBeLessThan(t.indexOf('Zulu'));
  });

  // --- Progressive disclosure: flat vs organized ---

  it('renders a header-less flat list with no groups and no pins', () => {
    renderWithProviders(<DashboardSidebar />);
    expect(screen.queryByText('Pinned')).not.toBeInTheDocument();
    // No "Agents" section label in flat mode — and now nothing else either:
    // the nav button that used to be the one legitimate "Agents" in the tree
    // says Team, so the word should be absent from a flat sidebar entirely.
    expect(screen.queryByText('Agents')).not.toBeInTheDocument();
    expect(screen.getAllByText('Team').length).toBe(1);
  });

  it('shows section headers in order Pinned → groups → Agents when organized', () => {
    mockMeshPaths.mockReturnValue(['/projects/alpha', '/projects/beta', '/projects/gamma']);
    mockSidebarPrefs.mockReturnValue(
      makePrefs({
        pinned: [agent('/projects/alpha')],
        groups: [group({ items: [agent('/projects/beta')] })],
      })
    );
    renderWithProviders(<DashboardSidebar />);
    const t = document.body.textContent ?? '';
    expect(t.indexOf('Pinned')).toBeGreaterThanOrEqual(0);
    expect(t.indexOf('Clients')).toBeGreaterThan(t.indexOf('Pinned'));
    // The ungrouped "Agents" section label appears after the group (organized).
    const agentsIdx = t.lastIndexOf('Agents');
    expect(agentsIdx).toBeGreaterThan(t.indexOf('Clients'));
  });

  it('hides the Pinned section when there are no pins', () => {
    renderWithProviders(<DashboardSidebar />);
    expect(screen.queryByText('Pinned')).not.toBeInTheDocument();
  });

  it('renders the Pinned section when pins exist', () => {
    mockSidebarPrefs.mockReturnValue(makePrefs({ pinned: [agent('/projects/alpha')] }));
    renderWithProviders(<DashboardSidebar />);
    expect(screen.getByText('Pinned')).toBeInTheDocument();
  });

  // --- Multi-presence: pinned agent also renders in its group ---

  it('renders a pinned+grouped agent twice (multi-presence)', () => {
    mockMeshPaths.mockReturnValue(['/projects/alpha', '/projects/beta']);
    mockSidebarPrefs.mockReturnValue(
      makePrefs({
        pinned: [agent('/projects/alpha')],
        groups: [group({ items: [agent('/projects/alpha')] })],
      })
    );
    renderWithProviders(<DashboardSidebar />);
    // alpha appears once in Pinned and once in the group.
    expect(screen.getAllByText('alpha')).toHaveLength(2);
  });

  // --- Empty group ---

  it('renders the drag hint for an empty group and does not remove it', () => {
    mockSidebarPrefs.mockReturnValue(makePrefs({ groups: [group({ items: [] })] }));
    renderWithProviders(<DashboardSidebar />);
    // Names both things you can drag in: rooms became a drag source in DOR-581,
    // and a hint that still said "agents" would be describing the old gesture.
    expect(screen.getByText('Drag agents, channels, or conversations here')).toBeInTheDocument();
    expect(screen.getByText('Clients')).toBeInTheDocument();
    expect(mockUpdateSidebar).not.toHaveBeenCalled(); // never auto-deleted
  });

  // --- "Jump back in" (team-room-home §D2.3) ---
  //
  // It replaced the "Recent" section, and the visibility rule went with it: the
  // old one needed two agents and a session, because a one-agent cockpit's
  // recents were a copy of its only row. This list holds rooms too, so the only
  // question it can honestly ask is whether there is anything to go back to.

  it('draws nothing at all when there is nothing to jump back into', async () => {
    renderWithProviders(<DashboardSidebar />);
    // Awaited, not asserted on the first frame: the sources are still in flight
    // then, and a shortcut that showed its skeletons and then vanished would
    // pass a synchronous check while looking wrong.
    await waitFor(() => expect(screen.queryByText('Jump back in')).not.toBeInTheDocument());
  });

  it('offers a session to jump back into, even for a one-agent cockpit', () => {
    mockMeshPaths.mockReturnValue(['/projects/solo']);
    mockRecent.mockReturnValue({
      data: {
        sessions: [
          {
            id: 's1',
            title: 'Fix the bug',
            cwd: '/projects/solo',
            updatedAt: new Date().toISOString(),
            runtime: 'claude-code',
            permissionMode: 'default',
            createdAt: new Date().toISOString(),
          },
        ],
        agentActivity: {},
      },
      isLoading: false,
    });
    renderWithProviders(<DashboardSidebar />);
    expect(screen.getByText('Jump back in')).toBeInTheDocument();
    expect(screen.getByText('Fix the bug')).toBeInTheDocument();
  });

  // The whole point of the rewrite: a person who spent the morning in #general
  // used to see nothing about it here.
  it('offers rooms alongside sessions, most recent first', async () => {
    mockRooms.mockReturnValue([
      room({
        id: 'c1',
        kind: 'channel',
        slug: 'general',
        title: 'general',
        lastActivityAt: '2026-08-01T12:00:00.000Z',
      }),
    ]);
    mockRecent.mockReturnValue({
      data: {
        sessions: [
          {
            id: 's1',
            title: 'Fix the bug',
            cwd: '/projects/alpha',
            updatedAt: '2026-08-01T09:00:00.000Z',
            runtime: 'claude-code',
            permissionMode: 'default',
            createdAt: '2026-08-01T08:00:00.000Z',
          },
        ],
        agentActivity: {},
      },
      isLoading: false,
    });
    renderWithProviders(<DashboardSidebar />);

    const shortcut = (await screen.findByText('Jump back in')).closest(
      '[data-slot="sidebar-group"]'
    ) as HTMLElement;
    await waitFor(() => expect(within(shortcut).getByText('general')).toBeInTheDocument());
    expect(within(shortcut).getByText('Fix the bug')).toBeInTheDocument();
    const text = shortcut.textContent ?? '';
    expect(text.indexOf('general')).toBeLessThan(text.indexOf('Fix the bug'));
  });

  it('opens a room from the shortcut, the same place its own section would', async () => {
    mockRooms.mockReturnValue([channel('c1', 'general')]);
    renderWithProviders(<DashboardSidebar />);

    const shortcut = (await screen.findByText('Jump back in')).closest(
      '[data-slot="sidebar-group"]'
    ) as HTMLElement;
    await waitFor(() => expect(within(shortcut).getByText('general')).toBeInTheDocument());
    fireEvent.click(within(shortcut).getByText('general'));

    expect(mockNavigate).toHaveBeenCalledWith({ to: '/channels', search: { id: 'c1' } });
  });

  it('shows 3 skeleton rows while the first answer is on its way', () => {
    mockRecent.mockReturnValue({ data: undefined, isLoading: true });
    renderWithProviders(<DashboardSidebar />);
    // Scoped to the shortcut group: the Channels and Direct messages sections
    // render their own skeletons off a different query, so a whole-container
    // count would be measuring all three at once.
    const shortcut = screen.getByText('Jump back in').closest('[data-slot="sidebar-group"]');
    expect(shortcut?.querySelectorAll('[data-slot="sidebar-menu-skeleton"]')).toHaveLength(3);
  });

  // --- Add affordance + onboarding ---

  it('renders the + Add agent button', () => {
    renderWithProviders(<DashboardSidebar />);
    expect(screen.getByLabelText('Add agent')).toBeInTheDocument();
  });

  it('renders onboarding card for 1-2 agents', () => {
    mockMeshPaths.mockReturnValue(['/agents/solo']);
    renderWithProviders(<DashboardSidebar />);
    expect(screen.getByText(/Add more agents to your fleet/)).toBeInTheDocument();
  });

  it('renders inline "Add agent" link for 3-4 agents', () => {
    mockMeshPaths.mockReturnValue(['/agents/one', '/agents/two', '/agents/three']);
    renderWithProviders(<DashboardSidebar />);
    expect(screen.queryByText(/Add more agents to your fleet/)).not.toBeInTheDocument();
    expect(screen.getAllByText('Add agent').length).toBeGreaterThanOrEqual(1);
  });

  it('shows no add prompt for 5+ agents (header + is enough)', () => {
    mockMeshPaths.mockReturnValue(['/a/1', '/a/2', '/a/3', '/a/4', '/a/5']);
    renderWithProviders(<DashboardSidebar />);
    expect(screen.queryByText(/Add more agents to your fleet/)).not.toBeInTheDocument();
    // Only the header "+" (aria-label) remains, no inline text link.
    expect(screen.queryByText('Add agent')).not.toBeInTheDocument();
  });

  // --- Legacy localStorage pin migration (DOR-329) ---

  describe('legacy localStorage pin migration', () => {
    const LEGACY_KEY = 'dorkos-pinned-agents';

    it('seeds server pins from localStorage (order preserved) and removes the key when server is empty', () => {
      localStorage.setItem(LEGACY_KEY, JSON.stringify(['/projects/beta', '/projects/alpha']));
      renderWithProviders(<DashboardSidebar />);
      expect(mockUpdateSidebar).toHaveBeenCalledTimes(1);
      const updater = mockUpdateSidebar.mock.calls[0]![0] as (p: { pinned: SidebarItemRef[] }) => {
        pinned: SidebarItemRef[];
      };
      // The legacy key held bare paths; they are seeded as agent references.
      expect(updater({ pinned: [] }).pinned).toEqual([
        agent('/projects/beta'),
        agent('/projects/alpha'),
      ]);
      expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    });

    it('server wins when it already has pins: does not seed, still removes the key', () => {
      localStorage.setItem(LEGACY_KEY, JSON.stringify(['/projects/beta']));
      mockSidebarPrefs.mockReturnValue(makePrefs({ pinned: [agent('/projects/alpha')] }));
      renderWithProviders(<DashboardSidebar />);
      expect(mockUpdateSidebar).not.toHaveBeenCalled();
      expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    });

    it('is a no-op on a re-mount once the key is gone', () => {
      localStorage.setItem(LEGACY_KEY, JSON.stringify(['/projects/beta']));
      const first = renderWithProviders(<DashboardSidebar />);
      expect(mockUpdateSidebar).toHaveBeenCalledTimes(1);
      first.unmount();
      renderWithProviders(<DashboardSidebar />);
      expect(mockUpdateSidebar).toHaveBeenCalledTimes(1);
    });

    it('does nothing when there is no legacy key', () => {
      renderWithProviders(<DashboardSidebar />);
      expect(mockUpdateSidebar).not.toHaveBeenCalled();
    });
  });

  // --- Groups hint card threshold (DOR-329) ---

  describe('groups hint card', () => {
    const eightPaths = Array.from({ length: 8 }, (_, i) => `/projects/p${i}`);

    it('shows the hint at ≥8 agents with no groups and not dismissed', () => {
      mockMeshPaths.mockReturnValue(eightPaths);
      renderWithProviders(<DashboardSidebar />);
      expect(screen.getByText('Group your agents')).toBeInTheDocument();
    });

    it('hides the hint below 8 agents', () => {
      mockMeshPaths.mockReturnValue(eightPaths.slice(0, 7));
      renderWithProviders(<DashboardSidebar />);
      expect(screen.queryByText('Group your agents')).not.toBeInTheDocument();
    });

    it('hides the hint once a group exists', () => {
      mockMeshPaths.mockReturnValue(eightPaths);
      mockSidebarPrefs.mockReturnValue(makePrefs({ groups: [group()] }));
      renderWithProviders(<DashboardSidebar />);
      expect(screen.queryByText('Group your agents')).not.toBeInTheDocument();
    });

    it('hides the hint when previously dismissed', () => {
      mockMeshPaths.mockReturnValue(eightPaths);
      mockSidebarPrefs.mockReturnValue(makePrefs({ groupsHintDismissed: true }));
      renderWithProviders(<DashboardSidebar />);
      expect(screen.queryByText('Group your agents')).not.toBeInTheDocument();
    });

    it('persists dismissal via the sidebar prefs updater', () => {
      mockMeshPaths.mockReturnValue(eightPaths);
      renderWithProviders(<DashboardSidebar />);
      fireEvent.click(screen.getByLabelText('Dismiss grouping tip'));
      expect(mockUpdateSidebar).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Click-to-profile — the sidebar's half of the id bridge (DOR-957)
// ---------------------------------------------------------------------------
//
// A row knows an agent by its DIRECTORY; the profile drawer knows it by the id
// the mesh registered. `meshFleet()` above keeps those two visibly different on
// purpose, and this is where that pays: handing the path down instead of the id
// would open a drawer the roster has no row for, and every other assertion in
// this file would still pass.
describe('DashboardSidebar click-to-profile (DOR-957)', () => {
  afterEach(() => cleanup());

  const ALPHA_PATH = '/projects/alpha';
  const ALPHA_ID = `mesh-id${ALPHA_PATH}`;
  const GHOST_PATH = '/projects/ghost';

  beforeEach(() => {
    localStorage.clear();
    mockMeshPaths.mockReset();
    mockMeshPaths.mockReturnValue([ALPHA_PATH, '/projects/beta']);
    mockUnmappedPaths.mockReset();
    mockUnmappedPaths.mockReturnValue([]);
    mockSidebarPrefs.mockReset();
    mockSidebarPrefs.mockReturnValue(makePrefs());
    mockRecent.mockReset();
    mockRecent.mockReturnValue({ data: { sessions: [], agentActivity: {} }, isLoading: false });
    mockNavigate.mockReset();
    mockResolvedAgents.mockReset();
    mockResolvedAgents.mockReturnValue({});
    mockRooms.mockReset();
    mockRooms.mockReturnValue([]);
    mockAttentionMap.mockReset();
    mockAttentionMap.mockImplementation((paths: string[]) =>
      Object.fromEntries(paths.map((p) => [p, 'active']))
    );
    mockExecutionExceptions.mockReset();
    mockExecutionExceptions.mockReturnValue({
      exceptions: [],
      brokenPaths: [],
      defaultRuntime: 'claude-code',
    });
    mockSelectedCwd = null;
    mockPathname = '/';
    mockLocation = { pathname: '/', search: {} };
  });

  it('opens a row’s profile under the REGISTRY id, never the path the row holds', async () => {
    renderWithProviders(<DashboardSidebar />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open alpha’s profile' }));

    expect(mockNavigate).toHaveBeenCalled();
    expect(mockLocation.search.profile).toBe(ALPHA_ID);
    expect(mockLocation.search.profile).not.toBe(ALPHA_PATH);
  });

  it('draws no profile control for a row the roster cannot name', async () => {
    // A directory the sidebar lists while the registry has no row for it — no
    // id, so no control, rather than a face that opens an empty drawer.
    mockMeshPaths.mockReturnValue([ALPHA_PATH, GHOST_PATH]);
    mockUnmappedPaths.mockReturnValue([GHOST_PATH]);
    renderWithProviders(<DashboardSidebar />);

    await screen.findByRole('button', { name: 'Open alpha’s profile' });
    expect(screen.queryByRole('button', { name: 'Open ghost’s profile' })).not.toBeInTheDocument();
  });
});

describe('DashboardSidebar attention filters + reveal (DOR-339)', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    localStorage.clear();
    mockMeshPaths.mockReset();
    mockSidebarPrefs.mockReset();
    mockUpdateSidebar.mockReset();
    mockRecent.mockReset();
    mockNavigate.mockReset();
    mockResolvedAgents.mockReset();
    mockResolvedAgents.mockReturnValue({});
    mockMeshPaths.mockReturnValue(['~/.dork/agents/dorkbot', '/projects/alpha', '/projects/beta']);
    mockSidebarPrefs.mockReturnValue(makePrefs());
    mockRecent.mockReturnValue({ data: { sessions: [], agentActivity: {} }, isLoading: false });
    mockRooms.mockReset();
    mockRooms.mockReturnValue([]);
    mockAttentionMap.mockReset();
    mockExecutionExceptions.mockReset();
    mockExecutionExceptions.mockReturnValue({
      exceptions: [],
      brokenPaths: [],
      defaultRuntime: 'claude-code',
    });
    mockSelectedCwd = null;
    mockPathname = '/';
  });

  // The bridge the operator asked for: breakage found in Settings has to reach
  // the attention model, or "Needs attention" is only ever about live sessions.
  it('hands a broken execution config to the attention model, alongside the live signals', () => {
    mockExecutionExceptions.mockReturnValue({
      exceptions: [],
      brokenPaths: ['/projects/alpha'],
      defaultRuntime: 'claude-code',
    });
    mockAttentionMap.mockImplementation((paths: string[]) =>
      Object.fromEntries(paths.map((p) => [p, 'active']))
    );
    renderWithProviders(<DashboardSidebar />);
    expect(mockAttentionMap).toHaveBeenCalledWith(expect.any(Array), ['/projects/alpha']);
  });

  /** Override the attention map for specific paths; everything else stays 'active'. */
  function attentionOverride(states: Record<string, string>) {
    mockAttentionMap.mockImplementation((paths: string[]) =>
      Object.fromEntries(paths.map((p) => [p, states[p] ?? 'active']))
    );
  }

  it("a group's 'Needs attention' filter shows only the qualifying member, hiding the rest behind a reveal row that expands on click", () => {
    attentionOverride({ '/projects/alpha': 'needs-attention', '/projects/beta': 'inactive' });
    mockSidebarPrefs.mockReturnValue(
      makePrefs({
        groups: [
          group({
            items: [agent('/projects/alpha'), agent('/projects/beta')],
            displayFilter: 'attention',
          }),
        ],
      })
    );
    renderWithProviders(<DashboardSidebar />);

    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.queryByText('beta')).not.toBeInTheDocument();
    expect(screen.getByText('1 hidden')).toBeInTheDocument();

    fireEvent.click(screen.getByText('1 hidden'));
    expect(screen.getByText('beta')).toBeInTheDocument();
  });

  it("the ungrouped section's default 'all' filter collapses an inactive agent behind '1 inactive agent', which expands on click", () => {
    attentionOverride({ '/projects/beta': 'inactive' });
    renderWithProviders(<DashboardSidebar />);

    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.queryByText('beta')).not.toBeInTheDocument();
    expect(screen.getByText('1 inactive agent')).toBeInTheDocument();

    fireEvent.click(screen.getByText('1 inactive agent'));
    expect(screen.getByText('beta')).toBeInTheDocument();
  });
});

describe('DashboardSidebar smart groups (DOR-338)', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    localStorage.clear();
    mockMeshPaths.mockReset();
    mockSidebarPrefs.mockReset();
    mockUpdateSidebar.mockReset();
    mockRecent.mockReset();
    mockNavigate.mockReset();
    mockResolvedAgents.mockReset();
    mockResolvedAgents.mockReturnValue({});
    mockMeshPaths.mockReturnValue(['~/.dork/agents/dorkbot', '/projects/alpha', '/projects/beta']);
    mockSidebarPrefs.mockReturnValue(makePrefs());
    mockRecent.mockReturnValue({ data: { sessions: [], agentActivity: {} }, isLoading: false });
    mockRooms.mockReset();
    mockRooms.mockReturnValue([]);
    mockAttentionMap.mockReset();
    mockExecutionExceptions.mockReset();
    mockExecutionExceptions.mockReturnValue({
      exceptions: [],
      brokenPaths: [],
      defaultRuntime: 'claude-code',
    });
    mockSelectedCwd = null;
    mockPathname = '/';
  });

  // The bridge the operator asked for: breakage found in Settings has to reach
  // the attention model, or "Needs attention" is only ever about live sessions.
  it('hands a broken execution config to the attention model, alongside the live signals', () => {
    mockExecutionExceptions.mockReturnValue({
      exceptions: [],
      brokenPaths: ['/projects/alpha'],
      defaultRuntime: 'claude-code',
    });
    mockAttentionMap.mockImplementation((paths: string[]) =>
      Object.fromEntries(paths.map((p) => [p, 'active']))
    );
    renderWithProviders(<DashboardSidebar />);
    expect(mockAttentionMap).toHaveBeenCalledWith(expect.any(Array), ['/projects/alpha']);
  });

  /** Override the attention map for specific paths; everything else stays 'active'. */
  function attentionOverride(states: Record<string, string>) {
    mockAttentionMap.mockImplementation((paths: string[]) =>
      Object.fromEntries(paths.map((p) => [p, states[p] ?? 'active']))
    );
  }

  const smartGroup = (overrides: Partial<SidebarGroup> = {}) =>
    group({
      id: 's1',
      name: 'Attention now',
      kind: 'smart',
      sortMode: 'recent',
      rules: { statuses: ['needs-attention'] },
      ...overrides,
    });

  /** A wrapper-based render so `rerender` re-applies the same providers (live re-evaluation test). */
  function renderRerenderable() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Wrapper({ children }: { children: React.ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <SidebarProvider>{children}</SidebarProvider>
          </TooltipProvider>
        </QueryClientProvider>
      );
    }
    return render(<DashboardSidebar />, { wrapper: Wrapper });
  }

  it('renders derived members matching the rules, keeping the multi-presence copy in the ungrouped list', () => {
    attentionOverride({ '/projects/alpha': 'needs-attention', '/projects/beta': 'active' });
    mockSidebarPrefs.mockReturnValue(makePrefs({ groups: [smartGroup()] }));
    renderWithProviders(<DashboardSidebar />);

    expect(screen.getByText('Attention now')).toBeInTheDocument();
    // alpha matches the rule: one copy inside the smart group, one in "Agents"
    // (multi-presence — a smart group never removes an agent from its manual
    // home / the ungrouped list).
    expect(screen.getAllByText('alpha')).toHaveLength(2);
    // beta doesn't match: only its ungrouped copy renders.
    expect(screen.getAllByText('beta')).toHaveLength(1);
  });

  it('mute never filters membership: a muted needs-attention agent still matches the rule and renders dimmed in both places', () => {
    // Mute is a rendering/rollup lens (DOR-339), never a membership filter —
    // evaluateSmartGroup reads the raw attention map, independent of mute.
    attentionOverride({ '/projects/alpha': 'needs-attention', '/projects/beta': 'active' });
    mockSidebarPrefs.mockReturnValue(
      makePrefs({ groups: [smartGroup()], muted: [agent('/projects/alpha')] })
    );
    renderWithProviders(<DashboardSidebar />);

    // Still matches the statuses: ['needs-attention'] rule — one copy in the
    // smart group, one in the ungrouped list (multi-presence).
    expect(screen.getAllByText('alpha')).toHaveLength(2);
    // Both copies render muted (dimmed + the "Muted" glyph) — mute is a
    // per-path rendering state, not a per-section one.
    expect(screen.getAllByLabelText('Muted')).toHaveLength(2);
  });

  it('shows an honest "0 matching" state when nothing matches the rules', () => {
    attentionOverride({ '/projects/alpha': 'active', '/projects/beta': 'active' });
    mockSidebarPrefs.mockReturnValue(makePrefs({ groups: [smartGroup()] }));
    renderWithProviders(<DashboardSidebar />);

    expect(screen.getByText('No agents match these rules')).toBeInTheDocument();
  });

  it('re-evaluates live: an attention-state flip moves an agent out of the smart group', () => {
    attentionOverride({ '/projects/alpha': 'needs-attention', '/projects/beta': 'active' });
    mockSidebarPrefs.mockReturnValue(makePrefs({ groups: [smartGroup()] }));
    const { rerender } = renderRerenderable();

    expect(screen.getAllByText('alpha')).toHaveLength(2);

    // alpha goes idle — no longer matches `statuses: ['needs-attention']`.
    attentionOverride({ '/projects/alpha': 'active', '/projects/beta': 'active' });
    rerender(<DashboardSidebar />);

    expect(screen.getAllByText('alpha')).toHaveLength(1); // only the ungrouped copy survives
    expect(screen.getByText('No agents match these rules')).toBeInTheDocument();
  });
});

describe('DashboardSidebar mixed groups (sidebar-groups, DOR-580)', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    localStorage.clear();
    mockMeshPaths.mockReset();
    mockSidebarPrefs.mockReset();
    mockUpdateSidebar.mockReset();
    mockRecent.mockReset();
    mockNavigate.mockReset();
    mockResolvedAgents.mockReset();
    mockResolvedAgents.mockReturnValue({});
    mockMeshPaths.mockReturnValue(['/projects/alpha', '/projects/beta']);
    mockSidebarPrefs.mockReturnValue(makePrefs());
    mockRecent.mockReturnValue({ data: { sessions: [], agentActivity: {} }, isLoading: false });
    mockRooms.mockReset();
    mockRooms.mockReturnValue([]);
    mockAttentionMap.mockReset();
    mockAttentionMap.mockImplementation((paths: string[]) =>
      Object.fromEntries(paths.map((p) => [p, 'active']))
    );
    mockSelectedCwd = null;
    mockPathname = '/';
  });

  /**
   * The room row's mark, as the accessibility tree exposes it: decorative text.
   *
   * Read off the row in the room's OWN section — the "Jump back in" shortcut
   * draws the same room a second time, and a mark that differed between the two
   * would be exactly the drift this asserts against.
   */
  function markOf(roomName: string): string {
    const row = outsideShortcut(roomName).closest('[data-slot="sidebar-menu-item"]');
    return row?.querySelector('[data-slot="room-avatar"]')?.textContent ?? '';
  }

  it('renders a channel inside the group it was filed into, beside its agents', async () => {
    mockRooms.mockReturnValue([channel('c1', 'general')]);
    mockSidebarPrefs.mockReturnValue(
      makePrefs({ groups: [group({ items: [agent('/projects/alpha'), roomRef('c1')] })] })
    );
    renderWithProviders(<DashboardSidebar />);

    // Gate on the CHANNEL, not on the group header: the header renders from
    // prefs on the first pass, so waiting for it proves nothing about whether
    // the room list has arrived yet.
    await screen.findAllByText('#general');
    const groupBody = screen
      .getByText('Clients')
      .closest('[data-slot="sidebar-group"]') as HTMLElement;
    expect(within(groupBody).getByText('alpha')).toBeInTheDocument();
    expect(within(groupBody).getByText('#general')).toBeInTheDocument();
  });

  it('shows a grouped channel in exactly one place — never also in Channels', async () => {
    mockRooms.mockReturnValue([channel('c1', 'general'), channel('c2', 'random')]);
    mockSidebarPrefs.mockReturnValue(makePrefs({ groups: [group({ items: [roomRef('c1')] })] }));
    renderWithProviders(<DashboardSidebar />);

    // The gate: #random only ever renders once the room list has settled, so
    // reaching it proves the ungrouped Channels list has been built.
    expect((await screen.findAllByText('#random'))[0]).toBeInTheDocument();
    // The count is knowable, so assert it rather than "not more than one".
    expect(allOutsideShortcut('#general')).toHaveLength(1);
    expect(allOutsideShortcut('#random')).toHaveLength(1);
    // And the one #general is the copy inside the group.
    const groupBody = screen.getByText('Clients').closest('[data-slot="sidebar-group"]')!;
    expect(within(groupBody as HTMLElement).getByText('#general')).toBeInTheDocument();
  });

  it('a direct message in a group keeps out of the Direct messages section', async () => {
    mockRooms.mockReturnValue([
      dmWith('dm1', '/projects/alpha', 'Ana'),
      dmWith('dm2', '/projects/beta', 'Bo'),
    ]);
    mockSidebarPrefs.mockReturnValue(makePrefs({ groups: [group({ items: [roomRef('dm1')] })] }));
    renderWithProviders(<DashboardSidebar />);

    expect((await screen.findAllByText('Bo'))[0]).toBeInTheDocument();
    expect(allOutsideShortcut('Ana')).toHaveLength(1);
    const groupBody = screen.getByText('Clients').closest('[data-slot="sidebar-group"]')!;
    expect(within(groupBody as HTMLElement).getByText('Ana')).toBeInTheDocument();
  });

  it('a pinned room renders in Pinned as well as its own section (multi-presence)', async () => {
    mockRooms.mockReturnValue([channel('c1', 'general')]);
    mockSidebarPrefs.mockReturnValue(makePrefs({ pinned: [roomRef('c1')] }));
    renderWithProviders(<DashboardSidebar />);

    await screen.findByText('Pinned');
    expect(allOutsideShortcut('#general')).toHaveLength(2);
  });

  // --- Empty states that must not lie (spec §4) ---

  it('invites a first channel when there are genuinely none', async () => {
    renderWithProviders(<DashboardSidebar />);
    expect(await screen.findByText(/No channels yet/)).toBeInTheDocument();
    expect(screen.queryByText(/channels are all in groups/)).not.toBeInTheDocument();
  });

  it('says why Channels is empty when every channel is in a group, instead of "create one"', async () => {
    mockRooms.mockReturnValue([channel('c1', 'general')]);
    mockSidebarPrefs.mockReturnValue(makePrefs({ groups: [group({ items: [roomRef('c1')] })] }));
    renderWithProviders(<DashboardSidebar />);

    expect(await screen.findByText('Your channels are all in groups above.')).toBeInTheDocument();
    expect(screen.queryByText(/No channels yet/)).not.toBeInTheDocument();
  });

  it('invites a first conversation when there are genuinely none', async () => {
    renderWithProviders(<DashboardSidebar />);
    expect(await screen.findByText(/No messages yet/)).toBeInTheDocument();
    expect(screen.queryByText(/conversations are all in groups/)).not.toBeInTheDocument();
  });

  it('says why Direct messages is empty when every conversation is in a group', async () => {
    mockRooms.mockReturnValue([dmWith('dm1', '/projects/alpha', 'Ana')]);
    mockSidebarPrefs.mockReturnValue(makePrefs({ groups: [group({ items: [roomRef('dm1')] })] }));
    renderWithProviders(<DashboardSidebar />);

    expect(
      await screen.findByText('Your conversations are all in groups above.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/No messages yet/)).not.toBeInTheDocument();
  });

  it('says why Agents is empty when every agent is in a group', async () => {
    mockSidebarPrefs.mockReturnValue(
      makePrefs({ groups: [group({ items: [agent('/projects/alpha'), agent('/projects/beta')] })] })
    );
    renderWithProviders(<DashboardSidebar />);
    expect(await screen.findByText('Your agents are all in groups above.')).toBeInTheDocument();
  });

  it('stays quiet about grouping when some agents are still ungrouped', async () => {
    mockSidebarPrefs.mockReturnValue(
      makePrefs({ groups: [group({ items: [agent('/projects/alpha')] })] })
    );
    renderWithProviders(<DashboardSidebar />);
    // Gate on the settled sidebar: beta's ungrouped row is what proves the
    // section rendered at all before the absence below is asserted.
    expect(await screen.findByText('beta')).toBeInTheDocument();
    expect(screen.queryByText('Your agents are all in groups above.')).not.toBeInTheDocument();
  });

  // --- DOR-582: a DM wears its agent's face ---

  it("draws a one-to-one conversation with the agent's own emoji, not a letter", async () => {
    mockRooms.mockReturnValue([dmWith('dm1', '/projects/alpha', 'Ana')]);
    renderWithProviders(<DashboardSidebar />);

    await screen.findAllByText('Ana');
    // No manifest is resolved in this fixture, so the face is hashed from the
    // path — the same expression the agent's own row resolves through.
    const expected = resolveAgentVisual({ id: '/projects/alpha' }).emoji;
    expect(markOf('Ana')).toBe(expected);
    // 'A' is what the old AuthorRef-driven mark drew for "Ana". Naming it here
    // is the point: this test fails loudly if the row regresses to a letter.
    expect(markOf('Ana')).not.toBe('A');
  });

  it('draws a group conversation as a stack of every agent in it', async () => {
    const participants: AuthorRef[] = [
      { id: 'p-you', kind: 'human', displayName: 'You', handle: null },
      {
        id: 'p-ana',
        kind: 'agent',
        displayName: 'Ana',
        handle: null,
        agentRef: agentAuthorRef('/projects/alpha'),
      },
      {
        id: 'p-bo',
        kind: 'agent',
        displayName: 'Bo',
        handle: null,
        agentRef: agentAuthorRef('/projects/beta'),
      },
    ];
    mockRooms.mockReturnValue([room({ id: 'dm1', kind: 'dm', title: 'Ana and Bo', participants })]);
    renderWithProviders(<DashboardSidebar />);

    await screen.findAllByText('Ana and Bo');
    const expected =
      resolveAgentVisual({ id: '/projects/alpha' }).emoji +
      resolveAgentVisual({ id: '/projects/beta' }).emoji;
    expect(markOf('Ana and Bo')).toBe(expected);
  });

  it('gives a channel the # sigil rather than any face', async () => {
    mockRooms.mockReturnValue([channel('c1', 'general')]);
    renderWithProviders(<DashboardSidebar />);

    await screen.findAllByText('#general');
    const row = outsideShortcut('#general').closest('[data-slot="sidebar-menu-item"]')!;
    const mark = row.querySelector('[data-slot="room-avatar"]')!;
    // The lucide Hash glyph is an <svg>, and it carries no text at all — which
    // is exactly how it differs from every face-bearing mark.
    expect(mark.tagName.toLowerCase()).toBe('svg');
    expect(mark.textContent).toBe('');
  });
});

describe('DashboardSidebar threads (room-messaging-design §3)', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    localStorage.clear();
    mockMeshPaths.mockReset();
    mockMeshPaths.mockReturnValue([]);
    mockSidebarPrefs.mockReset();
    mockSidebarPrefs.mockReturnValue(makePrefs());
    mockUpdateSidebar.mockReset();
    mockRecent.mockReset();
    mockRecent.mockReturnValue({ data: { sessions: [], agentActivity: {} }, isLoading: false });
    mockNavigate.mockReset();
    mockResolvedAgents.mockReset();
    mockResolvedAgents.mockReturnValue({});
    mockRooms.mockReset();
    mockRooms.mockReturnValue([]);
    mockThreads.mockReset();
    mockThreads.mockReturnValue([]);
    mockAttentionMap.mockReset();
    mockAttentionMap.mockImplementation((paths: string[]) =>
      Object.fromEntries(paths.map((p) => [p, 'active']))
    );
    mockSelectedCwd = null;
    mockPathname = '/';
    useRoomOpenThreadStore.setState({ open: {} });
  });

  const thread = (overrides: Partial<ThreadSummary> = {}): ThreadSummary => ({
    roomId: 'room-1',
    roomKind: 'channel',
    roomSlug: 'general',
    roomTitle: 'general',
    rootEntryId: 'entry-1',
    rootAuthorId: 'author-1',
    rootPreview: 'Deploy is red again',
    replyCount: 2,
    unreadCount: 0,
    lastActivityAt: '2026-07-30T12:00:00.000Z',
    ...overrides,
  });

  it('draws the Threads section above Channels', async () => {
    mockThreads.mockReturnValue([thread()]);
    mockRooms.mockReturnValue([channel('room-1', 'general')]);
    renderWithProviders(<DashboardSidebar />);

    const threads = await screen.findByRole('button', { name: 'Threads' });
    const channels = screen.getByRole('button', { name: 'Channels' });
    // `compareDocumentPosition` answers about the rendered order, which is the
    // claim — "above" is a fact about the DOM, not about the source.
    expect(threads.compareDocumentPosition(channels)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('opens the right room with the right thread panel, store first then URL', async () => {
    mockThreads.mockReturnValue([thread({ roomId: 'room-7', rootEntryId: 'entry-9' })]);
    renderWithProviders(<DashboardSidebar />);

    fireEvent.click(await screen.findByText('Deploy is red again'));

    // The store is what draws the panel. Navigating alone would do nothing at
    // all in a room the reader is already in — the URL is only read on the way
    // into a room — so this assertion is the feature, not a detail of it.
    expect(useRoomOpenThreadStore.getState().open['room-7']).toEqual({
      rootEntryId: 'entry-9',
      focusComposer: false,
    });
    // …and the URL carries both, so the result is linkable and survives reload.
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/channels',
      search: { id: 'room-7', thread: 'entry-9' },
    });
  });

  it('shows no Threads section when the reader is in none', async () => {
    mockRooms.mockReturnValue([channel('room-1', 'general')]);
    renderWithProviders(<DashboardSidebar />);

    await screen.findByRole('button', { name: 'Channels' });
    expect(screen.queryByRole('button', { name: 'Threads' })).not.toBeInTheDocument();
  });
});
