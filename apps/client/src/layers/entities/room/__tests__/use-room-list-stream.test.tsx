// @vitest-environment jsdom
/** The global-stream half of the sidebar's freshness (ADR-0265). */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RoomSummary, RoomWithRoster, ThreadSummary } from '@dorkos/shared/room-schemas';
import { roomKeys } from '../api/query-keys';
import { useRoomListStream } from '../model/use-room-list-stream';
import { useRoomWorkingStore } from '../model/live/use-room-working';

/** Handlers registered by the hook, keyed by the event they wait for. */
afterEach(() => {
  vi.useRealTimers();
});

const registry = new Map<string, Array<(payload?: unknown) => void>>();
const handlers = {
  clear: () => registry.clear(),
  set: (event: string, handler: (payload?: unknown) => void) => {
    registry.set(event, [...(registry.get(event) ?? []), handler]);
  },
  get: (event: string): ((payload?: unknown) => void) | undefined => {
    const list = registry.get(event);
    if (!list) return undefined;
    return (payload?: unknown) => list.forEach((h) => h(payload));
  },
  keys: () => registry.keys(),
};

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
    // `room_activity` fires for a thread reply exactly as it does for a top-level post — a reply
    // IS an entry in the room's log (ADR 260728-022013) — so there is no second event to wait
    // for, and this is the only thing that moves a thread row for a room nobody has open.
    const { invalidated } = setup();
    handlers.get('room_activity')!();
    expect(invalidated).toContainEqual(['rooms', 'threads']);
    expect(invalidated).toContainEqual(['rooms', 'list']);
  });

  it('refetches the list when a room starts or stops waiting on a person (DOR-3236)', () => {
    // Unlike presence, this fires only when the count changes, and the list is
    // where a folded section reads it from.
    const { invalidated } = setup();
    handlers.get('room_awaiting')!({ roomId: 'room-1', awaiting: 1 });
    expect(invalidated.length).toBeGreaterThan(0);
  });

  it('feeds the working store from presence without refetching the list', () => {
    // The one event here that must not invalidate: it fires at every claim and again every ten
    // seconds while a turn runs, so refetching on it would turn one busy room into a poll of
    // every row — for a fact the payload carries whole.
    const { invalidated } = setup();
    handlers.get('room_presence')!({ roomId: 'room-1', working: 2 });
    expect(useRoomWorkingStore.getState().rooms['room-1']?.working).toBe(2);
    expect(invalidated).toEqual([]);
  });

  it('refetches an open room once for a burst of roster events, even across tasks', async () => {
    vi.useFakeTimers();
    const { invalidated, queryClient } = setup();
    seedOpenRoom(queryClient, 'me', 0);
    const detail = JSON.stringify(roomKeys.detail('room-1'));
    const refetches = () => invalidated.filter((key) => JSON.stringify(key) === detail).length;

    // Each frame on the stream is its own task, so the burst is spread over time.
    handlers.get('room_member_removed')!({ roomId: 'room-1', authorId: 'agent-1' });
    await vi.advanceTimersByTimeAsync(5);
    handlers.get('room_member_removed')!({ roomId: 'room-1', authorId: 'agent-2' });
    await vi.advanceTimersByTimeAsync(5);
    handlers.get('room_member_added')!({ roomId: 'room-1', authorId: 'agent-3' });
    expect(refetches()).toBe(0);
    await vi.advanceTimersByTimeAsync(50);

    expect(refetches()).toBe(1);
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

    it('never raises a badge, so an out-of-order event cannot un-read a room', () => {
      // Reading can only REDUCE what is unread, so a count that would raise the badge is this
      // event arriving beside a fresher one.
      const { queryClient } = setup();
      seedRoomList(queryClient, 2);

      handlers.get('read_cursor')!(cursorEvent({ unreadCount: 8 }));

      expect(badge(queryClient, 'room-1')).toBe(2);
    });

    it('a list fetch already in flight cannot put the badge back on', async () => {
      // The race the patch has to survive: `room_activity` invalidates the list, its GET is
      // computed while the room is still unread, and it resolves AFTER the cursor event lands.
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

    it('asks again for the list fetch it cancelled, so nothing else that read carried is lost', async () => {
      // The other half of the cancel above (DOR-1358). A cancelled fetch is
      // REVERTED and nothing schedules a replacement, so every fact that
      // response was carrying — a membership after a rejoin, a room somebody
      // created, a rename — is dropped with the stale count. The sidebar then
      // keeps drawing the world as it was until the next room event.
      //
      // Seed the defect by deleting the re-ask in `applyReadCursor` and this
      // goes red: `invalidated` stays empty and the list is never asked again.
      const { invalidated, queryClient } = setup();
      seedRoomList(queryClient, 3);
      const inFlight = queryClient
        .fetchQuery({
          queryKey: ['rooms', 'list', null],
          queryFn: () => new Promise<RoomSummary[]>(() => {}),
        })
        .catch(() => undefined);

      handlers.get('read_cursor')!(cursorEvent());
      await inFlight;

      expect(invalidated).toContainEqual(['rooms', 'list']);
    });

    it('refetches the Threads list only when this room has an unread thread', () => {
      const { invalidated, queryClient } = setup();
      seedRoomList(queryClient, 3);
      queryClient.setQueryData(['rooms', 'threads'], [
        { roomId: 'room-1', rootEntryId: 'e1', unreadCount: 2 },
      ] as unknown as ThreadSummary[]);

      handlers.get('read_cursor')!(cursorEvent());

      // A thread count is measured against this same cursor and cannot be recomputed from it — a
      // ThreadSummary carries no seq — so the one row that cannot be patched is the one that is
      // asked for again.
      expect(invalidated).toContainEqual(['rooms', 'threads']);
    });
  });

  describe('the well-known lookup (the home tab is reading it)', () => {
    function seedWellKnown(queryClient: QueryClient, room: unknown) {
      // Through the factory, never a hand-written path: the whole defect was WHERE this key sits,
      // so a test that spells its own path would keep passing if it moved back under the list
      // prefix.
      queryClient.setQueryData(roomKeys.wellKnown('team'), room);
    }

    it('is not touched by the cursor patch, and the badge still clears', () => {
      const { queryClient } = setup();
      seedRoomList(queryClient, 3);
      seedWellKnown(queryClient, { id: 'team-room', archived: true, unreadCount: 0 });

      expect(() => handlers.get('read_cursor')!(cursorEvent())).not.toThrow();

      // The patch it was interrupting completed.
      expect(badge(queryClient, 'room-1')).toBe(0);
      // And the lookup is exactly as it was — a single room, not mapped over.
      expect(queryClient.getQueryData(roomKeys.wellKnown('team'))).toEqual({
        id: 'team-room',
        archived: true,
        unreadCount: 0,
      });
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
