/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import { createMockTransport } from '@dorkos/test-utils';
import { CommandPaletteDialog } from '../ui/CommandPaletteDialog';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';

const mockTransport = createMockTransport();

/**
 * The palette resolves which session an agent should open on from the query
 * cache, so it needs a real client. A fresh one per render keeps each case's
 * cache empty.
 */
function render(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

// jsdom does not implement scrollIntoView (used by cmdk when filtering items)
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
});

afterEach(cleanup);

// --- Router mock ---
const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

// --- Shared mock fns ---

const mockSetGlobalPaletteOpen = vi.fn();
const mockSetSettingsOpen = vi.fn();
const mockSetTasksOpen = vi.fn();
const mockOpenConnections = vi.fn();
const mockSetPickerOpen = vi.fn();
const mockImportOpen = vi.fn();
const mockSetTheme = vi.fn();

let mockGlobalPaletteOpen = true;
let mockTheme = 'light';

const mockSetPreviousCwd = vi.fn();
// Hoisted, NOT built inside the selector. A zustand action has a stable
// identity for the app's lifetime, and a mock that mints a fresh `vi.fn()` per
// selector call does not: it makes every consuming `useCallback` re-create on
// every render, which quietly repairs stale-closure bugs that are real in
// production. That is what hid the palette's New Session reading a
// boot-time `selectedCwd` (DOR-928).
const mockToggleGlobalPalette = vi.fn();
const mockSetSelectedCwd = vi.fn();
const mockSetStoreSessionId = vi.fn();
const mockClearGlobalPaletteInitialSearch = vi.fn();
const mockOpenFeedback = vi.fn();
const mockSettingsDeepLink = {
  isOpen: false,
  activeTab: null,
  section: null,
  open: () => mockSetSettingsOpen(true),
  close: () => mockSetSettingsOpen(false),
  setTab: () => {},
  setSection: () => {},
};
const mockTasksDeepLink = {
  isOpen: false,
  activeTab: null,
  section: null,
  open: () => mockSetTasksOpen(true),
  close: () => mockSetTasksOpen(false),
  setTab: () => {},
  setSection: () => {},
};

vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      globalPaletteOpen: mockGlobalPaletteOpen,
      setGlobalPaletteOpen: mockSetGlobalPaletteOpen,
      toggleGlobalPalette: mockToggleGlobalPalette,
      setSettingsOpen: mockSetSettingsOpen,
      setTasksOpen: mockSetTasksOpen,
      setPickerOpen: mockSetPickerOpen,
      setPreviousCwd: mockSetPreviousCwd,
      // The real store carries these; "New session" reads the active agent from
      // here and mints an id into it (DOR-928).
      selectedCwd: mockSelectedCwd,
      setSelectedCwd: mockSetSelectedCwd,
      setSessionId: mockSetStoreSessionId,
      globalPaletteInitialSearch: null,
      clearGlobalPaletteInitialSearch: mockClearGlobalPaletteInitialSearch,
    };
    return selector ? selector(state) : state;
  },
  useTheme: () => ({ theme: mockTheme, setTheme: mockSetTheme }),
  // `usePaletteActions` resolves which conversation a slash command runs in,
  // and that resolver asks the server when nothing is cached.
  useTransport: () => mockTransport,
  useReportIssue: () => vi.fn(),
  // `usePaletteActions` reads the feedback dialog's store, so the palette does
  // not render at all without it (DOR-902).
  useFeedbackDialogStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = { openFeedback: mockOpenFeedback };
    return selector ? selector(state) : state;
  },
  useIsMobile: () => false,
  useNow: () => Date.now(),
  // URL deep-link hooks — during the dual-signal era we forward open/close
  // to the existing store-setter mocks so legacy assertions still hold while
  // the palette migrates to router-first dialog opens (task 2.7).
  // Returned as ONE stable object, like the real hooks: a fresh literal per
  // call re-creates every consuming `useCallback`, which hides stale-closure
  // bugs that are real in production (DOR-928).
  useSettingsDeepLink: () => mockSettingsDeepLink,
  useTasksDeepLink: () => mockTasksDeepLink,
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
let mockSelectedCwd: string | null = '/projects/current';

vi.mock('@/layers/entities/session', async (importOriginal) => ({
  // Keep the real session resolver — the palette builds its hrefs with it.
  ...(await importOriginal<typeof import('@/layers/entities/session')>()),
  useDirectoryState: () => [mockSelectedCwd, mockSetDir],
}));

// --- Use REAL useAgentFrecency (tests localStorage integration) ---
// No mock for '../model/use-agent-frecency' — the real hook is used.

// --- Mock usePaletteItems with configurable agents ---

const mockAgents: AgentPathEntry[] = [
  { id: 'agent-1', name: 'Auth Service', projectPath: '/projects/auth' },
  { id: 'agent-2', name: 'API Gateway', projectPath: '/projects/gateway' },
  { id: 'agent-3', name: 'Frontend App', projectPath: '/projects/current' },
];

let mockPaletteRecentAgents: AgentPathEntry[] = [mockAgents[2], mockAgents[0]];
let mockPaletteAllAgents: AgentPathEntry[] = mockAgents;

vi.mock('../model/use-palette-items', () => ({
  usePaletteItems: () => {
    const features = [
      { id: 'tasks', label: 'Tasks Scheduler', icon: 'Clock', action: 'openTasks' },
      { id: 'relay', label: 'Connections', icon: 'Radio', action: 'openRelay' },
      { id: 'mesh', label: 'Mesh Network', icon: 'Globe', action: 'openMesh' },
      { id: 'settings', label: 'Settings', icon: 'Settings', action: 'openSettings' },
    ];
    const commands = [{ name: '/deploy', description: 'Deploy service' }];
    const quickActions = [
      { id: 'new-session', label: 'New Session', icon: 'Plus', action: 'newSession' },
      {
        id: 'discover',
        label: 'Bring in existing projects',
        icon: 'Search',
        action: 'discoverAgents',
      },
      { id: 'browse', label: 'Browse Filesystem', icon: 'FolderOpen', action: 'browseFilesystem' },
      { id: 'theme', label: 'Toggle Theme', icon: 'Moon', action: 'toggleTheme' },
    ];
    return {
      // No rooms — rooms in the palette have their own file
      // (`rooms-in-palette.test.tsx`), which runs the real assembly.
      rooms: {
        channels: [],
        dms: [],
        unread: [],
        isLoading: false,
        isError: false,
      },
      recentAgents: mockPaletteRecentAgents,
      allAgents: mockPaletteAllAgents,
      features,
      commands,
      quickActions,
      searchableItems: [
        ...mockPaletteAllAgents.map((a: AgentPathEntry) => ({
          id: a.id,
          name: a.name,
          type: 'agent',
          keywords: [a.projectPath],
          data: a,
        })),
        ...features.map((f) => ({ id: f.id, name: f.label, type: 'feature', data: f })),
        ...commands.map((c) => ({ id: `cmd-${c.name}`, name: c.name, type: 'command', data: c })),
        ...quickActions.map((q) => ({ id: q.id, name: q.label, type: 'quick-action', data: q })),
      ],
      newActions: quickActions.filter((q) => q.id === 'new-session'),
      sessions: [],
      continueRows: [],
      // The untyped palette's Recent list is where agent rows live now.
      recent: mockPaletteRecentAgents.map((agent: AgentPathEntry) => ({
        kind: 'agent' as const,
        key: `agent:${agent.projectPath}`,
        lastActivityAt: '2026-08-09T10:00:00.000Z',
        agent,
      })),
      isLoading: false,
    };
  },
}));

// Mock usePaletteSearch: passthrough all items so existing rendering assertions hold.
// Prefix filtering (@ / >) is preserved so mode-switching tests work correctly.
vi.mock('../model/use-palette-search', () => ({
  usePaletteSearch: (items: Array<{ id: string; type: string; name: string }>, search: string) => {
    const prefix = search.startsWith('@') ? '@' : search.startsWith('>') ? '>' : null;
    const term = prefix ? search.slice(1) : search;
    const filtered =
      prefix === '@'
        ? items.filter((i) => i.type === 'agent')
        : prefix === '>'
          ? items.filter((i) => i.type === 'command')
          : items;
    return { results: filtered.map((item) => ({ item, matches: undefined })), prefix, term };
  },
  parsePrefix: (search: string) => {
    if (search.startsWith('@')) return { prefix: '@', term: search.slice(1) };
    if (search.startsWith('>')) return { prefix: '>', term: search.slice(1) };
    return { prefix: null, term: search };
  },
}));

vi.mock('../model/use-global-palette', () => ({
  useGlobalPalette: () => ({
    globalPaletteOpen: mockGlobalPaletteOpen,
    setGlobalPaletteOpen: mockSetGlobalPaletteOpen,
    toggleGlobalPalette: vi.fn(),
  }),
}));

// Mock usePreviewData so AgentPreviewPanel doesn't call real entity hooks
vi.mock('../model/use-preview-data', () => ({
  usePreviewData: () => ({
    sessionCount: 0,
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

describe('Command Palette Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockGlobalPaletteOpen = true;
    mockSelectedCwd = '/projects/current';
    mockTheme = 'light';
    mockPaletteRecentAgents = [mockAgents[2], mockAgents[0]];
    mockPaletteAllAgents = mockAgents;
  });

  // --- Full agent switching flow (two-step: click agent → sub-menu → Open Here) ---

  it('starts the new conversation on the agent you are on NOW, not the one at boot', async () => {
    // The palette is mounted for the whole life of the app (`AppShell` renders
    // it unconditionally), so a handler whose dependency list is missing an
    // entry is created ONCE, at boot, and keeps whatever `selectedCwd` was then
    // — usually none. Switch agents, hit New Session, and the conversation
    // opens somewhere you are not (DOR-928).
    mockSelectedCwd = '/projects/first';
    // Wrapper-based so `rerender` re-applies the providers — the point of this
    // case is a SECOND render of the SAME mounted component.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const Wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { rerender } = rtlRender(<CommandPaletteDialog />, { wrapper: Wrapper });

    mockSelectedCwd = '/projects/second'; // you switch agents
    rerender(<CommandPaletteDialog />);

    const row = screen.getAllByText('New Session')[0].closest('[data-slot="command-item"]');
    fireEvent.click(row as Element);

    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: {
        dir: '/projects/second',
        session: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
        ),
      },
    });
  });

  it('the New Session quick action actually starts one', async () => {
    // Red when the contribution registers an action the dispatcher has no case
    // for: the row is offered, clicking it closes the palette, and nothing
    // whatsoever happens (DOR-928 review).
    render(<CommandPaletteDialog />);
    const row = screen.getAllByText('New Session')[0].closest('[data-slot="command-item"]');
    expect(row).not.toBeNull();
    fireEvent.click(row as Element);

    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: {
        dir: '/projects/current', // the agent you are on
        session: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
        ),
      },
    });
  });

  it('clicking an agent navigates to sub-menu; Open Here switches, records frecency, and closes', async () => {
    render(<CommandPaletteDialog />);

    // Click on "Auth Service" agent to open sub-menu
    const item = screen.getByText('Auth Service').closest('[data-slot="command-item"]');
    expect(item).toBeTruthy();
    fireEvent.click(item as Element);

    // Sub-menu should appear
    expect(screen.getByText('Open Here')).toBeInTheDocument();

    // Click Open Here to complete the switch
    const openHereItem = screen.getByText('Open Here').closest('[data-slot="command-item"]');
    fireEvent.click(openHereItem as Element);

    // Should set directory to the agent's project path
    expect(mockSetDir).toHaveBeenCalledWith('/projects/auth', expect.anything());

    // Should close the palette
    expect(mockSetGlobalPaletteOpen).toHaveBeenCalledWith(false);

    // Should record frecency in localStorage (real hook)
    // Frecency lands only after the agent actually opens (DOR-928), so this
    // waits for the write rather than reading straight after the click.
    await waitFor(() => expect(localStorage.getItem('dorkos:agent-frecency-v2')).not.toBeNull());
    const stored = localStorage.getItem('dorkos:agent-frecency-v2');
    expect(stored).toBeTruthy();
    const entries = JSON.parse(stored!);
    expect(entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ agentId: 'agent-1', totalCount: 1 })])
    );
  });

  it('records frecency correctly for the active agent via Open Here', async () => {
    render(<CommandPaletteDialog />);

    // Click the active agent (Frontend App, which matches selectedCwd) to open sub-menu
    const item = screen.getAllByText('Frontend App')[0].closest('[data-slot="command-item"]');
    expect(item).toBeTruthy();
    fireEvent.click(item as Element);

    // Click Open Here
    const openHereItem = screen.getByText('Open Here').closest('[data-slot="command-item"]');
    fireEvent.click(openHereItem as Element);

    expect(mockSetDir).toHaveBeenCalledWith('/projects/current', expect.anything());

    // Frecency recorded for agent-3
    // Frecency lands only after the agent actually opens (DOR-928), so this
    // waits for the write rather than reading straight after the click.
    await waitFor(() => expect(localStorage.getItem('dorkos:agent-frecency-v2')).not.toBeNull());
    const stored = localStorage.getItem('dorkos:agent-frecency-v2');
    const entries = JSON.parse(stored!);
    expect(entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ agentId: 'agent-3', totalCount: 1 })])
    );
  });

  it('increments frecency count on repeated agent selection via Open Here', async () => {
    const { unmount } = render(<CommandPaletteDialog />);

    // Select Auth Service via sub-menu twice
    const item1 = screen.getByText('Auth Service').closest('[data-slot="command-item"]');
    fireEvent.click(item1 as Element);
    fireEvent.click(screen.getByText('Open Here').closest('[data-slot="command-item"]') as Element);
    unmount();

    // Re-render and select again
    mockGlobalPaletteOpen = true;
    const { unmount: unmount2 } = render(<CommandPaletteDialog />);
    const item2 = screen.getByText('Auth Service').closest('[data-slot="command-item"]');
    fireEvent.click(item2 as Element);
    fireEvent.click(screen.getByText('Open Here').closest('[data-slot="command-item"]') as Element);
    unmount2();

    // Frecency lands only after the agent actually opens (DOR-928), so this
    // waits for the write rather than reading straight after the click.
    await waitFor(() => expect(localStorage.getItem('dorkos:agent-frecency-v2')).not.toBeNull());
    const stored = localStorage.getItem('dorkos:agent-frecency-v2');
    const entries = JSON.parse(stored!);
    const authEntry = entries.find((e: { agentId: string }) => e.agentId === 'agent-1');
    expect(authEntry.totalCount).toBe(2);
  });

  // --- @ prefix mode ---

  it('entering @ shows All Agents and hides other groups', () => {
    render(<CommandPaletteDialog />);
    const input = screen.getByPlaceholderText('Search rooms, agents, commands...');
    fireEvent.change(input, { target: { value: '@' } });

    // All Agents visible
    expect(screen.getByText('All Agents')).toBeInTheDocument();

    // Other groups hidden
    expect(screen.queryByText('Recent Agents')).not.toBeInTheDocument();
    expect(screen.queryByText('Features')).not.toBeInTheDocument();
    expect(screen.queryByText('Quick Actions')).not.toBeInTheDocument();
    expect(screen.queryByText('Commands')).not.toBeInTheDocument();
  });

  it('@ followed by agent name still shows All Agents group', () => {
    render(<CommandPaletteDialog />);
    const input = screen.getByPlaceholderText('Search rooms, agents, commands...');
    fireEvent.change(input, { target: { value: '@auth' } });

    expect(screen.getByText('All Agents')).toBeInTheDocument();
    expect(screen.queryByText('Features')).not.toBeInTheDocument();
  });

  it('selecting an agent from search mode opens sub-menu; Open Here records frecency and sets dir', async () => {
    render(<CommandPaletteDialog />);
    const input = screen.getByPlaceholderText('Search rooms, agents, commands...');

    // Type a search query that matches an agent via cmdk's fuzzy filter
    fireEvent.change(input, { target: { value: 'API Gateway' } });

    // All Agents group should appear when searching
    expect(screen.getByText('All Agents')).toBeInTheDocument();

    // Click the agent to open sub-menu
    const item = screen.getByText('API Gateway').closest('[data-slot="command-item"]');
    fireEvent.click(item as Element);

    // Sub-menu should appear; click Open Here to complete the switch
    const openHereItem = screen.getByText('Open Here').closest('[data-slot="command-item"]');
    fireEvent.click(openHereItem as Element);

    expect(mockSetDir).toHaveBeenCalledWith('/projects/gateway', expect.anything());
    expect(mockSetGlobalPaletteOpen).toHaveBeenCalledWith(false);

    // Frecency lands only after the agent actually opens (DOR-928), so this
    // waits for the write rather than reading straight after the click.
    await waitFor(() => expect(localStorage.getItem('dorkos:agent-frecency-v2')).not.toBeNull());
    const stored = localStorage.getItem('dorkos:agent-frecency-v2');
    const entries = JSON.parse(stored!);
    expect(entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ agentId: 'agent-2' })])
    );
  });

  // --- Feature opening ---

  /**
   * Features and quick actions are reached by TYPING now: the untyped palette
   * is Continue / Recent / New and nothing else (§15). The mocked search passes
   * everything through for a non-prefix query, so these stay about dispatch.
   */
  function searchThen(text = 'a') {
    render(<CommandPaletteDialog />);
    fireEvent.change(screen.getByPlaceholderText('Search rooms, agents, commands...'), {
      target: { value: text },
    });
  }

  it('selecting Tasks Scheduler opens tasks dialog and closes palette', () => {
    searchThen();
    const item = screen.getByText('Tasks Scheduler').closest('[data-slot="command-item"]');
    fireEvent.click(item as Element);

    expect(mockSetTasksOpen).toHaveBeenCalledWith(true);
    expect(mockSetGlobalPaletteOpen).toHaveBeenCalledWith(false);
  });

  it('selecting Connections goes to the page and closes the palette', () => {
    searchThen();
    const item = screen.getByText('Connections').closest('[data-slot="command-item"]');
    fireEvent.click(item as Element);

    expect(mockOpenConnections).toHaveBeenCalledWith('messaging');
    expect(mockSetGlobalPaletteOpen).toHaveBeenCalledWith(false);
  });

  it('selecting Mesh Network navigates to /agents and closes palette', () => {
    searchThen();
    const item = screen.getByText('Mesh Network').closest('[data-slot="command-item"]');
    fireEvent.click(item as Element);

    expect(mockNavigate).toHaveBeenCalledWith({ to: '/team' });
    expect(mockSetGlobalPaletteOpen).toHaveBeenCalledWith(false);
  });

  it('selecting Settings opens settings dialog and closes palette', () => {
    searchThen();
    const item = screen.getByText('Settings').closest('[data-slot="command-item"]');
    fireEvent.click(item as Element);

    expect(mockSetSettingsOpen).toHaveBeenCalledWith(true);
    expect(mockSetGlobalPaletteOpen).toHaveBeenCalledWith(false);
  });

  // --- Quick actions ---

  it('Bring in existing projects opens the import dialog', () => {
    searchThen();
    const item = screen
      .getByText('Bring in existing projects')
      .closest('[data-slot="command-item"]');
    fireEvent.click(item as Element);

    expect(mockImportOpen).toHaveBeenCalledTimes(1);
  });

  it('Browse Filesystem opens directory picker', () => {
    searchThen();
    const item = screen.getByText('Browse Filesystem').closest('[data-slot="command-item"]');
    fireEvent.click(item as Element);

    expect(mockSetPickerOpen).toHaveBeenCalledWith(true);
  });

  it('Toggle Theme calls setTheme with opposite theme', () => {
    mockTheme = 'dark';
    searchThen();
    const item = screen.getByText('Toggle Theme').closest('[data-slot="command-item"]');
    fireEvent.click(item as Element);

    expect(mockSetTheme).toHaveBeenCalledWith('light');
  });

  // --- Search behavior ---

  it('typing a search query reveals Commands and All Agents groups', () => {
    render(<CommandPaletteDialog />);
    const input = screen.getByPlaceholderText('Search rooms, agents, commands...');
    fireEvent.change(input, { target: { value: 'deploy' } });

    expect(screen.getByText('Commands')).toBeInTheDocument();
    expect(screen.getByText('/deploy')).toBeInTheDocument();
    expect(screen.getByText('All Agents')).toBeInTheDocument();
  });

  it('Commands group is hidden when search is empty', () => {
    render(<CommandPaletteDialog />);
    expect(screen.queryByText('Commands')).not.toBeInTheDocument();
  });

  // --- Mesh always-on (no feature flag checks) ---

  it('renders agent data without any feature flag gating', () => {
    searchThen();

    // Agents from mesh appear directly without any "mesh disabled" message
    // getAllByText used because the selected agent name also appears in the preview panel
    expect(screen.getAllByText('Frontend App').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Auth Service').length).toBeGreaterThan(0);

    // Mesh is a feature option in the palette
    expect(screen.getByText('Mesh Network')).toBeInTheDocument();

    // No disabled-state messages
    expect(screen.queryByText(/mesh.*disabled/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/enable.*mesh/i)).not.toBeInTheDocument();
  });

  // --- Empty state ---

  it('renders correctly when no agents are registered', () => {
    mockPaletteRecentAgents = [];
    mockPaletteAllAgents = [];

    searchThen();

    // Recent group should not appear (empty)
    expect(screen.queryByText('Recent')).not.toBeInTheDocument();

    // Features and Quick Actions still render for a typed query
    expect(screen.getByText('Features')).toBeInTheDocument();
    expect(screen.getByText('Quick Actions')).toBeInTheDocument();
  });

  // --- Dialog closed state ---

  it('does not render any content when palette is closed', () => {
    mockGlobalPaletteOpen = false;
    render(<CommandPaletteDialog />);

    expect(
      screen.queryByPlaceholderText('Search rooms, agents, commands...')
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Recent Agents')).not.toBeInTheDocument();
    expect(screen.queryByText('Features')).not.toBeInTheDocument();
  });

  // --- Frecency persists across re-renders ---

  it('frecency data persists in localStorage across palette close and reopen', async () => {
    // First render: select an agent via sub-menu Open Here
    const { unmount } = render(<CommandPaletteDialog />);
    const item = screen.getByText('Auth Service').closest('[data-slot="command-item"]');
    fireEvent.click(item as Element);
    fireEvent.click(screen.getByText('Open Here').closest('[data-slot="command-item"]') as Element);
    unmount();

    // Verify localStorage has data
    await waitFor(() => expect(localStorage.getItem('dorkos:agent-frecency-v2')).not.toBeNull());
    const storedBefore = localStorage.getItem('dorkos:agent-frecency-v2');
    expect(storedBefore).toBeTruthy();

    // Second render: data should still be in localStorage
    mockGlobalPaletteOpen = true;
    render(<CommandPaletteDialog />);

    const storedAfter = localStorage.getItem('dorkos:agent-frecency-v2');
    expect(storedAfter).toBe(storedBefore);
  });
});
