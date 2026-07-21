// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { DashboardSidebar } from '../ui/DashboardSidebar';
import { SidebarProvider, TooltipProvider } from '@/layers/shared/ui';
import type { SidebarPrefs, SidebarGroup } from '@dorkos/shared/config-schema';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn();
let mockPathname = '/';
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: mockPathname } }),
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
const mockResolvedAgents = vi.fn<
  () => Record<string, { name: string; displayName?: string } | null>
>(() => ({}));
let mockSelectedCwd: string | null = null;

function makePrefs(overrides: Partial<SidebarPrefs> = {}): SidebarPrefs {
  return {
    pinned: [],
    groups: [],
    ungroupedSortMode: 'name',
    ungroupedCollapsed: false,
    recentsCollapsed: false,
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

const mockTransport = {
  getConfig: vi.fn().mockResolvedValue({ agents: { defaultAgent: 'dorkbot' } }),
  listMeshAgentPaths: vi.fn(),
  resolveAgents: vi.fn().mockResolvedValue({}),
  listSessions: vi.fn().mockResolvedValue({ sessions: [] }),
};

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useTransport: () => mockTransport,
    useNow: () => Date.now(),
    useIsMobile: () => false,
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
    pinPath: passthrough,
    unpinPath: passthrough,
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

vi.mock('@/layers/entities/agent', () => ({
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

vi.mock('@/layers/entities/session', () => ({
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
    agentPaths: [],
    sortMode: 'manual',
    collapsed: false,
    displayFilter: 'all',
    muted: false,
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
      '/projects/zebra': { name: 'zebra', displayName: 'Apple' },
      '/projects/alpha': { name: 'alpha', displayName: 'Zulu' },
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
        pinned: ['/projects/alpha'],
        groups: [group({ agentPaths: ['/projects/beta'] })],
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
    mockSidebarPrefs.mockReturnValue(makePrefs({ pinned: ['/projects/alpha'] }));
    renderWithProviders(<DashboardSidebar />);
    expect(screen.getByText('Pinned')).toBeInTheDocument();
  });

  // --- Multi-presence: pinned agent also renders in its group ---

  it('renders a pinned+grouped agent twice (multi-presence)', () => {
    mockMeshPaths.mockReturnValue(['/projects/alpha', '/projects/beta']);
    mockSidebarPrefs.mockReturnValue(
      makePrefs({
        pinned: ['/projects/alpha'],
        groups: [group({ agentPaths: ['/projects/alpha'] })],
      })
    );
    renderWithProviders(<DashboardSidebar />);
    // alpha appears once in Pinned and once in the group.
    expect(screen.getAllByText('alpha')).toHaveLength(2);
  });

  // --- Empty group ---

  it('renders the "Drag agents here" hint for an empty group and does not remove it', () => {
    mockSidebarPrefs.mockReturnValue(makePrefs({ groups: [group({ agentPaths: [] })] }));
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
    const { container } = renderWithProviders(<DashboardSidebar />);
    expect(screen.getByText('Recent')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-slot="sidebar-menu-skeleton"]')).toHaveLength(3);
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
      const updater = mockUpdateSidebar.mock.calls[0]![0] as (p: { pinned: string[] }) => {
        pinned: string[];
      };
      expect(updater({ pinned: [] }).pinned).toEqual(['/projects/beta', '/projects/alpha']);
      expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    });

    it('server wins when it already has pins: does not seed, still removes the key', () => {
      localStorage.setItem(LEGACY_KEY, JSON.stringify(['/projects/beta']));
      mockSidebarPrefs.mockReturnValue(makePrefs({ pinned: ['/projects/alpha'] }));
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
          group({ agentPaths: ['/projects/alpha', '/projects/beta'], displayFilter: 'attention' }),
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
