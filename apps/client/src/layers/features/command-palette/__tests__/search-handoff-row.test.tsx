/**
 * @vitest-environment jsdom
 *
 * ⌘K's last row, reached the way a person reaches it (P3 AC-6,
 * `specs/message-search` §8).
 *
 * `model/__tests__/search-surface.test.ts` proves the RULE. This file proves it
 * governs the DOM: the row is absent from an untyped palette, appears the
 * moment there is a question to hand across, carries the words rather than the
 * prefix that narrowed the list, and hands off GLOBALLY under a scope chip
 * while saying so. Absence asserted on its own would pass against a palette
 * that never drew the row at all, which is why both halves are here.
 *
 * Nothing about the row is stubbed. The only seam is the app store, so the
 * hand-off's one effect — opening the message-search box with those words — can
 * be observed.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import { createMockTransport } from '@dorkos/test-utils';
import type { Session } from '@dorkos/shared/types';
import { useInteractionStore } from '@/layers/entities/interactions';
import { CommandPaletteDialog } from '../ui/CommandPaletteDialog';

/** The one effect the row has: it opens the other box, holding these words. */
const openMessageSearch = vi.hoisted(() => vi.fn());

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
      openMessageSearch,
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
  openMessageSearch.mockClear();
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
      .find((el) => /^Search (all )?messages for/.test(el.textContent ?? '')) ?? null
  );
}

describe('the message-search hand-off row', () => {
  it('is not offered before anything has been typed — while the list around it is not empty', async () => {
    // The untyped palette is a command center, not a search result: there is no
    // question to hand off yet. The positive anchor keeps this from passing
    // against a palette that rendered nothing at all.
    render(<CommandPaletteDialog />);

    await waitFor(() => expect(screen.getByText('Dashboard overhaul')).toBeInTheDocument());
    expect(handoffRow()).toBeNull();
    expect(screen.queryByText(/Search messages/)).toBeNull();
  });

  it('appears the moment there is something to hand across, with the query in it', async () => {
    render(<CommandPaletteDialog />);
    type('dash');

    await waitFor(() => expect(handoffRow()).not.toBeNull());
    expect(handoffRow()).toHaveTextContent('Search messages for “dash”…');
  });

  it('tells you which key opens it', async () => {
    // The hint ships in the same commit as the binding, which is the promise
    // this row's own TSDoc made while nothing answered ⌘⇧F. A hint for a key
    // nobody bound is folklore; a binding nobody is told about is worse.
    render(<CommandPaletteDialog />);
    type('dash');

    await waitFor(() => expect(handoffRow()).not.toBeNull());
    expect(handoffRow()?.textContent).toMatch(/⌘⇧F|Ctrl⇧F/);
  });

  it('sends the words that were typed, not the prefix used to narrow the list', async () => {
    render(<CommandPaletteDialog />);
    type('#dash');

    await waitFor(() => expect(handoffRow()).not.toBeNull());
    // Both halves: what the row SAYS and what it HANDS OVER. A `#` is how a
    // person narrowed this list, and asking a message index for "#dash" would
    // find nothing — so the row said the right thing while the hand-off asked
    // the wrong question, and only the second assertion caught it.
    expect(handoffRow()).toHaveTextContent('Search messages for “dash”…');
    fireEvent.click(handoffRow() as HTMLElement);
    expect(openMessageSearch).toHaveBeenCalledWith('dash');
  });

  it('opens the search box when chosen', async () => {
    render(<CommandPaletteDialog />);
    type('dash');

    await waitFor(() => expect(handoffRow()).not.toBeNull());
    fireEvent.click(handoffRow() as HTMLElement);

    expect(openMessageSearch).toHaveBeenCalledWith('dash');
  });

  it('says “all messages” under a chip, and hands off globally', async () => {
    // Two rules composing (P3.3). Under a chip there are no prefixes —
    // everything a scope admits is a conversation, so `#` is a character in a
    // title rather than a mode switch, and `term` is the WHOLE search string.
    // And the hand-off widens to a global search on purpose, because the
    // message-search box has no scope vocabulary to carry a chip into
    // (`search-surface`) — so the row has to SAY it is widening or it reads as
    // searching inside the scope and quietly does not.
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
    expect(handoffRow()).toHaveTextContent('Search all messages for “#dash”…');
    fireEvent.click(handoffRow() as HTMLElement);
    // Exactly these words, and note what is NOT with them: the chip. Asserted
    // as the whole call so a scope argument smuggled in later has to come past
    // this line.
    expect(openMessageSearch).toHaveBeenCalledWith('#dash');
  });

  it('draws it last, below every row the ranking produced', async () => {
    render(<CommandPaletteDialog />);
    type('dash');

    await waitFor(() => expect(handoffRow()).not.toBeNull());
    const rows = screen.getAllByRole('option');
    // More than one row, or "last" says nothing.
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[rows.length - 1]).toBe(handoffRow());
  });
});
