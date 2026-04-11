// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { DashboardSidebar } from '../ui/DashboardSidebar';
import { SidebarProvider, TooltipProvider } from '@/layers/shared/ui';

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
const mockSetSidebarLevel = vi.fn();
const mockPinnedAgentPaths = vi.fn<() => string[]>(() => []);
const mockPinAgent = vi.fn();
const mockUnpinAgent = vi.fn();
const mockSetAgentDialogOpen = vi.fn();
const mockSetPickerOpen = vi.fn();
let mockSelectedCwd: string | null = null;

const mockTransport = {
  getConfig: vi.fn().mockResolvedValue({
    agents: { defaultAgent: 'dorkbot', defaultDirectory: '~/.dork/agents' },
  }),
  listMeshAgentPaths: vi.fn().mockImplementation(() =>
    Promise.resolve({
      agents: mockMeshPaths().map((p) => ({
        id: p,
        name: p.split('/').pop() ?? 'agent',
        projectPath: p,
      })),
    })
  ),
  resolveAgents: vi.fn().mockResolvedValue({}),
  listSessions: vi.fn().mockResolvedValue([]),
};

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useTransport: () => mockTransport,
    useNow: () => Date.now(),
    useAppStore: (selector: (s: Record<string, unknown>) => unknown) => {
      return selector({
        setGlobalPaletteOpen: mockSetGlobalPaletteOpen,
        selectedCwd: mockSelectedCwd,
        setSidebarLevel: mockSetSidebarLevel,
        pinnedAgentPaths: mockPinnedAgentPaths(),
        pinAgent: mockPinAgent,
        unpinAgent: mockUnpinAgent,
        setAgentDialogOpen: mockSetAgentDialogOpen,
        setPickerOpen: mockSetPickerOpen,
      });
    },
  };
});

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
  useResolvedAgents: () => ({ data: {} }),
  useAgentVisual: () => ({ color: '#aaaaaa', emoji: '🤖' }),
  AgentIdentity: ({ name, emoji }: { name: string; emoji: string }) => (
    <span>
      <span>{emoji}</span>
      <span>{name}</span>
    </span>
  ),
}));

vi.mock('@/layers/entities/session', () => ({
  useSessions: () => ({
    sessions: [],
    activeSessionId: null,
    isLoading: false,
    setActiveSession: vi.fn(),
  }),
  useSessionBorderState: () => ({
    kind: 'idle',
    color: 'rgba(128, 128, 128, 0.08)',
    pulse: false,
    label: 'Idle',
  }),
  useAgentHottestStatus: () => ({
    kind: 'idle',
    color: 'rgba(128, 128, 128, 0.08)',
    pulse: false,
    label: 'Idle',
  }),
}));

vi.mock('@/layers/features/feature-promos', () => ({
  PromoSlot: () => null,
}));

// ---------------------------------------------------------------------------
// Browser API mocks
// ---------------------------------------------------------------------------

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

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <SidebarProvider>{ui}</SidebarProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

describe('DashboardSidebar', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    // Reset return values (clearAllMocks only clears call history, not return values)
    mockMeshPaths.mockReset();
    mockPinnedAgentPaths.mockReset();
    mockPinAgent.mockReset();
    mockUnpinAgent.mockReset();
    mockSetGlobalPaletteOpen.mockReset();
    mockSetSidebarLevel.mockReset();
    mockSetAgentDialogOpen.mockReset();
    mockSetPickerOpen.mockReset();
    mockNavigate.mockReset();
    mockMeshPaths.mockReturnValue(['~/.dork/agents/dorkbot', '/projects/alpha', '/projects/beta']);
    mockPinnedAgentPaths.mockReturnValue([]);
    mockSelectedCwd = null;
    mockPathname = '/';
    mockTransport.listMeshAgentPaths.mockImplementation(() =>
      Promise.resolve({
        agents: mockMeshPaths().map((p) => ({
          id: p,
          name: p.split('/').pop() ?? 'agent',
          projectPath: p,
        })),
      })
    );
  });

  it('renders Dashboard nav item', () => {
    renderWithProviders(<DashboardSidebar />);
    const items = screen.getAllByText('Dashboard');
    expect(items.length).toBeGreaterThanOrEqual(1);
  });

  it('renders Agents nav item that navigates to /agents', () => {
    renderWithProviders(<DashboardSidebar />);
    const agentsButtons = screen.getAllByText('Agents');
    // First "Agents" is the nav button, second is the group label
    fireEvent.click(agentsButtons[0]);
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/agents' });
  });

  it('marks Dashboard active when pathname is /', () => {
    mockPathname = '/';
    renderWithProviders(<DashboardSidebar />);
    const dashboardBtns = screen.getAllByText('Dashboard').map((el) => el.closest('button'));
    expect(dashboardBtns.some((btn) => btn?.getAttribute('data-active') === 'true')).toBe(true);
  });

  it('marks Agents nav active when pathname is /agents', () => {
    mockPathname = '/agents';
    renderWithProviders(<DashboardSidebar />);
    // The nav button "Agents" — not the group label
    const agentsBtns = screen.getAllByText('Agents').map((el) => el.closest('button'));
    expect(agentsBtns.some((btn) => btn?.getAttribute('data-active') === 'true')).toBe(true);
  });

  it('renders default agent (dorkbot) in the agent list', () => {
    renderWithProviders(<DashboardSidebar />);
    const names = screen.getAllByText('dorkbot');
    expect(names.length).toBeGreaterThanOrEqual(1);
  });

  it('navigates to default agent session on click', () => {
    renderWithProviders(<DashboardSidebar />);
    const dorkbotElements = screen.getAllByText('dorkbot');
    fireEvent.click(dorkbotElements[0]);
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: { dir: '~/.dork/agents/dorkbot' },
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
      const name = p.split('/').pop()!;
      expect(screen.getAllByText(name).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('sorts agents alphabetically by last path segment', () => {
    mockMeshPaths.mockReturnValue(['/projects/zebra', '/projects/alpha', '/projects/middle']);
    renderWithProviders(<DashboardSidebar />);
    const allText = document.body.textContent ?? '';
    expect(allText.indexOf('alpha')).toBeLessThan(allText.indexOf('middle'));
    expect(allText.indexOf('middle')).toBeLessThan(allText.indexOf('zebra'));
  });

  it('hides PINNED section when no pins', () => {
    mockPinnedAgentPaths.mockReturnValue([]);
    renderWithProviders(<DashboardSidebar />);
    expect(screen.queryByText('Pinned')).not.toBeInTheDocument();
  });

  it('renders PINNED section when pins exist', () => {
    mockPinnedAgentPaths.mockReturnValue(['/projects/alpha']);
    mockMeshPaths.mockReturnValue(['/projects/alpha', '/projects/beta']);
    renderWithProviders(<DashboardSidebar />);
    expect(screen.getByText('Pinned')).toBeInTheDocument();
  });

  it('does not render SidebarFooterBar (footer is in AppShell)', () => {
    renderWithProviders(<DashboardSidebar />);
    expect(screen.queryByLabelText('Settings')).not.toBeInTheDocument();
  });

  it('renders + button in AGENTS header', () => {
    renderWithProviders(<DashboardSidebar />);
    expect(screen.getByLabelText('Add agent')).toBeInTheDocument();
  });

  it('renders onboarding card when 1-2 agents', () => {
    mockMeshPaths.mockReturnValue(['/agents/solo']);
    renderWithProviders(<DashboardSidebar />);
    expect(screen.getByText(/Add more agents to your fleet/)).toBeInTheDocument();
  });

  it('renders text link when 3-4 agents', () => {
    mockMeshPaths.mockReturnValue(['/agents/one', '/agents/two', '/agents/three']);
    renderWithProviders(<DashboardSidebar />);
    expect(screen.queryByText(/Add more agents to your fleet/)).not.toBeInTheDocument();
    // The inline "Add agent" text link should be present (not inside the onboarding card)
    const addLinks = screen.getAllByText('Add agent');
    expect(addLinks.length).toBeGreaterThanOrEqual(1);
  });

  it('shows no prompt for 5+ agents', () => {
    mockMeshPaths.mockReturnValue([
      '/agents/one',
      '/agents/two',
      '/agents/three',
      '/agents/four',
      '/agents/five',
    ]);
    renderWithProviders(<DashboardSidebar />);
    expect(screen.queryByText(/Add more agents to your fleet/)).not.toBeInTheDocument();
    // No inline "Add agent" text link either — the + button in the header is sufficient
    expect(screen.queryByText('Add agent')).not.toBeInTheDocument();
  });
});
