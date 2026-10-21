/**
 * What one card on the Threads page shows of its thread: the message it hangs
 * off, and the newest replies under it.
 *
 * Read out of the room's own history — the same cache entry the room view
 * fills — rather than a second copy of the thread, so a reply that lands is the
 * same object here as in the room.
 *
 * @module widgets/room-view/model/use-thread-card
 */
import { useMemo } from 'react';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import { threadRootIdOf, useRoomEntries } from '@/layers/entities/room';

/**
 * How many of a thread's newest replies its card draws.
 *
 * Two: enough to see where the conversation is, few enough that a page of
 * busy threads still reads as a list of threads rather than a wall of replies.
 */
export const THREAD_CARD_LATEST_REPLIES = 2;

/** What a card has of its thread. */
export interface ThreadCardEntries {
  /** The message the thread hangs off, once the room's history holds it. */
  root: RoomEntry | undefined;
  /** The newest replies, oldest first — at most {@link THREAD_CARD_LATEST_REPLIES}. */
  latest: RoomEntry[];
  /** Whether the room's history has arrived, so an absent root means gone, not pending. */
  loaded: boolean;
}

/**
 * The root and the newest replies of one thread.
 *
 * The room's history is its trailing page plus the roots that page points at
 * from further back, so a thread that is still being answered always has its
 * root and its newest replies here. A thread nobody has answered for longer
 * than a page has neither — the card says what the list told it instead.
 *
 * @param roomId - The room the thread lives in.
 * @param rootEntryId - The entry it hangs off.
 */
export function useThreadCardEntries(roomId: string, rootEntryId: string): ThreadCardEntries {
  const entries = useRoomEntries(roomId);
  const data = entries.data;
  return useMemo(() => {
    let root: RoomEntry | undefined;
    const replies: RoomEntry[] = [];
    for (const entry of data ?? []) {
      if (entry.id === rootEntryId) root = entry;
      else if (threadRootIdOf(entry) === rootEntryId) replies.push(entry);
    }
    return {
      root,
      latest: replies.slice(-THREAD_CARD_LATEST_REPLIES),
      loaded: data !== undefined,
    };
  }, [data, rootEntryId]);
}
