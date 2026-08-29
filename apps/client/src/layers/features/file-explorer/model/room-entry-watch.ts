/**
 * "Something happened in this room" — the one signal both room-files surfaces
 * refresh on (spec `project-rooms` §3.9).
 *
 * A room's files change when somebody merges, and a merge is announced in the
 * room as an entry of its own (spec §3.6) — but so is every message, and the
 * room's stream carries both. Rather than guess at the shape of a merge entry,
 * ANY arriving entry is taken as "look again", and the cost of being wrong is
 * bounded by the throttle below.
 *
 * **Watched through the query cache rather than through the stream itself.**
 * `useRoomStream` merges every arriving entry into the room's cached history,
 * so subscribing to that cache entry is subscribing to the stream — without
 * opening a second socket or reaching past the hook that owns the first one.
 *
 * @module features/file-explorer/model/room-entry-watch
 */
import type { QueryClient } from '@tanstack/react-query';
import { roomKeys } from '@/layers/entities/room';

/**
 * The shortest gap between two refreshes the room's stream can provoke.
 *
 * A room talking all afternoon buys at most one refresh every fifteen seconds
 * per watcher, and a merge lands on screen inside that same window.
 */
export const ROOM_FILES_REFRESH_INTERVAL_MS = 15_000;

/**
 * Call `onChange` when this room's history moves, at most once per
 * {@link ROOM_FILES_REFRESH_INTERVAL_MS}.
 *
 * **Trailing rather than leading, deliberately:** the entry announcing a merge
 * reaches this client at the same moment the merge lands, and a read asked for
 * in that instant can still race the commit it is asking about. Waiting is both
 * cheaper and more likely to be right.
 *
 * @param queryClient - The cache the room's stream writes arriving entries into.
 * @param roomId - The room to watch.
 * @param onChange - What to do when something arrived.
 * @returns The unsubscribe, which also cancels a refresh still waiting out the
 *   throttle.
 */
export function watchRoomEntries(
  queryClient: QueryClient,
  roomId: string,
  onChange: () => void
): () => void {
  const historyKey = JSON.stringify(roomKeys.entries(roomId));
  let lastAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated') return;
    if (JSON.stringify(event.query.queryKey) !== historyKey) return;
    if (timer !== null) return;
    const wait = Math.max(0, ROOM_FILES_REFRESH_INTERVAL_MS - (Date.now() - lastAt));
    timer = setTimeout(() => {
      timer = null;
      lastAt = Date.now();
      onChange();
    }, wait);
  });

  return () => {
    if (timer !== null) clearTimeout(timer);
    unsubscribe();
  };
}
