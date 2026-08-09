/**
 * The rooms the command palette offers (spec `rooms` §13.2).
 *
 * `#` addresses a channel — a room is named — and `@` addresses a direct
 * message alongside the agents, because a DM is addressed by who is in it. That
 * split is the whole reason this hook hands back two lists rather than one.
 *
 * Read-only, like the sidebar's own use. `useRoomListStream` is called once,
 * from something always mounted (`use-room-list-stream.ts` says so itself);
 * today that is `use-room-document-title.ts:61`. A second call here would only
 * duplicate invalidations on the same shared `/api/events` subscription.
 *
 * @module features/command-palette/model/use-palette-rooms
 */
import { useMemo } from 'react';
import { useRooms, hasUnread, type RoomSummary } from '@/layers/entities/room';
import { sortRoomsForPalette } from './palette-rooms';

/** The room list, split the way the palette's two prefixes address it. */
export interface PaletteRooms {
  /** What `#` addresses: channels. */
  channels: RoomSummary[];
  /** What `@` addresses beside the agents: direct messages. */
  dms: RoomSummary[];
  /**
   * Every room with something waiting, most recent first — what the palette
   * shows before anything is typed.
   */
  unread: RoomSummary[];
  /** Whether the room list is still on its way. */
  isLoading: boolean;
  /** Whether the room list failed to load. */
  isError: boolean;
}

/**
 * Read every room the cockpit can see and put it in palette order.
 *
 * Both lists come back unread-first, so `#` with nothing typed after it leads
 * with the channel that needs reading rather than the alphabetically luckiest
 * one.
 */
export function usePaletteRooms(): PaletteRooms {
  // The one caller anywhere that asks for archived rooms. A channel somebody
  // closed used to disappear from the product entirely — the route could always
  // list them, nothing ever asked (DOR-1051) — and search is the honest place
  // to bring it back: you go looking for it by name, rather than being shown it.
  //
  // It buys its own cache entry (`roomKeys.listWithArchived`), so the sidebar,
  // the room view and the presence strip keep reading a list with no archived
  // rooms in it. One shared key would mean whichever of us fetched last decided
  // what all of them showed.
  const { data, isLoading, isError } = useRooms({ includeArchived: true });

  return useMemo(() => {
    const rooms = data ?? [];
    // `=== 'channel'`, the same predicate the sidebar's `useRoomsByKind` uses,
    // so the two room lists cannot disagree. This was `!== 'dm'` while a thread
    // was a room and the palette carried them; a thread is a relation between
    // entries now and never a row in a room list (ADR 260728-022013).
    const channels = sortRoomsForPalette(rooms.filter((r) => r.kind === 'channel'));
    const dms = sortRoomsForPalette(rooms.filter((r) => r.kind === 'dm'));
    return {
      channels,
      dms,
      // Built from the two addressable lists rather than from `rooms` again, so
      // a room can only be badged here if it is somewhere a person can also
      // find it. Filtering `rooms` directly would be a second, parallel
      // predicate — the shape that once let a row the `#` list had excluded
      // back in through the Unread group.
      //
      // Archived rooms are left out of it. They are in the two lists above so
      // they can be SEARCHED for; the unread group is what Cmd+K then Enter
      // opens, and a channel somebody closed is not work waiting on you —
      // however many entries it ended on.
      unread: sortRoomsForPalette(
        [...channels, ...dms].filter((room) => !room.archived && hasUnread(room))
      ),
      isLoading,
      isError,
    };
  }, [data, isLoading, isError]);
}
