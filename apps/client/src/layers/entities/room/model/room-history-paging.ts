/**
 * How far back into each room this client has read, and whether there is more.
 *
 * **Its own store rather than a field on the history**, because the history
 * cache entry is one flat array in `seq` order and has to stay that: the live
 * stream merges into it, the read cursor takes its last element, and every
 * consumer reads it as "the room's log so far". The page boundary is a fact
 * ABOUT that array which the array itself cannot hold — a thread root riding
 * with a page sits at an arbitrary distance below it, so the oldest element is
 * routinely not the oldest of the last page (DOR-690, DOR-1734).
 *
 * Keyed by room and never cleared on unmount, deliberately: on a phone the
 * thread panel is a full-screen push that unmounts the room column, and a
 * reader who had loaded four pages back must not come out of a thread with one.
 * The history cache it describes outlives the same unmount for the same reason.
 *
 * @module entities/room/model/room-history-paging
 */
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

/** Where one room's loaded history stops, and whether anything is below it. */
export interface RoomHistoryPaging {
  /**
   * The `seq` to pass as `?before=` to read the page directly older than what
   * is loaded — the oldest entry of the oldest PAGE, never of the merged array.
   *
   * `null` when the room answered an empty page, which is the only honest
   * "there is nothing older" this client can have.
   */
  cursor: number | null;
  /**
   * True once the room has answered a page with nothing new in it.
   *
   * Set from what came BACK rather than from the size of what was asked for.
   * A page can be short for reasons that are not the beginning of the room, and
   * it can be exactly full with nothing behind it; the one thing that always
   * means "stop" is a read that moved the cursor nowhere.
   */
  exhausted: boolean;
}

/** Each room's history boundary. */
interface RoomHistoryPagingState {
  /** Room id → where its loaded history stops. */
  paging: Record<string, RoomHistoryPaging | undefined>;
}

/** Ways the boundary moves. */
interface RoomHistoryPagingActions {
  /**
   * Record where a page left the boundary.
   *
   * @param roomId - The room the page came from.
   * @param cursor - The page's own oldest `seq` (`olderCursor`), or `null` when
   *   the page was empty.
   * @param exhausted - True when this read found nothing older than what was
   *   already held.
   */
  notePage: (roomId: string, cursor: number | null, exhausted: boolean) => void;
}

/** The per-room history-boundary store. */
export const useRoomHistoryPagingStore = create<
  RoomHistoryPagingState & RoomHistoryPagingActions
>()(
  devtools(
    (set) => ({
      paging: {},

      notePage: (roomId, cursor, exhausted) =>
        set(
          (state) => {
            const held = state.paging[roomId];
            if (held?.cursor === cursor && held.exhausted === exhausted) return state;
            return { paging: { ...state.paging, [roomId]: { cursor, exhausted } } };
          },
          false,
          'roomHistoryPaging/notePage'
        ),
    }),
    { name: 'RoomHistoryPagingStore' }
  )
);

/**
 * Whether one room has history the reader has not loaded, as far as this client
 * can tell.
 *
 * **Optimistic until proven otherwise**, which is what makes the affordance
 * honest without a second round trip: a room whose first page has not been read
 * yet says `false` (there is nothing to load older THAN), and one that has says
 * `true` until a read comes back with nothing new. The cost of being wrong is
 * one press that finds nothing and takes the control away; the cost of the
 * other guess is history a reader is never offered.
 *
 * @param roomId - The room on screen, or `null` when none is.
 */
export function useRoomHasOlderHistory(roomId: string | null): boolean {
  return useRoomHistoryPagingStore((state) => {
    if (roomId === null) return false;
    const paging = state.paging[roomId];
    return paging !== undefined && paging.cursor !== null && !paging.exhausted;
  });
}
