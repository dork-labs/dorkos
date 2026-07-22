/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { RightPanelContribution } from '@/layers/shared/model';

// Spy on the imperative expand so tests can assert the open-floor argument
// (DOR-388). Hoisted because the vi.mock factory below closes over it.
const { mockPanelExpand } = vi.hoisted(() => ({ mockPanelExpand: vi.fn() }));

// Mock react-resizable-panels with imperative handle support for panelRef
vi.mock('react-resizable-panels', async () => {
  const { useImperativeHandle } = await import('react');

  function MockPanel({ children, id, ref }: React.PropsWithChildren<Record<string, unknown>>) {
    useImperativeHandle(ref as React.Ref<unknown>, () => ({
      collapse: () => {},
      expand: mockPanelExpand,
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
// The active agent id + selected working directory feed agent/folder-scoped
// visibility predicates; mutate per-test to exercise those paths.
let mockCurrentAgentId: string | null = null;
let mockSelectedCwd: string | null = null;
// The explicitly-opened agent path (Agent Hub) — the click-driven selection
// signal the container threads into every visibleWhen predicate.
let mockExplicitAgentPath: string | null = null;

vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      rightPanelOpen: mockRightPanelOpen,
      setRightPanelOpen: mockSetRightPanelOpen,
      activeRightPanelTab: mockActiveRightPanelTab,
      setActiveRightPanelTab: mockSetActiveRightPanelTab,
      setActiveRightPanelTabView: mockSetActiveRightPanelTabView,
      currentAgentId: mockCurrentAgentId,
      selectedCwd: mockSelectedCwd,
      explicitAgentPath: mockExplicitAgentPath,
    }),
  useIsMobile: () => mockIsMobile,
  useSlotContributions: () => mockContributions,
  useTransport: () => mockTransport,
}));

// The container is router-free — it takes `pathname` as a prop (AppShell passes
// the live router pathname; the embed passes a constant), so no router mock is
// needed here.

// Import after mocks are set up
import { RightPanelContainer } from '../ui/RightPanelContainer';
import { RIGHT_PANEL_DEFAULT_PCT } from '../model/use-right-panel-sizing';

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
    mockCurrentAgentId = null;
    mockSelectedCwd = null;
    mockExplicitAgentPath = null;
  });

  it('renders collapsed panel in DOM when rightPanelOpen is false but contributions exist', () => {
    mockRightPanelOpen = false;
    mockContributions = [makeContribution('a')];

    render(<RightPanelContainer pathname={mockPathname} />);

    // Panel structure stays in the DOM for animation readiness (collapsed)
    expect(screen.getByTestId('right-panel')).toBeInTheDocument();
    expect(screen.getByTestId('resize-handle')).toBeInTheDocument();
  });

  it('renders the sole global tab body — never the removed empty state', () => {
    // Off contextual routes only Pulse (a global tab) is visible. The shell shows
    // its body, not the Wave-1 "nothing to inspect" empty state, which the
    // always-present Pulse makes permanently unreachable (so it was removed).
    mockRightPanelOpen = true;
    mockActiveRightPanelTab = 'pulse';
    mockContributions = [makeContribution('pulse', { isGlobal: true })];

    render(<RightPanelContainer pathname={mockPathname} />);

    expect(screen.getByTestId('right-panel')).toBeInTheDocument();
    expect(screen.getByTestId('tab-content-pulse')).toBeInTheDocument();
    expect(screen.queryByText('Nothing to inspect here yet.')).not.toBeInTheDocument();
    // The close button is still structurally present.
    expect(screen.getByRole('button', { name: 'Close panel' })).toBeInTheDocument();
  });

  it('renders desktop Panel and resize handle when open with visible contributions', () => {
    mockRightPanelOpen = true;
    mockActiveRightPanelTab = 'a';
    mockContributions = [makeContribution('a')];

    render(<RightPanelContainer pathname={mockPathname} />);

    expect(screen.getByTestId('right-panel')).toBeInTheDocument();
    expect(screen.getByTestId('resize-handle')).toBeInTheDocument();
  });

  it('expands with the default size as a floor when opening (DOR-388)', () => {
    mockRightPanelOpen = true;
    mockActiveRightPanelTab = 'a';
    mockContributions = [makeContribution('a')];

    render(<RightPanelContainer pathname={mockPathname} />);

    // The mock panel reports isCollapsed, so the open-sync effect fires. A bare
    // expand() falls back to minSize when no size is remembered — the floor
    // argument is what keeps the panel from reopening squished.
    expect(mockPanelExpand).toHaveBeenCalledWith(RIGHT_PANEL_DEFAULT_PCT);
  });

  it('renders the active tab component content', () => {
    mockRightPanelOpen = true;
    mockActiveRightPanelTab = 'a';
    mockContributions = [makeContribution('a')];

    render(<RightPanelContainer pathname={mockPathname} />);

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

      render(<RightPanelContainer pathname={mockPathname} />);

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

    render(<RightPanelContainer pathname={mockPathname} />);

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

    render(<RightPanelContainer pathname={mockPathname} />);

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

    render(<RightPanelContainer pathname={mockPathname} />);

    expect(screen.getByRole('tab', { name: 'Terminal' })).toBeInTheDocument();
  });

  // DOR-364: the container threads the active agent id and selected working
  // directory into every visibleWhen context, so tabs can scope visibility to a
  // specific agent or folder.
  describe('agent + folder context', () => {
    it('hides an agent-scoped tab when the active agent id does not match', () => {
      mockRightPanelOpen = true;
      mockActiveRightPanelTab = 'agent-hub';
      mockCurrentAgentId = 'agent-other';
      mockContributions = [
        makeContribution('agent-hub', { title: 'Agent Profile' }),
        makeContribution('canvas', { title: 'Canvas' }),
        makeContribution('scoped', {
          title: 'Scoped',
          visibleWhen: ({ agentId }) => agentId === 'agent-x',
        }),
      ];

      render(<RightPanelContainer pathname={mockPathname} />);

      expect(screen.getByRole('tab', { name: 'Agent Profile' })).toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: 'Scoped' })).not.toBeInTheDocument();
    });

    it('shows an agent-scoped tab when the active agent id matches', () => {
      mockRightPanelOpen = true;
      mockActiveRightPanelTab = 'agent-hub';
      mockCurrentAgentId = 'agent-x';
      mockContributions = [
        makeContribution('agent-hub', { title: 'Agent Profile' }),
        makeContribution('scoped', {
          title: 'Scoped',
          visibleWhen: ({ agentId }) => agentId === 'agent-x',
        }),
      ];

      render(<RightPanelContainer pathname={mockPathname} />);

      expect(screen.getByRole('tab', { name: 'Scoped' })).toBeInTheDocument();
    });

    it('hides a folder-scoped tab when the selected cwd does not match', () => {
      mockRightPanelOpen = true;
      mockActiveRightPanelTab = 'agent-hub';
      mockSelectedCwd = '/repo/other';
      mockContributions = [
        makeContribution('agent-hub', { title: 'Agent Profile' }),
        makeContribution('canvas', { title: 'Canvas' }),
        makeContribution('scoped', {
          title: 'Scoped',
          visibleWhen: ({ cwd }) => cwd === '/repo/a',
        }),
      ];

      render(<RightPanelContainer pathname={mockPathname} />);

      expect(screen.queryByRole('tab', { name: 'Scoped' })).not.toBeInTheDocument();
    });

    it('shows a folder-scoped tab when the selected cwd matches', () => {
      mockRightPanelOpen = true;
      mockActiveRightPanelTab = 'agent-hub';
      mockSelectedCwd = '/repo/a';
      mockContributions = [
        makeContribution('agent-hub', { title: 'Agent Profile' }),
        makeContribution('scoped', {
          title: 'Scoped',
          visibleWhen: ({ cwd }) => cwd === '/repo/a',
        }),
      ];

      render(<RightPanelContainer pathname={mockPathname} />);

      expect(screen.getByRole('tab', { name: 'Scoped' })).toBeInTheDocument();
    });

    // Regression guard for the previously-hardcoded context site: the container
    // must pass the real agentId + cwd (not undefined) alongside pathname +
    // transport to every predicate.
    it('passes the full agent context (agentId + cwd) to visibleWhen', () => {
      mockRightPanelOpen = true;
      mockActiveRightPanelTab = 'a';
      mockPathname = '/session';
      mockCurrentAgentId = 'agent-x';
      mockSelectedCwd = '/repo/a';
      mockExplicitAgentPath = '/repo/explicit';
      const predicate = vi.fn(() => true);
      mockContributions = [makeContribution('a', { visibleWhen: predicate })];

      render(<RightPanelContainer pathname={mockPathname} />);

      expect(predicate).toHaveBeenCalledWith(
        expect.objectContaining({
          pathname: '/session',
          transport: mockTransport,
          agentId: 'agent-x',
          cwd: '/repo/a',
          explicitAgentPath: '/repo/explicit',
        })
      );
    });

    // Existing pathname-only predicates are unaffected by the added fields.
    it('leaves a pathname-only predicate unaffected by the agent context', () => {
      mockRightPanelOpen = true;
      mockActiveRightPanelTab = 'agent-hub';
      mockPathname = '/session';
      mockCurrentAgentId = 'agent-x';
      mockSelectedCwd = '/repo/a';
      mockContributions = [
        makeContribution('agent-hub', { title: 'Agent Profile' }),
        makeContribution('session-only', {
          title: 'Session Only',
          visibleWhen: ({ pathname }) => pathname === '/session',
        }),
      ];

      render(<RightPanelContainer pathname={mockPathname} />);

      expect(screen.getByRole('tab', { name: 'Session Only' })).toBeInTheDocument();
    });

    // Selection honesty (fix 2): a tab gated on an explicit agent pick — the
    // real Agent Profile rule off /session — stays hidden until the operator
    // opens one, then appears. Proves the container threads `explicitAgentPath`.
    it('hides a selection-gated tab off /session when no agent is explicitly opened', () => {
      mockRightPanelOpen = true;
      mockActiveRightPanelTab = 'other';
      mockPathname = '/';
      mockSelectedCwd = '/repo/ambient';
      mockExplicitAgentPath = null;
      mockContributions = [
        makeContribution('other', { title: 'Other' }),
        makeContribution('selection', {
          title: 'Selection',
          visibleWhen: ({ explicitAgentPath }) => explicitAgentPath != null,
        }),
      ];

      render(<RightPanelContainer pathname={mockPathname} />);

      expect(screen.queryByRole('tab', { name: 'Selection' })).not.toBeInTheDocument();
    });

    it('shows a selection-gated tab once an agent is explicitly opened', () => {
      mockRightPanelOpen = true;
      mockActiveRightPanelTab = 'other';
      mockPathname = '/';
      mockExplicitAgentPath = '/repo/picked';
      mockContributions = [
        makeContribution('other', { title: 'Other' }),
        makeContribution('selection', {
          title: 'Selection',
          visibleWhen: ({ explicitAgentPath }) => explicitAgentPath != null,
        }),
      ];

      render(<RightPanelContainer pathname={mockPathname} />);

      expect(screen.getByRole('tab', { name: 'Selection' })).toBeInTheDocument();
    });
  });

  it('auto-selects first visible tab (view-only) when active tab is not visible', () => {
    mockRightPanelOpen = true;
    // Active tab 'missing' is not in contributions
    mockActiveRightPanelTab = 'missing';
    mockContributions = [makeContribution('a'), makeContribution('b')];

    render(<RightPanelContainer pathname={mockPathname} />);

    // Auto-select uses the view-only setter so it never overwrites the per-agent
    // stored preference (DOR-227) — the persisting setter must stay untouched.
    expect(mockSetActiveRightPanelTabView).toHaveBeenCalledWith('a');
    expect(mockSetActiveRightPanelTab).not.toHaveBeenCalled();
  });

  it('does not auto-select when active tab is already visible', () => {
    mockRightPanelOpen = true;
    mockActiveRightPanelTab = 'b';
    mockContributions = [makeContribution('a'), makeContribution('b')];

    render(<RightPanelContainer pathname={mockPathname} />);

    expect(mockSetActiveRightPanelTabView).not.toHaveBeenCalled();
    expect(mockSetActiveRightPanelTab).not.toHaveBeenCalled();
  });

  // Default-tab rule (the Chrome sidePanel rule): contextual wins when present,
  // the global Pulse tab is only the fallback — so Pulse sorts first in the strip
  // yet never steals the default from a contextual surface.
  describe('default-tab fallback (contextual over global)', () => {
    it('prefers the first contextual tab over the global tab when auto-selecting', () => {
      // /session with no persisted tab: Pulse is present and sorts first, but the
      // first CONTEXTUAL tab (Agent Profile) must be the default.
      mockRightPanelOpen = true;
      mockActiveRightPanelTab = null;
      mockContributions = [
        makeContribution('pulse', { isGlobal: true }),
        makeContribution('agent-hub'),
        makeContribution('canvas'),
      ];

      render(<RightPanelContainer pathname={mockPathname} />);

      expect(mockSetActiveRightPanelTabView).toHaveBeenCalledWith('agent-hub');
    });

    it('falls back to the global tab when no contextual tab is visible', () => {
      // Dashboard/activity/tasks/…: only the global Pulse tab is visible, so it
      // becomes the default.
      mockRightPanelOpen = true;
      mockActiveRightPanelTab = null;
      mockContributions = [makeContribution('pulse', { isGlobal: true })];

      render(<RightPanelContainer pathname={mockPathname} />);

      expect(mockSetActiveRightPanelTabView).toHaveBeenCalledWith('pulse');
    });

    it('leaves a persisted, still-visible contextual tab untouched (DOR-227)', () => {
      // The per-agent persisted tab keeps winning on /session — the global tab
      // must not override it.
      mockRightPanelOpen = true;
      mockActiveRightPanelTab = 'canvas';
      mockContributions = [
        makeContribution('pulse', { isGlobal: true }),
        makeContribution('agent-hub'),
        makeContribution('canvas'),
      ];

      render(<RightPanelContainer pathname={mockPathname} />);

      expect(mockSetActiveRightPanelTabView).not.toHaveBeenCalled();
      expect(mockSetActiveRightPanelTab).not.toHaveBeenCalled();
    });
  });

  it('an explicit tab click persists via setActiveRightPanelTab (not the view-only setter)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    mockRightPanelOpen = true;
    mockActiveRightPanelTab = 'a';
    mockContributions = [makeContribution('a'), makeContribution('b')];

    render(<RightPanelContainer pathname={mockPathname} />);

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

    render(<RightPanelContainer pathname={mockPathname} />);

    // Only one visible contribution → no tab bar
    expect(screen.queryByTestId('tab-bar')).not.toBeInTheDocument();
    // Active content 'a' still renders
    expect(screen.getByTestId('tab-content-a')).toBeInTheDocument();
  });

  it('renders no empty-state copy when every contribution is filtered out', () => {
    // The Wave-1 empty state is gone (Pulse makes it unreachable): a route that
    // filters out its only contribution renders an empty body, never stale copy.
    mockRightPanelOpen = true;
    mockActiveRightPanelTab = 'a';
    mockContributions = [makeContribution('a', { visibleWhen: () => false })];

    render(<RightPanelContainer pathname={mockPathname} />);
    expect(screen.queryByText('Nothing to inspect here yet.')).not.toBeInTheDocument();
  });

  it('renders Sheet instead of Panel on mobile', () => {
    mockIsMobile = true;
    mockRightPanelOpen = true;
    mockActiveRightPanelTab = 'a';
    mockContributions = [makeContribution('a')];

    render(<RightPanelContainer pathname={mockPathname} />);

    expect(screen.getByTestId('sheet')).toBeInTheDocument();
    expect(screen.queryByTestId('right-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('resize-handle')).not.toBeInTheDocument();
  });

  it('mobile Sheet renders active content', () => {
    mockIsMobile = true;
    mockRightPanelOpen = true;
    mockActiveRightPanelTab = 'a';
    mockContributions = [makeContribution('a')];

    render(<RightPanelContainer pathname={mockPathname} />);

    expect(screen.getByTestId('tab-content-a')).toBeInTheDocument();
  });

  it('mobile returns null when rightPanelOpen is false', () => {
    mockIsMobile = true;
    mockRightPanelOpen = false;
    mockContributions = [makeContribution('a')];

    const { container } = render(<RightPanelContainer pathname={mockPathname} />);
    expect(container.innerHTML).toBe('');
  });

  it('mobile Sheet also renders the shared header (tab strip + close)', () => {
    mockIsMobile = true;
    mockRightPanelOpen = true;
    mockActiveRightPanelTab = 'a';
    mockContributions = [makeContribution('a'), makeContribution('b')];

    render(<RightPanelContainer pathname={mockPathname} />);

    expect(screen.getByRole('tablist', { name: 'Right panel tabs' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close panel' })).toBeInTheDocument();
  });

  // variant='overlay' is the narrow Obsidian embed: always a slide-over Sheet,
  // never the resizable inset Panel — even on a wide (non-mobile) viewport,
  // since the embed has no PanelGroup to split.
  describe("variant='overlay' (embed)", () => {
    it('renders the Sheet, not the inset Panel, on a wide viewport', () => {
      mockIsMobile = false;
      mockRightPanelOpen = true;
      mockActiveRightPanelTab = 'a';
      mockContributions = [makeContribution('a')];

      render(<RightPanelContainer pathname={mockPathname} variant="overlay" />);

      expect(screen.getByTestId('sheet')).toBeInTheDocument();
      expect(screen.queryByTestId('right-panel')).not.toBeInTheDocument();
      expect(screen.queryByTestId('resize-handle')).not.toBeInTheDocument();
    });

    it('renders nothing when the panel is closed', () => {
      mockIsMobile = false;
      mockRightPanelOpen = false;
      mockContributions = [makeContribution('a')];

      const { container } = render(
        <RightPanelContainer pathname={mockPathname} variant="overlay" />
      );
      expect(container.innerHTML).toBe('');
    });

    it('drops a transport-gated tab (the terminal) under the in-process transport', () => {
      // The embed's DirectTransport reports supportsTerminal=false, so the
      // terminal tab hides while the other contextual tabs stay — the capability
      // gate, exercised in the overlay presentation.
      mockIsMobile = false;
      mockRightPanelOpen = true;
      mockActiveRightPanelTab = 'agent-hub';
      mockTransport = { supportsTerminal: false };
      mockContributions = [
        makeContribution('pulse', { title: 'Pulse', isGlobal: true }),
        makeContribution('agent-hub', { title: 'Agent Profile' }),
        makeContribution('files', { title: 'Files' }),
        makeContribution('terminal', {
          title: 'Terminal',
          visibleWhen: ({ transport }) => transport?.supportsTerminal === true,
        }),
      ];

      render(<RightPanelContainer pathname={mockPathname} variant="overlay" />);

      expect(screen.getByRole('tab', { name: 'Pulse' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Agent Profile' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Files' })).toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: 'Terminal' })).not.toBeInTheDocument();
    });
  });
});
