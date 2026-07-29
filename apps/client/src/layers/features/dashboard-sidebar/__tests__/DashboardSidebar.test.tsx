// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { agentAuthorRef, type AuthorRef, type RoomSummary } from '@dorkos/shared/room-schemas';
import { resolveAgentVisual } from '@/layers/shared/lib';
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
    { id: `${id}-you`, kind: 'human', displayName: 'You' },
    { id: `${id}-agent`, kind: 'agent', displayName: title, agentRef: agentAuthorRef(agentPath) },
  ];
  return room({ id, kind: 'dm', title, participants });
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn();
let mockPathname = '/';
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
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
const mockTransport = {
  getConfig: vi.fn().mockResolvedValue({ agents: { defaultAgent: 'dorkbot' } }),
  listMeshAgentPaths: vi.fn(),
  resolveAgents: vi.fn().mockResolvedValue({}),
  listSessions: vi.fn().mockResolvedValue({ sessions: [] }),
  listRooms: vi.fn(() => Promise.resolve(mockRooms())),
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

vi.mock('@/layers/entities/mesh', () => ({
  useMeshAgentPaths: () => ({
    data: {
      agents: mockMeshPaths().map((p) => ({
        id: p,
        name: p.split('/').pop() ?? 'agent',
        projectPath: p,
      })),
    },
  }),
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
  useAgentVisual: () => ({ color: '#aaaaaa', emoji: '🤖' }),
  AgentIdentity: ({ name, emoji }: { name: string; emoji: string }) => (
    <span>
      <span>{emoji}</span>
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
const mockAttentionMap = vi.fn((paths: string[]) =>
  Object.fromEntries(paths.map((p) => [p, 'active']))
);

vi.mock('@/layers/entities/session', async (importOriginal) => ({
  // The query-key factory is the real one: a stub here would let the sidebar
  // read a cache key nothing in the app writes and never say so (DOR-497).
  sessionKeys: (await importOriginal<typeof import('@/layers/entities/session')>()).sessionKeys,
  useAgentSessions: () => ({ sessions: [], activeSessionId: null, isLoading: false }),
  useSessionBorderState: () => ({ kind: 'idle', color: 'x', pulse: false, label: 'Idle' }),
  useAgentHottestStatus: () => ({ kind: 'idle', color: 'x', pulse: false, label: 'Idle' }),
  useAgentsAggregateStatus: () => false,
  useAgentAttentionMap: (paths: string[]) => mockAttentionMap(paths),
  usePulseMotion: () => ({ animate: undefined, transition: undefined }),
  useRenameSession: () => ({ mutate: vi.fn() }),
  useRecentSessions: () => mockRecent(),
  sessionDisplayTitle: (t: string) => t,
  SessionRow: () => null,
  OriginMark: () => null,
  // Stubbed rather than imported: mirrors the real partition (session-origin-legibility)
  // without pulling the real module into this wholesale mock.
  partitionSessionsByOrigin: (sessions: Array<{ origin?: string }>) => ({
    conversations: sessions.filter((s) => !s.origin || s.origin === 'user'),
    automated: sessions.filter((s) => s.origin && s.origin !== 'user'),
  }),
}));

vi.mock('@/layers/features/feature-promos', () => ({ PromoSlot: () => null }));

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
    mockAttentionMap.mockReset();
    mockAttentionMap.mockImplementation((paths: string[]) =>
      Object.fromEntries(paths.map((p) => [p, 'active']))
    );
    mockSelectedCwd = null;
    mockPathname = '/';
  });

  // --- Navigation ---

  it('renders Dashboard nav item', () => {
    renderWithProviders(<DashboardSidebar />);
    expect(screen.getAllByText('Dashboard').length).toBeGreaterThanOrEqual(1);
  });

  it('navigates to /agents from the Agents nav item', () => {
    renderWithProviders(<DashboardSidebar />);
    fireEvent.click(screen.getAllByText('Agents')[0]);
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/agents' });
  });

  it('renders default agent (dorkbot) and navigates on click', () => {
    renderWithProviders(<DashboardSidebar />);
    fireEvent.click(screen.getAllByText('dorkbot')[0]);
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: expect.objectContaining({ dir: '~/.dork/agents/dorkbot' }),
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
    // No "Agents" section label in flat mode (nav item "Agents" is a button, not a group label)
    const agentsLabels = screen.getAllByText('Agents').filter((el) => el.closest('button'));
    expect(agentsLabels.length).toBe(1); // only the nav button
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

  it('renders the "Drag agents here" hint for an empty group and does not remove it', () => {
    mockSidebarPrefs.mockReturnValue(makePrefs({ groups: [group({ items: [] })] }));
    renderWithProviders(<DashboardSidebar />);
    expect(screen.getByText('Drag agents here')).toBeInTheDocument();
    expect(screen.getByText('Clients')).toBeInTheDocument();
    expect(mockUpdateSidebar).not.toHaveBeenCalled(); // never auto-deleted
  });

  // --- Recent section visibility ---

  it('hides Recent when fewer than 2 agents', () => {
    mockMeshPaths.mockReturnValue(['/projects/solo']);
    mockRecent.mockReturnValue({
      data: {
        sessions: [
          {
            id: 's1',
            title: 'Hi',
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
    expect(screen.queryByText('Recent')).not.toBeInTheDocument();
  });

  it('hides Recent when there are no recent sessions', () => {
    renderWithProviders(<DashboardSidebar />);
    expect(screen.queryByText('Recent')).not.toBeInTheDocument();
  });

  it('shows Recent with session rows when ≥2 agents have recent sessions', () => {
    mockRecent.mockReturnValue({
      data: {
        sessions: [
          {
            id: 's1',
            title: 'Fix the bug',
            cwd: '/projects/alpha',
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
    expect(screen.getByText('Recent')).toBeInTheDocument();
    expect(screen.getByText('Fix the bug')).toBeInTheDocument();
  });

  it('shows 3 skeleton rows while Recent is loading', () => {
    mockRecent.mockReturnValue({ data: undefined, isLoading: true });
    renderWithProviders(<DashboardSidebar />);
    // Scoped to the Recent group: the Channels and Direct messages sections
    // render their own skeletons off a different query, so a whole-container
    // count would be measuring all three at once.
    const recentGroup = screen.getByText('Recent').closest('[data-slot="sidebar-group"]');
    expect(recentGroup?.querySelectorAll('[data-slot="sidebar-menu-skeleton"]')).toHaveLength(3);
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
    mockSelectedCwd = null;
    mockPathname = '/';
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
    mockSelectedCwd = null;
    mockPathname = '/';
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

  /** The room row's mark, as the accessibility tree exposes it: decorative text. */
  function markOf(roomName: string): string {
    const row = screen.getByText(roomName).closest('[data-slot="sidebar-menu-item"]');
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
    await screen.findByText('#general');
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
    expect(await screen.findByText('#random')).toBeInTheDocument();
    // The count is knowable, so assert it rather than "not more than one".
    expect(screen.getAllByText('#general')).toHaveLength(1);
    expect(screen.getAllByText('#random')).toHaveLength(1);
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

    expect(await screen.findByText('Bo')).toBeInTheDocument();
    expect(screen.getAllByText('Ana')).toHaveLength(1);
    const groupBody = screen.getByText('Clients').closest('[data-slot="sidebar-group"]')!;
    expect(within(groupBody as HTMLElement).getByText('Ana')).toBeInTheDocument();
  });

  it('a pinned room renders in Pinned as well as its own section (multi-presence)', async () => {
    mockRooms.mockReturnValue([channel('c1', 'general')]);
    mockSidebarPrefs.mockReturnValue(makePrefs({ pinned: [roomRef('c1')] }));
    renderWithProviders(<DashboardSidebar />);

    await screen.findByText('Pinned');
    expect(screen.getAllByText('#general')).toHaveLength(2);
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

    await screen.findByText('Ana');
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
      { id: 'p-you', kind: 'human', displayName: 'You' },
      {
        id: 'p-ana',
        kind: 'agent',
        displayName: 'Ana',
        agentRef: agentAuthorRef('/projects/alpha'),
      },
      { id: 'p-bo', kind: 'agent', displayName: 'Bo', agentRef: agentAuthorRef('/projects/beta') },
    ];
    mockRooms.mockReturnValue([room({ id: 'dm1', kind: 'dm', title: 'Ana and Bo', participants })]);
    renderWithProviders(<DashboardSidebar />);

    await screen.findByText('Ana and Bo');
    const expected =
      resolveAgentVisual({ id: '/projects/alpha' }).emoji +
      resolveAgentVisual({ id: '/projects/beta' }).emoji;
    expect(markOf('Ana and Bo')).toBe(expected);
  });

  it('gives a channel the # sigil rather than any face', async () => {
    mockRooms.mockReturnValue([channel('c1', 'general')]);
    renderWithProviders(<DashboardSidebar />);

    await screen.findByText('#general');
    const row = screen.getByText('#general').closest('[data-slot="sidebar-menu-item"]')!;
    const mark = row.querySelector('[data-slot="room-avatar"]')!;
    // The lucide Hash glyph is an <svg>, and it carries no text at all — which
    // is exactly how it differs from every face-bearing mark.
    expect(mark.tagName.toLowerCase()).toBe('svg');
    expect(mark.textContent).toBe('');
  });
});
