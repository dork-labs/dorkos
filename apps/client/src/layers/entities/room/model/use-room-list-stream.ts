/**
 * Keep the sidebar's room list and thread list honest about rooms the reader
 * does not have open.
 *
 * A room's entries ride its own `/api/rooms/:id/events` stream, which only the
 * open room subscribes to. Everything else a list row shows — a channel someone
 * else just created, a room that moved up the activity order, a title that
 * changed, an unread count — arrives on the global `/api/events` fan-out, which
 * is already connected for the session list (ADR-0265). Riding it costs no
 * second connection and replaces a poll.
 *
 * @module entities/room/model/use-room-list-stream
 */
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { RoomSummary, RoomWithRoster, ThreadSummary } from '@dorkos/shared/room-schemas';
import { useEventSubscription } from '@/layers/shared/model';
import { roomKeys } from '../api/query-keys';
import { useRoomWorkingStore } from './use-room-working';

/** Global events that change what a room list row says. */
const ROOM_LIST_EVENTS = [
  'room_created',
  'room_updated',
  'room_member_added',
  'room_member_removed',
  'room_activity',
] as const;

/**
 * What a `read_cursor` broadcast says: whose cursor moved, in what, and to
 * where.
 *
 * One event answers for every kind of thread a person reads — a room, an agent
 * session, the inbox (team-room-home §D4) — so this narrows to the room ones and
 * leaves the rest to whoever draws them.
 */
interface ReadCursorMoved {
  userId: string;
  threadId: string;
  lastReadSeq: number;
  /** What this room's badge should now read — computed by the server. */
  unreadCount: number;
}

/**
 * Is this an event that says a ROOM read cursor moved?
 *
 * The payload arrives as `unknown` — the fan-out is a string-keyed channel and
 * nothing types the two ends together — so it is checked rather than trusted. A
 * malformed event is dropped silently, like the presence count beside it: this
 * clears a badge, and a badge is not worth a console the operator reads past.
 *
 * `unreadCount` is required HERE and optional on the wire: the server sends it
 * for a room because a room is the only thread whose badge the server can count,
 * and an event without one is an event this hook has nothing to patch with.
 * Dropping it leaves the badge exactly as it was, which beats guessing zero.
 */
function isReadCursorMoved(payload: unknown): payload is ReadCursorMoved {
  if (typeof payload !== 'object' || payload === null) return false;
  const { userId, threadKind, threadId, lastReadSeq, unreadCount } = payload as Record<
    string,
    unknown
  >;
  return (
    threadKind === 'room' &&
    typeof userId === 'string' &&
    userId.length > 0 &&
    typeof threadId === 'string' &&
    threadId.length > 0 &&
    typeof lastReadSeq === 'number' &&
    typeof unreadCount === 'number'
  );
}

/**
 * Whether a cursor that moved is THIS reader's own.
 *
 * An agent's never reaches here at all: `read_cursor` is the people's event by
 * contract, and an agent advancing its own cursor as it takes turns
 * (room-participation §8.3) is silent. What is left is telling two PEOPLE apart,
 * which needs `viewerAuthorId` — it rides the room detail and is therefore only
 * in hand for rooms this client has opened; where it is, it decides, and where
 * it is not, a single-human install (ADR 260727-184933 D6) makes the remaining
 * answer yes. The day a second person shares an install, this is the line that
 * has to learn who the reader is without a room open.
 */
function movedByReader(queryClient: QueryClient, event: ReadCursorMoved): boolean {
  const open = queryClient.getQueryData<RoomWithRoster>(roomKeys.detail(event.threadId));
  return open === undefined || open.viewerAuthorId === event.userId;
}

/**
 * Apply a cursor this reader moved somewhere else to the caches that draw it.
 *
 * Patched rather than invalidated, so the badge on the second device goes out on
 * the event instead of on the round trip after it — which is the whole point of
 * carrying the count on the wire. The count comes from the server because a room
 * summary holds no seq to measure the new cursor against, so this client could
 * only guess zero and be wrong about anything that arrived in between.
 *
 * The one round trip it can still cost is a replacement for the list fetch its
 * own cancel interrupted, if there was one — see the re-ask at the end.
 */
function applyReadCursor(queryClient: QueryClient, event: ReadCursorMoved): void {
  // Cancel before writing — the ordering every optimistic update needs. A list
  // GET already in flight was computed BEFORE this cursor moved, so its response
  // carries the old count and would land on top of the patch below and put the
  // badge back on, where it would stay until the next thing to touch the list.
  // (`room_activity` starts exactly such a refetch, which is how the two race.)
  //
  // Whether anything was actually interrupted has to be read BEFORE the cancel,
  // because afterwards there is nothing left to ask — see the re-ask at the end
  // of this function for what it is for.
  const interrupted = queryClient.isFetching({ queryKey: roomKeys.lists() }) > 0;
  void queryClient.cancelQueries({ queryKey: roomKeys.lists() });

  // `null` means "not a member here", which is not a number to overwrite.
  //
  // **Only ever downwards**, which is the same monotonic rule the cursor itself
  // keeps. Reading can only reduce what is unread, so a count that would RAISE
  // the badge is this event arriving out of order with a fresher one — the case
  // is a `room_activity` refetch in flight when the cursor lands, whose response
  // was computed before the cursor moved and resolves after this patch. Taking
  // the lower of the two means whichever of them arrives last is still right.
  //
  // **The guard is not defensive noise.** This writes by PREFIX, so it reaches
  // every cache entry under `lists()` — including any future key somebody nests
  // there whose data is not a list of rooms. One such key already existed (the
  // well-known lookup, whose data is a single room or `null`), and mapping over
  // it threw a `TypeError` out of an event handler: on the in-process transport
  // that takes the whole global stream down with it. That key was moved out
  // (`roomKeys.wellKnown`), and this stays so the next one is merely ignored.
  queryClient.setQueriesData<RoomSummary[]>({ queryKey: roomKeys.lists() }, (rooms) =>
    Array.isArray(rooms)
      ? rooms.map((room) =>
          room.id === event.threadId && room.unreadCount !== null
            ? { ...room, unreadCount: Math.min(room.unreadCount, event.unreadCount) }
            : room
        )
      : rooms
  );

  // The open room's own copy of the cursor. Without this the reader's membership
  // still says what it said before, so `useMarkRoomRead` would write a cursor the
  // server already holds — and the unread rule would be measured from a number
  // this client knows is stale. `Math.max` keeps the client-side rule the server
  // enforces: a cursor never walks backwards.
  queryClient.setQueryData<RoomWithRoster>(roomKeys.detail(event.threadId), (room) =>
    room
      ? {
          ...room,
          members: room.members.map((member) =>
            member.authorId === event.userId
              ? { ...member, lastReadSeq: Math.max(member.lastReadSeq, event.lastReadSeq) }
              : member
          ),
        }
      : room
  );

  // Threads are refetched rather than patched: a `ThreadSummary` carries no seq,
  // so its unread count cannot be recomputed from a cursor — only the server can
  // say how many replies are still above it. Asked only when this room actually
  // has an unread thread row on screen, so the ordinary case (open a room, no
  // threads in it) costs no request at all.
  const threads = queryClient.getQueryData<ThreadSummary[]>(roomKeys.threads());
  if (threads?.some((thread) => thread.roomId === event.threadId && thread.unreadCount > 0)) {
    void queryClient.invalidateQueries({ queryKey: roomKeys.threads() });
  }

  // Ask again for whatever the cancel above threw away (DOR-1358).
  //
  // A cancelled fetch is REVERTED, and TanStack schedules nothing in its place:
  // the query goes back to idle holding the data it had, and stays there until
  // something else invalidates it. So the cancel does not merely postpone "an
  // ordering bump, a renamed room" — it DROPS them, along with anything else
  // that response was carrying, for as long as the room list is quiet.
  //
  // The case that made this visible: a person rejoins a channel, the rejoin
  // invalidates the list, and a cursor event lands while that GET is in flight
  // — from their phone, or from any other room, since a cursor in a room this
  // client has never opened reaches here too. The list is reverted to the copy
  // where they are still not a member, and the sidebar row goes on saying "Left"
  // in a channel they are back in.
  //
  // Only ever paid for by an interrupted fetch, and in the OPEN room that is
  // routine rather than rare: `useMarkRoomRead` invalidates the list on success
  // and the server echoes the `read_cursor` back to this client, so the
  // mutation's own list GET is usually the fetch this cancels. About one extra
  // list GET per cursor advance, self-limiting. With nothing in flight there is
  // nothing to make good, and turning every cursor into a refetch is exactly
  // what patching the badge in place exists to avoid. The patch is written
  // first, so the badge is already right while the replacement GET runs — and
  // that GET is computed AFTER the cursor moved, so its answer agrees with it.
  if (interrupted) void queryClient.invalidateQueries({ queryKey: roomKeys.lists() });
}

/**
 * Refresh the room list whenever a room is created, changed, or spoken in.
 *
 * **Call once, from something that is always mounted** — today that is
 * `useRoomDocumentTitle` in the app shell, not the sidebar. A room list read
 * outside the caller's own subtree (the browser tab's unread badge is) goes
 * stale the moment that caller unmounts, and the sidebar unmounts on mobile and
 * on `/marketplace`. The invalidation is deliberately blunt — a list row is
 * cheap to refetch and the alternative is patching five event shapes into a
 * cache by hand, which is five chances to drift from the server.
 *
 * Two events here are handled rather than refetched, each because the payload
 * already carries the whole answer: presence, and a read cursor moving on
 * another device.
 */
export function useRoomListStream(): void {
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: roomKeys.lists() });
    // By name, because the well-known lookup is deliberately not under the list
    // prefix (`roomKeys.wellKnown` says why). It is what the home tab reads to
    // decide whether #team is here, put away, or not opened yet, so it has to
    // be refreshed by the same events — a room created, un-archived or renamed
    // in another tab must not leave Home describing the world as it was.
    void queryClient.invalidateQueries({ queryKey: roomKeys.wellKnowns() });
    // The Threads section is refreshed by the same events, and has to be: a
    // reply lands in a room nobody has open, and the row that has to notice is
    // in the sidebar rather than in the room. `room_activity` fires for a thread
    // reply exactly as it does for a top-level post — a reply IS an entry in the
    // room's log (ADR 260728-022013), so there is no second event to wait for.
    void queryClient.invalidateQueries({ queryKey: roomKeys.threads() });
  };

  // A fixed-length literal tuple, so the hook count never varies between
  // renders — this is a loop over constants, not over data.
  useEventSubscription(ROOM_LIST_EVENTS[0], refresh);
  useEventSubscription(ROOM_LIST_EVENTS[1], refresh);
  useEventSubscription(ROOM_LIST_EVENTS[2], refresh);
  useEventSubscription(ROOM_LIST_EVENTS[3], refresh);
  useEventSubscription(ROOM_LIST_EVENTS[4], refresh);

  // Presence is the one room-list event that must NOT refetch. It fires when a
  // claim is taken and again every ten seconds while the work runs, so treating
  // it like the five above would turn every busy room into a poll of the whole
  // list — for a fact the event already carries in full. It goes to a store the
  // rows read directly instead.
  useEventSubscription('room_presence', (payload) =>
    useRoomWorkingStore.getState().observe(payload)
  );

  // The same reader, reading on another device. Their cursor moved there, so the
  // badge has to go out here — on the event, not on the next poll of the list.
  useEventSubscription('read_cursor', (payload) => {
    if (!isReadCursorMoved(payload) || !movedByReader(queryClient, payload)) return;
    applyReadCursor(queryClient, payload);
  });
}
