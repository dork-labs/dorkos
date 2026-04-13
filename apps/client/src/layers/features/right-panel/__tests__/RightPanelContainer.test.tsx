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

// Mock Sheet components for mobile rendering
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
  };
});

// Mutable mock state — mutate per-test
const mockSetRightPanelOpen = vi.fn();
const mockSetActiveRightPanelTab = vi.fn();

let mockRightPanelOpen = false;
let mockActiveRightPanelTab: string | null = null;
let mockIsMobile = false;
let mockContributions: RightPanelContribution[] = [];

vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      rightPanelOpen: mockRightPanelOpen,
      setRightPanelOpen: mockSetRightPanelOpen,
      activeRightPanelTab: mockActiveRightPanelTab,
      setActiveRightPanelTab: mockSetActiveRightPanelTab,
    }),
  useIsMobile: () => mockIsMobile,
  useSlotContributions: () => mockContributions,
}));

vi.mock('@tanstack/react-router', () => ({
  useRouterState: () => '/session',
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

  it('does not render its own tab bar (tab switching is handled by content components)', () => {
    mockRightPanelOpen = true;
    mockActiveRightPanelTab = 'a';
    mockContributions = [makeContribution('a'), makeContribution('b')];

    render(<RightPanelContainer />);

    expect(screen.queryByTestId('tab-bar')).not.toBeInTheDocument();
  });

  it('auto-selects first visible tab when active tab is not in visible contributions', () => {
    mockRightPanelOpen = true;
    // Active tab 'missing' is not in contributions
    mockActiveRightPanelTab = 'missing';
    mockContributions = [makeContribution('a'), makeContribution('b')];

    render(<RightPanelContainer />);

    expect(mockSetActiveRightPanelTab).toHaveBeenCalledWith('a');
  });

  it('does not auto-select when active tab is already visible', () => {
    mockRightPanelOpen = true;
    mockActiveRightPanelTab = 'b';
    mockContributions = [makeContribution('a'), makeContribution('b')];

    render(<RightPanelContainer />);

    expect(mockSetActiveRightPanelTab).not.toHaveBeenCalled();
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

  it('mobile Sheet does not render its own tab bar', () => {
    mockIsMobile = true;
    mockRightPanelOpen = true;
    mockActiveRightPanelTab = 'a';
    mockContributions = [makeContribution('a'), makeContribution('b')];

    render(<RightPanelContainer />);

    expect(screen.queryByTestId('tab-bar')).not.toBeInTheDocument();
  });
});
