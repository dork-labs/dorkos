/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { RightPanelContribution } from '@/layers/shared/model';

// Mock react-resizable-panels with imperative handle support for panelRef
vi.mock('react-resizable-panels', async () => {
  const { useImperativeHandle } = await import('react');

  function MockPanel({ children, id, ref }: React.PropsWithChildren<Record<string, unknown>>) {
    useImperativeHandle(ref as React.Ref<unknown>, () => ({
      collapse: () => {},
      expand: () => {},
      isCollapsed: () => true,
      isExpanded: () => false,
      getSize: () => 0,
      resize: () => {},
      getId: () => id ?? 'right-panel',
    }));
    return (
      <div data-testid="right-panel" id={id as string}>
        {children}
      </div>
    );
  }

  return {
    Panel: MockPanel,
    PanelResizeHandle: ({
      className,
      children,
    }: React.PropsWithChildren<Record<string, unknown>>) => (
      <div data-testid="resize-handle" className={className as string}>
        {children}
      </div>
    ),
  };
});

// Mock Sheet + Tooltip components. Sheet stubs enable mobile rendering; Tooltip
// stubs let the container-owned RightPanelHeader render its tab strip without a
// TooltipProvider/ResizeObserver in jsdom.
vi.mock('@/layers/shared/ui', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const Passthrough = ({ children }: React.PropsWithChildren) => <>{children}</>;
  return {
    ...actual,
    Sheet: ({ children, open }: React.PropsWithChildren<{ open?: boolean }>) =>
      open ? <div data-testid="sheet">{children}</div> : null,
    SheetContent: ({ children, className }: React.PropsWithChildren<{ className?: string }>) => (
      <div data-testid="sheet-content" className={className}>
        {children}
      </div>
    ),
    SheetHeader: Passthrough,
    SheetTitle: ({ children }: React.PropsWithChildren) => (
      <span data-testid="sheet-title">{children}</span>
    ),
    SheetDescription: Passthrough,
    Tooltip: Passthrough,
    TooltipTrigger: Passthrough,
    TooltipContent: () => null,
    TooltipProvider: Passthrough,
  };
});

// Mutable mock state — mutate per-test
const mockSetRightPanelOpen = vi.fn();
const mockSetActiveRightPanelTab = vi.fn();
// View-only setter used by the container's auto-select fallback (DOR-227). It
// must NOT be the persisting `setActiveRightPanelTab`.
const mockSetActiveRightPanelTabView = vi.fn();

let mockRightPanelOpen = false;
let mockActiveRightPanelTab: string | null = null;
let mockIsMobile = false;
let mockContributions: RightPanelContribution[] = [];
// The container gates capability-scoped tabs (e.g. the web-only terminal) on the
// active transport; mutate per-test to exercise the transport-gated path.
let mockTransport: { supportsTerminal: boolean } = { supportsTerminal: true };
let mockPathname = '/session';

vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      rightPanelOpen: mockRightPanelOpen,
      setRightPanelOpen: mockSetRightPanelOpen,
      activeRightPanelTab: mockActiveRightPanelTab,
      setActiveRightPanelTab: mockSetActiveRightPanelTab,
      setActiveRightPanelTabView: mockSetActiveRightPanelTabView,
    }),
  useIsMobile: () => mockIsMobile,
  useSlotContributions: () => mockContributions,
  useTransport: () => mockTransport,
}));

vi.mock('@tanstack/react-router', () => ({
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: mockPathname } }),
}));

// Import after mocks are set up
import { RightPanelContainer } from '../ui/RightPanelContainer';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// Helper to create a minimal LucideIcon stub
const MockIcon = () => null;

function makeContribution(
  id: string,
  overrides: Partial<RightPanelContribution> = {}
): RightPanelContribution {
  return {
    id,
    title: `Tab ${id}`,
    icon: MockIcon as unknown as RightPanelContribution['icon'],
    component: () => <div data-testid={`tab-content-${id}`}>Content {id}</div>,
    ...overrides,
  };
}

describe('RightPanelContainer', () => {
  beforeEach(() => {
    mockRightPanelOpen = false;
    mockActiveRightPanelTab = null;
    mockIsMobile = false;
    mockContributions = [];
    mockTransport = { supportsTerminal: true };
    mockPathname = '/session';
  });

  it('renders collapsed panel in DOM when rightPanelOpen is false but contributions exist', () => {
    mockRightPanelOpen = false;
    mockContributions = [makeContribution('a')];

    render(<RightPanelContainer />);

    // Panel structure stays in the DOM for animation readiness (collapsed)
    expect(screen.getByTestId('right-panel')).toBeInTheDocument();
    expect(screen.getByTestId('resize-handle')).toBeInTheDocument();
  });

  it('returns null when no visible contributions exist', () => {
    mockRightPanelOpen = true;
    mockContributions = [];

    const { container } = render(<RightPanelContainer />);
    expect(container.innerHTML).toBe('');
  });

  it('renders desktop Panel and resize handle when open with visible contributions', () => {
    mockRightPanelOpen = true;
    mockActiveRightPanelTab = 'a';
    mockContributions = [makeContribution('a')];

    render(<RightPanelContainer />);

    expect(screen.getByTestId('right-panel')).toBeInTheDocument();
    expect(screen.getByTestId('resize-handle')).toBeInTheDocument();
  });

  it('renders the active tab component content', () => {
    mockRightPanelOpen = true;
    mockActiveRightPanelTab = 'a';
    mockContributions = [makeContribution('a')];

    render(<RightPanelContainer />);

    expect(screen.getByTestId('tab-content-a')).toBeInTheDocument();
  });

  // The container owns the shared header now — the tab strip and close button
  // are structural, so no panel can lose them. Parametrized across the four
  // built-in tab ids to prove it holds regardless of which tab is active.
  it.each(['agent-hub', 'canvas', 'files', 'terminal'])(
    'renders the shared tab strip and close button when %s is the active tab',
    (activeId) => {
      mockRightPanelOpen = true;
      mockActiveRightPanelTab = activeId;
      mockContributions = [
        makeContribution('agent-hub'),
        makeContribution('canvas'),
        makeContribution('files'),
        makeContribution('terminal'),
      ];

      render(<RightPanelContainer />);

      expect(screen.getByRole('tablist', { name: 'Right panel tabs' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Close panel' })).toBeInTheDocument();
    }
  );

  it("renders the active tab's headerActions in the shared header", () => {
    mockRightPanelOpen = true;
    mockActiveRightPanelTab = 'files';
    mockContributions = [
      makeContribution('agent-hub'),
      makeContribution('files', {
        headerActions: () => <button type="button">New File</button>,
      }),
    ];

    render(<RightPanelContainer />);

    expect(screen.getByRole('button', { name: 'New File' })).toBeInTheDocument();
  });

  it('hides a transport-gated tab when the active transport lacks the capability', () => {
    // PR #149 regression: transport gating now lives in the container, which
    // forwards `transport` to each `visibleWhen`.
    mockRightPanelOpen = true;
    mockActiveRightPanelTab = 'agent-hub';
    mockTransport = { supportsTerminal: false };
    mockContributions = [
      makeContribution('agent-hub', { title: 'Agent Profile' }),
      makeContribution('canvas', { title: 'Canvas' }),
      makeContribution('terminal', {
        title: 'Terminal',
        visibleWhen: ({ transport }) => transport?.supportsTerminal === true,
      }),
    ];

    render(<RightPanelContainer />);

    expect(screen.getByRole('tab', { name: 'Agent Profile' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Canvas' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Terminal' })).not.toBeInTheDocument();
  });

  it('shows a transport-gated tab when the active transport has the capability', () => {
    mockRightPanelOpen = true;
    mockActiveRightPanelTab = 'agent-hub';
    mockTransport = { supportsTerminal: true };
    mockContributions = [
      makeContribution('agent-hub', { title: 'Agent Profile' }),
      makeContribution('terminal', {
        title: 'Terminal',
        visibleWhen: ({ transport }) => transport?.supportsTerminal === true,
      }),
    ];

    render(<RightPanelContainer />);

    expect(screen.getByRole('tab', { name: 'Terminal' })).toBeInTheDocument();
  });

  it('auto-selects first visible tab (view-only) when active tab is not visible', () => {
    mockRightPanelOpen = true;
    // Active tab 'missing' is not in contributions
    mockActiveRightPanelTab = 'missing';
    mockContributions = [makeContribution('a'), makeContribution('b')];

    render(<RightPanelContainer />);

    // Auto-select uses the view-only setter so it never overwrites the per-agent
    // stored preference (DOR-227) — the persisting setter must stay untouched.
    expect(mockSetActiveRightPanelTabView).toHaveBeenCalledWith('a');
    expect(mockSetActiveRightPanelTab).not.toHaveBeenCalled();
  });

  it('does not auto-select when active tab is already visible', () => {
    mockRightPanelOpen = true;
    mockActiveRightPanelTab = 'b';
    mockContributions = [makeContribution('a'), makeContribution('b')];

    render(<RightPanelContainer />);

    expect(mockSetActiveRightPanelTabView).not.toHaveBeenCalled();
    expect(mockSetActiveRightPanelTab).not.toHaveBeenCalled();
  });

  it('an explicit tab click persists via setActiveRightPanelTab (not the view-only setter)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    mockRightPanelOpen = true;
    mockActiveRightPanelTab = 'a';
    mockContributions = [makeContribution('a'), makeContribution('b')];

    render(<RightPanelContainer />);

    await user.click(screen.getByRole('tab', { name: 'Tab b' }));
    // The user's explicit pick DOES update the stored preference.
    expect(mockSetActiveRightPanelTab).toHaveBeenCalledWith('b');
    expect(mockSetActiveRightPanelTabView).not.toHaveBeenCalled();
  });

  it('filters out contributions where visibleWhen returns false', () => {
    mockRightPanelOpen = true;
    mockActiveRightPanelTab = 'a';
    mockContributions = [
      makeContribution('a'),
      makeContribution('b', { visibleWhen: () => false }),
    ];

    render(<RightPanelContainer />);

    // Only one visible contribution → no tab bar
    expect(screen.queryByTestId('tab-bar')).not.toBeInTheDocument();
    // Active content 'a' still renders
    expect(screen.getByTestId('tab-content-a')).toBeInTheDocument();
  });

  it('renders null when all contributions are filtered by visibleWhen', () => {
    mockRightPanelOpen = true;
    mockActiveRightPanelTab = 'a';
    mockContributions = [makeContribution('a', { visibleWhen: () => false })];

    const { container } = render(<RightPanelContainer />);
    expect(container.innerHTML).toBe('');
  });

  it('renders Sheet instead of Panel on mobile', () => {
    mockIsMobile = true;
    mockRightPanelOpen = true;
    mockActiveRightPanelTab = 'a';
    mockContributions = [makeContribution('a')];

    render(<RightPanelContainer />);

    expect(screen.getByTestId('sheet')).toBeInTheDocument();
    expect(screen.queryByTestId('right-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('resize-handle')).not.toBeInTheDocument();
  });

  it('mobile Sheet renders active content', () => {
    mockIsMobile = true;
    mockRightPanelOpen = true;
    mockActiveRightPanelTab = 'a';
    mockContributions = [makeContribution('a')];

    render(<RightPanelContainer />);

    expect(screen.getByTestId('tab-content-a')).toBeInTheDocument();
  });

  it('mobile returns null when rightPanelOpen is false', () => {
    mockIsMobile = true;
    mockRightPanelOpen = false;
    mockContributions = [makeContribution('a')];

    const { container } = render(<RightPanelContainer />);
    expect(container.innerHTML).toBe('');
  });

  it('mobile Sheet also renders the shared header (tab strip + close)', () => {
    mockIsMobile = true;
    mockRightPanelOpen = true;
    mockActiveRightPanelTab = 'a';
    mockContributions = [makeContribution('a'), makeContribution('b')];

    render(<RightPanelContainer />);

    expect(screen.getByRole('tablist', { name: 'Right panel tabs' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close panel' })).toBeInTheDocument();
  });
});
