// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { REACTION_FREQUENTS_DEFAULT } from '@dorkos/shared/room-schemas';
import type { RoomSummary, RoomWithRoster } from '@dorkos/shared/room-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { useRoomDocumentTitle } from '../use-room-document-title';

// ---------------------------------------------------------------------------
// Mocks — the route, which is the only thing here that needs a live router
// ---------------------------------------------------------------------------

let pathname = '/session';
let search: Record<string, unknown> = {};

/**
 * Handlers the hook registered against the global `/api/events` fan-out, so a
 * test can fire one. Stubbed rather than mounting an `EventStreamProvider`,
 * which owns a real SSE connection.
 */
const streamHandlers = new Map<string, () => void>();

vi.mock('@/layers/shared/model', async () => {
  const actual =
    await vi.importActual<typeof import('@/layers/shared/model')>('@/layers/shared/model');
  return {
    ...actual,
    useSafePathname: () => pathname,
    useSafeSearch: () => search,
    useEventSubscription: (event: string, handler: () => void) => {
      streamHandlers.set(event, handler);
    },
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function summary(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    id: 'room-1',
    kind: 'channel',
    slug: 'general',
    title: 'General',
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

function withRoster(overrides: Partial<RoomSummary> = {}): RoomWithRoster {
  return {
    ...summary(overrides),
    members: [],
    viewerAuthorId: 'author-you',
    reactionFrequents: [...REACTION_FREQUENTS_DEFAULT],
  };
}

function wrapperFor(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  pathname = '/session';
  search = {};
  streamHandlers.clear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useRoomDocumentTitle', () => {
  it('names the open channel the way it is spoken', async () => {
    pathname = '/channels';
    search = { id: 'room-1' };
    const transport = createMockTransport({
      getRoom: vi.fn().mockResolvedValue(withRoster()),
      listRooms: vi.fn().mockResolvedValue([summary()]),
    });

    const { result } = renderHook(() => useRoomDocumentTitle(), { wrapper: wrapperFor(transport) });

    // `#general`, not `general` — this string goes in a browser tab, where no
    // mark is drawn beside it.
    await waitFor(() => expect(result.current.roomTitle).toBe('#general'));
  });

  it('ignores a stale ?thread= and names the room in the URL, as ChannelsPage does', async () => {
    // A bookmark from when a thread was a room of its own. `?thread=` used to
    // win over `?id=`; a thread is now a relation between entries inside one
    // room's log (ADR 260728-022013), so the old link opens the room it names
    // rather than a room that no longer exists.
    pathname = '/channels';
    search = { id: 'room-1', thread: 'thread-1' };
    const getRoom = vi.fn().mockResolvedValue(withRoster());
    const transport = createMockTransport({ getRoom, listRooms: vi.fn().mockResolvedValue([]) });

    const { result } = renderHook(() => useRoomDocumentTitle(), { wrapper: wrapperFor(transport) });

    await waitFor(() => expect(result.current.roomTitle).toBe('#general'));
    expect(getRoom).toHaveBeenCalledWith('room-1');
    expect(getRoom).not.toHaveBeenCalledWith('thread-1');
  });

  it('names no room anywhere but /channels, even with a stale id in the URL', async () => {
    pathname = '/session';
    search = { id: 'room-1' };
    const transport = createMockTransport({
      getRoom: vi.fn().mockResolvedValue(withRoster()),
      listRooms: vi.fn().mockResolvedValue([summary()]),
    });

    const { result } = renderHook(() => useRoomDocumentTitle(), { wrapper: wrapperFor(transport) });

    await waitFor(() => expect(result.current.unreadRoomCount).toBe(0));
    expect(result.current.roomTitle).toBeNull();
    expect(transport.getRoom).not.toHaveBeenCalled();
  });

  it('counts rooms that are unread, not the messages in them', async () => {
    const transport = createMockTransport({
      listRooms: vi.fn().mockResolvedValue([
        summary({ id: 'a', slug: 'busy', unreadCount: 40 }),
        summary({ id: 'b', slug: 'quiet', unreadCount: 1 }),
        summary({ id: 'c', slug: 'read', unreadCount: 0 }),
        // Not a member: `null` is "not applicable", never zero.
        summary({ id: 'd', slug: 'never-joined', unreadCount: null }),
      ]),
    });

    const { result } = renderHook(() => useRoomDocumentTitle(), { wrapper: wrapperFor(transport) });

    // Two conversations want you — not the 41 messages they are holding.
    await waitFor(() => expect(result.current.unreadRoomCount).toBe(2));
  });

  it('counts nothing while the list is still loading', () => {
    const pending = new Promise<RoomSummary[]>(() => {});
    const transport = createMockTransport({ listRooms: vi.fn().mockReturnValue(pending) });

    const { result } = renderHook(() => useRoomDocumentTitle(), { wrapper: wrapperFor(transport) });

    expect(result.current).toEqual({ roomTitle: null, unreadRoomCount: 0 });
  });

  it('keeps the badge live with no sidebar mounted anywhere', async () => {
    // The defect this guards: `useRoomListStream` used to be called only by
    // `DashboardSidebar`, which is unmounted on mobile (closed drawer, the
    // default) and on /marketplace. Nothing here renders a sidebar — this is
    // the app shell's own room reading, on its own — so if the subscription
    // ever moves back down into a feature, the count below never moves.
    let quiet = true;
    const listRooms = vi.fn(() =>
      Promise.resolve([
        summary({ id: 'a', slug: 'general', unreadCount: quiet ? 0 : 3 }),
        summary({ id: 'b', slug: 'backend', unreadCount: quiet ? 0 : 1 }),
      ])
    );
    const transport = createMockTransport({ listRooms });

    const { result } = renderHook(() => useRoomDocumentTitle(), { wrapper: wrapperFor(transport) });
    await waitFor(() => expect(listRooms).toHaveBeenCalledTimes(1));
    expect(result.current.unreadRoomCount).toBe(0);

    // Somebody posts in both rooms. The server says so on the global fan-out.
    quiet = false;
    act(() => streamHandlers.get('room_activity')!());

    // Two conversations now want you, and the tab found out without the sidebar.
    await waitFor(() => expect(result.current.unreadRoomCount).toBe(2));
    expect(listRooms).toHaveBeenCalledTimes(2);
  });

  it('subscribes to every event that changes what the badge should say', () => {
    const transport = createMockTransport({ listRooms: vi.fn().mockResolvedValue([]) });
    renderHook(() => useRoomDocumentTitle(), { wrapper: wrapperFor(transport) });

    // A room created, renamed, joined, left or spoken in all move the count.
    // `room_presence` rides along because the same hook owns the room-list
    // subscription — it feeds the sidebar's working dots and never the badge,
    // which is why the count is untouched by it. `room_read_cursor` does move
    // the badge: it is this same person reading on another device, and the tab
    // has to stop asking for their attention when they do.
    expect([...streamHandlers.keys()].sort()).toEqual([
      'room_activity',
      'room_created',
      'room_member_added',
      'room_member_removed',
      'room_presence',
      'room_read_cursor',
      'room_updated',
    ]);
  });
});
