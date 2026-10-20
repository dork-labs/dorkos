/**
 * @vitest-environment jsdom
 */
/**
 * Mini-app tabs follow their placement rules in the right panel (spec
 * `mini-app-placement`): the container filters them by where the person is,
 * holds its tab while "here" resolves, and the ⋯ menu shows or hides a tab
 * here by writing a saved choice.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {
  placementShows,
  type MiniAppPlacement,
  type PlacementHere,
  type SavedPlacement,
} from '@dorkos/shared/mini-app-placement';
import type { RightPanelContribution } from '@/layers/shared/model';

type HereState =
  { status: 'ready'; here: PlacementHere } | { status: 'pending'; last: PlacementHere | null };

let mockHereState: HereState = { status: 'ready', here: { page: 'channels', roomId: 'R1' } };
let mockSaved: SavedPlacement[] = [];
const mockSetPlacement = vi.fn();

vi.mock('../model/use-placement-here', () => ({
  usePlacementHere: () => mockHereState,
}));
vi.mock('@/layers/entities/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session')>()),
  useSessionId: () => [null, vi.fn()],
}));
vi.mock('@/layers/entities/room', () => ({ useRoom: () => ({ data: undefined }) }));
vi.mock('@/layers/entities/computer', () => ({ useComputer: () => ({ data: undefined }) }));
vi.mock('@/layers/entities/local-browser', () => ({
  useLocalBrowserState: () => ({ data: undefined }),
}));
vi.mock('@/layers/entities/config', () => ({
  useConfig: () => ({ data: {} }),
  usePanelTabPlacements: () => mockSaved,
  useSetPanelTabPlacement: () => ({ setPlacement: mockSetPlacement, isPending: false }),
}));

vi.mock('react-resizable-panels', async () => {
  const { useImperativeHandle } = await import('react');
  function MockPanel({ children, id, ref }: React.PropsWithChildren<Record<string, unknown>>) {
    useImperativeHandle(ref as React.Ref<unknown>, () => ({
      collapse: () => {},
      expand: () => {},
      isCollapsed: () => false,
      isExpanded: () => true,
      getSize: () => 30,
      resize: () => {},
      getId: () => id ?? 'right-panel',
    }));
    return <div data-testid="right-panel">{children}</div>;
  }
  return {
    Panel: MockPanel,
    PanelResizeHandle: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  };
});

// Tooltips need a provider and a ResizeObserver; this suite has no opinion on them.
vi.mock('@/layers/shared/ui', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const Passthrough = ({ children }: React.PropsWithChildren) => <>{children}</>;
  return {
    ...actual,
    Tooltip: Passthrough,
    TooltipTrigger: Passthrough,
    TooltipContent: () => null,
    TooltipProvider: Passthrough,
  };
});

const mockSetActiveRightPanelTab = vi.fn();
const mockSetActiveRightPanelTabView = vi.fn();
const mockSettingsOpen = vi.fn();
let mockActiveRightPanelTab: string | null = null;
let mockContributions: RightPanelContribution[] = [];

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        rightPanelOpen: true,
        setRightPanelOpen: vi.fn(),
        activeRightPanelTab: mockActiveRightPanelTab,
        setActiveRightPanelTab: mockSetActiveRightPanelTab,
        setActiveRightPanelTabView: mockSetActiveRightPanelTabView,
        currentAgentId: null,
        selectedCwd: null,
        explicitAgentPath: null,
        roomCanvasLiveRoomId: null,
        roomCanvasUnread: {},
      }),
    useIsMobile: () => false,
    useIsBelowDesktop: () => false,
    useSlotContributions: () => mockContributions,
    useTransport: () => ({ supportsTerminal: true }),
    useSettingsDeepLink: () => ({ open: mockSettingsOpen }),
    useSafeNavigate: () => null,
    useMenuExtensionPages: () => [],
  };
});

import { RightPanelContainer } from '../ui/RightPanelContainer';

const MockIcon = () => null;
const EMPTY = { agents: [], rooms: [], pages: [] };
const IN_R1: MiniAppPlacement = { show: { ...EMPTY, rooms: ['R1'] }, hide: EMPTY };
const R1: PlacementHere = { page: 'channels', roomId: 'R1' };
const R2: PlacementHere = { page: 'channels', roomId: 'R2' };

const pulse: RightPanelContribution = {
  id: 'pulse',
  title: 'Pulse',
  icon: MockIcon as unknown as RightPanelContribution['icon'],
  component: () => <div data-testid="tab-content-pulse" />,
  isGlobal: true,
};
const queue: RightPanelContribution = {
  id: 'social-queue:queue',
  title: 'Queue',
  icon: MockIcon as unknown as RightPanelContribution['icon'],
  component: () => <div data-testid="tab-content-queue" />,
  extensionId: 'social-queue',
  declaredPlacement: IN_R1,
};

function renderPanel() {
  return render(<RightPanelContainer pathname="/channels" />);
}

/** Open the ⋯ menu the way a pointer does, and wait for its content. */
async function openMenu() {
  fireEvent.pointerDown(screen.getByTestId('mini-app-tab-menu'), { button: 0, ctrlKey: false });
  return screen.findByRole('menu');
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

beforeEach(() => {
  mockHereState = { status: 'ready', here: R1 };
  mockSaved = [];
  mockActiveRightPanelTab = 'pulse';
  mockContributions = [pulse, queue];
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RightPanelContainer — mini-app placement', () => {
  it('shows the mini-app tab in a room its placement names', () => {
    renderPanel();
    expect(screen.getByRole('tab', { name: 'Queue' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Pulse' })).toBeInTheDocument();
  });

  it('hides the mini-app tab in a room its placement does not name, keeping built-in tabs', () => {
    mockHereState = { status: 'ready', here: R2 };
    renderPanel();
    expect(screen.queryByRole('tab', { name: 'Queue' })).not.toBeInTheDocument();
    // A single view can still be closed and reopened through the unified row.
    expect(screen.getByRole('tab', { name: 'Pulse' })).toBeInTheDocument();
    expect(screen.getByTestId('tab-content-pulse')).toBeInTheDocument();
  });

  it('lets a saved choice override the declared default', () => {
    mockHereState = { status: 'ready', here: R2 };
    mockSaved = [{ tab: queue.id, show: { ...EMPTY, rooms: ['R2'] }, hide: EMPTY }];
    renderPanel();
    expect(screen.getByRole('tab', { name: 'Queue' })).toBeInTheDocument();
  });

  it('a saved choice can hide a tab its declared default would show', () => {
    mockSaved = [{ tab: queue.id, show: { ...EMPTY, rooms: ['R2'] }, hide: EMPTY }];
    renderPanel();
    expect(screen.queryByRole('tab', { name: 'Queue' })).not.toBeInTheDocument();
  });

  it('auto-selects away from a mini-app tab hidden here once "here" is ready', () => {
    mockHereState = { status: 'ready', here: R2 };
    mockActiveRightPanelTab = queue.id;
    renderPanel();
    expect(mockSetActiveRightPanelTabView).toHaveBeenCalledWith('pulse');
  });

  it('keeps the open mini-app tab and re-picks nothing while "here" is pending', () => {
    mockHereState = { status: 'pending', last: R1 };
    mockActiveRightPanelTab = queue.id;
    renderPanel();
    expect(screen.getByRole('tab', { name: 'Queue' })).toBeInTheDocument();
    expect(screen.getByTestId('tab-content-queue')).toBeInTheDocument();
    expect(mockSetActiveRightPanelTabView).not.toHaveBeenCalled();
  });

  it('offers no ⋯ menu while "here" is pending, so no choice is written for the place just left', () => {
    mockHereState = { status: 'pending', last: R1 };
    mockActiveRightPanelTab = queue.id;
    renderPanel();
    expect(screen.queryByTestId('mini-app-tab-menu')).not.toBeInTheDocument();
  });

  it('re-picks nothing while pending even when the last answer hid the tab', () => {
    mockHereState = { status: 'pending', last: R2 };
    mockActiveRightPanelTab = queue.id;
    renderPanel();
    expect(mockSetActiveRightPanelTabView).not.toHaveBeenCalled();
  });

  it('lists a tab hidden here under "Show here", and choosing it shows it here and opens it', async () => {
    mockHereState = { status: 'ready', here: R2 };
    renderPanel();

    const menu = await openMenu();
    expect(within(menu).getByText('Show here')).toBeInTheDocument();
    // No mini-app tab is open, so the per-tab actions are not offered.
    expect(within(menu).queryByRole('menuitem', { name: 'Hide here' })).not.toBeInTheDocument();

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Queue' }));

    expect(mockSetPlacement).toHaveBeenCalledTimes(1);
    const [tab, placement] = mockSetPlacement.mock.calls[0] as [string, MiniAppPlacement];
    expect(tab).toBe(queue.id);
    expect(placementShows(placement, R2)).toBe(true);
    // Nothing broader changed: still shows in R1, still not in an unrelated room.
    expect(placementShows(placement, R1)).toBe(true);
    expect(placementShows(placement, { page: 'channels', roomId: 'R3' })).toBe(false);
    expect(mockSetActiveRightPanelTab).toHaveBeenCalledWith(queue.id);
  });

  it('"Hide here" on the open mini-app tab writes a placement that no longer shows here', async () => {
    mockActiveRightPanelTab = queue.id;
    renderPanel();

    const menu = await openMenu();
    expect(within(menu).queryByText('Show here')).not.toBeInTheDocument();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Hide here' }));

    expect(mockSetPlacement).toHaveBeenCalledTimes(1);
    const [tab, placement] = mockSetPlacement.mock.calls[0] as [string, MiniAppPlacement];
    expect(tab).toBe(queue.id);
    expect(placementShows(placement, R1)).toBe(false);
  });

  it('"Where it shows…" opens the mini app\'s settings', async () => {
    mockActiveRightPanelTab = queue.id;
    renderPanel();

    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Where it shows…' }));

    expect(mockSettingsOpen).toHaveBeenCalledWith('extensions', 'social-queue');
  });

  it('offers no menu when no mini-app tab is open and none is hidden here', () => {
    renderPanel();
    expect(screen.queryByTestId('mini-app-tab-menu')).not.toBeInTheDocument();
  });

  it('offers no "Show here" in a channel from a connected community', () => {
    // A community room has no id here, so "here" is every channel: too broad to name.
    mockHereState = { status: 'ready', here: { page: 'channels' } };
    renderPanel();
    expect(screen.queryByRole('tab', { name: 'Queue' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('mini-app-tab-menu')).not.toBeInTheDocument();
  });
});
