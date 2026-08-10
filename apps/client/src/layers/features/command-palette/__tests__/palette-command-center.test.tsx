/**
 * @vitest-environment jsdom
 *
 * ⌘K as a front door for recall (spec `sidebar-now-today-library` P3, §15).
 *
 * Everything here runs the REAL assembly — `usePaletteItems`, the real Fuse
 * search, the real session-list store. Only the transport, the router and the
 * three stores that would reach outside the palette are stubbed, because the
 * claims are about what the palette makes of real data: which groups it draws
 * and in what order, what a row says a conversation is doing, and what a
 * conversation may be found by.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import { createMockTransport } from '@dorkos/test-utils';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import type { Session } from '@dorkos/shared/types';
import { ROW_TITLE_CLASS, ROW_WHO_CLASS } from '@/layers/shared/lib/row-grammar';
import { TooltipProvider } from '@/layers/shared/ui';
import { useSessionListStore } from '@/layers/entities/session';
import { CommandPaletteDialog } from '../ui/CommandPaletteDialog';

// --- Fixtures ---

const ACTIVE_CWD = '/projects/dorkos';

const dorkos: AgentPathEntry = { id: 'agent-dorkos', name: 'DorkOS', projectPath: ACTIVE_CWD };
const warden: AgentPathEntry = {
  id: 'agent-warden',
  name: 'Warden',
  projectPath: '/projects/warden',
};

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    title: 'Dashboard overhaul',
    createdAt: '2026-08-09T09:00:00.000Z',
    updatedAt: '2026-08-09T10:00:00.000Z',
    permissionMode: 'default',
    runtime: 'claude-code',
    cwd: ACTIVE_CWD,
    ...overrides,
  };
}

/**
 * The one conversation whose title is the ONLY text in the whole corpus that
 * matches "zanzibar" — no agent, no room, no command, no directory does.
 */
const zanzibar = makeSession({
  id: '00000000-0000-4000-8000-0000000000aa',
  title: 'Zanzibar migration',
  cwd: '/projects/warden',
  updatedAt: '2026-08-09T08:00:00.000Z',
});

const live = makeSession({
  id: '00000000-0000-4000-8000-0000000000bb',
  title: 'Palette rewrite',
  updatedAt: '2026-08-09T11:00:00.000Z',
});

const room: RoomSummary = {
  id: 'room-general',
  kind: 'channel',
  slug: 'general',
  title: 'General',
  topic: null,
  workspaceId: null,
  archived: false,
  ambientMaxEntries: 30,
  createdAt: '2026-08-01T10:00:00.000Z',
  lastActivityAt: '2026-08-09T07:00:00.000Z',
  unreadCount: 0,
  participants: null,
};

// --- Mocks ---

const mockTransport = createMockTransport();
const mockNavigate = vi.fn();
const mockStartNewSession = vi.fn();
const mockSetGlobalPaletteOpen = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useTransport: () => mockTransport,
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      globalPaletteOpen: true,
      setGlobalPaletteOpen: mockSetGlobalPaletteOpen,
      setPickerOpen: vi.fn(),
      setCanvasOpen: vi.fn(),
      setRightPanelOpen: vi.fn(),
      setActiveRightPanelTab: vi.fn(),
      setPreviousCwd: vi.fn(),
      previousCwd: null,
      globalPaletteInitialSearch: null,
      clearGlobalPaletteInitialSearch: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
  useIsMobile: () => false,
  useSettingsDeepLink: () => ({ open: vi.fn(), close: vi.fn() }),
  useTasksDeepLink: () => ({ open: vi.fn(), close: vi.fn() }),
  useOpenConnections: () => vi.fn(),
  useFeedbackDialogStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = { openFeedback: vi.fn() };
    return selector ? selector(state) : state;
  },
  useAgentCreationStore: Object.assign(() => ({ open: vi.fn() }), {
    getState: () => ({ open: vi.fn() }),
  }),
  useImportProjectsStore: Object.assign(() => ({ open: vi.fn() }), {
    getState: () => ({ open: vi.fn() }),
  }),
  // The cockpit's own creation actions, so the "New" group has its two rows.
  useSlotContributions: () => [
    {
      id: 'new-session',
      label: 'New Session',
      icon: 'Plus',
      action: 'newSession',
      category: 'quick-action',
      priority: 1,
    },
    {
      id: 'create-agent',
      label: 'Create Agent',
      icon: 'Plus',
      action: 'createAgent',
      category: 'quick-action',
      priority: 2,
    },
    {
      id: 'settings',
      label: 'Settings',
      icon: 'Settings',
      action: 'openSettings',
      category: 'feature',
      priority: 1,
    },
  ],
}));

vi.mock('@/layers/entities/mesh', () => ({
  useMeshAgentPaths: () => ({ data: { agents: [dorkos, warden] }, isLoading: false }),
}));

vi.mock('@/layers/entities/command', () => ({
  useCommands: () => ({ data: { commands: [] } }),
}));

vi.mock('@/layers/entities/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session')>()),
  useDirectoryState: () => [ACTIVE_CWD, vi.fn()],
  useSessions: () => ({ sessions: [] }),
  useStartNewSession: () => mockStartNewSession,
}));

vi.mock('../model/use-agent-frecency', () => ({
  useAgentFrecency: () => ({
    entries: [],
    recordUsage: vi.fn(),
    getSortedAgentIds: (ids: string[]) => ids,
  }),
}));

vi.mock('../model/use-preview-data', () => ({
  usePreviewData: () => ({ sessionCount: 0, recentSessions: [], health: null }),
}));

vi.mock('@/layers/features/agent-hub', () => ({
  useAgentHubStore: Object.assign(() => ({}), { getState: () => ({ openHub: vi.fn() }) }),
}));

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

// jsdom implements neither, and cmdk needs both.
globalThis.ResizeObserver = vi.fn().mockImplementation(function () {
  return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
});
Element.prototype.scrollIntoView = vi.fn();

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return rtlRender(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <CommandPaletteDialog />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

/** Seed the recent-session window the palette asks the server for. */
function seedSessions(sessions: Session[], agentActivity: Record<string, string> = {}) {
  vi.mocked(mockTransport.listRecentSessions).mockResolvedValue({
    sessions,
    agentActivity,
    warnings: [],
  });
}

/** Seed the fleet-wide live stream — what makes a conversation a Continue row. */
function seedLive(statuses: Record<string, { lifecycle: string; activity?: unknown }>) {
  useSessionListStore.setState({ statuses: statuses as never });
}

const searchInput = () => screen.getByTestId('command-palette-input');
const type = (value: string) => fireEvent.change(searchInput(), { target: { value } });

/** Every group heading, in the order the list draws them. */
const headings = () =>
  Array.from(document.querySelectorAll('[cmdk-group-heading]')).map((el) => el.textContent);

/** The palette row carrying `text`. */
const rowFor = (text: string) => screen.getByText(text).closest('[role="option"]') as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  useSessionListStore.setState({ statuses: {}, sessions: {} });
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
  vi.mocked(mockTransport.listRooms).mockResolvedValue([room]);
  seedSessions([makeSession()]);
});

afterEach(cleanup);

describe('the zero-query command center', () => {
  it('draws exactly Continue, Recent and New, in that order, closed by the prefix legend', async () => {
    seedLive({ [live.id]: { lifecycle: 'streaming' } });
    seedSessions([live, makeSession()]);

    render();
    await screen.findByText('Palette rewrite');

    expect(headings()).toEqual(['Continue', 'Recent', 'New']);
    // The legend is not a group and not a row — it closes the list.
    expect(screen.getByText('agents and DMs')).toBeInTheDocument();
  });

  it('draws no Continue group at all when nothing is live', async () => {
    render();
    await screen.findByText('Dashboard overhaul');

    expect(headings()).not.toContain('Continue');
    // Zero DOM, not an empty box: no heading anywhere carries the word.
    expect(screen.queryByText('Continue')).not.toBeInTheDocument();
  });

  it('offers the cockpit’s creation actions under New', async () => {
    render();
    await screen.findByText('Dashboard overhaul');

    expect(screen.getByText('New Session')).toBeInTheDocument();
    expect(screen.getByText('Create Agent')).toBeInTheDocument();
  });
});

describe('the verb on a Continue row (BC-37)', () => {
  it('names the tool when the conversation is on one it recognizes', async () => {
    seedLive({
      [live.id]: {
        lifecycle: 'streaming',
        activity: { toolName: 'Edit', target: 'strip-state.ts' },
      },
    });
    seedSessions([live]);

    render();

    expect(await screen.findByText('Editing strip-state.ts…')).toBeInTheDocument();
  });

  it('says only "Working…" when the server has sent no tool at all', async () => {
    seedLive({ [live.id]: { lifecycle: 'streaming' } });
    seedSessions([live]);

    render();

    expect(await screen.findByText('Working…')).toBeInTheDocument();
  });

  it('says "waiting on you" when the conversation is blocked', async () => {
    seedLive({ [live.id]: { lifecycle: 'blocked' } });
    seedSessions([live]);

    render();

    expect(await screen.findByText('waiting on you')).toBeInTheDocument();
  });

  it('says nothing at all about an idle conversation', async () => {
    // Not a different verb — no second line. A row that keeps talking about a
    // turn that ended is the lie the ladder exists to prevent.
    //
    // The lifecycle is seeded rather than left absent, and that is the whole
    // difference between this case and "the store happens to be empty": with no
    // status at all, deleting the Continue filter still leaves nothing to draw
    // and this passes for a reason that has nothing to do with the ladder.
    seedLive({ [live.id]: { lifecycle: 'idle' } });
    seedSessions([live]);

    render();
    await screen.findByText('Palette rewrite');

    // No verb, from either end of the ladder's silence…
    expect(screen.queryByText('Working…')).not.toBeInTheDocument();
    expect(screen.queryByText('waiting on you')).not.toBeInTheDocument();
    // …and no Continue row either. The two are separate claims: the ladder
    // silences an idle session's verb, and the Continue filter keeps it out of
    // the group in the first place. Asserting only the first leaves the second
    // free to break — an idle row would join Continue, say nothing, and look
    // exactly like a passing test.
    expect(headings()).not.toContain('Continue');
  });
});

describe('a conversation row', () => {
  it('reads `Agent › title`, with the whole line in its tooltip', async () => {
    render();
    await screen.findByText('Dashboard overhaul');

    const row = rowFor('Dashboard overhaul');
    expect(row).toHaveAttribute('title', 'DorkOS › Dashboard overhaul');
    expect(screen.getByText('DorkOS')).toBeInTheDocument();
  });

  it('spends the sidebar’s own truncation budget, not one of its own', async () => {
    render();
    await screen.findByText('Dashboard overhaul');

    // The classes come from `row-grammar.ts`; the CSS they resolve to is
    // asserted from computed style in the browser test (BC-25), which is the
    // only place a layout exists at all.
    expect(screen.getByText('DorkOS')).toHaveAttribute('class', ROW_WHO_CLASS);
    expect(screen.getByText('Dashboard overhaul')).toHaveAttribute('class', ROW_TITLE_CLASS);
  });

  it('marks where an automated conversation came from', async () => {
    seedSessions([makeSession({ origin: 'task', originLabel: 'Scheduled task · daily-digest' })]);

    render();
    // The conversation is automated, so it takes no Recent row — but it stays
    // findable, and the row it gets when found says where it came from.
    await waitFor(() => expect(searchInput()).toBeInTheDocument());
    type('Dashboard');

    expect(await screen.findByLabelText('Origin: Scheduled task · daily-digest')).toBeVisible();
  });

  it('draws no origin mark on a conversation you started yourself', async () => {
    render();
    await screen.findByText('Dashboard overhaul');

    // Unmarked is you; marked is something that happened without you (BC-26).
    expect(screen.queryByLabelText(/^Origin:/)).not.toBeInTheDocument();
  });
});

describe('finding a conversation by name (P3 AC-1)', () => {
  it('typing a session title finds the session', async () => {
    seedSessions([zanzibar, makeSession()]);

    render();
    await screen.findByText('Dashboard overhaul');

    // "zanzibar" appears in no agent name, no room, no command and no
    // directory — the title is the only text in the corpus that matches.
    type('zanzibar');

    const row = await screen.findByText('Zanzibar migration');
    expect(row.closest('[role="option"]')).toBeInTheDocument();
    expect(headings()).toContain('Conversations');
  });

  it('finds nothing by that name before the conversation exists', async () => {
    // The same query against a corpus without it — so the case above is the
    // title matching, and not the palette showing everything it has.
    seedSessions([makeSession()]);

    render();
    await screen.findByText('Dashboard overhaul');

    type('zanzibar');

    await waitFor(() => expect(screen.queryByText('Zanzibar migration')).not.toBeInTheDocument());
    expect(headings()).not.toContain('Conversations');
  });
});

describe('acting on the row under the highlight', () => {
  it('opens the conversation in its OWN directory, not the one on screen', async () => {
    seedSessions([zanzibar]);

    render();
    const row = await screen.findByText('Zanzibar migration');
    fireEvent.click(row.closest('[role="option"]') as Element);

    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      // `/projects/warden`, though the palette was opened from `/projects/dorkos`.
      search: { session: zanzibar.id, dir: '/projects/warden' },
    });
  });

  it('⌘↵ starts a NEW conversation with that agent instead of opening this one', async () => {
    seedSessions([zanzibar]);

    render();
    await screen.findByText('Zanzibar migration');
    // cmdk highlights the first row on its own; assert that before acting on it.
    await waitFor(() =>
      expect(rowFor('Zanzibar migration')).toHaveAttribute('aria-selected', 'true')
    );

    fireEvent.keyDown(searchInput(), { key: 'Enter', metaKey: true });

    expect(mockStartNewSession).toHaveBeenCalledWith('/projects/warden');
    // And it did NOT open the existing one.
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockSetGlobalPaletteOpen).toHaveBeenCalledWith(false);
  });

  it('shows both shortcuts on the highlighted row, and on no other', async () => {
    // Two conversations. `Dashboard overhaul` is the more recent, so Recent
    // leads with it and cmdk highlights it.
    seedSessions([zanzibar, makeSession()]);

    render();
    await screen.findByText('Zanzibar migration');
    await waitFor(() =>
      expect(rowFor('Dashboard overhaul')).toHaveAttribute('aria-selected', 'true')
    );

    // One row is highlighted, so exactly one row carries the pair.
    expect(screen.getAllByText('↵')).toHaveLength(1);
    expect(screen.getAllByText('⌘↵')).toHaveLength(1);
    expect(rowFor('Dashboard overhaul')).toHaveTextContent('↵');
    expect(rowFor('Zanzibar migration')).not.toHaveTextContent('↵');
  });
});
