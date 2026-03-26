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
const mockTransport = {
  getConfig: vi.fn().mockResolvedValue({
    agents: { defaultAgent: 'dorkbot', defaultDirectory: '~/.dork/agents' },
  }),
  resolveAgents: vi.fn().mockResolvedValue({}),
};

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useTransport: () => mockTransport,
    useAppStore: (
      selector: (s: {
        recentCwds: RecentCwd[];
        setGlobalPaletteOpen: (open: boolean) => void;
      }) => unknown
    ) => {
      return selector({
        recentCwds: mockRecentCwds(),
        setGlobalPaletteOpen: mockSetGlobalPaletteOpen,
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
    expect(agentsButtons.length).toBeGreaterThanOrEqual(1);

    fireEvent.click(agentsButtons[0]);
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/agents' });
  });

  it('marks Dashboard active when pathname is /', () => {
    mockPathname = '/';
    renderWithProviders(<DashboardSidebar />);
    const dashboardBtns = screen.getAllByText('Dashboard').map((el) => el.closest('button'));
    expect(dashboardBtns.some((btn) => btn?.getAttribute('data-active') === 'true')).toBe(true);
  });

  it('marks Agents active when pathname is /agents', () => {
    mockPathname = '/agents';
    renderWithProviders(<DashboardSidebar />);
    const agentsBtns = screen.getAllByText('Agents').map((el) => el.closest('button'));
    expect(agentsBtns.some((btn) => btn?.getAttribute('data-active') === 'true')).toBe(true);
  });

  it('renders Default Agent section with fallback name', () => {
    renderWithProviders(<DashboardSidebar />);
    const labels = screen.getAllByText('Default Agent');
    expect(labels.length).toBeGreaterThanOrEqual(1);
    // Falls back to 'dorkbot' before config loads
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

  it('hides Recent Agents section when recentCwds is empty', () => {
    mockRecentCwds.mockReturnValue([]);
    renderWithProviders(<DashboardSidebar />);
    expect(screen.queryByText('Recent Agents')).not.toBeInTheDocument();
  });

  it('shows Recent Agents section when recentCwds is non-empty', () => {
    mockRecentCwds.mockReturnValue([
      { path: '/projects/test', accessedAt: new Date().toISOString() },
    ]);
    renderWithProviders(<DashboardSidebar />);
    expect(screen.getByText('Recent Agents')).toBeInTheDocument();
  });

  it('limits to 8 recent agents', () => {
    const cwds: RecentCwd[] = Array.from({ length: 10 }, (_, i) => ({
      path: `/projects/project-${i}`,
      accessedAt: new Date(Date.now() - i * 1000).toISOString(),
    }));
    mockRecentCwds.mockReturnValue(cwds);
    renderWithProviders(<DashboardSidebar />);

    // Should show at most 8 agent items (path basenames as fallback names)
    const agentButtons = screen.getAllByText(/project-\d/);
    expect(agentButtons.length).toBeLessThanOrEqual(8);
  });

  it('does not render SidebarFooterBar (footer is in AppShell)', () => {
    renderWithProviders(<DashboardSidebar />);
    expect(screen.queryByLabelText('Settings')).not.toBeInTheDocument();
  });
});
