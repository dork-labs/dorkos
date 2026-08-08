// @vitest-environment jsdom
/**
 * The global-stream half of the sidebar's freshness (ADR-0265).
 *
 * A room the reader does not have open sends nothing to this client except
 * through `/api/events`, so what this hook subscribes to IS the mechanism —
 * a row that is not refreshed here is a row that stays wrong until something
 * unrelated happens to refetch it. Both lists it feeds are asserted, because
 * the thread list rides the same events and was added to them later.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RoomSummary, RoomWithRoster, ThreadSummary } from '@dorkos/shared/room-schemas';
import { useRoomListStream } from '../model/use-room-list-stream';
import { useRoomWorkingStore } from '../model/use-room-working';

/** Handlers registered by the hook, keyed by the event they wait for. */
const handlers = new Map<string, (payload?: unknown) => void>();

vi.mock('@/layers/shared/model', () => ({
  useEventSubscription: (event: string, handler: (payload?: unknown) => void) => {
    handlers.set(event, handler);
  },
}));

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidated: unknown[] = [];
  const spy = queryClient.invalidateQueries.bind(queryClient);
  queryClient.invalidateQueries = ((filters?: { queryKey?: unknown }) => {
    invalidated.push(filters?.queryKey);
    return spy(filters as Parameters<typeof spy>[0]);
  }) as typeof queryClient.invalidateQueries;

  renderHook(() => useRoomListStream(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
  return { invalidated, queryClient };
}

/** A room list holding one room with `unread` messages the reader has not seen. */
function seedRoomList(queryClient: QueryClient, unread: number | null) {
  queryClient.setQueryData(['rooms', 'list', null], [
    { id: 'room-1', kind: 'channel', title: 'Backend', unreadCount: unread },
    { id: 'room-2', kind: 'channel', title: 'Design', unreadCount: 4 },
  ] as unknown as RoomSummary[]);
}

/** The open room, as `GET /api/rooms/:id` answers it for `viewer`. */
function seedOpenRoom(queryClient: QueryClient, viewer: string, lastReadSeq: number) {
  queryClient.setQueryData(['rooms', 'detail', 'room-1'], {
    id: 'room-1',
    viewerAuthorId: viewer,
    members: [
      { roomId: 'room-1', authorId: viewer, lastReadSeq },
      { roomId: 'room-1', authorId: 'agent-1', lastReadSeq: 0 },
    ],
  } as unknown as RoomWithRoster);
}

/** One `read_cursor` broadcast for a room, as the server sends it. */
function cursorEvent(over: Partial<Record<string, unknown>> = {}) {
  return {
    userId: 'me',
    threadKind: 'room',
    threadId: 'room-1',
    lastReadSeq: 7,
    unreadCount: 0,
    ...over,
  };
}

/** The unread count the room list now draws for `roomId`. */
function badge(queryClient: QueryClient, roomId: string): number | null | undefined {
  return queryClient
    .getQueryData<RoomSummary[]>(['rooms', 'list', null])
    ?.find((room) => room.id === roomId)?.unreadCount;
}

describe('useRoomListStream', () => {
  beforeEach(() => handlers.clear());

  it('refreshes the Threads list when somebody speaks in a room', () => {
    // `room_activity` fires for a thread reply exactly as it does for a
    // top-level post — a reply IS an entry in the room's log
    // (ADR 260728-022013) — so there is no second event to wait for, and this
    // is the only thing that moves a thread row for a room nobody has open.
    const { invalidated } = setup();
    handlers.get('room_activity')!();
    expect(invalidated).toContainEqual(['rooms', 'threads']);
    expect(invalidated).toContainEqual(['rooms', 'list']);
  });

  it('subscribes to every event that changes what a row says', () => {
    setup();
    expect([...handlers.keys()].sort()).toEqual([
      'read_cursor',
      'room_activity',
      'room_created',
      'room_member_added',
      'room_member_removed',
      'room_presence',
      'room_updated',
    ]);
  });

  it('feeds the working store from presence without refetching the list', () => {
    // The one event here that must not invalidate: it fires at every claim and
    // again every ten seconds while a turn runs, so refetching on it would turn
    // one busy room into a poll of every row — for a fact the payload carries
    // whole. Seed the defect by calling `refresh` from the presence handler and
    // the second assertion goes red.
    const { invalidated } = setup();
    handlers.get('room_presence')!({ roomId: 'room-1', working: 2 });
    expect(useRoomWorkingStore.getState().rooms['room-1']?.working).toBe(2);
    expect(invalidated).toEqual([]);
  });

  it('refreshes both lists when a member is removed', () => {
    // Not cosmetic for threads: the aggregation joins on the roster, so losing
    // a membership removes that room's threads from this reader's list
    // entirely. The row has to go on the same event that took the room away.
    const { invalidated } = setup();
    handlers.get('room_member_removed')!();
    expect(invalidated).toContainEqual(['rooms', 'threads']);
    expect(invalidated).toContainEqual(['rooms', 'list']);
  });

  describe('a cursor this reader moved on another device', () => {
    it('clears the badge in place, without asking the server anything', () => {
      const { invalidated, queryClient } = setup();
      seedRoomList(queryClient, 3);

      handlers.get('read_cursor')!(cursorEvent());

      expect(badge(queryClient, 'room-1')).toBe(0);
      // The point of carrying the count on the wire: no refetch stands between
      // the event and the badge going out.
      expect(invalidated).toEqual([]);
    });

    it('draws the count the server sent, not zero', () => {
      // The other device stopped reading at seq 7 and two messages landed after
      // it. A client that assumed "somebody read it, so it is clear" would wipe
      // a badge that is still owed.
      const { queryClient } = setup();
      seedRoomList(queryClient, 5);

      handlers.get('read_cursor')!(cursorEvent({ unreadCount: 2 }));

      expect(badge(queryClient, 'room-1')).toBe(2);
      expect(badge(queryClient, 'room-2')).toBe(4);
    });

    it('moves the open room copy of the cursor, so the reader is not re-marked', () => {
      const { queryClient } = setup();
      seedOpenRoom(queryClient, 'me', 2);

      handlers.get('read_cursor')!(cursorEvent());

      const room = queryClient.getQueryData<RoomWithRoster>(['rooms', 'detail', 'room-1']);
      expect(room?.members.find((m) => m.authorId === 'me')?.lastReadSeq).toBe(7);
      expect(room?.members.find((m) => m.authorId === 'agent-1')?.lastReadSeq).toBe(0);
    });

    it('never raises a badge, so an out-of-order event cannot un-read a room', () => {
      // Reading can only REDUCE what is unread, so a count that would raise the
      // badge is this event arriving beside a fresher one. The lower of the two
      // is the one that can still be true.
      const { queryClient } = setup();
      seedRoomList(queryClient, 2);

      handlers.get('read_cursor')!(cursorEvent({ unreadCount: 8 }));

      expect(badge(queryClient, 'room-1')).toBe(2);
    });

    it('a list fetch already in flight cannot put the badge back on', async () => {
      // The race the patch has to survive: `room_activity` invalidates the list,
      // its GET is computed while the room is still unread, and it resolves AFTER
      // the cursor event lands. Without the cancel, that stale response overwrites
      // the cleared badge and the room reads as unread until something else
      // refetches it.
      const { queryClient } = setup();
      seedRoomList(queryClient, 3);
      let resolveStale = (_rooms: RoomSummary[]): void => {};
      const inFlight = queryClient
        .fetchQuery({
          queryKey: ['rooms', 'list', null],
          queryFn: () =>
            new Promise<RoomSummary[]>((resolve) => {
              resolveStale = resolve;
            }),
        })
        // Cancelling rejects the fetch, which is the expected end of this one.
        .catch(() => undefined);

      handlers.get('read_cursor')!(cursorEvent());
      resolveStale([
        { id: 'room-1', kind: 'channel', title: 'Backend', unreadCount: 3 },
      ] as unknown as RoomSummary[]);
      await inFlight;

      expect(badge(queryClient, 'room-1')).toBe(0);
    });

    it('never walks the open room cursor backwards', () => {
      // The same monotonic rule the server keeps. This client can be AHEAD of the
      // event: it read to seq 9 a moment ago, and a cursor event for seq 7 is one
      // that was already true when it was sent.
      const { queryClient } = setup();
      seedOpenRoom(queryClient, 'me', 9);

      handlers.get('read_cursor')!(cursorEvent());

      const room = queryClient.getQueryData<RoomWithRoster>(['rooms', 'detail', 'room-1']);
      expect(room?.members.find((m) => m.authorId === 'me')?.lastReadSeq).toBe(9);
    });

    it('leaves a room the list has never heard of alone', () => {
      const { queryClient } = setup();
      seedRoomList(queryClient, 3);

      handlers.get('read_cursor')!(cursorEvent({ threadId: 'room-9' }));

      expect(badge(queryClient, 'room-1')).toBe(3);
      expect(badge(queryClient, 'room-2')).toBe(4);
    });

    it('mints nothing when this client has never read a list or a room', () => {
      // A cache entry invented here would be a room summary and a roster nobody
      // fetched — read by the sidebar as truth, and never refetched, because a
      // query with data is not a query that is missing.
      const { queryClient } = setup();

      handlers.get('read_cursor')!(cursorEvent());

      expect(queryClient.getQueryData(['rooms', 'list', null])).toBeUndefined();
      expect(queryClient.getQueryData(['rooms', 'detail', 'room-1'])).toBeUndefined();
    });

    it('refetches the Threads list only when this room has an unread thread', () => {
      const { invalidated, queryClient } = setup();
      seedRoomList(queryClient, 3);
      queryClient.setQueryData(['rooms', 'threads'], [
        { roomId: 'room-1', rootEntryId: 'e1', unreadCount: 2 },
      ] as unknown as ThreadSummary[]);

      handlers.get('read_cursor')!(cursorEvent());

      // A thread count is measured against this same cursor and cannot be
      // recomputed from it — a ThreadSummary carries no seq — so the one row
      // that cannot be patched is the one that is asked for again.
      expect(invalidated).toContainEqual(['rooms', 'threads']);
    });

    it('leaves the Threads list alone when nothing in the room was unread', () => {
      const { invalidated, queryClient } = setup();
      seedRoomList(queryClient, 3);
      queryClient.setQueryData(['rooms', 'threads'], [
        { roomId: 'room-1', rootEntryId: 'e1', unreadCount: 0 },
        { roomId: 'room-2', rootEntryId: 'e2', unreadCount: 5 },
      ] as unknown as ThreadSummary[]);

      handlers.get('read_cursor')!(cursorEvent());

      expect(invalidated).toEqual([]);
    });
  });

  describe('a cursor that is not this reader', () => {
    it('ignores a cursor in something that is not a room', () => {
      // One event answers for rooms, agent sessions and the inbox alike, so a
      // session's cursor arrives here too — and patching a room badge from it
      // would clear an unread room because a chat was read.
      const { queryClient } = setup();
      seedRoomList(queryClient, 3);

      handlers.get('read_cursor')!(cursorEvent({ threadKind: 'session' }));

      expect(badge(queryClient, 'room-1')).toBe(3);
    });

    it('ignores another person reading a room this client has open', () => {
      const { queryClient } = setup();
      seedRoomList(queryClient, 3);
      seedOpenRoom(queryClient, 'me', 2);

      handlers.get('read_cursor')!(cursorEvent({ userId: 'someone-else' }));

      expect(badge(queryClient, 'room-1')).toBe(3);
    });

    it('leaves the badge alone when a room cursor arrives without a count', () => {
      // The count is the only thing this hook can patch a badge with — a room
      // summary carries no seq to recompute one from — so an event without it is
      // one there is nothing to do about. Leaving the badge as it stands is the
      // conservative half of that: guessing zero would clear a room that still
      // has messages in it. The server does not send this shape for a room (the
      // room domain computes the count on both routes), so this pins the guard
      // rather than a case in flight.
      const { queryClient, invalidated } = setup();
      seedRoomList(queryClient, 3);
      const { unreadCount: _dropped, ...countless } = cursorEvent();

      handlers.get('read_cursor')!(countless);

      expect(badge(queryClient, 'room-1')).toBe(3);
      expect(invalidated).toEqual([]);
    });

    it('drops a malformed event instead of writing rubbish into the badge', () => {
      const { queryClient } = setup();
      seedRoomList(queryClient, 3);

      handlers.get('read_cursor')!({ threadKind: 'room', threadId: 'room-1' });
      handlers.get('read_cursor')!(null);

      expect(badge(queryClient, 'room-1')).toBe(3);
    });

    it('leaves a room this reader has not joined without a count', () => {
      // `null` is "not a member here", which is not a number to overwrite —
      // writing 0 there would draw a read room where there is no cursor at all.
      const { queryClient } = setup();
      seedRoomList(queryClient, null);

      handlers.get('read_cursor')!(cursorEvent());

      expect(badge(queryClient, 'room-1')).toBeNull();
    });
  });

  it('never invalidates the bare root key, which would sweep the histories', () => {
    const { invalidated } = setup();
    handlers.get('room_activity')!();
    // `['rooms']` prefix-matches `['rooms','entries',id]`, and a room's history
    // belongs to its own stream.
    expect(invalidated).not.toContainEqual(['rooms']);
  });
});
