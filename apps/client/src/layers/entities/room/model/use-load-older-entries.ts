/**
 * Reading a room further back than the page it opened on (DOR-1734).
 *
 * @module entities/room/model/use-load-older-entries
 */
import { useCallback, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ROOM_ENTRY_PAGE_SIZE_DEFAULT, type RoomEntry } from '@dorkos/shared/room-schemas';
import { useTransport } from '@/layers/shared/model';
import { roomKeys } from '../api/query-keys';
import { mergeRoomHistory, olderCursor, pageReachesTheBeginning } from '../lib/history';
import { useRoomHasOlderHistory, useRoomHistoryPagingStore } from './room-history-paging';

/** What a surface needs to offer "read older" and say whether it did anything. */
export interface LoadOlderRoomEntries {
  /**
   * True when this room has history the reader has not loaded yet.
   *
   * False before the first page has arrived, and false the moment a read comes
   * back short — which is most rooms on their FIRST read, since most rooms are
   * smaller than one page. So a surface can draw the control from this alone,
   * and the overwhelmingly common room never draws it at all.
   */
  canLoadOlder: boolean;
  /** True while a page is on its way. */
  isLoadingOlder: boolean;
  /**
   * The `seq` the next read will page from — the oldest entry of the oldest
   * page loaded, or `null` when there is nothing to page from yet.
   *
   * Published because it is also the row a caller has to put the reader back
   * on: it names the message that was at the ceiling of the history when the
   * press happened, which is exactly the boundary the new page lands above.
   * A caller reaching into the merged array for that row instead would find a
   * thread root sitting in front of the page — the same trap `olderCursor`
   * exists to keep this hook out of.
   */
  cursor: number | null;
  /**
   * Read the page directly older than what is loaded and prepend it.
   *
   * Resolves when the merge has happened, so a caller can put the reader back
   * where they were standing without racing the render.
   */
  loadOlder: () => Promise<void>;
}

/**
 * Read one room's history backwards, a page at a time.
 *
 * **The page is PREPENDED into the history the stream owns, never fetched
 * beside it.** There is one array per room and everything reads it as the log
 * so far — grouping, the thread panel, the read cursor, the stream's resume
 * cursor. A second cache holding "the older pages" would mean every one of
 * those consumers joining two lists, and two of them (the cursors) taking the
 * last element of the wrong one.
 *
 * **Nothing this writes can move either cursor**, and that is a property of the
 * data rather than of care taken here: `?before=` answers entries strictly
 * older than the cursor it is given, and both cursors read the LAST element of
 * the merged array. So the page lands entirely in front of the newest entry,
 * and `useMarkRoomRead` and the stream's resume both see exactly what they saw
 * before the press. Pinned by tests in both places.
 *
 * **`before` comes from the store, not from the array.** The oldest element of
 * the merged history is routinely a thread root fetched from behind the page
 * (DOR-690), at an arbitrary distance below it — paging from that seq would
 * skip every entry between the root and the page floor, permanently. See
 * `olderCursor` and `room-history-paging.ts`.
 *
 * @param roomId - The room on screen, or `null` when none is.
 */
export function useLoadOlderRoomEntries(roomId: string | null): LoadOlderRoomEntries {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const canLoadOlder = useRoomHasOlderHistory(roomId);
  // Where the next read starts, and where the reader has to be put back. Read
  // through the store rather than passed around, so the two callers of it — the
  // read below and the caller re-anchoring after it — cannot disagree.
  const cursor = useRoomHistoryPagingStore((state) =>
    roomId === null ? null : (state.paging[roomId]?.cursor ?? null)
  );

  const mutation = useMutation({
    mutationFn: async (id: string) => {
      // Re-read at call time rather than closed over: the value this hook
      // rendered with is one page behind after the read before it.
      const from = useRoomHistoryPagingStore.getState().paging[id]?.cursor;
      // Nothing to page from: the room's first read has not landed, or it came
      // back empty. Either way there is no honest `before` to send, and sending
      // none would re-read the trailing window over the top of the stream's
      // work — the one refetch `roomEntriesQuery` exists to prevent.
      if (from === undefined || from === null) return;
      // The same page size the room opened on, named rather than defaulted:
      // `ListRoomEntriesQuery` carries the default on the SERVER's side of the
      // parse, so a client omitting it is asking for whatever that route
      // decides today. Reading back should step by what the reader already has.
      const page = await transport.listRoomEntries(id, {
        before: from,
        limit: ROOM_ENTRY_PAGE_SIZE_DEFAULT,
      });
      const key = roomKeys.entries(id);
      const held = queryClient.getQueryData<RoomEntry[]>(key);
      const merged = mergeRoomHistory(held, page);
      queryClient.setQueryData<RoomEntry[]>(key, merged);
      // A page shorter than the one asked for is the beginning of the room, and
      // on this route that is definitive rather than a guess (see
      // `pageReachesTheBeginning`). The second clause is a belt: a read that
      // moved the history by nothing can only mean there is nothing to move it
      // with, whatever the arithmetic above thought.
      useRoomHistoryPagingStore
        .getState()
        .notePage(
          id,
          olderCursor(page) ?? from,
          pageReachesTheBeginning(page, ROOM_ENTRY_PAGE_SIZE_DEFAULT) ||
            merged.length === (held?.length ?? 0)
        );
    },
    meta: { errorLabel: "Couldn't load older messages" },
  });

  const { mutateAsync, isPending } = mutation;
  /**
   * Whether a read is in the air, held in a REF rather than read off
   * `isPending`.
   *
   * `isPending` is render state: it is true only after React has committed the
   * render the mutation started, and false only after it has committed the one
   * that finished it. A caller pressing twice in the same tick sees `false`
   * both times, and a caller pressing again the instant the first read resolves
   * sees `true` — so the same flag lets a duplicate through AND swallows a
   * legitimate second press, which is both halves of this wrong at once
   * (measured: the double-press test read three fetches, the walk-a-room-back
   * test read two pages instead of three). A ref answers about the read, not
   * about the render, and both cases became deterministic.
   */
  const inFlightRef = useRef(false);
  const loadOlder = useCallback(async () => {
    // **This is the gate, not the button's `disabled`.** The control being
    // disabled while a read is in flight is an affordance — it tells a reader
    // what is happening — and it is not a guarantee: the same callback is
    // reachable from a keyboard repeat that outruns a re-render, and from any
    // host that wires it to something other than that button. A second read at
    // the same cursor would merge a page identical to the one already landing
    // and be recorded as "nothing older", taking the control away over a room
    // with plenty of history left. Pinned by its own test.
    if (roomId === null || inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      // Swallowed rather than propagated: the failure is already reported by
      // the mutation cache's own handler (`meta.errorLabel`), and the caller
      // awaits this only to know when it may put the reader back where they
      // were.
      await mutateAsync(roomId).catch(() => undefined);
    } finally {
      inFlightRef.current = false;
    }
  }, [roomId, mutateAsync]);

  return {
    canLoadOlder,
    isLoadingOlder: isPending,
    cursor,
    loadOlder,
  };
}
