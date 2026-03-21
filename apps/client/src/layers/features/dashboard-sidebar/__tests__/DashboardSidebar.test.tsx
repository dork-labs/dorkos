// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
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
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useAppStore: (selector: (s: { recentCwds: RecentCwd[] }) => unknown) => {
      return selector({ recentCwds: mockRecentCwds() });
    },
  };
});

vi.mock('@/layers/entities/agent', () => ({
  useResolvedAgents: () => ({ data: {} }),
  useAgentVisual: () => ({ color: '#aaaaaa', emoji: '🤖' }),
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
  return render(
    <TooltipProvider>
      <SidebarProvider>{ui}</SidebarProvider>
    </TooltipProvider>
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
    const dashboardBtn = screen.getAllByText('Dashboard')[0].closest('button');
    expect(dashboardBtn).toHaveAttribute('data-active', 'true');
  });

  it('marks Agents active when pathname is /agents', () => {
    mockPathname = '/agents';
    renderWithProviders(<DashboardSidebar />);
    const agentsBtn = screen.getAllByText('Agents')[0].closest('button');
    expect(agentsBtn).toHaveAttribute('data-active', 'true');
  });

  it('renders Sessions nav item that navigates to /session', () => {
    renderWithProviders(<DashboardSidebar />);
    const sessionsButtons = screen.getAllByText('Sessions');
    expect(sessionsButtons.length).toBeGreaterThanOrEqual(1);

    fireEvent.click(sessionsButtons[0]);
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/session' });
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
