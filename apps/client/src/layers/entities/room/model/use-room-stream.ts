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
 * A dropped stream is retried here, in the hook, rather than below it. The
 * `SSEConnection` that carries the session stream's resilience speaks HTTP
 * directly and cannot be reached through the Transport port, so wiring this to
 * it would leave embedded mode (Obsidian's `DirectTransport`, which has no HTTP
 * server) with the only unreliable room stream. The port stays contract-level —
 * one subscription, no retries, the same line `session-stream-methods.ts` draws
 * — and resilience sits above it, where both adapters inherit it.
 *
 * With one deliberate exception, in the other direction: DETECTING a dead
 * socket lives in the HTTP adapter's `subscribeRoom`, because the server's
 * heartbeat is an SSE comment the adapter drops. Up here a silent socket and a
 * quiet room are the same thing. The adapter turns silence into a throw; this
 * loop turns a throw into a reconnect.
 *
 * @module entities/room/model/use-room-stream
 */
import { useCallback, useEffect, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import { SSE_RESILIENCE } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import { roomKeys } from '../api/query-keys';
import { useRoomPresenceStore } from './use-room-presence';

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
 * Full-jitter exponential backoff, the same curve `SSEConnection` retries on.
 *
 * @param failures - Consecutive failed attempts, starting at 1.
 */
function backoffMs(failures: number): number {
  const ceiling = Math.min(
    SSE_RESILIENCE.BACKOFF_CAP_MS,
    SSE_RESILIENCE.BACKOFF_BASE_MS * 2 ** failures
  );
  return Math.random() * ceiling;
}

/** Wait `ms`, or return early the moment `signal` aborts. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // An already-aborted signal never fires `abort` again, so it has to be read
    // rather than listened for — otherwise this waits out the full backoff.
    if (signal.aborted) return resolve();
    const settle = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', settle);
      resolve();
    };
    const timer = setTimeout(settle, ms);
    signal.addEventListener('abort', settle, { once: true });
  });
}

/** What the open room's live stream is doing. */
export interface RoomStreamState {
  /**
   * True once the stream has dropped, been retried to the limit, and stopped —
   * so the room on screen is no longer live. Nothing else reports this: the
   * global stream keeps reconnecting and re-badging the room in the sidebar,
   * which would make a frozen room look like a quiet one.
   */
  stalled: boolean;
  /** Try again from the newest entry the reader holds. */
  retry: () => void;
}

/**
 * Subscribe to a room's live entries and reflect them into the cache.
 *
 * Reconnects on its own: when the stream ends or throws, the cursor is
 * recomputed from the cache — so the resume is gap-free however many entries
 * were missed — and the subscription reopens after a jittered backoff. Attempts
 * stop at {@link SSE_RESILIENCE.DISCONNECTED_THRESHOLD} rather than retrying
 * forever, and a stream that stayed up longer than the stability window is
 * forgiven its earlier failures, so a server that restarts nightly never spends
 * the budget.
 *
 * @param roomId - The room to follow, or `null` when nothing is selected.
 * @param hydrated - Whether the room's history has loaded. The stream waits for
 *   it, because the cursor it resumes from is that read's high-water mark.
 * @returns Whether the stream has given up, and a way to ask it to try again.
 */
export function useRoomStream(roomId: string | null, hydrated: boolean): RoomStreamState {
  const transport = useTransport();
  const queryClient = useQueryClient();
  // Which room gave up, not whether one did: switching rooms must not carry the
  // dead-stream notice across to a room whose stream is perfectly alive.
  const [stalledRoomId, setStalledRoomId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Re-running the effect is the whole of a retry: the cycle below clears the
  // stall itself, so there is nothing to reset here.
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (roomId === null || !hydrated) return;

    const controller = new AbortController();

    void (async () => {
      // A fresh subscription cycle is starting, so no room is dead right now.
      // Without this the notice is sticky: leaving a stalled room and coming
      // back opens a healthy stream under a banner still saying nothing is
      // coming through. Clearing on the way IN also covers the retry button and
      // a re-hydrate, which are the only other ways a cycle begins.
      setStalledRoomId(null);
      let failures = 0;
      while (!controller.signal.aborted) {
        const openedAt = Date.now();
        try {
          const stream = transport.subscribeRoom(
            roomId,
            cursorFromCache(queryClient, roomId),
            controller.signal
          );
          for await (const event of stream) {
            if (controller.signal.aborted) return;
            // Signals (typing, presence) are live-only and carry no `seq`, so
            // they never enter the history — they go to the presence store,
            // which expires them rather than keeping them.
            if (event.type === 'signal') {
              useRoomPresenceStore.getState().observe(roomId, event);
              continue;
            }
            // Reactions are durable state on an entry rather than a place in the
            // log, so they carry no `seq` and nothing here merges them. The
            // server keeps them fresh on this stream and re-sends the trailing
            // window on a resume; drawing them is B3's, and until it lands this
            // is a deliberate ignore rather than a gap.
            if (event.type === 'reaction') continue;
            // An author's own entry retires that author's indicators here. It
            // has to happen on the way in, beside the merge: the entry replays
            // on a reconnect and the `done` beside it does not, so a client that
            // waited for the release would draw "working" under an answer that
            // is already on screen (`use-room-presence` explains the rest).
            useRoomPresenceStore.getState().clearAuthor(roomId, event.entry.authorId);
            // Only the history. The same post also fans out globally as
            // `room_activity`, which `useRoomListStream` turns into the list
            // refresh — so refreshing here too would just do it twice.
            queryClient.setQueryData<RoomEntry[]>(roomKeys.entries(roomId), (cached) =>
              mergeRoomEntry(cached, event.entry)
            );
          }
        } catch (err) {
          if (controller.signal.aborted) return;
          console.warn('[rooms] live stream dropped', { roomId, err });
        }
        if (controller.signal.aborted) return;

        // A stream that ran for the stability window did its job; whatever went
        // wrong after that is a fresh incident, not a continuing one.
        if (Date.now() - openedAt >= SSE_RESILIENCE.STABILITY_WINDOW_MS) failures = 0;
        failures += 1;
        if (failures >= SSE_RESILIENCE.DISCONNECTED_THRESHOLD) {
          // Whatever was working is now unknowable: the releases would have come
          // down the stream that just died. A frozen "· 42s" under a banner
          // saying nothing is coming through is the lingering-dots lie.
          useRoomPresenceStore.getState().clearRoom(roomId);
          setStalledRoomId(roomId);
          return;
        }
        await wait(backoffMs(failures), controller.signal);
      }
    })();

    return () => controller.abort();
  }, [roomId, hydrated, transport, queryClient, attempt]);

  return { stalled: stalledRoomId !== null && stalledRoomId === roomId, retry };
}
