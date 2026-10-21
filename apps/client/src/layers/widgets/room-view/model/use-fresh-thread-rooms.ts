/**
 * Keep the Threads page's replies current without opening a stream per room.
 *
 * @module widgets/room-view/model/use-fresh-thread-rooms
 */
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ThreadSummary } from '@dorkos/shared/room-schemas';
import { roomKeys } from '@/layers/entities/room';

/**
 * Re-read a room's history whenever one of its threads moved.
 *
 * **Why this and not the room's own stream.** A room's history is normally kept
 * current by its live stream, which the room view opens while the room is on
 * screen. The Threads page draws threads from many rooms at once, and a stream
 * per room would spend the browser's handful of connections on a list. The
 * thread list itself is refreshed by the app-wide room events (a reply lands,
 * `room_activity` fires, the list is read again), so a thread whose newest
 * reply moved is exactly the signal that its room's history is behind.
 *
 * The first answer is never a move: a room is read when its card mounts, so
 * there is nothing stale to replace yet.
 *
 * @param threads - The thread list, as the page draws it.
 */
export function useFreshThreadRooms(threads: readonly ThreadSummary[] | undefined): void {
  const queryClient = useQueryClient();
  const seen = useRef<Map<string, string> | null>(null);

  useEffect(() => {
    if (threads === undefined) return;
    const previous = seen.current;
    const next = new Map(threads.map((thread) => [thread.rootEntryId, thread.lastActivityAt]));
    seen.current = next;
    if (previous === null) return;
    const moved = new Set<string>();
    for (const thread of threads) {
      const before = previous.get(thread.rootEntryId);
      if (before !== undefined && before !== thread.lastActivityAt) moved.add(thread.roomId);
    }
    for (const roomId of moved) {
      void queryClient.invalidateQueries({ queryKey: roomKeys.entries(roomId) });
    }
  }, [threads, queryClient]);
}
