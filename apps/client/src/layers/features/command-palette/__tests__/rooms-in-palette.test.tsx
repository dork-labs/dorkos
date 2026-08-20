/**
 * @vitest-environment jsdom
 *
 * Rooms in the command palette (spec `rooms` §13.2).
 *
 * Unlike its sibling files this one does **not** stub `usePaletteItems`. The
 * room list, the ordering, the flat search list and the prefix filter are all
 * the real ones, reached through a mock `Transport` — because the claim under
 * test is that those pieces agree with each other, and a stub for any of them
 * would be the only thing making them agree.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render as rtlRender,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import { createMockTransport } from '@dorkos/test-utils';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import { CommandPaletteDialog } from '../ui/CommandPaletteDialog';

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

/** Two entries waiting, and it spoke EARLIER than the quiet one. */
const urgent = makeRoom({
  id: 'room-urgent',
  slug: 'urgent',
  title: 'Urgent',
  lastActivityAt: '2026-07-26T09:00:00.000Z',
  unreadCount: 2,
});

/** Nothing waiting, and it spoke LATER — so only unread-first can outrank it. */
const quiet = makeRoom({
  id: 'room-quiet',
  slug: 'quiet',
  title: 'Quiet',
  lastActivityAt: '2026-07-26T20:00:00.000Z',
  unreadCount: 0,
});

/**
 * A channel the operator can see but has never joined, so there is no read
 * cursor and `unreadCount` is `null` — "not applicable", not zero.
 *
 * This is a real state, not a contrived one: the server shows the operator
 * every room (`room-service.ts`), so a channel someone else made arrives here
 * the moment `#` is typed.
 */
const outsider = makeRoom({
  id: 'room-outsider',
  slug: 'outsider',
  title: 'Outsider',
  lastActivityAt: '2026-07-26T06:00:00.000Z',
  unreadCount: null,
});

const dmWithAna = makeRoom({
  id: 'room-dm-ana',
  kind: 'dm',
  slug: null,
  title: 'Ana',
  lastActivityAt: '2026-07-26T08:00:00.000Z',
  unreadCount: 0,
  participants: [
    { id: 'author-ana', kind: 'agent', displayName: 'Ana', handle: null, agentRef: 'ana' },
  ],
});

/**
 * A conversation whose title a channel query also matches — deliberately, so
 * "`#` leaves direct messages out" fails when the prefix stops scoping. Without
 * it, `#quiet` narrows to the same visible set with or without the prefix, and
 * the test passes for the wrong reason.
 */
const dmWithQuietPartner = makeRoom({
  id: 'room-dm-quiet-partner',
  kind: 'dm',
  slug: null,
  title: 'Quiet Partner',
  lastActivityAt: '2026-07-26T05:00:00.000Z',
  unreadCount: 0,
  participants: [
    {
      id: 'author-qp',
      kind: 'agent',
      displayName: 'Quiet Partner',
      handle: null,
      agentRef: 'quiet-partner',
    },
  ],
});

/**
 * A direct message with something waiting.
 *
 * **Separate from {@link dmWithAna} on purpose.** The Unread group is built
 * FROM the channel and DM lists rather than by re-filtering every room, and
 * that derivation has two halves. Every other DM fixture here is caught up, so
 * without this one, dropping DMs from the derivation entirely passes the whole
 * file.
 *
 * Flipping `dmWithAna` instead would have done it, at the cost of breaking
 * `opens a direct message`: the badge changes that row's accessible name, and
 * that test matches it exactly.
 *
 * It spoke earlier than every other unread room, so it cannot disturb the
 * unread-first ordering `leads with the unread room` pins.
 */
const dmWithBo = makeRoom({
  id: 'room-dm-bo',
  kind: 'dm',
  slug: null,
  title: 'Bo',
  lastActivityAt: '2026-07-26T04:00:00.000Z',
  unreadCount: 2,
  participants: [
    { id: 'author-bo', kind: 'agent', displayName: 'Bo', handle: null, agentRef: 'bo' },
  ],
});

const ALL_ROOMS = [urgent, quiet, outsider, dmWithAna, dmWithQuietPartner, dmWithBo];

// --- Transport ---

const mockTransport = createMockTransport();

/**
 * A real client per render, so one case's room list never leaks into the next.
 * `retry: false` so the error case fails once instead of backing off.
 */
function render(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
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
  vi.mocked(mockTransport.listRooms).mockResolvedValue(ALL_ROOMS);
  vi.mocked(mockTransport.listRecentSessions).mockResolvedValue({
    sessions: [
      {
        id: '00000000-0000-4000-8000-00000000cafe',
        title: 'Wiring the palette',
        cwd: '/projects/ana',
        createdAt: recentlyActive,
        updatedAt: recentlyActive,
        permissionMode: 'default',
        runtime: 'claude-code',
      },
    ],
    // No agent rows: the agent's own conversation is already in the list, and
    // Recent never says one thing twice.
    agentActivity: {},
    warnings: [],
  });
  mockNavigate.mockClear();
});

afterEach(cleanup);

// --- Mocks: everything the palette needs that is NOT rooms ---

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('@/layers/shared/model', () => ({
  // The real room hooks read the Transport through this port, so it is the one
  // export here that is not a stub of convenience.
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
  // `usePaletteActions` reads the feedback dialog's store, so the palette does
  // not render at all without it (DOR-902).
  useFeedbackDialogStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = { openFeedback: vi.fn() };
    return selector ? selector(state) : state;
  },
  useIsMobile: () => false,
  useNow: () => Date.now(),
  // One feature and one quick action, so "unread comes first" is a claim about
  // an order that has something else in it.
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
    data: { agents: [{ id: 'agent-ana', name: 'Ana', projectPath: '/projects/ana' }] },
    isLoading: false,
  }),
}));

vi.mock('@/layers/entities/command', () => ({
  useCommands: () => ({ data: { commands: [] } }),
}));

vi.mock('@/layers/entities/tasks', () => ({
  useActiveTaskRunCount: () => ({ data: undefined }),
}));

/**
 * A conversation in the active directory, active five minutes ago — months
 * later than every room here. Recent is ordered by recency, so this row wins on
 * time alone; only unread-first can put a July channel above it, which is what
 * makes the ordering claim below discriminating.
 */
const recentlyActive = new Date(Date.now() - 5 * 60 * 1000).toISOString();
vi.mock('@/layers/entities/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session')>()),
  useDirectoryState: () => ['/projects/ana', vi.fn()],
  useSessions: () => ({
    sessions: [
      {
        id: 'session-1',
        title: 'Wiring the palette',
        cwd: '/projects/ana',
        updatedAt: recentlyActive,
        createdAt: recentlyActive,
      },
    ],
  }),
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

const type = (value: string) => fireEvent.change(searchInput(), { target: { value } });

/** Every selectable row, in the order the list renders them. */
const rowNames = () => screen.getAllByRole('option').map((el) => el.textContent);

/** The palette row carrying `text`, once the room list has arrived. */
async function optionFor(text: string): Promise<HTMLElement> {
  const row = (await screen.findByText(text)).closest('[role="option"]');
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

describe('rooms in the command palette', () => {
  describe('before anything is typed', () => {
    it('leads with the unread room, above a conversation from five minutes ago', async () => {
      render(<CommandPaletteDialog />);
      await screen.findByText('#urgent');

      // `Urgent` last spoke in July; the conversation spoke five minutes ago.
      // Recency alone would invert this, so it can only pass on unread-first.
      expect(rowNames()[0]).toContain('#urgent');
      expect(rowNames().some((n) => n?.includes('Wiring the palette'))).toBe(true);
      expect(rowNames().findIndex((n) => n?.includes('#urgent'))).toBeLessThan(
        rowNames().findIndex((n) => n?.includes('Wiring the palette'))
      );
    });

    it('draws the `#` once — as the mark, spoken by the name, never both visibly', async () => {
      render(<CommandPaletteDialog />);
      const row = await optionFor('#urgent');

      // This is the `# #urgent` defect (spec `rooms` §13.1) guarded at the row
      // level: the visible name is bare and hidden from assistive technology,
      // the spoken name carries the `#` and is invisible. Rendering
      // `roomDisplayTitle` as plain text beside the mark breaks both halves.
      expect(within(row).getByText('urgent')).toHaveAttribute('aria-hidden', 'true');
      expect(within(row).getByText('#urgent')).toHaveClass('sr-only');
      // The count names itself and not the room, so the row is not "#urgent 2 unread in #urgent".
      expect(within(row).getByLabelText('2 unread')).toHaveTextContent('2');
    });

    it('shows a caught-up room too, but underneath everything that is waiting', async () => {
      // The untyped palette is a command center now, not a to-do list (§15):
      // Recent is where you have BEEN, so a caught-up room belongs in it. What
      // does not change is which one a person reaches first.
      render(<CommandPaletteDialog />);
      await screen.findByText('#urgent');

      expect(screen.getByText('#quiet')).toBeInTheDocument();
      expect(rowNames().findIndex((n) => n?.includes('#urgent'))).toBeLessThan(
        rowNames().findIndex((n) => n?.includes('#quiet'))
      );
    });

    it('badges an unread direct message here too, and ranks it above a caught-up one', async () => {
      // Recent is built from the channel list AND the DM list, so the half that
      // says DMs belong needs pinning as well, or dropping them silently
      // passes. `Bo` spoke at 04:00 and `Ana` at 08:00, so recency alone would
      // put Ana first — only "waiting leads" produces this order.
      render(<CommandPaletteDialog />);
      await screen.findByText('#urgent');

      const row = await optionFor('Message Bo');
      expect(within(row).getByLabelText('2 unread')).toHaveTextContent('2');
      expect(rowNames().findIndex((n) => n?.includes('Message Bo'))).toBeLessThan(
        rowNames().findIndex((n) => n?.includes('Message Ana'))
      );
    });

    it('does not treat a room the reader is not in as unread', async () => {
      // `outsider` carries `unreadCount: null` — "you are not a member", so
      // there is no read cursor and no number. Collapsing it into zero would
      // put every room the operator has ever laid eyes on in this list.
      vi.mocked(mockTransport.listRooms).mockResolvedValue([urgent, outsider]);
      render(<CommandPaletteDialog />);

      // Waiting on a room that IS unread, so the list has demonstrably arrived
      // before the absence below is asserted. Waiting on a feature instead
      // would resolve before the query settled and check nothing.
      await screen.findByText('#urgent');
      expect(screen.queryByText('#outsider')).not.toBeInTheDocument();
    });

    it('says what the prefixes do', async () => {
      render(<CommandPaletteDialog />);
      await screen.findByText('#urgent');

      expect(screen.getByText('channels')).toBeInTheDocument();
      expect(screen.getByText('agents and DMs')).toBeInTheDocument();
      expect(screen.getByText('commands')).toBeInTheDocument();
    });
  });

  describe('the # prefix', () => {
    it('lists every channel, and nothing that is not a room', async () => {
      render(<CommandPaletteDialog />);
      await screen.findByText('#urgent');
      type('#');

      await waitFor(() => expect(screen.getByText('#quiet')).toBeInTheDocument());
      expect(screen.getByText('#urgent')).toBeInTheDocument();
      // Not rooms: the agent, the feature, the quick action.
      expect(screen.queryByText('Ana')).not.toBeInTheDocument();
      expect(screen.queryByText('Settings')).not.toBeInTheDocument();
      expect(screen.queryByText('Toggle Theme')).not.toBeInTheDocument();
    });

    it('draws no badge for a channel the reader is not a member of', async () => {
      render(<CommandPaletteDialog />);
      await screen.findByText('#urgent');
      type('#');

      const row = await optionFor('#outsider');
      // `unreadCount: null` is "not applicable", not zero. Reading the count
      // directly instead of through `hasUnread` renders an empty pill here that
      // announces "null unread" — a badge on a room nobody is behind on.
      expect(within(row).queryByLabelText(/unread/)).toBeNull();
      // And the row itself is present, so this is an absent badge rather than
      // an absent room.
      expect(within(row).getByText('#outsider')).toHaveClass('sr-only');
    });

    it('leaves direct messages out — a DM is addressed by who is in it, not by a name', async () => {
      render(<CommandPaletteDialog />);
      await screen.findByText('#urgent');
      // `Quiet Partner` is a DM whose title this same query matches, so the
      // absence below is the PREFIX scoping DMs out — not the search term
      // failing to reach them.
      type('#quiet');

      await waitFor(() => expect(screen.getByText('#quiet')).toBeInTheDocument());
      expect(screen.queryByText('Message Quiet Partner')).not.toBeInTheDocument();
      expect(screen.queryByText('Message Ana')).not.toBeInTheDocument();
    });

    // NOTE: this case pins NARROWING, not the prefix. `#urgent` does not match
    // `#qui` with or without `#` stripped, so it stays green if `parsePrefix`
    // loses `#`. What pins the prefix is `lists every channel`,
    // `leaves direct messages out`, and the three status-row cases below.
    it('narrows to the matching channel as the query gets longer', async () => {
      render(<CommandPaletteDialog />);
      await screen.findByText('#urgent');
      type('#qui');

      await waitFor(() => expect(screen.getByText('#quiet')).toBeInTheDocument());
      expect(screen.queryByText('#urgent')).not.toBeInTheDocument();
    });

    it('keeps unread first inside the channel list too', async () => {
      render(<CommandPaletteDialog />);
      await screen.findByText('#urgent');
      type('#');

      await waitFor(() => expect(screen.getByText('#quiet')).toBeInTheDocument());
      expect(rowNames()[0]).toContain('#urgent');
    });
  });

  describe('the @ prefix', () => {
    it('offers the conversation with Ana and Ana herself — two different acts', async () => {
      render(<CommandPaletteDialog />);
      await screen.findByText('#urgent');
      type('@ana');

      await waitFor(() => expect(screen.getByText('Message Ana')).toBeInTheDocument());
      // The agent row, which drills into "New Session" and the rest.
      expect(screen.getByRole('option', { name: /^Ana/ })).toBeInTheDocument();
    });

    it('leaves channels out', async () => {
      render(<CommandPaletteDialog />);
      await screen.findByText('#urgent');
      type('@');

      await waitFor(() => expect(screen.getByText('Message Ana')).toBeInTheDocument());
      expect(screen.queryByText('#urgent')).not.toBeInTheDocument();
      expect(screen.queryByText('#quiet')).not.toBeInTheDocument();
    });
  });

  describe('opening a room', () => {
    it('navigates to the channel it names', async () => {
      render(<CommandPaletteDialog />);
      fireEvent.click(await optionFor('#urgent'));

      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/channels',
        search: { id: 'room-urgent' },
      });
    });

    it('opens a direct message', async () => {
      render(<CommandPaletteDialog />);
      await screen.findByText('#urgent');
      type('@ana');

      fireEvent.click(await screen.findByRole('option', { name: 'Message Ana' }));

      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/channels',
        search: { id: 'room-dm-ana' },
      });
    });
  });

  describe('when there are no channels to show', () => {
    it('says the list is loading rather than saying there are none', async () => {
      // Never settles, so the query stays pending for the length of the case.
      vi.mocked(mockTransport.listRooms).mockReturnValue(new Promise(() => {}));
      render(<CommandPaletteDialog />);
      type('#');

      expect(await screen.findByText('Loading channels…')).toBeInTheDocument();
    });

    it('says so when the list fails, instead of an empty result', async () => {
      vi.mocked(mockTransport.listRooms).mockRejectedValue(new Error('offline'));
      render(<CommandPaletteDialog />);
      type('#');

      expect(await screen.findByText('Could not load your channels.')).toBeInTheDocument();
    });

    it('says there are none when the list is genuinely empty', async () => {
      vi.mocked(mockTransport.listRooms).mockResolvedValue([]);
      render(<CommandPaletteDialog />);
      type('#');

      expect(await screen.findByText('No channels yet.')).toBeInTheDocument();
    });

    // The status row belongs to `#` and only to `#`. Everywhere else rooms are
    // one group among several, and a palette that announced "could not load
    // your channels" while happily listing agents and commands would be
    // reporting a failure nobody asked about.

    // Both cases below SEE the message under `#` first and then leave `#`. That
    // ordering is the point: it proves the query had already settled into the
    // state that produces the message, so the absence afterwards is the mode
    // scoping it out rather than a test that ran before the query answered.

    it('stays quiet about a failed room list once the # is deleted', async () => {
      vi.mocked(mockTransport.listRooms).mockRejectedValue(new Error('offline'));
      render(<CommandPaletteDialog />);
      type('#');
      expect(await screen.findByText('Could not load your channels.')).toBeInTheDocument();

      type('');

      await waitFor(() =>
        expect(screen.queryByText('Could not load your channels.')).not.toBeInTheDocument()
      );
      // The zero-query list is still drawn — this is a message that left, not a
      // palette that emptied. The prefix legend closes that list and is drawn
      // whenever it exists at all.
      expect(screen.getByText('agents and DMs')).toBeInTheDocument();
    });

    it('stays quiet about an empty channel list in @ mode', async () => {
      // A DM and no channels: `#` has nothing to list, `@` has something.
      vi.mocked(mockTransport.listRooms).mockResolvedValue([dmWithAna]);
      render(<CommandPaletteDialog />);
      type('#');
      expect(await screen.findByText('No channels yet.')).toBeInTheDocument();

      type('@');

      await waitFor(() => expect(screen.queryByText('No channels yet.')).not.toBeInTheDocument());
      expect(screen.getByText('Message Ana')).toBeInTheDocument();
    });
  });
});
