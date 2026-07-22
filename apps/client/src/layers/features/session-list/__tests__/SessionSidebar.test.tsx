import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionSidebar } from '../ui/SessionSidebar';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import type { Session } from '@dorkos/shared/types';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider, SidebarProvider } from '@/layers/shared/ui';

// SessionSidebar is now the quarantined embedded-shell (Obsidian) chrome: a
// self-contained four-tab strip over its own panels, with no extension-registry
// dependency. These tests exercise that standalone form.

// Mock useSessionId (TanStack Router search params)
const mockSetSessionId = vi.fn();
vi.mock('@/layers/entities/session/model/use-session-id', () => ({
  useSessionId: () => [null, mockSetSessionId] as const,
}));

// Mock useDirectoryState (TanStack Router search params)
vi.mock('@/layers/entities/session/model/use-directory-state', () => ({
  useDirectoryState: () => ['/test/cwd', vi.fn()] as const,
}));

// Mock TanStack Router hooks (SessionSidebar uses useNavigate and useLocation directly)
let mockPathname = '/session';
const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  useLocation: () => ({ pathname: mockPathname }),
  useSearch: () => ({}),
}));

// Mock URL deep-link hooks — TasksView (rendered in the schedules tabpanel) and
// use-task-notifications both call useTasksDeepLink. Stubbing here keeps the
// router mock minimal.
const mockOpenTasks = vi.fn();
vi.mock('@/layers/shared/model/use-dialog-deep-link', () => ({
  useTasksDeepLink: () => ({
    isOpen: false,
    activeTab: null,
    section: null,
    open: mockOpenTasks,
    close: vi.fn(),
    setTab: vi.fn(),
    setSection: vi.fn(),
  }),
  useRelayDeepLink: () => ({
    isOpen: false,
    activeTab: null,
    section: null,
    open: vi.fn(),
    close: vi.fn(),
    setTab: vi.fn(),
    setSection: vi.fn(),
  }),
  useSettingsDeepLink: () => ({
    isOpen: false,
    activeTab: null,
    section: null,
    open: vi.fn(),
    close: vi.fn(),
    setTab: vi.fn(),
    setSection: vi.fn(),
  }),
  useAgentDialogDeepLink: () => ({
    isOpen: false,
    activeTab: null,
    section: null,
    agentPath: null,
    open: vi.fn(),
    close: vi.fn(),
    setTab: vi.fn(),
    setSection: vi.fn(),
  }),
  useOpenAgentDialog: () => vi.fn(),
}));

// Mock app store (sidebar state + selectedCwd)
const mockSetSidebarOpen = vi.fn();
const mockSetTasksOpen = vi.fn();
const mockSetPickerOpen = vi.fn();
const mockSetAgentDialogOpen = vi.fn();
const mockSetRelayOpen = vi.fn();
const mockSetSettingsOpen = vi.fn();
let mockSidebarActiveTab: string = 'overview';
const mockSetSidebarActiveTab = vi.fn((tab: string) => {
  mockSidebarActiveTab = tab;
});
vi.mock('@/layers/shared/model/app-store', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      setSidebarOpen: mockSetSidebarOpen,
      setTasksOpen: mockSetTasksOpen,
      setPickerOpen: mockSetPickerOpen,
      setAgentDialogOpen: mockSetAgentDialogOpen,
      setRelayOpen: mockSetRelayOpen,
      setSettingsOpen: mockSetSettingsOpen,
      setGlobalPaletteOpen: vi.fn(),
      toggleDevtools: vi.fn(),
      devtoolsOpen: false,
      selectedCwd: '/test/cwd',
      recentCwds: [],
      enableTasksNotifications: false,
      tasksOpen: false,
      setTasksBadgeCount: vi.fn(),
      sidebarActiveTab: mockSidebarActiveTab,
      setSidebarActiveTab: mockSetSidebarActiveTab,
      sidebarOpen: true,
    };
    return selector ? selector(state) : state;
  },
}));

// Mock useIsMobile
vi.mock('@/layers/shared/model/use-is-mobile', () => ({
  useIsMobile: () => false,
}));

// Mock onboarding hooks
vi.mock('@/layers/features/onboarding', () => ({
  useOnboarding: () => ({ shouldShowOnboarding: false, dismiss: vi.fn() }),
  ProgressCard: () => null,
}));

// Mock agent entity hooks — mutable tool status for feature flag tests
let mockToolStatus = {
  tasks: 'enabled' as string,
  relay: 'enabled' as string,
  mesh: 'enabled' as string,
  adapter: 'enabled' as string,
};
vi.mock('@/layers/entities/agent', () => ({
  useCurrentAgent: () => ({ data: null, isLoading: false }),
  useAgentVisual: () => ({ color: 'hsl(0,70%,55%)', emoji: '🤖' }),
  useResolvedAgents: () => ({ data: undefined }),
  useAgentToolStatus: () => mockToolStatus,
  useMcpConfig: () => ({ data: undefined }),
  AgentIdentity: ({ name, emoji }: { name: string; emoji: string }) => (
    <span>
      <span>{emoji}</span>
      <span>{name}</span>
    </span>
  ),
}));

// Mock useTasksEnabled
vi.mock('@/layers/entities/tasks/model/use-tasks-config', () => ({
  useTasksEnabled: () => true,
}));

// Mock useActiveRunCount and useRuns
vi.mock('@/layers/entities/tasks/model/use-task-runs', () => ({
  useActiveTaskRunCount: () => ({ data: 0 }),
  useTaskRuns: () => ({ data: [] }),
}));

// Mock useCompletedRunBadge
const mockClearBadge = vi.fn();
vi.mock('@/layers/entities/tasks/model/use-completed-task-run-badge', () => ({
  useCompletedTaskRunBadge: () => ({ unviewedCount: 0, clearBadge: mockClearBadge }),
}));

// Mock useConnectionsStatus (derived hook in model/ segment)
vi.mock('../model/use-connections-status', () => ({
  useConnectionsStatus: () => 'none' as const,
}));

// Mock useRelayEnabled and useRelayAdapters (used by ConnectionsView)
vi.mock('@/layers/entities/relay', () => ({
  useRelayEnabled: () => false,
  useRelayAdapters: () => ({ data: [] }),
}));

// Mock useRegisteredAgents, useAgentAccess, and useMeshEnabled (used by ConnectionsView and PromoSlot)
vi.mock('@/layers/entities/mesh', () => ({
  useRegisteredAgents: () => ({ data: { agents: [] } }),
  useAgentAccess: () => ({ data: undefined, isLoading: false }),
  useMeshEnabled: () => false,
}));

// Mock useTheme (used by SidebarFooterBar)
vi.mock('@/layers/shared/model/use-theme', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
}));

// Mock sonner
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}));

// Mock favicon-utils
vi.mock('@/layers/shared/lib/favicon-utils', () => ({
  hashToHslColor: (_s: string) => 'hsl(0, 70%, 55%)',
  hashToEmoji: (_s: string) => '🤖',
}));

// Mock session-utils to avoid time-dependent behavior
vi.mock('@/layers/shared/lib/session-utils', () => ({
  groupSessionsByTime: (sessions: Session[]) => {
    if (sessions.length === 0) return [];
    const today = sessions.filter((s) => s.updatedAt >= '2026-02-07');
    const older = sessions.filter((s) => s.updatedAt < '2026-02-07');
    const groups = [];
    if (today.length > 0) groups.push({ label: 'Today', sessions: today });
    if (older.length > 0) groups.push({ label: 'Older', sessions: older });
    return groups;
  },
  formatRelativeTime: (iso: string) => (iso >= '2026-02-07' ? '1h ago' : 'Jan 1, 3pm'),
}));

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: overrides.id ?? 'session-1',
    title: overrides.title ?? 'Test session',
    createdAt: overrides.createdAt ?? '2026-02-07T10:00:00Z',
    updatedAt: overrides.updatedAt ?? '2026-02-07T14:00:00Z',
    permissionMode: overrides.permissionMode ?? 'default',
    runtime: overrides.runtime ?? 'claude-code',
    // Matches the app-store mock's selectedCwd — the canonical per-agent
    // selector (useAgentSessions, DOR-203) drops sessions with a foreign cwd.
    cwd: overrides.cwd ?? '/test/cwd',
    ...overrides,
  };
}

beforeAll(() => {
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

let mockTransport: Transport;

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={mockTransport}>
        <TooltipProvider>
          <SidebarProvider>{ui}</SidebarProvider>
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
}

describe('SessionSidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTransport = createMockTransport();
    mockSetSidebarOpen.mockClear();
    mockSidebarActiveTab = 'overview';
    mockPathname = '/session';
  });
  afterEach(() => {
    cleanup();
  });

  it('renders "New session" button', () => {
    renderWithQuery(<SessionSidebar />);
    expect(screen.getByText('New session')).toBeDefined();
  });

  it('shows empty state when no sessions', async () => {
    renderWithQuery(<SessionSidebar />);
    await waitFor(() => {
      expect(screen.getByText('No conversations yet')).toBeDefined();
    });
  });

  it('renders sessions grouped by time', async () => {
    mockTransport = createMockTransport({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [
          makeSession({ id: 's1', title: 'Today session', updatedAt: '2026-02-07T12:00:00Z' }),
          makeSession({ id: 's2', title: 'Old session', updatedAt: '2025-06-01T10:00:00Z' }),
        ],
      }),
    });

    renderWithQuery(<SessionSidebar />);

    await waitFor(() => {
      expect(screen.getByText('Today')).toBeDefined();
      expect(screen.getByText('Older')).toBeDefined();
    });

    // Sessions appear in both the overview "Recent Sessions" and the sessions tab
    expect(screen.getAllByText('Today session').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Old session').length).toBeGreaterThanOrEqual(1);
  });

  it('sets active session to a UUID on "New session" click', () => {
    renderWithQuery(<SessionSidebar />);
    fireEvent.click(screen.getByText('New session'));

    expect(mockSetSessionId).toHaveBeenCalledTimes(1);
    const calledWith = mockSetSessionId.mock.calls[0][0];
    expect(calledWith).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('generates unique UUIDs on each "New session" click', () => {
    renderWithQuery(<SessionSidebar />);
    const newSessionButton = screen.getByText('New session');

    fireEvent.click(newSessionButton);
    fireEvent.click(newSessionButton);

    expect(mockSetSessionId).toHaveBeenCalledTimes(2);
    const firstUUID = mockSetSessionId.mock.calls[0][0];
    const secondUUID = mockSetSessionId.mock.calls[1][0];
    expect(firstUUID).not.toBe(secondUUID);
  });

  it('hides "Today" header when it is the only group', async () => {
    mockTransport = createMockTransport({
      listSessions: vi.fn().mockResolvedValue({
        sessions: [
          makeSession({ id: 's1', title: 'Only today', updatedAt: '2026-02-07T12:00:00Z' }),
        ],
      }),
    });

    renderWithQuery(<SessionSidebar />);

    await waitFor(() => {
      expect(screen.getAllByText('Only today').length).toBeGreaterThanOrEqual(1);
    });

    expect(screen.queryByText('Today')).toBeNull();
  });

  it('does not render AgentContextChips (replaced by tab badges)', () => {
    renderWithQuery(<SessionSidebar />);
    expect(screen.queryByLabelText('Tasks scheduler')).toBeNull();
    expect(screen.queryByLabelText('Relay messaging')).toBeNull();
    expect(screen.queryByLabelText('Mesh discovery')).toBeNull();
  });

  it('does not render footer (footer moved to the embedding shell)', () => {
    renderWithQuery(<SessionSidebar />);
    // Footer with branding and settings lives in the embedding shell, not here.
    expect(screen.queryByLabelText('App Settings')).toBeNull();
  });

  describe('local tab strip', () => {
    it('renders the four built-in tab buttons', () => {
      renderWithQuery(<SessionSidebar />);
      expect(screen.getByRole('tablist')).toBeInTheDocument();
      const tabIds = screen.getAllByRole('tab').map((t) => t.id);
      expect(tabIds).toEqual([
        'sidebar-tab-overview',
        'sidebar-tab-sessions',
        'sidebar-tab-schedules',
        'sidebar-tab-connections',
      ]);
    });

    it('shows overview tabpanel by default and hides others', () => {
      renderWithQuery(<SessionSidebar />);
      const overviewPanel = document.getElementById('sidebar-tabpanel-overview');
      const sessionsPanel = document.getElementById('sidebar-tabpanel-sessions');
      const schedulesPanel = document.getElementById('sidebar-tabpanel-schedules');
      const connectionsPanel = document.getElementById('sidebar-tabpanel-connections');
      expect(overviewPanel?.classList.contains('hidden')).toBe(false);
      expect(sessionsPanel?.classList.contains('hidden')).toBe(true);
      expect(schedulesPanel?.classList.contains('hidden')).toBe(true);
      expect(connectionsPanel?.classList.contains('hidden')).toBe(true);
    });

    it('switching a tab calls setSidebarActiveTab', () => {
      renderWithQuery(<SessionSidebar />);

      const schedulesTab = screen.getAllByRole('tab').find((t) => t.id === 'sidebar-tab-schedules');
      expect(schedulesTab).toBeDefined();
      if (schedulesTab) {
        fireEvent.click(schedulesTab);
        expect(mockSetSidebarActiveTab).toHaveBeenCalledWith('schedules');
      }
    });

    it('reflects the store active tab by revealing its panel', () => {
      mockSidebarActiveTab = 'connections';
      renderWithQuery(<SessionSidebar />);
      const connectionsPanel = document.getElementById('sidebar-tabpanel-connections');
      const overviewPanel = document.getElementById('sidebar-tabpanel-overview');
      expect(connectionsPanel?.classList.contains('hidden')).toBe(false);
      expect(overviewPanel?.classList.contains('hidden')).toBe(true);
      const connectionsTab = screen
        .getAllByRole('tab')
        .find((t) => t.id === 'sidebar-tab-connections');
      expect(connectionsTab).toHaveAttribute('aria-selected', 'true');
    });

    it('resolves a stale/extension tab id back to overview', () => {
      // A leftover namespaced id from the old registry-backed strip (or an
      // uninstalled extension) is not one of the four built-ins, so the panel
      // area falls back to overview rather than going blank.
      mockSidebarActiveTab = 'linear-issues:linear-loop-sidebar';
      renderWithQuery(<SessionSidebar />);

      const overviewPanel = document.getElementById('sidebar-tabpanel-overview');
      expect(overviewPanel?.classList.contains('hidden')).toBe(false);
      // No phantom panel is mounted for the orphaned id.
      expect(
        document.getElementById('sidebar-tabpanel-linear-issues:linear-loop-sidebar')
      ).toBeNull();
      const overviewTab = screen.getAllByRole('tab').find((t) => t.id === 'sidebar-tab-overview');
      expect(overviewTab).toHaveAttribute('aria-selected', 'true');
    });

    it('each tabpanel has correct aria-labelledby linking to its tab', () => {
      renderWithQuery(<SessionSidebar />);
      const sessionsPanel = document.getElementById('sidebar-tabpanel-sessions');
      const schedulesPanel = document.getElementById('sidebar-tabpanel-schedules');
      const connectionsPanel = document.getElementById('sidebar-tabpanel-connections');
      expect(sessionsPanel?.getAttribute('aria-labelledby')).toBe('sidebar-tab-sessions');
      expect(schedulesPanel?.getAttribute('aria-labelledby')).toBe('sidebar-tab-schedules');
      expect(connectionsPanel?.getAttribute('aria-labelledby')).toBe('sidebar-tab-connections');
    });

    it('keeps the Schedules tab present even when Tasks is disabled-by-server', () => {
      // The quarantined strip is a fixed four-tab union; only the panel content
      // reacts to tool status, not the strip itself.
      //
      // SIGN-OFF (reviewer-accepted): keeping Schedules-when-server-disabled on
      // this deprecated embedded surface is deliberate — a benign empty state.
      // The registry-driven `visibleWhen` that used to hide it died with the
      // tab-strip machinery, and the Obsidian north-star rework deletes this whole
      // component; wiring conditional visibility back into a legacy shell is not
      // worth it.
      mockToolStatus = {
        tasks: 'disabled-by-server',
        relay: 'enabled',
        mesh: 'enabled',
        adapter: 'enabled',
      };
      renderWithQuery(<SessionSidebar />);
      const schedulesTab = screen.getAllByRole('tab').find((t) => t.id === 'sidebar-tab-schedules');
      expect(schedulesTab).toBeDefined();
      mockToolStatus = { tasks: 'enabled', relay: 'enabled', mesh: 'enabled', adapter: 'enabled' };
    });
  });
});
