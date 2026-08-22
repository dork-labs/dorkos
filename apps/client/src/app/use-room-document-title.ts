/**
 * What the browser tab has to say about rooms.
 *
 * The two facts `useDocumentTitle` needs and cannot fetch for itself: the room
 * you are reading, and how many rooms are waiting. The hook lives in
 * `shared/model`, which may not reach into `entities/` — so the app shell reads
 * the rooms and hands the answers down, the same way it already hands down the
 * current agent's name and emoji.
 *
 * @module app/use-room-document-title
 */
import { useMemo } from 'react';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import { useSafePathname, useSafeSearch } from '@/layers/shared/model';
import {
  hasUnread,
  roomDisplayTitle,
  useRoom,
  useRoomListStream,
  useRooms,
} from '@/layers/entities/room';

/** The one route whose search params name an open room. */
const ROOMS_PATHNAME = '/channels';

/** The room facts the document title is built from. */
export interface RoomDocumentTitle {
  /**
   * The open room on `/channels`, roster and all, or `null`.
   *
   * The tab needs only its name, but the channel bar needs the room — archived,
   * bridge visibility, working count, head count — and this is the one place the
   * open room is resolved. Handing back the object rather than a second copy of
   * the query is what keeps the bar and the tab reading the same room (spec
   * `one-bar-header` §3.4).
   */
  room: RoomWithRoster | null;
  /** The open room, written the way it is spoken (`#general`), or `null`. */
  roomTitle: string | null;
  /** How many rooms hold unread entries. */
  unreadRoomCount: number;
}

/**
 * Read the open room's name and the number of rooms with unread entries.
 *
 * The name comes from `useRoom`, not from the list, so the tab can never
 * disagree with the header on the same screen — and it costs no request, since
 * `ChannelsPage` reads the same query.
 *
 * Rooms are counted, not messages: `hasUnread` treats a `null` count as "not a
 * member", which is not zero, so a room the operator has only ever looked at is
 * never counted (spec `rooms` §13.1).
 *
 * `id` is the whole address, matching `ChannelsPage`. The count is read on
 * every route, because a tab you have left is exactly the one that needs to say
 * a room is waiting.
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
export function useRoomDocumentTitle(): RoomDocumentTitle {
  useRoomListStream();

  const pathname = useSafePathname();
  const search = useSafeSearch() as { id?: string };
  const roomId = pathname === ROOMS_PATHNAME ? (search.id ?? null) : null;

  const { data: room } = useRoom(roomId);
  const { data: rooms } = useRooms();

  const unreadRoomCount = useMemo(() => (rooms ?? []).filter(hasUnread).length, [rooms]);

  const open = roomId && room ? room : null;

  return {
    room: open,
    roomTitle: open ? roomDisplayTitle(open) : null,
    unreadRoomCount,
  };
}
