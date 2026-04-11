// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent } from '@testing-library/react';
import { DashboardSidebar } from '../ui/DashboardSidebar';
import { SidebarProvider, TooltipProvider } from '@/layers/shared/ui';
import type { RecentCwd } from '@/layers/shared/model';

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

const mockRecentCwds = vi.fn<() => RecentCwd[]>(() => []);
const mockSetGlobalPaletteOpen = vi.fn();
const mockSetSidebarLevel = vi.fn();
let mockSelectedCwd: string | null = null;

const mockTransport = {
  getConfig: vi.fn().mockResolvedValue({
    agents: { defaultAgent: 'dorkbot', defaultDirectory: '~/.dork/agents' },
  }),
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
        recentCwds: mockRecentCwds(),
        setGlobalPaletteOpen: mockSetGlobalPaletteOpen,
        selectedCwd: mockSelectedCwd,
        setSidebarLevel: mockSetSidebarLevel,
      });
    },
  };
});

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
    color: 'transparent',
    pulse: false,
    label: 'Idle',
  }),
  useAgentHottestStatus: () => ({
    kind: 'idle',
    color: 'transparent',
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
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecentCwds.mockReturnValue([]);
    mockSelectedCwd = null;
    mockPathname = '/';
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

  it('shows recent agents in the agent list', () => {
    mockRecentCwds.mockReturnValue([
      { path: '/projects/test', accessedAt: new Date().toISOString() },
    ]);
    renderWithProviders(<DashboardSidebar />);
    expect(screen.getByText('test')).toBeInTheDocument();
  });

  it('limits to MAX_AGENTS total agents', () => {
    const cwds: RecentCwd[] = Array.from({ length: 10 }, (_, i) => ({
      path: `/projects/project-${i}`,
      accessedAt: new Date(Date.now() - i * 1000).toISOString(),
    }));
    mockRecentCwds.mockReturnValue(cwds);
    renderWithProviders(<DashboardSidebar />);

    // Default agent (dorkbot) + 7 recent = 8 total (MAX_AGENTS)
    const agentButtons = screen.getAllByText(/project-\d/);
    expect(agentButtons.length).toBeLessThanOrEqual(7);
  });

  it('deduplicates default agent from recent list', () => {
    mockRecentCwds.mockReturnValue([
      { path: '~/.dork/agents/dorkbot', accessedAt: new Date().toISOString() },
      { path: '/projects/other', accessedAt: new Date().toISOString() },
    ]);
    renderWithProviders(<DashboardSidebar />);
    // "other" agent renders — proves dedup didn't eat it
    expect(screen.getAllByText('other').length).toBeGreaterThanOrEqual(1);
  });

  it('does not render SidebarFooterBar (footer is in AppShell)', () => {
    renderWithProviders(<DashboardSidebar />);
    expect(screen.queryByLabelText('Settings')).not.toBeInTheDocument();
  });
});
