// @vitest-environment jsdom
/**
 * Home is the #team room (team-room-home spec D3.2/D3.5).
 *
 * Two things are asserted here that nothing else can see. The first is the four
 * honest states before the room: a cockpit still loading, a server that has not
 * opened the room, a list that could not be read, and a room the owner put away
 * — none of which may draw a half-built conversation, and the last of which may
 * not quietly undo the owner's decision. The second is WHERE the pinned triage
 * header is mounted: outside the room's scroller. A header whose height changes
 * inside that element moves `scrollHeight` under `useTimelineScroll` and un-pins
 * a reader who never scrolled, and only a test that mounts both can say which
 * side of the scroller it landed on.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import {
  REACTION_FREQUENTS_DEFAULT,
  TEAM_ROOM_WELL_KNOWN,
  type RoomEntry,
  type RoomEvent,
  type RoomSummary,
} from '@dorkos/shared/room-schemas';

/** What `?…` says on this render. Set by a test before it renders. */
let search: Record<string, unknown> = {};

vi.mock('@tanstack/react-router', () => ({
  useSearch: () => search,
  useNavigate: () => vi.fn(),
  // `useInPlaceNavigate` (the thread-URL sync) reads the current location.
  useRouter: () => ({ state: { location: { pathname: '/', search: {} } } }),
}));

// The strip is the presence feature's, proven by its own suite. What this file
// checks is the ARGUMENT the home surface hands it — which room's work is
// already being narrated elsewhere on the page — and that its node lands inside
// the header rather than somewhere of its own.
const { presenceStrip, presence } = vi.hoisted(() => ({
  presenceStrip: vi.fn(),
  // Mutable, because whether anybody is working decides whether the quiet state
  // is allowed to say "All quiet." — see the quiet-state block below.
  presence: { occupied: true },
}));
vi.mock('@/layers/features/presence-strip', () => ({
  usePresenceStrip: (excludeRoomIds: readonly string[]) => {
    presenceStrip(excludeRoomIds);
    return {
      occupied: presence.occupied,
      node: <p data-testid="presence-strip">tangerines is working</p>,
    };
  },
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

// The global `/api/events` fan-out needs the app-level `EventStreamProvider`,
// which lives above the router. Nothing here is about that stream — the header
// keeps its own queue honest and has its own suite — so it is stubbed rather
// than dragged in, the way `tour-anchors.test.tsx` beside it does.
/**
 * The viewport, as a box a test can set. jsdom answers every media query the
 * same way, and the header's condense rule turns on this one.
 */
const { viewport } = vi.hoisted(() => ({ viewport: { mobile: false } }));

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useEventStream: () => ({ connectionState: 'connected', failedAttempts: 0 }),
    useEventSubscription: () => {},
    useIsMobile: () => viewport.mobile,
  };
});

import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { usePendingPostStore, useRoomDraftStore } from '@/layers/entities/room';
import { HOME_STARTER_CHIPS } from '@/layers/widgets/home';
import { HomeRoomPage } from '../HomeRoomPage';

const TEAM_ID = 'team-room';
const VIEWER_ID = 'author-you';

/** One post in #team, so the room has a history behind it. */
function post(seq: number): RoomEntry {
  return {
    roomId: TEAM_ID,
    seq,
    id: `entry-${seq}`,
    authorId: 'author-you',
    kind: 'post',
    body: { text: `line ${seq}` },
    mentions: [],
    sessionId: null,
    cascadeRoot: `entry-${seq}`,
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: '2026-08-07T10:00:00.000Z',
  };
}

/** #team as the room list carries it. */
function teamSummary(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    id: TEAM_ID,
    kind: 'channel',
    slug: 'team',
    title: '#team',
    topic: null,
    archived: false,
    ambientMaxEntries: 30,
    wellKnown: TEAM_ROOM_WELL_KNOWN,
    createdAt: '2026-08-08T09:00:00.000Z',
    lastActivityAt: '2026-08-08T10:00:00.000Z',
    unreadCount: 0,
    participants: null,
    ...overrides,
  };
}

/** A live but silent room stream, so the room is not busy reconnecting. */
function staysOpen(signal: AbortSignal): AsyncIterable<RoomEvent> {
  return (async function* () {
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  })();
}

/**
 * #team with the reader in it, caught up.
 *
 * The cursor matters: the quiet state measures "has anything happened since I
 * got here?" against it, so a roster without the reader in it can never be
 * quiet. The default is deliberately ahead of every seq these tests post, which
 * makes "caught up" the baseline; a test that wants unread messages says so by
 * seeding entries above this number.
 */
function teamRoster(lastReadSeq = 100) {
  return {
    ...teamSummary(),
    viewerAuthorId: VIEWER_ID,
    reactionFrequents: [...REACTION_FREQUENTS_DEFAULT],
    members: [
      {
        roomId: TEAM_ID,
        authorId: VIEWER_ID,
        responseMode: 'always' as const,
        joinedAt: '2026-08-01T09:00:00.000Z',
        joinedSeq: 0,
        lastReadSeq,
        author: { id: VIEWER_ID, kind: 'human' as const, displayName: 'Dorian', handle: null },
        origin: 'local' as const,
      },
    ],
  };
}

function renderHome(overrides: Partial<Transport> = {}) {
  const transport = createMockTransport({
    listRooms: vi.fn().mockResolvedValue([teamSummary()]),
    getRoom: vi.fn().mockResolvedValue(teamRoster()),
    listRoomEntries: vi.fn().mockResolvedValue([]),
    subscribeRoom: vi.fn((_id: string, _cursor: number, signal: AbortSignal) => staysOpen(signal)),
    ...overrides,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <TooltipProvider>{children}</TooltipProvider>
        </TransportProvider>
      </QueryClientProvider>
    );
  }

  return { transport, ...render(<HomeRoomPage />, { wrapper: Wrapper }) };
}

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn();
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

beforeEach(() => {
  presenceStrip.mockClear();
  search = {};
  presence.occupied = true;
  viewport.mobile = false;
  // Zustand stores outlive a render, and a draft left behind by one test would
  // put words in the next one's composer.
  useRoomDraftStore.setState({ drafts: {} });
  usePendingPostStore.setState({ posts: [] });
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('HomeRoomPage — the room', () => {
  it('renders #team, found by its well-known key rather than by a URL', async () => {
    const { transport } = renderHome();

    // The composer is the room: it names the destination it posts to.
    expect(await screen.findByPlaceholderText('Message #team…')).toBeInTheDocument();
    expect(transport.getRoom).toHaveBeenCalledWith(TEAM_ID);
  });

  it('draws no room masthead — the bar above already is one', async () => {
    // Home IS #team, and the bar names it and carries its chips. The masthead
    // under it said the same thing a second time and cost the feed a whole row
    // on every phone. Phase R1 deleted `RoomHeader` outright, so this is no
    // longer a prop that could be passed and ignored — but only a render of the
    // real `RoomSurface` can say the row is actually gone.
    const { container } = renderHome();
    await screen.findByPlaceholderText('Message #team…');

    // The masthead's own heading. The working chip is NOT asserted here: it
    // never rendered inside this tree even before R1, so a `queryByTestId` for
    // it passed no matter what the code did — a test that cannot fail. The bar's
    // own chips are proven where they render, in `HomeRoomChips.test.tsx`.
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();

    // And what the host contributes above the feed is untouched — the whole
    // point of removing a masthead rather than the chrome around it.
    expect(container.querySelector('[data-slot="pinned-triage-header"]')).not.toBeNull();
  });

  it('mounts the pinned triage header OUTSIDE the feed it sits above', async () => {
    const { container } = renderHome();
    await screen.findByPlaceholderText('Message #team…');

    const header = container.querySelector('[data-slot="pinned-triage-header"]');
    const scroller = container.querySelector('.overflow-y-auto');
    expect(header).not.toBeNull();
    expect(scroller).not.toBeNull();

    // Not merely "not the same element": the header must not be a DESCENDANT of
    // the scroller, which is the arrangement that fights the pin.
    expect(scroller!.contains(header!)).toBe(false);
    // And it is above it, not below.
    expect(header!.compareDocumentPosition(scroller!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  it('asks the presence strip for everywhere BUT this room', async () => {
    renderHome();
    await screen.findByPlaceholderText('Message #team…');

    // #team narrates its own work in its own live lane, so
    // an agent working here must not also be announced three lines up in a
    // different sentence.
    expect(presenceStrip).toHaveBeenCalledWith([TEAM_ID]);
    expect(await screen.findByTestId('presence-strip')).toBeInTheDocument();
  });

  it('offers Jump back in on this composer — the room keeps its own `@` picker', async () => {
    renderHome();
    const field = await screen.findByPlaceholderText('Message #team…');

    // The recents host is the element the tour spotlights and the browser specs
    // address; the field inside it is still the room's own composer.
    const host = await screen.findByTestId('home-composer');
    expect(host).toContainElement(field);
  });
});

/**
 * The composer and the header, agreeing about the keyboard (spec task 2.7).
 *
 * Typing is the primary action of this surface, and on a phone the header and a
 * software keyboard cannot both have the screen — the browser gate measured the
 * composer 129px behind the keyboard with a single approval showing. The two
 * components that have to agree are siblings inside `RoomSurface`, so the state
 * crosses through this page; what this block proves is that the wire is
 * connected in both directions. jsdom cannot measure a keyboard, so the height
 * itself stays the browser gate's to prove.
 */
describe('HomeRoomPage — getting out of the keyboard’s way', () => {
  /** One approval waiting, so the header has something to condense. */
  const waiting = {
    listPendingApprovals: vi.fn().mockResolvedValue({
      approvals: [
        {
          approvalId: '01JZ0000000000000000000001',
          capabilityId: 'marketplace.uninstall',
          capabilityTitle: 'Uninstall a marketplace package',
          tier: 'destructive' as const,
          summary: 'Uninstall "sentry-monitor"',
          requestedBy: '/Users/dev/agents/dorkbot',
          hasAgentPath: true,
          requestedAt: '2026-08-08T10:00:00.000Z',
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        },
      ],
    }),
  };

  it('condenses the header while the caret is in the composer, and restores it when it leaves', async () => {
    viewport.mobile = true;
    renderHome(waiting);
    const field = await screen.findByPlaceholderText('Message #team…');

    // Blurred first, deliberately: a room composer takes the caret when it
    // mounts, and jsdom has no touch to refuse it with, so the full header has
    // to be established rather than assumed.
    act(() => field.blur());
    expect(await screen.findByText('Waiting on you')).toBeInTheDocument();

    act(() => field.focus());

    expect(await screen.findByText('1 waiting')).toBeInTheDocument();
    expect(screen.queryByText('Waiting on you')).not.toBeInTheDocument();
  });

  it('gives the caret back — and the header — when the condensed line is tapped', async () => {
    viewport.mobile = true;
    renderHome(waiting);
    const field = await screen.findByPlaceholderText('Message #team…');
    act(() => field.focus());
    const line = await screen.findByRole('button', { name: /1 waiting/ });

    // `fireEvent`, not `userEvent`: a real tap on a phone does not necessarily
    // move focus to the button, so the click must not be allowed to blur the
    // field for us. Only the page's own blur can pass this.
    act(() => {
      fireEvent.click(line);
    });

    expect(await screen.findByText('Waiting on you')).toBeInTheDocument();
    expect(document.activeElement).not.toBe(field);
  });

  it('leaves a wide screen alone when the composer is focused', async () => {
    renderHome(waiting);
    const field = await screen.findByPlaceholderText('Message #team…');
    await screen.findByText('Waiting on you');

    act(() => field.focus());

    expect(screen.getByText('Waiting on you')).toBeInTheDocument();
    expect(screen.queryByText('1 waiting')).not.toBeInTheDocument();
  });
});

describe('HomeRoomPage — day one', () => {
  it('offers the openers above the composer while the room has nothing in it', async () => {
    renderHome();
    await screen.findByPlaceholderText('Message #team…');

    for (const line of HOME_STARTER_CHIPS) {
      expect(screen.getByRole('button', { name: line })).toBeInTheDocument();
    }
  });

  it('puts a pressed opener in the composer, and does not send it', async () => {
    const { transport } = renderHome();
    const field = await screen.findByPlaceholderText('Message #team…');
    const line = HOME_STARTER_CHIPS[0]!;

    await userEvent.click(screen.getByRole('button', { name: line }));

    // In the box the person is looking at, whole, ready to be edited.
    await waitFor(() => expect(field).toHaveValue(line));
    // And nowhere else. The first message sent is still one somebody chose to
    // send.
    expect(transport.postToRoom).not.toHaveBeenCalled();
  });

  it('takes them away once there is a conversation to read instead', async () => {
    renderHome({ listRoomEntries: vi.fn().mockResolvedValue([post(1)]) });
    await screen.findByPlaceholderText('Message #team…');

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: HOME_STARTER_CHIPS[0]! })).toBeNull()
    );
  });

  it('takes them away at the keystroke, not when the server echoes back', async () => {
    // The history is still empty and stays empty: this asserts the openers go on
    // the SEND, off the pending row the composer mints at the keystroke. Waiting
    // for the stream echo left a row of "start a conversation" prompts sitting
    // above the conversation you had just started, for a whole round trip.
    renderHome();
    const field = await screen.findByPlaceholderText('Message #team…');

    await userEvent.click(screen.getByRole('button', { name: HOME_STARTER_CHIPS[0]! }));
    await waitFor(() => expect(field).toHaveValue(HOME_STARTER_CHIPS[0]!));
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: HOME_STARTER_CHIPS[0]! })).toBeNull()
    );
  });
});

describe('HomeRoomPage — a quiet morning', () => {
  /** A room with a history, nothing waiting, and nobody working. */
  function renderQuietHome(overrides: Partial<Transport> = {}) {
    presence.occupied = false;
    return renderHome({ listRoomEntries: vi.fn().mockResolvedValue([post(1)]), ...overrides });
  }

  it('says so, once the room has a history and nothing needs answering', async () => {
    renderQuietHome();

    expect(await screen.findByText('All quiet.')).toBeInTheDocument();
  });

  it('stays away on day one — an empty room is not a quiet one', async () => {
    presence.occupied = false;
    renderHome();
    await screen.findByPlaceholderText('Message #team…');

    expect(screen.queryByText('All quiet.')).toBeNull();
    // The openers speak for that case instead.
    expect(screen.getByRole('button', { name: HOME_STARTER_CHIPS[0]! })).toBeInTheDocument();
  });

  it('stays away over a room that has been talking since the reader arrived', async () => {
    presence.occupied = false;
    // The roster says the reader had read up to seq 100; these landed after.
    renderHome({ listRoomEntries: vi.fn().mockResolvedValue([post(101), post(102)]) });
    await screen.findByPlaceholderText('Message #team…');

    expect(screen.queryByText('All quiet.')).toBeNull();
  });

  it('stays away while the pinned header has something to say', async () => {
    // The strip occupies the header, which is already telling the reader that
    // somebody is working. Two statements about one morning is one too many.
    presence.occupied = true;
    renderHome({ listRoomEntries: vi.fn().mockResolvedValue([post(1)]) });
    await screen.findByTestId('presence-strip');

    expect(screen.queryByText('All quiet.')).toBeNull();
  });

  it('sits above the feed, not inside it', async () => {
    const { container } = renderQuietHome();
    await screen.findByText('All quiet.');

    const line = container.querySelector('[data-slot="home-quiet-state"]');
    const scroller = container.querySelector('.overflow-y-auto');
    expect(line).not.toBeNull();
    expect(scroller!.contains(line!)).toBe(false);
  });
});

describe('HomeRoomPage — the attention deep links', () => {
  it('opens the sheet a pasted `?detail=` names, from the home surface', async () => {
    // The rows moved into the pinned triage header, so the URL they address has
    // to keep working where the header now lives — which is here.
    search = { detail: 'offline-agent', itemId: 'offline' };
    renderHome();

    expect(await screen.findByRole('dialog', { name: /offline/i })).toBeInTheDocument();
  });

  it('draws no sheet without one', async () => {
    renderHome();
    await screen.findByPlaceholderText('Message #team…');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('HomeRoomPage — before there is a room', () => {
  it('is quiet while the room list is still loading — no broken room', () => {
    const { container } = renderHome({
      listRooms: vi.fn<() => Promise<RoomSummary[]>>(() => new Promise(() => {})),
    });

    expect(container.querySelector('[aria-busy]')).not.toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText(/isn't open yet/i)).toBeNull();
  });

  it('says a room the server has not opened yet is not open — and offers no retry', async () => {
    renderHome({ listRooms: vi.fn().mockResolvedValue([]) });

    expect(await screen.findByText(/isn't open yet/i)).toBeInTheDocument();
    // Nothing to retry: the room arrives when the server opens it, and a button
    // that re-reads the same empty list would only look like it did something.
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('says a list it could not read is a read failure, and offers to try again', async () => {
    const listRooms = vi.fn().mockRejectedValue(new Error('offline'));
    renderHome({ listRooms });

    expect(await screen.findByText(/couldn't load your team room/i)).toBeInTheDocument();
    const before = listRooms.mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listRooms.mock.calls.length).toBeGreaterThan(before));
  });
});

describe('HomeRoomPage — a room the owner put away', () => {
  /** A cockpit whose #team is archived: absent from the live list, present in the full one. */
  function archivedTransport() {
    return {
      listRooms: vi.fn(async (query?: { includeArchived?: boolean }) =>
        query?.includeArchived === true ? [teamSummary({ archived: true })] : []
      ),
    };
  }

  it('says so, and does NOT bring it back on its own', async () => {
    const { transport } = renderHome(archivedTransport());

    expect(await screen.findByText('#team is archived')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).toBeNull();
    // The whole point: opening the page must not overrule "I put that away".
    expect(transport.updateRoom).not.toHaveBeenCalled();
  });

  it('offers the owner one press to bring it back', async () => {
    const { transport } = renderHome(archivedTransport());
    await screen.findByText('#team is archived');

    await userEvent.click(screen.getByRole('button', { name: 'Bring it back' }));

    await waitFor(() =>
      expect(transport.updateRoom).toHaveBeenCalledWith(TEAM_ID, { archived: false })
    );
  });
});
