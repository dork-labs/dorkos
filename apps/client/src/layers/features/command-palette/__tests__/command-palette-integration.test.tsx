/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import { createMockTransport } from '@dorkos/test-utils';
import { useInteractionStore } from '@/layers/entities/interactions';
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

// --- The REAL interaction store, so these are localStorage claims ---
// Nothing mocks `entities/interactions`: the palette records into the same
// durable store the sidebar reads, and that is what the frecency cases below
// assert against.

// --- Mock usePaletteItems with configurable agents ---

const mockAgents: AgentPathEntry[] = [
  { id: 'agent-1', name: 'Auth Service', projectPath: '/projects/auth' },
  { id: 'agent-2', name: 'API Gateway', projectPath: '/projects/gateway' },
  { id: 'agent-3', name: 'Frontend App', projectPath: '/projects/current' },
];

let mockPaletteRecentAgents: AgentPathEntry[] = [mockAgents[2], mockAgents[0]];
let mockPaletteAllAgents: AgentPathEntry[] = mockAgents;

/**
 * The ranking fields of a corpus row with no history behind it.
 *
 * Every row has to answer them — required, so a new kind of palette item cannot
 * arrive silently unranked — and this file's claims are about dispatch, not
 * about order.
 */
const unranked = {
  usageKey: null,
  lastActivityAt: null,
  waiting: false,
  demoted: false,
} as const;

vi.mock('../model/use-palette-items', () => ({
  usePaletteItems: () => {
    const features = [
      { id: 'tasks', label: 'Scheduled tasks', icon: 'Clock', action: 'openTasks' },
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
      allAgents: mockPaletteAllAgents,
      features,
      commands,
      quickActions,
      // The corpus the REAL search and ranking read — `usePaletteSearch` is not
      // mocked here, so what a typed query shows is decided by the code that
      // ships rather than by a passthrough stub.
      searchableItems: [
        ...mockPaletteAllAgents.map((a: AgentPathEntry) => ({
          id: a.id,
          name: a.name,
          type: 'agent',
          keywords: [a.projectPath],
          ...unranked,
          data: a,
        })),
        ...features.map((f) => ({
          id: f.id,
          name: f.label,
          type: 'feature',
          ...unranked,
          data: f,
        })),
        ...commands.map((c) => ({
          id: `cmd-${c.name}`,
          name: c.name,
          type: 'command',
          ...unranked,
          data: c,
        })),
        ...quickActions.map((q) => ({
          id: q.id,
          name: q.label,
          type: 'quick-action',
          ...unranked,
          data: q,
        })),
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
    // `motion.create(Component)` — needed because this mock SHADOWS the complete
    // one in `test-setup.ts`, and a partial shadow breaks the moment anything in
    // the import graph calls it at module scope (`gen-ui/ui/nodes/TableNode.tsx`
    // does). Identity is enough: nothing here renders the wrapped component.
    create: (Component: unknown) => Component,
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

/**
 * What the durable store has recorded, read back from the store itself.
 *
 * The store is a module singleton that hydrated once when this file was
 * imported, so clearing `localStorage` does not empty it — the `reset()` in
 * `beforeEach` is what does, and these read the state that write goes to.
 */
const storedCounts = () => useInteractionStore.getState().counts;
const storedOpened = () => useInteractionStore.getState().opened;

describe('Command Palette Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useInteractionStore.getState().reset();
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

    // And record the open in the durable store, keyed by DIRECTORY.
    // Frecency lands only after the agent actually opens (DOR-928), so this
    // waits for the write rather than reading straight after the click.
    await waitFor(() => expect(storedCounts()['agent:/projects/auth']).toBe(1));
    expect(storedOpened()['agent:/projects/auth']).toBeDefined();
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

    // Frecency recorded for the active agent's own directory.
    // Frecency lands only after the agent actually opens (DOR-928), so this
    // waits for the write rather than reading straight after the click.
    await waitFor(() => expect(storedCounts()['agent:/projects/current']).toBe(1));
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
    await waitFor(() => expect(storedCounts()['agent:/projects/auth']).toBe(2));
  });

  // --- @ prefix mode ---

  it('entering @ shows the Agents group and hides every other kind', () => {
    render(<CommandPaletteDialog />);
    const input = screen.getByPlaceholderText('Search rooms, agents, commands...');
    fireEvent.change(input, { target: { value: '@' } });

    expect(screen.getByText('Agents')).toBeInTheDocument();

    // `@` is a scope, so the kinds it does not address are gone entirely —
    // the ranking cannot bring back a row the prefix filtered out.
    expect(screen.queryByText('Recent')).not.toBeInTheDocument();
    expect(screen.queryByText('Actions')).not.toBeInTheDocument();
    expect(screen.queryByText('Commands')).not.toBeInTheDocument();
  });

  it('@ followed by agent name still shows the Agents group', () => {
    render(<CommandPaletteDialog />);
    const input = screen.getByPlaceholderText('Search rooms, agents, commands...');
    fireEvent.change(input, { target: { value: '@auth' } });

    expect(screen.getByText('Agents')).toBeInTheDocument();
    expect(screen.queryByText('Actions')).not.toBeInTheDocument();
  });

  it('selecting an agent from search mode opens sub-menu; Open Here records frecency and sets dir', async () => {
    render(<CommandPaletteDialog />);
    const input = screen.getByPlaceholderText('Search rooms, agents, commands...');

    // Type a search query that matches an agent via cmdk's fuzzy filter
    fireEvent.change(input, { target: { value: 'API Gateway' } });

    // The Agents group appears when searching
    expect(screen.getByText('Agents')).toBeInTheDocument();

    // Click the agent to open sub-menu. `getAllByText` because the real search
    // highlights the matched run — the name is drawn once inside a `<mark>` on
    // the row and once plainly in the preview panel beside it.
    const item = screen.getAllByText('API Gateway')[0].closest('[data-slot="command-item"]');
    fireEvent.click(item as Element);

    // Sub-menu should appear; click Open Here to complete the switch
    const openHereItem = screen.getByText('Open Here').closest('[data-slot="command-item"]');
    fireEvent.click(openHereItem as Element);

    expect(mockSetDir).toHaveBeenCalledWith('/projects/gateway', expect.anything());
    expect(mockSetGlobalPaletteOpen).toHaveBeenCalledWith(false);

    // Frecency lands only after the agent actually opens (DOR-928), so this
    // waits for the write rather than reading straight after the click.
    await waitFor(() => expect(storedCounts()['agent:/projects/gateway']).toBe(1));
  });

  // --- Feature opening ---

  /**
   * Features and quick actions are reached by TYPING now: the untyped palette
   * is Continue / Recent / New and nothing else (§15). Each case types the name
   * of the row it is about, the way a person does — search and ranking are the
   * real ones here, so a query that happened to match everything would let a row
   * be found by luck rather than by what was typed.
   */
  function searchThen(text: string) {
    render(<CommandPaletteDialog />);
    fireEvent.change(screen.getByPlaceholderText('Search rooms, agents, commands...'), {
      target: { value: text },
    });
  }

  it('selecting Scheduled tasks opens tasks dialog and closes palette', () => {
    searchThen('Scheduled tasks');
    const item = screen.getByText('Scheduled tasks').closest('[data-slot="command-item"]');
    fireEvent.click(item as Element);

    expect(mockSetTasksOpen).toHaveBeenCalledWith(true);
    expect(mockSetGlobalPaletteOpen).toHaveBeenCalledWith(false);
  });

  it('selecting Connections goes to the page and closes the palette', () => {
    searchThen('Connections');
    const item = screen.getByText('Connections').closest('[data-slot="command-item"]');
    fireEvent.click(item as Element);

    expect(mockOpenConnections).toHaveBeenCalledWith('messaging');
    expect(mockSetGlobalPaletteOpen).toHaveBeenCalledWith(false);
  });

  it('selecting Mesh Network navigates to /agents and closes palette', () => {
    searchThen('Mesh Network');
    const item = screen.getByText('Mesh Network').closest('[data-slot="command-item"]');
    fireEvent.click(item as Element);

    expect(mockNavigate).toHaveBeenCalledWith({ to: '/team' });
    expect(mockSetGlobalPaletteOpen).toHaveBeenCalledWith(false);
  });

  it('selecting Settings opens settings dialog and closes palette', () => {
    searchThen('Settings');
    const item = screen.getByText('Settings').closest('[data-slot="command-item"]');
    fireEvent.click(item as Element);

    expect(mockSetSettingsOpen).toHaveBeenCalledWith(true);
    expect(mockSetGlobalPaletteOpen).toHaveBeenCalledWith(false);
  });

  // --- Quick actions ---

  it('Bring in existing projects opens the import dialog', () => {
    searchThen('Bring in existing projects');
    const item = screen
      .getByText('Bring in existing projects')
      .closest('[data-slot="command-item"]');
    fireEvent.click(item as Element);

    expect(mockImportOpen).toHaveBeenCalledTimes(1);
  });

  it('Browse Filesystem opens directory picker', () => {
    searchThen('Browse Filesystem');
    const item = screen.getByText('Browse Filesystem').closest('[data-slot="command-item"]');
    fireEvent.click(item as Element);

    expect(mockSetPickerOpen).toHaveBeenCalledWith(true);
  });

  it('Toggle Theme calls setTheme with opposite theme', () => {
    mockTheme = 'dark';
    searchThen('Toggle Theme');
    const item = screen.getByText('Toggle Theme').closest('[data-slot="command-item"]');
    fireEvent.click(item as Element);

    expect(mockSetTheme).toHaveBeenCalledWith('light');
  });

  // --- Search behavior ---

  it('typing a search query reveals the Commands group', () => {
    render(<CommandPaletteDialog />);
    const input = screen.getByPlaceholderText('Search rooms, agents, commands...');
    fireEvent.change(input, { target: { value: 'deploy' } });

    expect(screen.getByText('Commands')).toBeInTheDocument();
    expect(screen.getByText('/deploy')).toBeInTheDocument();
  });

  it('Commands group is hidden when search is empty', () => {
    render(<CommandPaletteDialog />);
    expect(screen.queryByText('Commands')).not.toBeInTheDocument();
  });

  // --- Mesh always-on (no feature flag checks) ---

  it('renders agent data without any feature flag gating', () => {
    // `@` scopes to agents, so every registered agent is on screen at once —
    // which is the claim, and it does not depend on any one name matching a
    // query. getAllByText because the highlighted agent's name also appears in
    // the preview panel.
    render(<CommandPaletteDialog />);
    fireEvent.change(screen.getByPlaceholderText('Search rooms, agents, commands...'), {
      target: { value: '@' },
    });

    expect(screen.getAllByText('Frontend App').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Auth Service').length).toBeGreaterThan(0);
    expect(screen.getAllByText('API Gateway').length).toBeGreaterThan(0);

    // No disabled-state messages
    expect(screen.queryByText(/mesh.*disabled/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/enable.*mesh/i)).not.toBeInTheDocument();
  });

  // --- Empty state ---

  it('renders correctly when no agents are registered', () => {
    mockPaletteRecentAgents = [];
    mockPaletteAllAgents = [];

    searchThen('Settings');

    // Recent group should not appear (empty)
    expect(screen.queryByText('Recent')).not.toBeInTheDocument();

    // Actions still answer a typed query with no agents anywhere.
    expect(screen.getByText('Actions')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
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
    await waitFor(() => expect(localStorage.getItem('dorkos:interactions-v1')).not.toBeNull());
    const storedBefore = localStorage.getItem('dorkos:interactions-v1');
    expect(storedBefore).toContain('agent:/projects/auth');

    // Second render: data should still be in localStorage
    mockGlobalPaletteOpen = true;
    render(<CommandPaletteDialog />);

    const storedAfter = localStorage.getItem('dorkos:interactions-v1');
    expect(storedAfter).toBe(storedBefore);
  });
});
