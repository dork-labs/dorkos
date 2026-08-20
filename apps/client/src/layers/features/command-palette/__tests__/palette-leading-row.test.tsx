/**
 * @vitest-environment jsdom
 *
 * The palette's highlight, while the list moves under it (DOR-699).
 *
 * Like its `rooms-in-palette` sibling, this file does **not** stub the room
 * list — it drives the real `usePaletteRooms` through a mock `Transport` and a
 * real `QueryClient`, then re-points the transport and invalidates. That is the
 * actual shape of the bug: a message arrives, `room_activity` invalidates the
 * room list, and the Unread group re-sorts a new row above the one the
 * highlight is on. A stubbed list would reorder without any of that machinery
 * and would pass whether or not the fix works.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import { createMockTransport } from '@dorkos/test-utils';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import { CommandPaletteDialog } from '../ui/CommandPaletteDialog';
import { useLeadingRowPin } from '../model/use-leading-row-pin';

// --- Fixtures ---

function makeRoom(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    id: 'room-default',
    kind: 'channel',
    slug: 'default',
    title: 'Default',
    topic: null,
    workspaceId: null,
    archived: false,
    ambientMaxEntries: 30,
    createdAt: '2026-07-26T10:00:00.000Z',
    lastActivityAt: '2026-07-26T10:00:00.000Z',
    unreadCount: null,
    participants: null,
    ...overrides,
  };
}

/**
 * Caught up, so nothing is waiting in it and it sits below the agent rather
 * than on top. Its last activity is deliberately older than the agent's, and
 * deliberately not its `createdAt` — a room nobody has ever spoken in has no
 * "back" to jump to and is left out of Recent entirely.
 */
const caughtUp = makeRoom({
  id: 'room-quiet',
  slug: 'quiet',
  title: 'Quiet',
  unreadCount: 0,
  lastActivityAt: '2026-07-26T08:00:00.000Z',
});

/** The same room a moment later, with a message waiting in it. */
const nowUnread = { ...caughtUp, unreadCount: 1, lastActivityAt: '2026-07-26T11:00:00.000Z' };

/** What the palette leads with before any room is unread: the only agent. */
const LEADING_AGENT = 'Ana';

// --- Transport ---

const mockTransport = createMockTransport();

/**
 * Hands back the `QueryClient` as well as the render result, because the
 * reorder under test is an invalidation — the test has to be able to cause one.
 */
function render(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return { client, ...rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>) };
}

// jsdom implements neither, and cmdk needs both.
globalThis.ResizeObserver = vi.fn().mockImplementation(function () {
  return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
});
Element.prototype.scrollIntoView = vi.fn();

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
  vi.mocked(mockTransport.listRooms).mockResolvedValue([caughtUp]);
  // The agent's own last-session time. Recent ranks an agent by it, and an
  // agent with none has never run anything this window can see — so without
  // this the untyped palette would have no agent row to lead with.
  vi.mocked(mockTransport.listRecentSessions).mockResolvedValue({
    sessions: [],
    agentActivity: { '/projects/ana': '2026-07-26T09:00:00.000Z' },
    warnings: [],
  });
});

afterEach(cleanup);

// --- Mocks: everything the palette needs that is NOT rooms ---

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}));

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
  // Rows below the agent, so "the highlight moved down" and "the highlight came
  // back to the top" are claims about a list with somewhere else to be.
  useSlotContributions: () => [
    {
      id: 'settings',
      label: 'Settings',
      icon: 'Settings',
      action: 'openSettings',
      category: 'feature',
      priority: 1,
    },
    {
      id: 'theme',
      label: 'Toggle Theme',
      icon: 'Moon',
      action: 'toggleTheme',
      category: 'quick-action',
      priority: 1,
    },
  ],
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
  useMeshAgentPaths: () => ({
    data: { agents: [{ id: 'agent-ana', name: LEADING_AGENT, projectPath: '/projects/ana' }] },
    isLoading: false,
  }),
}));

vi.mock('@/layers/entities/command', () => ({
  useCommands: () => ({ data: { commands: [] } }),
}));

vi.mock('@/layers/entities/tasks', () => ({
  useActiveTaskRunCount: () => ({ data: undefined }),
}));

// No sessions of its own, so the leading row before the message is exactly the
// agent.
vi.mock('@/layers/entities/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session')>()),
  useDirectoryState: () => ['/projects/ana', vi.fn()],
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

// --- Helpers ---

const searchInput = () => screen.getByPlaceholderText('Search rooms, agents, commands...');

/** Every selectable row, in the order the list renders them. */
const rows = () => screen.getAllByRole('option');

/** What cmdk marks as the highlighted row — the row Enter would activate. */
const highlighted = () =>
  document.querySelector('[cmdk-item=""][aria-selected="true"]')?.getAttribute('data-value') ??
  null;

/** The value of the row on top of the list. */
const leadingValue = () => rows()[0]?.getAttribute('data-value') ?? null;

/**
 * Land a message in the caught-up room, the way one really arrives: the room
 * list answers differently, and the query that holds it is invalidated.
 */
async function landAMessage(client: QueryClient) {
  vi.mocked(mockTransport.listRooms).mockResolvedValue([nowUnread]);
  await client.invalidateQueries();
  await waitFor(() => expect(leadingValue()).toBe(caughtUp.id));
}

/**
 * Wait for the opened palette to settle on its pre-message shape. Matching on
 * the leading row's value rather than its text: the selected agent's name is
 * also drawn in the preview panel beside the list, so the name alone is
 * ambiguous.
 */
async function waitForAgentOnTop() {
  await waitFor(() => expect(leadingValue()).toBe(LEADING_AGENT));
}

describe('the palette highlight, while the list moves under it', () => {
  it('follows the room that a message just moved to the top', async () => {
    const { client } = render(<CommandPaletteDialog />);
    await waitForAgentOnTop();

    // Nothing is unread yet, so the agent leads and holds the highlight.
    expect(leadingValue()).toBe(LEADING_AGENT);
    expect(highlighted()).toBe(LEADING_AGENT);

    await landAMessage(client);

    // The room is on top now, and the highlight went with it — so Enter opens
    // the row the operator is looking at rather than the agent underneath it.
    await waitFor(() => expect(leadingValue()).toBe(caughtUp.id));
    await waitFor(() => expect(highlighted()).toBe(caughtUp.id));
  });

  it('leaves a highlight the operator moved exactly where they put it', async () => {
    const { client } = render(<CommandPaletteDialog />);
    await waitForAgentOnTop();

    fireEvent.keyDown(searchInput(), { key: 'ArrowDown' });
    const chosen = highlighted();
    expect(chosen).not.toBe(LEADING_AGENT);
    expect(chosen).not.toBeNull();

    await landAMessage(client);
    await waitFor(() => expect(leadingValue()).toBe(caughtUp.id));

    // The list moved; their choice did not.
    expect(highlighted()).toBe(chosen);
  });

  it('takes the highlight back to the first row when the operator types', async () => {
    render(<CommandPaletteDialog />);
    await waitForAgentOnTop();

    fireEvent.keyDown(searchInput(), { key: 'ArrowDown' });
    expect(highlighted()).not.toBe(LEADING_AGENT);

    // A new query is a fresh list, and cmdk has always re-selected its first
    // row here. Moving the highlight earlier must not have taken that away.
    fireEvent.change(searchInput(), { target: { value: 'a' } });
    await waitFor(() => expect(rows()[0]).toHaveAttribute('aria-selected', 'true'));
  });

  it('lets go of the operator’s choice once they search again', async () => {
    const { client } = render(<CommandPaletteDialog />);
    await waitForAgentOnTop();

    fireEvent.keyDown(searchInput(), { key: 'ArrowDown' });
    expect(highlighted()).not.toBe(LEADING_AGENT);

    // Searching and coming back is a fresh list, not a continuation of the row
    // they were on — so the highlight belongs to the top of the list again.
    // Without this, one arrow key would freeze the highlight for as long as the
    // palette stayed open, and the next message could not reach it.
    fireEvent.change(searchInput(), { target: { value: 'a' } });
    fireEvent.change(searchInput(), { target: { value: '' } });
    await waitForAgentOnTop();

    await landAMessage(client);
    await waitFor(() => expect(highlighted()).toBe(caughtUp.id));
  });

  it('ignores an arrow key that was picking an IME candidate', async () => {
    // cmdk bails on composing input before its own switch, so this ArrowDown
    // never moved the highlight; the pin must not count it as operator intent
    // and stop following the list.
    const { client } = render(<CommandPaletteDialog />);
    await waitForAgentOnTop();

    fireEvent.keyDown(searchInput(), { key: 'ArrowDown', isComposing: true });

    await landAMessage(client);
    await waitFor(() => expect(highlighted()).toBe(caughtUp.id));
  });
});

describe('the pin, scoped to the active page', () => {
  // The dialog test above cannot see the page-transition window: the global
  // motion mock renders AnimatePresence as a passthrough, so the departing
  // page's frozen wrapper never coexists with the incoming one the way it does
  // in a real browser for ~150ms. This drives the hook directly against that
  // exact DOM shape instead (DOR-699 review: the pin re-armed a row from the
  // page being torn down, and a quick second Enter fired it).
  function Harness({ activePage, onPin }: { activePage: string; onPin: (v: string) => void }) {
    const rootRef = React.useRef<HTMLDivElement>(null);
    useLeadingRowPin({ rootRef, activePage, onPin, resetKey: activePage });
    return (
      <div ref={rootRef}>
        {/* The exiting wrapper: rows frozen under the OLD page name. The
            attribute spread keeps JSX from treating cmdk's marker attribute
            as a React prop (react/no-unknown-property). */}
        <div data-palette-page="root">
          <div {...{ 'cmdk-item': '' }} data-value="stale-root-row" aria-selected="false" />
        </div>
      </div>
    );
  }

  it('holds off while only the departing page’s rows are in the DOM', () => {
    const onPin = vi.fn();
    rtlRender(<Harness activePage="agent-actions" onPin={onPin} />);
    expect(onPin).not.toHaveBeenCalled();
  });

  it('pins again once the rows on screen belong to the active page', () => {
    const onPin = vi.fn();
    rtlRender(<Harness activePage="root" onPin={onPin} />);
    expect(onPin).toHaveBeenCalledWith('stale-root-row');
  });
});
