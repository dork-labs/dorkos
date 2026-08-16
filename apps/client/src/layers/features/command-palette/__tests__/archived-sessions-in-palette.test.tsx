/**
 * @vitest-environment jsdom
 *
 * A conversation that left Today says so, and sits under one that did not
 * (P3 AC-5).
 *
 * `palette-sessions.test.ts` proves the RULE against a fixed boundary. This
 * file proves it is CONNECTED: the real recent-sessions query, the real corpus
 * assembly, the real day boundary, the real Fuse and the real ranker, through a
 * mock `Transport`, ending at the label and the order of rows in the DOM.
 *
 * **The clock is held still on purpose.** `useNow` is pinned to noon local, so
 * the 4am boundary these fixtures straddle is the same one whatever hour the
 * suite runs at — a "one hour ago" row would genuinely be archived if the suite
 * started at 04:30.
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

// --- The clock, and the day it sits in ---

/** Noon local today — far from the boundary in both directions. */
const NOW = (() => {
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  return noon.getTime();
})();

/** A local hour today, as the ISO string the wire carries. */
function todayAt(hour: number): string {
  const at = new Date(NOW);
  at.setHours(hour, 0, 0, 0);
  return at.toISOString();
}

/** A local hour YESTERDAY — before the 4am boundary this morning. */
function yesterdayAt(hour: number): string {
  const at = new Date(NOW);
  at.setDate(at.getDate() - 1);
  at.setHours(hour, 0, 0, 0);
  return at.toISOString();
}

// --- Fixtures ---

const AGENTS = [
  { id: 'agent-tangerines', name: 'Tangerines', projectPath: '/projects/tangerines' },
  { id: 'agent-blueberries', name: 'Blueberries', projectPath: '/projects/blueberries' },
];

function makeSession(overrides: Partial<Session> & { id: string }): Session {
  return {
    title: 'Design airtight box',
    createdAt: yesterdayAt(9),
    updatedAt: todayAt(11),
    permissionMode: 'default',
    runtime: 'claude-code',
    ...overrides,
  };
}

/**
 * Two conversations with the SAME title, so Fuse scores them identically and
 * only time can separate them.
 *
 * The ids are chosen so the ranker's deterministic tiebreak — the row key,
 * ascending — puts the archived one FIRST when scores are equal. That is what
 * makes the ordering claim below fail rather than pass by luck if the recency
 * signal ever stops applying: with the weight zeroed, these two rows tie, and
 * the tie resolves the wrong way round.
 */
const archivedSession = makeSession({
  id: '00000000-0000-4000-8000-00000000000a',
  cwd: '/projects/tangerines',
  updatedAt: yesterdayAt(20),
});

const liveSession = makeSession({
  id: 'ffffffff-0000-4000-8000-00000000000f',
  cwd: '/projects/blueberries',
  updatedAt: todayAt(11),
});

// --- Ports ---

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
  // Pinned, not `Date.now()`: the boundary these fixtures straddle has to be
  // the same one at 04:30 in the morning as at noon.
  useNow: () => NOW,
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
  useDirectoryState: () => ['/projects/tangerines', vi.fn()],
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
    sessions: [archivedSession, liveSession],
    agentActivity: {},
    warnings: [],
  });
  mockNavigate.mockClear();
  localStorage.clear();
  useInteractionStore.getState().reset();
});

afterEach(cleanup);

// --- Helpers ---

const searchInput = () => screen.getByTestId('command-palette-input');
const type = (value: string) => fireEvent.change(searchInput(), { target: { value } });

/** Every row's text, top to bottom — the list a person's Down arrow walks. */
const rowTexts = () => screen.getAllByRole('option').map((el) => el.textContent ?? '');

/** The one row belonging to a named agent. */
function rowFor(who: string): HTMLElement {
  const rows = screen.getAllByRole('option').filter((el) => (el.textContent ?? '').includes(who));
  expect(rows, `no row for "${who}" among ${JSON.stringify(rowTexts())}`).toHaveLength(1);
  return rows[0];
}

describe('archived conversations in the palette', () => {
  it('says on the row that it is archived, and says nothing on a live one', async () => {
    render(<CommandPaletteDialog />);
    type('airtight');

    // The positive anchor first: without a row that MUST be labelled, the
    // negative below passes against a DOM the query has not answered into yet.
    await waitFor(() => expect(rowFor('Tangerines')).toHaveTextContent('Archived'));
    expect(rowFor('Blueberries')).not.toHaveTextContent('Archived');
  });

  it('ranks it below a live conversation that matches exactly as well', async () => {
    render(<CommandPaletteDialog />);
    type('airtight');

    await waitFor(() => expect(rowFor('Tangerines')).toBeInTheDocument());
    const texts = rowTexts();
    // Same title, so Fuse cannot separate them and neither has been opened —
    // the conversation's own freshness is the only signal left.
    expect(texts.findIndex((t) => t.includes('Tangerines'))).toBeGreaterThan(
      texts.findIndex((t) => t.includes('Blueberries'))
    );
  });

  it('can still lead the list — it is labelled, not demoted the way a closed room is', async () => {
    // The whole difference between the two, seen from the DOM. `demoted` is a
    // hard partition below EVERY live row whatever it scores; a conversation
    // you keep coming back to is most of what ⌘K is for, so yesterday's is
    // still allowed to win on the operator's own history.
    const store = useInteractionStore.getState();
    for (let open = 0; open < 3; open += 1) store.recordOpened('session', archivedSession.id);

    render(<CommandPaletteDialog />);
    type('airtight');

    await waitFor(() => expect(rowFor('Tangerines')).toBeInTheDocument());
    expect(rowTexts()[0]).toContain('Tangerines');
  });

  it('carries the label into the untyped palette, where yesterday resurfaces', async () => {
    // The mockup's zero-query state: Recent is where an overnight-archived row
    // comes back, and it is labelled there too — same component, same word.
    render(<CommandPaletteDialog />);

    await waitFor(() => expect(rowFor('Blueberries')).toBeInTheDocument());
    expect(rowFor('Tangerines')).toHaveTextContent('Archived');
    expect(rowFor('Blueberries')).not.toHaveTextContent('Archived');
  });

  it('opens it like any other conversation', async () => {
    render(<CommandPaletteDialog />);
    type('airtight');

    await waitFor(() => expect(rowFor('Tangerines')).toBeInTheDocument());
    fireEvent.click(rowFor('Tangerines'));

    // A label, not a closed door: the row still does the thing it says.
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '/session',
        search: expect.objectContaining({ session: archivedSession.id }),
      })
    );
  });
});
