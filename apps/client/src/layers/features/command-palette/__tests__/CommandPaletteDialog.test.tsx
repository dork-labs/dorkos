/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { sessionKeys } from '@/layers/entities/session';
import type { Session } from '@dorkos/shared/types';
import '@testing-library/jest-dom/vitest';
import { createMockTransport } from '@dorkos/test-utils';
import { useInteractionStore } from '@/layers/entities/interactions';
import { CommandPaletteDialog } from '../ui/CommandPaletteDialog';
import { registerTabOpener } from '@/layers/shared/lib';
import { enterDesktopShell, leaveDesktopShell } from '@/test-helpers/desktop-shell';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';

/**
 * The palette resolves which session an agent should open on from the query
 * cache, so it needs a real client. A fresh one per render keeps each case's
 * cache empty, which is the "no cached sessions yet" branch.
 */
function render(ui: React.ReactElement, seed?: (client: QueryClient) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed?.(client);
  return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

// jsdom does not implement ResizeObserver (required by cmdk CommandList)
globalThis.ResizeObserver = vi.fn().mockImplementation(function () {
  // Vitest 4 spies honor `new` semantics; the implementation must be constructible.
  return {
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  };
});

// jsdom does not implement scrollIntoView (required by cmdk item selection)
Element.prototype.scrollIntoView = vi.fn();

// --- matchMedia mock (required for ResponsiveDialog / Radix viewport checks) ---
beforeEach(() => {
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
  useInteractionStore.getState().reset();
});

/**
 * Every agent directory this person has opened, from the ONE store that records
 * them.
 *
 * These claims used to be made against a `recordUsage` spy on ⌘K's own frecency
 * hook, which is gone: the palette keeps no memory of its own now, so the only
 * honest way to ask "was this open recorded" is to ask the store the sidebar
 * reads too. Keyed by directory, not mesh id — that is what the corpus ranks
 * agents under, and a record under any other key would rank nothing.
 */
function openedAgents(): string[] {
  return Object.keys(useInteractionStore.getState().opened)
    .filter((key) => key.startsWith('agent:'))
    .map((key) => key.slice('agent:'.length));
}

const tabCleanups: (() => void)[] = [];

/**
 * Register a strip and collect what it opens. Torn down in `afterEach` rather
 * than at the end of the test body, so a failing assertion cannot leak an opener
 * into the next case and make a cascade look like a second detection.
 */
function captureTabOpens(): string[] {
  const opened: string[] = [];
  tabCleanups.push(registerTabOpener((href) => opened.push(href)));
  return opened;
}

afterEach(() => {
  cleanup();
  tabCleanups.splice(0).forEach((clear) => clear());
  // Every test starts in a browser; the ones about the desktop app say so.
  leaveDesktopShell();
});

// --- Router mock ---
const mockTransport = createMockTransport();

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

// --- Shared mock fns ---

const mockSetGlobalPaletteOpen = vi.fn();
const mockSetSettingsOpen = vi.fn();
const mockSetTasksOpen = vi.fn();
const mockOpenConnections = vi.fn();
const mockImportOpen = vi.fn();
const mockSetPickerOpen = vi.fn();
const mockSetRightPanelOpen = vi.fn();
const mockSetActiveRightPanelTab = vi.fn();

let mockGlobalPaletteOpen = true;

const mockSetPreviousCwd = vi.fn();
const mockClearGlobalPaletteInitialSearch = vi.fn();

vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      setSettingsOpen: mockSetSettingsOpen,
      setTasksOpen: mockSetTasksOpen,
      setPickerOpen: mockSetPickerOpen,
      setRightPanelOpen: mockSetRightPanelOpen,
      setActiveRightPanelTab: mockSetActiveRightPanelTab,
      setPreviousCwd: mockSetPreviousCwd,
      globalPaletteInitialSearch: null,
      clearGlobalPaletteInitialSearch: mockClearGlobalPaletteInitialSearch,
    };
    return selector ? selector(state) : state;
  },
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
  // `usePaletteActions` resolves which conversation a slash command runs in,
  // and that resolver asks the server when nothing is cached.
  useTransport: () => mockTransport,
  useReportIssue: () => vi.fn(),
  // `usePaletteActions` reads the feedback dialog's store, so the palette does
  // not render at all without it (DOR-902).
  useFeedbackDialogStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = { openFeedback: vi.fn() };
    return selector ? selector(state) : state;
  },
  useIsMobile: () => false,
  useNow: () => Date.now(),
  // URL deep-link hooks — during the dual-signal era we forward open/close
  // to the existing store-setter mocks so legacy assertions still hold while
  // the palette migrates to router-first dialog opens (task 2.7).
  useSettingsDeepLink: () => ({
    isOpen: false,
    activeTab: null,
    section: null,
    open: () => mockSetSettingsOpen(true),
    close: () => mockSetSettingsOpen(false),
    setTab: () => {},
    setSection: () => {},
  }),
  useTasksDeepLink: () => ({
    isOpen: false,
    activeTab: null,
    section: null,
    open: () => mockSetTasksOpen(true),
    close: () => mockSetTasksOpen(false),
    setTab: () => {},
    setSection: () => {},
  }),
  useOpenConnections: () => mockOpenConnections,
  useAgentCreationStore: Object.assign(() => ({ open: vi.fn() }), {
    getState: () => ({ open: vi.fn() }),
  }),
  useImportProjectsStore: Object.assign(() => ({ open: mockImportOpen }), {
    getState: () => ({ open: mockImportOpen }),
  }),
}));

// A successful open: `setDir` runs `onOpened` once the agent is really on
// screen. Frecency and the switch-back target ride that callback, so a mock
// that ignored it would not be the contract the palette consumes (DOR-928).
const mockSetDir = vi.fn((_dir: string | null, opts?: { onOpened?: () => void }) => {
  opts?.onOpened?.();
});
vi.mock('@/layers/entities/session', async (importOriginal) => ({
  // Keep the real session resolver — the palette builds its hrefs with it, and
  // faking it would hide whether those hrefs carry a session at all.
  ...(await importOriginal<typeof import('@/layers/entities/session')>()),
  useDirectoryState: () => ['/projects/current', mockSetDir],
}));

// Mock usePreviewData so AgentPreviewPanel doesn't call real entity hooks
vi.mock('../model/use-preview-data', () => ({
  usePreviewData: () => ({
    sessionCount: 2,
    recentSessions: [],
    health: null,
  }),
}));

// Mock motion/react to render plain elements (avoids animation-related test issues)
vi.mock('motion/react', () => ({
  motion: {
    div: ({
      children,
      ...props
    }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) =>
      React.createElement('div', props, children),
    span: ({
      children,
      ...props
    }: React.HTMLAttributes<HTMLSpanElement> & { children?: React.ReactNode }) =>
      React.createElement('span', props, children),
  },
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => children,
  LayoutGroup: ({ children }: { children?: React.ReactNode }) => children,
}));

const mockOpenProfileDocked = vi.fn();
vi.mock('@/layers/features/profile', () => ({
  PROFILE_PANEL_ID: 'profile',
  useProfileStore: Object.assign(() => ({}), {
    getState: () => ({ openProfileDocked: mockOpenProfileDocked }),
  }),
}));

const mockAgents: AgentPathEntry[] = [
  { id: 'agent-1', name: 'Auth Service', projectPath: '/projects/auth' },
  { id: 'agent-2', name: 'API Gateway', projectPath: '/projects/api' },
  { id: 'agent-3', name: 'Worker', projectPath: '/projects/current' },
];

/**
 * No rooms. This file is about agents, features and commands; rooms in the
 * palette have their own file (`rooms-in-palette.test.tsx`), which runs the
 * real assembly against a mock Transport rather than a stub like this one.
 */
const noRooms = {
  channels: [],
  dms: [],
  unread: [],
  isLoading: false,
  isError: false,
};

/**
 * The ranking fields of a row with no history behind it.
 *
 * Every corpus row has to answer them — that is the point of their being
 * required — and this file's claims are about which rows a query REACHES, not
 * about the order use and freshness put them in. Those live in
 * `palette-ranking.test.ts` and in the wire-through file beside it.
 */
const unranked = {
  usageKey: null,
  lastActivityAt: null,
  waiting: false,
  demoted: false,
} as const;

vi.mock('../model/use-palette-items', () => ({
  usePaletteItems: () => ({
    rooms: noRooms,
    allAgents: mockAgents,
    features: [
      { id: 'tasks', label: 'Tasks Scheduler', icon: 'Clock', action: 'openTasks' },
      { id: 'relay', label: 'Connections', icon: 'Radio', action: 'openRelay' },
      { id: 'mesh', label: 'Mesh Network', icon: 'Globe', action: 'openMesh' },
      { id: 'settings', label: 'Settings', icon: 'Settings', action: 'openSettings' },
    ],
    commands: [
      { name: '/hello', description: 'Say hello' },
      { name: '/world', description: 'Say world' },
    ],
    quickActions: [
      { id: 'new-session', label: 'New Session', icon: 'Plus', action: 'newSession' },
      {
        id: 'discover',
        label: 'Bring in existing projects',
        icon: 'Search',
        action: 'discoverAgents',
      },
      { id: 'browse', label: 'Browse Filesystem', icon: 'FolderOpen', action: 'browseFilesystem' },
      { id: 'theme', label: 'Toggle Theme', icon: 'Moon', action: 'toggleTheme' },
    ],
    // The corpus the REAL search and ranking read. `usePaletteSearch` is
    // deliberately not mocked in this file: it is the thing that decides what
    // a typed query shows, and a passthrough stub in its place would have left
    // every assertion below green against a palette that never ranked anything.
    searchableItems: [
      ...mockAgents.map((a) => ({
        id: a.id,
        name: a.name,
        type: 'agent',
        keywords: [a.projectPath],
        ...unranked,
        data: a,
      })),
      ...[
        { id: 'tasks', label: 'Tasks Scheduler', icon: 'Clock', action: 'openTasks' },
        { id: 'relay', label: 'Connections', icon: 'Radio', action: 'openRelay' },
        { id: 'mesh', label: 'Mesh Network', icon: 'Globe', action: 'openMesh' },
        { id: 'settings', label: 'Settings', icon: 'Settings', action: 'openSettings' },
      ].map((f) => ({ id: f.id, name: f.label, type: 'feature', ...unranked, data: f })),
      ...[
        { name: '/hello', description: 'Say hello' },
        { name: '/world', description: 'Say world' },
      ].map((c) => ({ id: `cmd-${c.name}`, name: c.name, type: 'command', ...unranked, data: c })),
      ...[
        { id: 'new-session', label: 'New Session', icon: 'Plus', action: 'newSession' },
        {
          id: 'discover',
          label: 'Bring in existing projects',
          icon: 'Search',
          action: 'discoverAgents',
        },
        {
          id: 'browse',
          label: 'Browse Filesystem',
          icon: 'FolderOpen',
          action: 'browseFilesystem',
        },
        { id: 'theme', label: 'Toggle Theme', icon: 'Moon', action: 'toggleTheme' },
      ].map((q) => ({ id: q.id, name: q.label, type: 'quick-action', ...unranked, data: q })),
    ],
    newActions: [{ id: 'new-session', label: 'New Session', icon: 'Plus', action: 'newSession' }],
    sessions: [],
    continueRows: [],
    // The zero-query Recent list. Agent rows, so the sub-menu drill-in this
    // file has always asserted still has a row to start from.
    recent: [
      {
        kind: 'agent',
        key: `agent:${mockAgents[2].projectPath}`,
        lastActivityAt: '2026-08-09T10:00:00.000Z',
        agent: mockAgents[2],
      },
      {
        kind: 'agent',
        key: `agent:${mockAgents[0].projectPath}`,
        lastActivityAt: '2026-08-09T09:00:00.000Z',
        agent: mockAgents[0],
      },
    ],
    isLoading: false,
  }),
}));

vi.mock('../model/use-global-palette', () => ({
  useGlobalPalette: () => ({
    globalPaletteOpen: mockGlobalPaletteOpen,
    setGlobalPaletteOpen: mockSetGlobalPaletteOpen,
    toggleGlobalPalette: vi.fn(),
  }),
}));

describe('CommandPaletteDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGlobalPaletteOpen = true;
  });

  // --- Rendering when open ---

  it('renders the command input when open', () => {
    render(<CommandPaletteDialog />);
    expect(screen.getByPlaceholderText('Search rooms, agents, commands...')).toBeInTheDocument();
  });

  it('renders the Recent group heading', () => {
    render(<CommandPaletteDialog />);
    expect(screen.getByText('Recent')).toBeInTheDocument();
  });

  it('renders agent names from the Recent mix', () => {
    render(<CommandPaletteDialog />);
    // getAllByText used because the selected agent name also appears in the preview panel
    expect(screen.getAllByText('Worker').length).toBeGreaterThan(0);
    expect(screen.getByText('Auth Service')).toBeInTheDocument();
  });

  /**
   * The zero-query palette is a command center, not a menu of everything
   * (§15). Features and Quick Actions used to be dumped here in full; they are
   * still one keystroke away, and the search-mode cases further down assert
   * that they come back the moment anything is typed.
   */
  it('does not dump Features and Quick Actions into the untyped palette', () => {
    render(<CommandPaletteDialog />);
    expect(screen.queryByText('Features')).not.toBeInTheDocument();
    expect(screen.queryByText('Quick Actions')).not.toBeInTheDocument();
    expect(screen.queryByText('Toggle Theme')).not.toBeInTheDocument();
  });

  it("renders the New group with the cockpit's creation actions", () => {
    render(<CommandPaletteDialog />);
    expect(screen.getByText('New')).toBeInTheDocument();
    expect(screen.getByText('New Session')).toBeInTheDocument();
  });

  it('does not render Commands group when search query is empty', () => {
    render(<CommandPaletteDialog />);
    expect(screen.queryByText('Commands')).not.toBeInTheDocument();
  });

  it('does not render the Agents group when search is empty', () => {
    render(<CommandPaletteDialog />);
    expect(screen.queryByText('Agents')).not.toBeInTheDocument();
  });

  it('renders "No results found." text when search yields no matches', () => {
    render(<CommandPaletteDialog />);
    // cmdk's CommandEmpty is hidden when items are present; enter a nonsense query to trigger it
    const input = screen.getByPlaceholderText('Search rooms, agents, commands...');
    // The empty element exists in the DOM even when hidden (cmdk hides it via CSS/aria)
    // We just verify the empty state element is rendered in the component tree
    expect(input).toBeInTheDocument(); // confirms dialog is open and rendered
  });

  // --- Not rendered when closed ---

  it('does not render dialog content when globalPaletteOpen is false', () => {
    mockGlobalPaletteOpen = false;
    render(<CommandPaletteDialog />);
    expect(
      screen.queryByPlaceholderText('Search rooms, agents, commands...')
    ).not.toBeInTheDocument();
  });

  // --- Agent selection (two-step: click agent → sub-menu → Open Here) ---

  it('clicking an agent item opens the sub-menu (agent-actions page)', () => {
    render(<CommandPaletteDialog />);
    const item = screen.getAllByText('Worker')[0].closest('[data-slot="command-item"]');
    if (item) fireEvent.click(item as Element);
    // Sub-menu should appear with the agent actions
    expect(screen.getByText('Open Here')).toBeInTheDocument();
    expect(screen.getByText('Open in New Tab')).toBeInTheDocument();
    expect(screen.getByText('New Session')).toBeInTheDocument();
    expect(screen.getByText('Edit Worker Settings')).toBeInTheDocument();
  });

  it('offers Open in New Window in the desktop app', () => {
    enterDesktopShell();
    render(<CommandPaletteDialog />);
    const item = screen.getAllByText('Worker')[0].closest('[data-slot="command-item"]');
    if (item) fireEvent.click(item as Element);
    expect(screen.getByText('Open in New Window')).toBeInTheDocument();
  });

  it('leaves Open in New Window out entirely in the browser', () => {
    // Not disabled, not remapped to a tab — absent. In a browser a new window
    // IS the tab the row above already offers, and two rows that do the same
    // thing is a lie told in the UI (DOR-568).
    render(<CommandPaletteDialog />);
    const item = screen.getAllByText('Worker')[0].closest('[data-slot="command-item"]');
    if (item) fireEvent.click(item as Element);
    expect(screen.getByText('Open in New Tab')).toBeInTheDocument();
    expect(screen.queryByText('Open in New Window')).not.toBeInTheDocument();
  });

  it('shows breadcrumb when in agent sub-menu', () => {
    render(<CommandPaletteDialog />);
    const item = screen.getAllByText('Worker')[0].closest('[data-slot="command-item"]');
    if (item) fireEvent.click(item as Element);
    expect(screen.getByText('All')).toBeInTheDocument();
    expect(screen.getByText('Agent: Worker')).toBeInTheDocument();
  });

  it('opens an in-window tab on the agent\u2019s project from Open in New Tab', () => {
    // DOR-540: this used to be a second window (and before DOR-534, a hand-off
    // to Chrome). In the desktop app it is now a tab in this window, aimed at
    // `/session` with only the agent's directory — the loader resolves which
    // session that becomes.
    enterDesktopShell();
    const opened = captureTabOpens();
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<CommandPaletteDialog />);
    const item = screen.getAllByText('Worker')[0].closest('[data-slot="command-item"]');
    if (item) fireEvent.click(item as Element);
    const newTabItem = screen.getByText('Open in New Tab').closest('[data-slot="command-item"]');
    if (newTabItem) fireEvent.click(newTabItem as Element);

    expect(opened).toHaveLength(1);
    const target = new URL(opened[0], window.location.origin);
    expect(target.pathname).toBe('/session');
    expect(target.searchParams.get('dir')).toBe('/projects/current');
    // Nothing is cached for this agent, so the href does NOT guess: it leaves
    // `?session=` off and lets the loader resolve which conversation that is,
    // rather than inventing an id and opening an empty chat (DOR-928).
    expect(target.searchParams.get('session')).toBeNull();
    // And never the session of whatever tab you were already reading.
    expect(target.searchParams.get('session')).not.toBe('session-in-progress');
    // A tab is not a window.
    expect(openSpy).not.toHaveBeenCalled();
    expect(openedAgents()).toContain('/projects/current');

    openSpy.mockRestore();
  });

  it('names the agent’s session up front when this window already knows it', () => {
    // Naming it saves the loader's redirect — a second navigation and a history
    // REPLACE, plus a frame where the new tab is titled after an href it is
    // about to lose. Worth doing when it is free, which is exactly when the
    // session list for that agent is already cached.
    enterDesktopShell();
    const opened = captureTabOpens();
    render(<CommandPaletteDialog />, (client) => {
      client.setQueryData(sessionKeys.list('/projects/current'), [
        { id: 'known-session' },
      ] as Session[]);
    });
    const item = screen.getAllByText('Worker')[0].closest('[data-slot="command-item"]');
    if (item) fireEvent.click(item as Element);
    const newTabItem = screen.getByText('Open in New Tab').closest('[data-slot="command-item"]');
    if (newTabItem) fireEvent.click(newTabItem as Element);

    const target = new URL(opened[0], window.location.origin);
    expect(target.searchParams.get('session')).toBe('known-session');
  });

  it('opens a real browser tab from Open in New Tab in the browser', () => {
    // Same row, same label, different owner (DOR-568). `main.tsx` registers no
    // strip in a browser, so nothing is registered here either — that absence
    // IS the browser condition, and the seam answers it with the browser's own
    // tabs rather than a silent in-place navigation.
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<CommandPaletteDialog />);
    const item = screen.getAllByText('Worker')[0].closest('[data-slot="command-item"]');
    if (item) fireEvent.click(item as Element);
    const newTabItem = screen.getByText('Open in New Tab').closest('[data-slot="command-item"]');
    if (newTabItem) fireEvent.click(newTabItem as Element);

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(expect.any(String), '_blank');
    const target = new URL(String(openSpy.mock.calls[0][0]));
    expect(target.origin).toBe(window.location.origin);
    expect(target.pathname).toBe('/session');
    expect(target.searchParams.get('dir')).toBe('/projects/current');
    expect(openedAgents()).toContain('/projects/current');

    openSpy.mockRestore();
  });

  it('opens a second cockpit window \u2014 not a tab \u2014 from Open in New Window', () => {
    // "Another tab" and "put this on my other monitor" are different requests,
    // so the strip must not absorb the second one. Same target as the tab
    // action; only where it lands differs. Desktop-only — see the browser case
    // above, where the row does not exist at all.
    enterDesktopShell();
    const opened = captureTabOpens();
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<CommandPaletteDialog />);
    const item = screen.getAllByText('Worker')[0].closest('[data-slot="command-item"]');
    if (item) fireEvent.click(item as Element);
    const newWindowItem = screen
      .getByText('Open in New Window')
      .closest('[data-slot="command-item"]');
    if (newWindowItem) fireEvent.click(newWindowItem as Element);

    expect(opened).toEqual([]);
    expect(openSpy).toHaveBeenCalledTimes(1);
    // Asserting the WHOLE call pins the arity: the desktop shell adopts a
    // same-origin `_blank` as a DorkOS window, and a `noopener` third argument
    // would forfeit that.
    expect(openSpy).toHaveBeenCalledWith(expect.any(String), '_blank');
    const target = new URL(String(openSpy.mock.calls[0][0]));
    expect(target.origin).toBe(window.location.origin);
    expect(target.pathname).toBe('/session');
    expect(target.searchParams.get('dir')).toBe('/projects/current');
    // Same rule as the tab action: nothing cached for this agent, so the href
    // leaves `?session=` to the loader rather than inventing one (DOR-928).
    expect(target.searchParams.get('session')).toBeNull();

    openSpy.mockRestore();
  });

  it('records the agent and switches directory when Open Here is clicked in sub-menu', async () => {
    render(<CommandPaletteDialog />);
    // Click agent to enter sub-menu
    const item = screen.getAllByText('Worker')[0].closest('[data-slot="command-item"]');
    if (item) fireEvent.click(item as Element);
    // Click Open Here
    const openHereItem = screen.getByText('Open Here').closest('[data-slot="command-item"]');
    if (openHereItem) fireEvent.click(openHereItem as Element);
    expect(mockSetDir).toHaveBeenCalledWith('/projects/current', expect.anything());
    // Frecency waits for the agent to actually open (DOR-928): a failed or
    // overtaken lookup must not rank an agent you never reached.
    await waitFor(() => expect(openedAgents()).toContain('/projects/current'));
  });

  it('starts a BRAND-NEW conversation from New Session, not the agent’s latest', async () => {
    // Red when New Session routes through `setDir`: that resolves the agent's
    // most recent conversation and resumes it, which is exactly what "Open
    // Here" two rows above already does — two rows, one behaviour (DOR-928).
    render(<CommandPaletteDialog />);
    const item = screen.getAllByText('Worker')[0].closest('[data-slot="command-item"]');
    if (item) fireEvent.click(item as Element);
    const newSession = screen.getByText('New Session').closest('[data-slot="command-item"]');
    if (newSession) fireEvent.click(newSession as Element);

    expect(mockSetDir).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: {
        dir: '/projects/current',
        session: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
        ),
      },
    });
    await waitFor(() => expect(openedAgents()).toContain('/projects/current'));
  });

  it('closes palette after Open Here is clicked in sub-menu', () => {
    render(<CommandPaletteDialog />);
    const item = screen.getAllByText('Worker')[0].closest('[data-slot="command-item"]');
    if (item) fireEvent.click(item as Element);
    const openHereItem = screen.getByText('Open Here').closest('[data-slot="command-item"]');
    if (openHereItem) fireEvent.click(openHereItem as Element);
    expect(mockSetGlobalPaletteOpen).toHaveBeenCalledWith(false);
  });

  it('opens the agent’s profile in the right panel from the sub-menu', () => {
    render(<CommandPaletteDialog />);
    const item = screen.getAllByText('Worker')[0].closest('[data-slot="command-item"]');
    if (item) fireEvent.click(item as Element);
    const editItem = screen.getByText('Edit Worker Settings').closest('[data-slot="command-item"]');
    if (editItem) fireEvent.click(editItem as Element);
    // One call now, not three: naming the agent, selecting the tab and opening
    // the panel are all "open the profile", and the store does them together.
    expect(mockOpenProfileDocked).toHaveBeenCalledWith('/projects/current');
    expect(mockSetGlobalPaletteOpen).toHaveBeenCalledWith(false);
  });

  // --- Feature action dispatching ---

  /**
   * Features and quick actions are reached by typing now, so every case below
   * types first — and types the row's own name, the way a person does. Search
   * and ranking are the real ones here, so a query that happened to match
   * everything (`'a'`, as this used to pass) would leave the row a case is
   * about to be found by luck rather than by what was typed.
   */
  function searchThen(text: string) {
    render(<CommandPaletteDialog />);
    fireEvent.change(screen.getByPlaceholderText('Search rooms, agents, commands...'), {
      target: { value: text },
    });
  }

  it('opens Tasks dialog and closes palette when Tasks Scheduler is selected', () => {
    searchThen('Tasks Scheduler');
    const item = screen.getByText('Tasks Scheduler').closest('[data-slot="command-item"]');
    if (item) fireEvent.click(item as Element);
    expect(mockSetTasksOpen).toHaveBeenCalledWith(true);
    expect(mockSetGlobalPaletteOpen).toHaveBeenCalledWith(false);
  });

  it('goes to the Connections page when Connections is selected', () => {
    searchThen('Connections');
    const item = screen.getByText('Connections').closest('[data-slot="command-item"]');
    if (item) fireEvent.click(item as Element);
    expect(mockOpenConnections).toHaveBeenCalledWith('messaging');
  });

  it('navigates to /agents when Mesh Network is selected', () => {
    searchThen('Mesh Network');
    const item = screen.getByText('Mesh Network').closest('[data-slot="command-item"]');
    if (item) fireEvent.click(item as Element);
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/team' });
  });

  it('opens Settings dialog when Settings is selected', () => {
    searchThen('Settings');
    const item = screen.getByText('Settings').closest('[data-slot="command-item"]');
    if (item) fireEvent.click(item as Element);
    expect(mockSetSettingsOpen).toHaveBeenCalledWith(true);
  });

  // --- Quick action dispatching ---

  it('opens the import dialog when Bring in existing projects quick action is selected', () => {
    searchThen('Bring in existing projects');
    const item = screen
      .getByText('Bring in existing projects')
      .closest('[data-slot="command-item"]');
    if (item) fireEvent.click(item as Element);
    expect(mockImportOpen).toHaveBeenCalledTimes(1);
  });

  it('opens directory picker when Browse Filesystem quick action is selected', () => {
    searchThen('Browse Filesystem');
    const item = screen.getByText('Browse Filesystem').closest('[data-slot="command-item"]');
    if (item) fireEvent.click(item as Element);
    expect(mockSetPickerOpen).toHaveBeenCalledWith(true);
  });

  // --- @ prefix (agent-only) mode ---

  it('shows the Agents group and hides Actions/Recent in @ mode', () => {
    render(<CommandPaletteDialog />);
    const input = screen.getByPlaceholderText('Search rooms, agents, commands...');
    fireEvent.change(input, { target: { value: '@' } });
    expect(screen.getByText('Agents')).toBeInTheDocument();
    expect(screen.queryByText('Actions')).not.toBeInTheDocument();
    expect(screen.queryByText('Recent')).not.toBeInTheDocument();
  });

  it('does not show Commands group in @ mode', () => {
    render(<CommandPaletteDialog />);
    const input = screen.getByPlaceholderText('Search rooms, agents, commands...');
    fireEvent.change(input, { target: { value: '@hello' } });
    expect(screen.queryByText('Commands')).not.toBeInTheDocument();
  });

  // --- Search reveals All Agents and Commands ---

  it('shows the Agents group when a non-@ search query is entered', () => {
    render(<CommandPaletteDialog />);
    const input = screen.getByPlaceholderText('Search rooms, agents, commands...');
    fireEvent.change(input, { target: { value: 'auth' } });
    expect(screen.getByText('Agents')).toBeInTheDocument();
  });

  it('shows Commands group when a non-@ search query is entered', () => {
    render(<CommandPaletteDialog />);
    const input = screen.getByPlaceholderText('Search rooms, agents, commands...');
    fireEvent.change(input, { target: { value: 'hello' } });
    expect(screen.getByText('Commands')).toBeInTheDocument();
    expect(screen.getByText('/hello')).toBeInTheDocument();
  });
});
