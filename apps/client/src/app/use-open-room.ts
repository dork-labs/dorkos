/**
 * The room open on `/channels`, and how many rooms are waiting.
 *
 * Two facts the app shell needs and resolves once: the open room, which the
 * channel bar reads, and the count of rooms with unread entries, which the
 * window title shows as `(N)` while the window is hidden.
 *
 * @module app/use-open-room
 */
import { useMemo } from 'react';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import { useSafePathname, useSafeSearch } from '@/layers/shared/model';
import { hasUnread, useRoom, useRoomListStream, useRooms } from '@/layers/entities/room';

/** The one route whose search params name an open room. */
const ROOMS_PATHNAME = '/channels';

/** The room facts the app shell reads. */
export interface OpenRoom {
  /**
   * The open local room on `/channels`, roster and all, or `null`.
   *
   * The channel bar needs the room — archived, bridge visibility, working
   * count, head count — and this is the one place the open room is resolved,
   * so the bar and the page read the same room (spec `one-bar-header` §3.4).
   * A connected community's room is read through that community, not here.
   */
  room: RoomWithRoster | null;
  /** How many rooms hold unread entries. */
  unreadRoomCount: number;
}

/**
 * Read the open room and the number of rooms with unread entries.
 *
 * Rooms are counted, not messages: `hasUnread` treats a `null` count as "not a
 * member", which is not zero, so a room the operator has only ever looked at is
 * never counted (spec `rooms` §13.1). The count is read on every route, because
 * a tab you have left is exactly the one that needs to say a room is waiting.
 *
 * **This hook owns the room list's live subscription, deliberately.**
 * `useRoomListStream` used to be called by `DashboardSidebar`, which was fine
 * while the sidebar was the only thing reading the list — it self-healed on
 * mount. It is not always mounted: on mobile the body lives in a `SheetContent`
 * with no `forceMount` and is gone whenever the drawer is closed (the default),
 * and `/marketplace` swaps the whole body out for its own. A badge that only
 * refreshes where the sidebar renders is frozen exactly where §13.3 needs it
 * live — a backgrounded tab. So the subscription sits with the always-mounted
 * consumer rather than one route's worth of UI, and cannot drift from it again.
 * The query is shared, so the sidebar keeps getting fresh rows for free.
 */
export function useOpenRoom(): OpenRoom {
  useRoomListStream();

  const pathname = useSafePathname();
  const search = useSafeSearch() as { id?: string; community?: string };
  const roomId = pathname === ROOMS_PATHNAME && !search.community ? (search.id ?? null) : null;

  const { data: room } = useRoom(roomId);
  const { data: rooms } = useRooms();

  const unreadRoomCount = useMemo(() => (rooms ?? []).filter(hasUnread).length, [rooms]);

  return { room: roomId && room ? room : null, unreadRoomCount };
}
