/**
 * Bridge a room's durable SSE stream into the query cache (spec `rooms` §7).
 *
 * The connect is a RESUME, never cold: it opens only once `useRoomEntries` has
 * landed, and resumes from the highest `seq` that read produced. That closes the
 * window a cold connect would leave — an entry committed between the history
 * read and the subscription would otherwise be delivered in a snapshot frame
 * this stream deliberately skips, and so would never reach the reader. An empty
 * room resumes from `0`, which the server serves as "replay nothing, go live".
 *
 * @module entities/room/model/use-room-stream
 */
import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import { useTransport } from '@/layers/shared/model';
import { roomKeys } from '../api/query-keys';

/**
 * Insert an entry into a room's cached history, keeping it ordered by `seq` and
 * dropping a duplicate. A replayed entry is not an error — resuming from a
 * cursor the reader already holds is how a reconnect stays gap-free — so an
 * already-present `seq` is a no-op that preserves the cached array's identity.
 *
 * @param cached - The current cached history, oldest-first.
 * @param entry - The entry to merge in.
 * @internal Exported for testing.
 */
export function mergeRoomEntry(
  cached: readonly RoomEntry[] | undefined,
  entry: RoomEntry
): RoomEntry[] {
  const list = cached ?? [];
  if (list.some((held) => held.seq === entry.seq)) return list as RoomEntry[];
  // Entries almost always arrive in order, so check the tail before sorting.
  if (list.length === 0 || list[list.length - 1]!.seq < entry.seq) return [...list, entry];
  return [...list, entry].sort((a, b) => a.seq - b.seq);
}

/** The highest `seq` a room's cached history holds, or 0 when it is empty. */
function cursorFromCache(queryClient: QueryClient, roomId: string): number {
  const cached = queryClient.getQueryData<RoomEntry[]>(roomKeys.entries(roomId));
  return cached && cached.length > 0 ? cached[cached.length - 1]!.seq : 0;
}

/**
 * Subscribe to a room's live entries and reflect them into the cache.
 *
 * @param roomId - The room to follow, or `null` when nothing is selected.
 * @param hydrated - Whether the room's history has loaded. The stream waits for
 *   it, because the cursor it resumes from is that read's high-water mark.
 */
export function useRoomStream(roomId: string | null, hydrated: boolean): void {
  const transport = useTransport();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (roomId === null || !hydrated) return;

    const controller = new AbortController();

    void (async () => {
      try {
        const stream = transport.subscribeRoom(
          roomId,
          cursorFromCache(queryClient, roomId),
          controller.signal
        );
        for await (const event of stream) {
          if (controller.signal.aborted) return;
          // Signals (typing, presence) are live-only and carry no `seq`. Nothing
          // renders them yet, so they are read off the wire and dropped rather
          // than parked in a store no view consumes.
          if (event.type !== 'entry') continue;
          // Only the history. The same post also fans out globally as
          // `room_activity`, which `useRoomListStream` turns into the list
          // refresh — so refreshing here too would just do it twice.
          queryClient.setQueryData<RoomEntry[]>(roomKeys.entries(roomId), (cached) =>
            mergeRoomEntry(cached, event.entry)
          );
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        // THIS DOES NOT RECONNECT, and the failure is silent to the reader — the
        // deps below never change, so a dropped socket (laptop sleep, a server
        // restart) leaves this room's messages frozen while the GLOBAL stream
        // reconnects and keeps re-badging it in the sidebar.
        //
        // Deliberately deferred to R3 (DOR-526 definition-of-done), because
        // nothing in R2 can post into a room, so there is no live traffic to
        // miss. It has to land BEFORE the composer does, not beside it: the
        // moment somebody can post, a dead stream is a lost message. Reuse
        // `shared/lib/transport/sse-connection.ts` — backoff, jitter, the
        // heartbeat watchdog and visibility handling are all already there.
        console.warn('[rooms] live stream ended and will not reconnect', { roomId, err });
      }
    })();

    return () => controller.abort();
  }, [roomId, hydrated, transport, queryClient]);
}
