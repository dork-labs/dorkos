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
 * inside that element moves `scrollHeight` under `useStickToBottom` and un-pins
 * a reader who never scrolled, and only a test that mounts both can say which
 * side of the scroller it landed on.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import {
  REACTION_FREQUENTS_DEFAULT,
  TEAM_ROOM_WELL_KNOWN,
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
const { presenceStrip } = vi.hoisted(() => ({ presenceStrip: vi.fn() }));
vi.mock('@/layers/features/presence-strip', () => ({
  usePresenceStrip: (excludeRoomIds: readonly string[]) => {
    presenceStrip(excludeRoomIds);
    return { occupied: true, node: <p data-testid="presence-strip">tangerines is working</p> };
  },
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

// The global `/api/events` fan-out needs the app-level `EventStreamProvider`,
// which lives above the router. Nothing here is about that stream — the header
// keeps its own queue honest and has its own suite — so it is stubbed rather
// than dragged in, the way `tour-anchors.test.tsx` beside it does.
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useEventStream: () => ({ connectionState: 'connected', failedAttempts: 0 }),
    useEventSubscription: () => {},
  };
});

import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { HomeRoomPage } from '../HomeRoomPage';

const TEAM_ID = 'team-room';

/** #team as the room list carries it. */
function teamSummary(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    id: TEAM_ID,
    kind: 'channel',
    slug: 'team',
    title: '#team',
    topic: null,
    workspaceId: null,
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

function renderHome(overrides: Partial<Transport> = {}) {
  const transport = createMockTransport({
    listRooms: vi.fn().mockResolvedValue([teamSummary()]),
    getRoom: vi.fn().mockResolvedValue({
      ...teamSummary(),
      members: [],
      viewerAuthorId: 'author-you',
      reactionFrequents: [...REACTION_FREQUENTS_DEFAULT],
    }),
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

    // #team narrates its own work under the composer (`RoomPresenceLine`), so
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
