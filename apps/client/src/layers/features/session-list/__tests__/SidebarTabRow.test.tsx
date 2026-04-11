// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TooltipProvider } from '@/layers/shared/ui';
import { SidebarTabRow } from '../ui/SidebarTabRow';

const mockCreationOpen = vi.fn();

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useAgentCreationStore: Object.assign(() => ({}), {
      getState: () => ({ open: mockCreationOpen }),
    }),
  };
});

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

  // Radix UI's @radix-ui/react-use-size calls ResizeObserver which jsdom doesn't provide.
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

function Wrapper({ children }: { children: React.ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>;
}

const defaultProps = {
  activeTab: 'sessions' as const,
  onTabChange: vi.fn(),
  schedulesBadge: 0,
  connectionsStatus: 'none' as const,
  visibleTabs: ['sessions', 'schedules', 'connections'] as (
    | 'sessions'
    | 'schedules'
    | 'connections'
  )[],
};

describe('SidebarTabRow', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockCreationOpen.mockReset();
  });

  it('renders three tabs with correct ARIA attributes', () => {
    render(<SidebarTabRow {...defaultProps} />, { wrapper: Wrapper });

    const tablist = screen.getByRole('tablist');
    expect(tablist).toHaveAttribute('aria-label', 'Sidebar views');

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
  });

  it('active tab has aria-selected true, others false', () => {
    render(<SidebarTabRow {...defaultProps} activeTab="schedules" />, { wrapper: Wrapper });

    const tabs = screen.getAllByRole('tab');
    const sessionsTab = tabs.find((t) => t.id === 'sidebar-tab-sessions');
    const schedulesTab = tabs.find((t) => t.id === 'sidebar-tab-schedules');
    const connectionsTab = tabs.find((t) => t.id === 'sidebar-tab-connections');

    expect(sessionsTab).toHaveAttribute('aria-selected', 'false');
    expect(schedulesTab).toHaveAttribute('aria-selected', 'true');
    expect(connectionsTab).toHaveAttribute('aria-selected', 'false');
  });

  it('click handler fires with correct tab value', () => {
    const onTabChange = vi.fn();
    render(<SidebarTabRow {...defaultProps} onTabChange={onTabChange} />, { wrapper: Wrapper });

    const tabs = screen.getAllByRole('tab');
    const schedulesTab = tabs.find((t) => t.id === 'sidebar-tab-schedules')!;
    fireEvent.click(schedulesTab);

    expect(onTabChange).toHaveBeenCalledWith('schedules');
  });

  it('renders schedules badge when schedulesBadge > 0', () => {
    render(<SidebarTabRow {...defaultProps} schedulesBadge={3} />, { wrapper: Wrapper });

    // Badge should show the count
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('does not render schedules badge when schedulesBadge is 0', () => {
    render(<SidebarTabRow {...defaultProps} schedulesBadge={0} />, { wrapper: Wrapper });

    // No numeric badge should be present
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('renders schedules badge as 9+ when count exceeds 9', () => {
    render(<SidebarTabRow {...defaultProps} schedulesBadge={15} />, { wrapper: Wrapper });

    expect(screen.getByText('9+')).toBeInTheDocument();
  });

  it('renders connections status dot with correct color for each status', () => {
    const { container, rerender } = render(
      <SidebarTabRow {...defaultProps} connectionsStatus="ok" />,
      { wrapper: Wrapper }
    );

    // Check for green dot (ok)
    let dot = container.querySelector('.bg-green-500');
    expect(dot).toBeInTheDocument();

    rerender(
      <Wrapper>
        <SidebarTabRow {...defaultProps} connectionsStatus="partial" />
      </Wrapper>
    );
    dot = container.querySelector('.bg-amber-500');
    expect(dot).toBeInTheDocument();

    rerender(
      <Wrapper>
        <SidebarTabRow {...defaultProps} connectionsStatus="error" />
      </Wrapper>
    );
    dot = container.querySelector('.bg-red-500');
    expect(dot).toBeInTheDocument();
  });

  it('hides connections status dot when status is none', () => {
    render(<SidebarTabRow {...defaultProps} connectionsStatus="none" />, { wrapper: Wrapper });

    // No status dots should be present on the connections tab
    const connectionsTab = screen
      .getAllByRole('tab')
      .find((t) => t.id === 'sidebar-tab-connections')!;
    const dots = connectionsTab.querySelectorAll('.rounded-full.size-1\\.5');
    expect(dots).toHaveLength(0);
  });

  it('only renders visible tabs', () => {
    render(<SidebarTabRow {...defaultProps} visibleTabs={['sessions', 'connections']} />, {
      wrapper: Wrapper,
    });

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(tabs.map((t) => t.id)).toEqual(['sidebar-tab-sessions', 'sidebar-tab-connections']);
  });

  it('arrow key navigation moves focus between tabs', () => {
    const onTabChange = vi.fn();
    render(<SidebarTabRow {...defaultProps} onTabChange={onTabChange} />, { wrapper: Wrapper });

    const tablist = screen.getByRole('tablist');

    // Press ArrowRight
    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    expect(onTabChange).toHaveBeenCalledWith('schedules');

    // Press ArrowLeft (wraps around)
    onTabChange.mockClear();
    fireEvent.keyDown(tablist, { key: 'ArrowLeft' });
    // From 'sessions' (index 0), ArrowLeft wraps to 'connections' (index 2)
    expect(onTabChange).toHaveBeenCalledWith('connections');
  });

  it('each tab has aria-controls linking to tabpanel', () => {
    render(<SidebarTabRow {...defaultProps} />, { wrapper: Wrapper });

    const tabs = screen.getAllByRole('tab');
    expect(tabs[0]).toHaveAttribute('aria-controls', 'sidebar-tabpanel-sessions');
    expect(tabs[1]).toHaveAttribute('aria-controls', 'sidebar-tabpanel-schedules');
    expect(tabs[2]).toHaveAttribute('aria-controls', 'sidebar-tabpanel-connections');
  });

  it('renders New Agent button with correct aria-label', () => {
    render(<SidebarTabRow {...defaultProps} />, { wrapper: Wrapper });
    expect(screen.getByLabelText('New Agent')).toBeInTheDocument();
  });

  it('New Agent button calls useAgentCreationStore.open()', () => {
    render(<SidebarTabRow {...defaultProps} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByLabelText('New Agent'));
    expect(mockCreationOpen).toHaveBeenCalledWith();
  });
});
