import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionSidebar } from '../ui/SessionSidebar';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import type { Session } from '@dorkos/shared/types';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider, SidebarProvider } from '@/layers/shared/ui';

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
}));

// Mock app store (sidebar state + selectedCwd)
const mockSetSidebarOpen = vi.fn();
const mockSetPulseOpen = vi.fn();
const mockSetPickerOpen = vi.fn();
const mockSetAgentDialogOpen = vi.fn();
const mockSetOnboardingStep = vi.fn();
const mockSetRelayOpen = vi.fn();
const mockSetMeshOpen = vi.fn();
const mockSetSettingsOpen = vi.fn();
let mockSidebarActiveTab: 'sessions' | 'schedules' | 'connections' = 'sessions';
const mockSetSidebarActiveTab = vi.fn((tab: string) => {
  mockSidebarActiveTab = tab as 'sessions' | 'schedules' | 'connections';
});
vi.mock('@/layers/shared/model/app-store', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      setSidebarOpen: mockSetSidebarOpen,
      setPulseOpen: mockSetPulseOpen,
      setPickerOpen: mockSetPickerOpen,
      setAgentDialogOpen: mockSetAgentDialogOpen,
      setOnboardingStep: mockSetOnboardingStep,
      setRelayOpen: mockSetRelayOpen,
      setMeshOpen: mockSetMeshOpen,
      setSettingsOpen: mockSetSettingsOpen,
      setGlobalPaletteOpen: vi.fn(),
      toggleDevtools: vi.fn(),
      devtoolsOpen: false,
      selectedCwd: '/test/cwd',
      recentCwds: [],
      enablePulseNotifications: false,
      pulseOpen: false,
      setPulseBadgeCount: vi.fn(),
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
  pulse: 'enabled' as string,
  relay: 'enabled' as string,
  mesh: 'enabled' as string,
  adapter: 'enabled' as string,
};
vi.mock('@/layers/entities/agent', () => ({
  useCurrentAgent: () => ({ data: null, isLoading: false }),
  useInitAgent: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAgentVisual: () => ({ color: 'hsl(0,70%,55%)', emoji: '🤖' }),
  useResolvedAgents: () => ({ data: undefined }),
  useAgentToolStatus: () => mockToolStatus,
  useMcpConfig: () => ({ data: undefined }),
}));

// Mock usePulseEnabled
vi.mock('@/layers/entities/pulse/model/use-pulse-config', () => ({
  usePulseEnabled: () => true,
}));

// Mock useActiveRunCount
vi.mock('@/layers/entities/pulse/model/use-runs', () => ({
  useActiveRunCount: () => ({ data: 0 }),
}));

// Mock useCompletedRunBadge
const mockClearBadge = vi.fn();
vi.mock('@/layers/entities/pulse/model/use-completed-run-badge', () => ({
  useCompletedRunBadge: () => ({ unviewedCount: 0, clearBadge: mockClearBadge }),
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

// Mock useRegisteredAgents and useAgentAccess (used by ConnectionsView)
vi.mock('@/layers/entities/mesh', () => ({
  useRegisteredAgents: () => ({ data: { agents: [] } }),
  useAgentAccess: () => ({ data: undefined, isLoading: false }),
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
    mockSidebarActiveTab = 'sessions';
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
      listSessions: vi
        .fn()
        .mockResolvedValue([
          makeSession({ id: 's1', title: 'Today session', updatedAt: '2026-02-07T12:00:00Z' }),
          makeSession({ id: 's2', title: 'Old session', updatedAt: '2025-06-01T10:00:00Z' }),
        ]),
    });

    renderWithQuery(<SessionSidebar />);

    await waitFor(() => {
      expect(screen.getByText('Today')).toBeDefined();
      expect(screen.getByText('Older')).toBeDefined();
    });

    expect(screen.getByText('Today session')).toBeDefined();
    expect(screen.getByText('Old session')).toBeDefined();
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
      listSessions: vi
        .fn()
        .mockResolvedValue([
          makeSession({ id: 's1', title: 'Only today', updatedAt: '2026-02-07T12:00:00Z' }),
        ]),
    });

    renderWithQuery(<SessionSidebar />);

    await waitFor(() => {
      expect(screen.getByText('Only today')).toBeDefined();
    });

    expect(screen.queryByText('Today')).toBeNull();
  });

  it('does not render AgentContextChips (replaced by tab badges)', () => {
    renderWithQuery(<SessionSidebar />);
    expect(screen.queryByLabelText('Pulse scheduler')).toBeNull();
    expect(screen.queryByLabelText('Relay messaging')).toBeNull();
    expect(screen.queryByLabelText('Mesh discovery')).toBeNull();
  });

  it('does not render footer (footer moved to AppShell)', () => {
    renderWithQuery(<SessionSidebar />);
    // Footer with branding and settings now lives in AppShell, not the sidebar
    expect(screen.queryByLabelText('Settings')).toBeNull();
  });

  describe('tab switching', () => {
    it('renders SidebarTabRow with tab buttons', () => {
      renderWithQuery(<SessionSidebar />);
      expect(screen.getByRole('tablist')).toBeInTheDocument();
      // At minimum: sessions + connections (schedules depends on Pulse feature flag)
      expect(screen.getAllByRole('tab').length).toBeGreaterThanOrEqual(2);
    });

    it('shows sessions tabpanel by default and hides others', () => {
      renderWithQuery(<SessionSidebar />);
      const sessionsPanel = document.getElementById('sidebar-tabpanel-sessions');
      const schedulesPanel = document.getElementById('sidebar-tabpanel-schedules');
      const connectionsPanel = document.getElementById('sidebar-tabpanel-connections');
      expect(sessionsPanel?.classList.contains('hidden')).toBe(false);
      expect(schedulesPanel?.classList.contains('hidden')).toBe(true);
      expect(connectionsPanel?.classList.contains('hidden')).toBe(true);
    });

    it('switching tab calls setSidebarActiveTab', () => {
      renderWithQuery(<SessionSidebar />);

      const schedulesTab = screen.getAllByRole('tab').find((t) => t.id === 'sidebar-tab-schedules');
      expect(schedulesTab).toBeDefined();
      if (schedulesTab) {
        fireEvent.click(schedulesTab);
        expect(mockSetSidebarActiveTab).toHaveBeenCalledWith('schedules');
      }
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
  });

  describe('keyboard shortcuts', () => {
    it('Cmd+1 switches to sessions tab when sidebar is open', () => {
      renderWithQuery(<SessionSidebar />);
      fireEvent.keyDown(document, { key: '1', metaKey: true });
      expect(mockSetSidebarActiveTab).toHaveBeenCalledWith('sessions');
    });

    it('Cmd+2 switches to schedules tab when visible and sidebar open', () => {
      renderWithQuery(<SessionSidebar />);
      fireEvent.keyDown(document, { key: '2', metaKey: true });
      expect(mockSetSidebarActiveTab).toHaveBeenCalledWith('schedules');
    });

    it('Cmd+3 switches to connections tab when visible and sidebar open', () => {
      renderWithQuery(<SessionSidebar />);
      fireEvent.keyDown(document, { key: '3', metaKey: true });
      expect(mockSetSidebarActiveTab).toHaveBeenCalledWith('connections');
    });

    it('Ctrl+number also works (cross-platform)', () => {
      renderWithQuery(<SessionSidebar />);
      fireEvent.keyDown(document, { key: '2', ctrlKey: true });
      expect(mockSetSidebarActiveTab).toHaveBeenCalledWith('schedules');
    });

    it('plain number keys without modifier do not switch tabs', () => {
      renderWithQuery(<SessionSidebar />);
      fireEvent.keyDown(document, { key: '2' });
      expect(mockSetSidebarActiveTab).not.toHaveBeenCalled();
    });
  });

  describe('feature flags', () => {
    afterEach(() => {
      // Restore default tool status after each feature flag test
      mockToolStatus = {
        pulse: 'enabled',
        relay: 'enabled',
        mesh: 'enabled',
        adapter: 'enabled',
      };
    });

    it('hides schedules tab when Pulse is disabled-by-server', () => {
      mockToolStatus = {
        pulse: 'disabled-by-server',
        relay: 'enabled',
        mesh: 'enabled',
        adapter: 'enabled',
      };

      renderWithQuery(<SessionSidebar />);

      const schedulesTab = screen.getAllByRole('tab').find((t) => t.id === 'sidebar-tab-schedules');
      expect(schedulesTab).toBeUndefined();
    });

    it('falls back to sessions when active tab becomes hidden', () => {
      mockSidebarActiveTab = 'schedules';

      mockToolStatus = {
        pulse: 'disabled-by-server',
        relay: 'enabled',
        mesh: 'enabled',
        adapter: 'enabled',
      };

      renderWithQuery(<SessionSidebar />);

      // The fallback effect should call setSidebarActiveTab('sessions')
      expect(mockSetSidebarActiveTab).toHaveBeenCalledWith('sessions');
    });
  });
});
