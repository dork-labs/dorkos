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
import { useSafePathname, useSafeSearch } from '@/layers/shared/model';
import { hasUnread, roomDisplayTitle, useRoom, useRooms } from '@/layers/entities/room';

/** The one route whose search params name an open room. */
const ROOMS_PATHNAME = '/channels';

/** The room facts the document title is built from. */
export interface RoomDocumentTitle {
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
 * `thread` wins over `id` when both are in the URL, matching `ChannelsPage`: a
 * thread is a room in its own right and is what renders. The count is read on
 * every route, because a tab you have left is exactly the one that needs to say
 * a room is waiting.
 */
export function useRoomDocumentTitle(): RoomDocumentTitle {
  const pathname = useSafePathname();
  const search = useSafeSearch() as { id?: string; thread?: string };
  const roomId = pathname === ROOMS_PATHNAME ? (search.thread ?? search.id ?? null) : null;

  const { data: room } = useRoom(roomId);
  const { data: rooms } = useRooms();

  const unreadRoomCount = useMemo(() => (rooms ?? []).filter(hasUnread).length, [rooms]);

  return {
    roomTitle: roomId && room ? roomDisplayTitle(room) : null,
    unreadRoomCount,
  };
}
