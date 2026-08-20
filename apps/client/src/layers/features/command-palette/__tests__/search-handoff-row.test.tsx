/**
 * @vitest-environment jsdom
 *
 * ⌘K's last row, reached the way a person reaches it (P3 AC-6).
 *
 * `model/__tests__/search-surface.test.ts` proves the RULE. This file proves it
 * governs the DOM: with the cockpit's real route registry the row is absent —
 * not disabled, not a placeholder, absent — and with a search surface added to
 * that registry the same palette grows the row, with the words that were typed
 * in it. Absence asserted on its own would pass against a palette that never
 * drew the row at all, which is why both halves are here.
 *
 * Only the registry is seeded. The gate, the row, the page and the dialog are
 * all the shipped ones.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import { createMockTransport } from '@dorkos/test-utils';
import type { Session } from '@dorkos/shared/types';
import { useInteractionStore } from '@/layers/entities/interactions';
import { SEARCH_SURFACE_PATH } from '../model/search-surface';
import { CommandPaletteDialog } from '../ui/CommandPaletteDialog';

/**
 * The routes this cockpit is pretending to serve, on top of the real ones.
 *
 * Hoisted so the module mock below can close over it, and read fresh on every
 * call — the gate asks the registry per keystroke, so a test can hand it a
 * cockpit that grew a search page.
 */
const extraRoutes = vi.hoisted(() => ({ paths: [] as string[] }));

const openLink = vi.hoisted(() => vi.fn());

vi.mock('@/layers/shared/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/lib')>();
  return {
    ...actual,
    get APP_ROUTE_PATHS() {
      return [...actual.APP_ROUTE_PATHS, ...extraRoutes.paths];
    },
    openLink,
  };
});

// --- Fixtures ---

const AGENTS = [{ id: 'agent-dash', name: 'Dashboards', projectPath: '/projects/dash' }];

const session: Session = {
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Dashboard overhaul',
  createdAt: '2026-08-09T09:00:00.000Z',
  updatedAt: '2026-08-09T10:00:00.000Z',
  permissionMode: 'default',
  runtime: 'claude-code',
  cwd: '/projects/dash',
};

const mockTransport = createMockTransport();
const mockNavigate = vi.fn();

function render(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

globalThis.ResizeObserver = vi.fn().mockImplementation(function () {
  return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
});
Element.prototype.scrollIntoView = vi.fn();

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mockNavigate }));

vi.mock('@/layers/shared/model', () => ({
  useTransport: () => mockTransport,
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      globalPaletteOpen: true,
      setGlobalPaletteOpen: vi.fn(),
      toggleGlobalPalette: vi.fn(),
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
  useReportIssue: () => vi.fn(),
  useFeedbackDialogStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = { openFeedback: vi.fn() };
    return selector ? selector(state) : state;
  },
  useIsMobile: () => false,
  useNow: () => Date.now(),
  useSlotContributions: () => [],
  useSettingsDeepLink: () => ({ open: vi.fn(), close: vi.fn() }),
  useTasksDeepLink: () => ({ open: vi.fn(), close: vi.fn() }),
  useOpenConnections: () => vi.fn(),
  useAgentCreationStore: Object.assign(() => ({ open: vi.fn() }), {
    getState: () => ({ open: vi.fn() }),
  }),
  useImportProjectsStore: Object.assign(() => ({ open: vi.fn() }), {
    getState: () => ({ open: vi.fn() }),
  }),
}));

vi.mock('@/layers/entities/mesh', () => ({
  useMeshAgentPaths: () => ({ data: { agents: AGENTS }, isLoading: false }),
}));

vi.mock('@/layers/entities/command', () => ({ useCommands: () => ({ data: { commands: [] } }) }));

vi.mock('@/layers/entities/tasks', () => ({
  useActiveTaskRunCount: () => ({ data: undefined }),
}));

vi.mock('@/layers/entities/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session')>()),
  useDirectoryState: () => ['/projects/dash', vi.fn()],
  useSessions: () => ({ sessions: [] }),
}));

vi.mock('../model/use-preview-data', () => ({
  usePreviewData: () => ({ sessionCount: 0, recentSessions: [], health: null }),
}));

vi.mock('@/layers/features/profile', () => ({
  PROFILE_PANEL_ID: 'profile',
  useProfileStore: Object.assign(() => ({}), {
    getState: () => ({ openProfileDocked: vi.fn() }),
  }),
}));

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

beforeEach(() => {
  extraRoutes.paths = [];
  openLink.mockClear();
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
  vi.mocked(mockTransport.listRooms).mockResolvedValue([]);
  vi.mocked(mockTransport.listRecentSessions).mockResolvedValue({
    sessions: [session],
    agentActivity: {},
    warnings: [],
  });
  mockNavigate.mockClear();
  localStorage.clear();
  useInteractionStore.getState().reset();
});

afterEach(cleanup);

const searchInput = () => screen.getByTestId('command-palette-input');
const type = (value: string) => fireEvent.change(searchInput(), { target: { value } });

/** The hand-off row, or `null`. Matched on the phrase, across its child spans. */
function handoffRow(): HTMLElement | null {
  return (
    screen
      .queryAllByRole('option')
      .find((el) => (el.textContent ?? '').startsWith('Search messages for')) ?? null
  );
}

describe('the message-search hand-off row', () => {
  it('is absent from a cockpit with no such surface — while the list around it is not', async () => {
    render(<CommandPaletteDialog />);
    type('dash');

    // The positive anchor: results for this query DID arrive, so the absence
    // below is about the hand-off row rather than about an empty palette.
    await waitFor(() => expect(screen.getByText('Dashboard overhaul')).toBeInTheDocument());
    expect(handoffRow()).toBeNull();
    // Nor as a disabled row, a placeholder, or a heading over nothing.
    expect(screen.queryByText(/Search messages/)).toBeNull();
  });

  it('appears by itself when the cockpit starts serving one, with the query in it', async () => {
    extraRoutes.paths = [SEARCH_SURFACE_PATH];
    render(<CommandPaletteDialog />);
    type('dash');

    await waitFor(() => expect(handoffRow()).not.toBeNull());
    expect(handoffRow()).toHaveTextContent('Search messages for “dash”…');
  });

  it('sends the words that were typed, not the prefix used to narrow the list', async () => {
    extraRoutes.paths = [SEARCH_SURFACE_PATH];
    render(<CommandPaletteDialog />);
    type('#dash');

    await waitFor(() => expect(handoffRow()).not.toBeNull());
    // Both halves: what the row SAYS and where it GOES. A `#` is how a person
    // narrowed this list, and asking a message index for "#dash" would find
    // nothing — so the row said the right thing while the link asked the wrong
    // question, and only this second assertion caught it.
    expect(handoffRow()).toHaveTextContent('Search messages for “dash”…');
    fireEvent.click(handoffRow() as HTMLElement);
    expect(openLink).toHaveBeenCalledWith('/search?q=dash');
  });

  it('leaves for the surface when chosen', async () => {
    extraRoutes.paths = [SEARCH_SURFACE_PATH];
    render(<CommandPaletteDialog />);
    type('dash');

    await waitFor(() => expect(handoffRow()).not.toBeNull());
    fireEvent.click(handoffRow() as HTMLElement);

    expect(openLink).toHaveBeenCalledWith('/search?q=dash');
  });

  it('is not offered before anything has been typed', async () => {
    // The untyped palette is a command center, not a search result — there is
    // no question to hand off yet.
    extraRoutes.paths = [SEARCH_SURFACE_PATH];
    render(<CommandPaletteDialog />);

    await waitFor(() => expect(screen.getByText('Dashboard overhaul')).toBeInTheDocument());
    expect(handoffRow()).toBeNull();
  });

  it('treats a `#` inside a scope as a character, because the chip already fixed the kind', async () => {
    // The one place this row composes with somebody else's rule (P3.3): under a
    // chip there are no prefixes — everything a scope admits is a conversation,
    // so `#` is a character in a title rather than a mode switch. Verified by
    // execution, not assumed: the hand-off reads `term`, and under a chip
    // `term` is the WHOLE search string, `#` included. Asking a message index
    // for "dash" when the person typed "#dash" inside a scope would be dropping
    // a character they meant.
    extraRoutes.paths = [SEARCH_SURFACE_PATH];
    render(<CommandPaletteDialog />);

    // Pick up a chip the way a person does: type enough of the agent's name,
    // put the highlight on its row, press Tab.
    type('@dash');
    await waitFor(() => expect(screen.getByText('Dashboards')).toBeInTheDocument());
    const agentRow = screen
      .getAllByRole('option')
      .find((el) => (el.textContent ?? '').includes('Dashboards')) as HTMLElement;
    fireEvent.mouseMove(agentRow);
    fireEvent.mouseEnter(agentRow);
    await waitFor(() => expect(agentRow.getAttribute('data-selected')).toBe('true'));
    fireEvent.keyDown(searchInput(), { key: 'Tab', bubbles: true });
    await screen.findByTestId('palette-scope-chip');

    type('#dash');

    await waitFor(() => expect(handoffRow()).not.toBeNull());
    expect(handoffRow()).toHaveTextContent('Search messages for “#dash”…');
    fireEvent.click(handoffRow() as HTMLElement);
    // Exactly this href, and note what is NOT in it: the chip. The hand-off
    // widens to a global search on purpose — the search surface has no scope
    // vocabulary to carry a chip into (`search-surface`). Asserted as the whole
    // string so a scope parameter smuggled in later has to come past this line.
    expect(openLink).toHaveBeenCalledWith('/search?q=%23dash');
  });

  it('draws it last, below every row the ranking produced', async () => {
    extraRoutes.paths = [SEARCH_SURFACE_PATH];
    render(<CommandPaletteDialog />);
    type('dash');

    await waitFor(() => expect(handoffRow()).not.toBeNull());
    const rows = screen.getAllByRole('option');
    // More than one row, or "last" says nothing.
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[rows.length - 1]).toBe(handoffRow());
  });
});
