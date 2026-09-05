/**
 * Reading a room further back than the page it opened on (DOR-1734).
 *
 * @module entities/room/model/use-load-older-entries
 */
import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ROOM_ENTRY_PAGE_SIZE_DEFAULT, type RoomEntry } from '@dorkos/shared/room-schemas';
import { useTransport } from '@/layers/shared/model';
import { roomKeys } from '../api/query-keys';
import { mergeRoomHistory, olderCursor } from '../lib/history';
import { useRoomHasOlderHistory, useRoomHistoryPagingStore } from './room-history-paging';

/** What a surface needs to offer "read older" and say whether it did anything. */
export interface LoadOlderRoomEntries {
  /**
   * True when this room has history the reader has not loaded yet.
   *
   * False before the first page has arrived and false once a read has come back
   * with nothing older, so a surface can draw the control from this alone.
   */
  canLoadOlder: boolean;
  /** True while a page is on its way. */
  isLoadingOlder: boolean;
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

  const mutation = useMutation({
    mutationFn: async (id: string) => {
      const cursor = useRoomHistoryPagingStore.getState().paging[id]?.cursor;
      // Nothing to page from: the room's first read has not landed, or it came
      // back empty. Either way there is no honest `before` to send, and sending
      // none would re-read the trailing window over the top of the stream's
      // work — the one refetch `roomEntriesQuery` exists to prevent.
      if (cursor === undefined || cursor === null) return;
      // The same page size the room opened on, named rather than defaulted:
      // `ListRoomEntriesQuery` carries the default on the SERVER's side of the
      // parse, so a client omitting it is asking for whatever that route
      // decides today. Reading back should step by what the reader already has.
      const page = await transport.listRoomEntries(id, {
        before: cursor,
        limit: ROOM_ENTRY_PAGE_SIZE_DEFAULT,
      });
      const key = roomKeys.entries(id);
      const held = queryClient.getQueryData<RoomEntry[]>(key);
      const merged = mergeRoomHistory(held, page);
      queryClient.setQueryData<RoomEntry[]>(key, merged);
      // Measured on what came BACK, not on how full the page was. A read that
      // grew the history by nothing is the only signal that cannot be wrong —
      // an exactly-full last page and a short page mid-room both lie the other
      // way, and the cost of being wrong here is a control that stays on for
      // one more press.
      useRoomHistoryPagingStore
        .getState()
        .notePage(id, olderCursor(page) ?? cursor, merged.length === (held?.length ?? 0));
    },
    meta: { errorLabel: "Couldn't load older messages" },
  });

  const { mutateAsync, isPending } = mutation;
  const loadOlder = useCallback(async () => {
    // A second press while the first read is in flight would ask for the SAME
    // cursor, merge a page that changes nothing, and be recorded as "nothing
    // older" — taking the control away over a room with plenty left. The button
    // is disabled meanwhile; this is the guard that does not depend on that.
    if (roomId === null || isPending) return;
    // Swallowed rather than propagated: the failure is already reported by the
    // mutation cache's own handler (`meta.errorLabel`), and the caller awaits
    // this only to know when it may put the reader back where they were.
    await mutateAsync(roomId).catch(() => undefined);
  }, [roomId, isPending, mutateAsync]);

  return { canLoadOlder, isLoadingOlder: mutation.isPending, loadOlder };
}
