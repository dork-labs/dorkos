/**
 * Read one room and its history (spec `rooms` §7).
 *
 * @module entities/room/model/use-room
 */
import { useEffect } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import { useTransport } from '@/layers/shared/model';
import { roomKeys } from '../api/query-keys';
import { usePendingPostStore } from './pending-posts';

/**
 * Fetch one room with its roster.
 *
 * @param roomId - The room to read, or `null` when nothing is selected (the
 *   query stays idle rather than firing against a made-up id).
 */
export function useRoom(roomId: string | null): UseQueryResult<RoomWithRoster> {
  const transport = useTransport();
  return useQuery({
    queryKey: roomKeys.detail(roomId ?? ''),
    queryFn: () => transport.getRoom(roomId!),
    enabled: roomId !== null,
  });
}

/**
 * One definition of a room's history query, so the reader that fetches it and
 * the reader that only looks at it can never key on different things.
 *
 * **The stream owns this cache entry, and every option here says so.** The read
 * hydrates it once; from then on `useRoomStream` merges arriving entries into
 * it and nothing else may write it. A background refetch would undo that work
 * twice over: the server answers with the TRAILING page, so a room left open
 * long enough to have scrolled past a page is truncated back to fifty rows, and
 * anything the socket delivered while the GET was in flight is overwritten by a
 * response that predates it — permanently, because the stream only recomputes
 * its cursor when it reconnects and never re-delivers what it already sent.
 *
 * - `staleTime: Infinity` — nothing here goes stale, because the stream is what
 *   keeps it current. A refetch could only ever be a step backwards.
 * - `refetchOnWindowFocus: false` — the default fired the truncating refetch on
 *   every alt-tab back into a room. Same precedent as `useSessionHistory`.
 * - `refetchOnReconnect: false` — the stream has its own resume, from a cursor,
 *   and it is gap-free; a whole-page GET beside it is a slower, lossier answer
 *   to the same question.
 *
 * `meta.streamOwned` says the same thing to anything holding a broom: see
 * `installReconnectInvalidation`, which invalidates the world when the global
 * stream recovers and has to be told what not to sweep.
 */
function roomEntriesQuery(transport: Transport, roomId: string | null) {
  return {
    queryKey: roomKeys.entries(roomId ?? ''),
    queryFn: () => transport.listRoomEntries(roomId!),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    meta: { streamOwned: true },
  };
}

/**
 * Fetch the trailing page of a room's history, oldest-first.
 *
 * The server's default page size is the whole hydration this view needs.
 * Scrolling further back than that page is `?before=`, which the server serves
 * and no client surface asks for yet.
 *
 * **A page can arrive with entries older than itself in front of it**: the
 * thread roots it replies to that fell out of the window (DOR-690), so a thread
 * still draws as a thread once its root is fifty entries back. They are part of
 * this history like anything else — the same `seq` order, the same grouping,
 * the same cursor — which is why nothing downstream has to know about them.
 *
 * **This is the room's owner of its history, and there should be one.** The
 * cache entry it fills is also where the live stream merges arriving entries
 * (`useRoomStream`), so a second fetch of the same key can overwrite an entry
 * the socket has already delivered but the in-flight GET predates. Anything that
 * only wants to READ the history reads {@link useLoadedRoomEntries} instead.
 *
 * @param roomId - The room to read, or `null` when nothing is selected.
 */
export function useRoomEntries(roomId: string | null): UseQueryResult<RoomEntry[]> {
  const transport = useTransport();
  const query = useQuery({ ...roomEntriesQuery(transport, roomId), enabled: roomId !== null });
  const entries = query.data;

  // A message this reader sent can reach the screen through this read as well as
  // through the stream, and only the stream used to retire the row holding it.
  // Any refetch while a post was in flight — a room reopened after its cache was
  // collected, a hydrate that raced a send — therefore left a permanent
  // "Sending…" row directly under the message it was waiting for, with nothing
  // on it to press. Whatever puts an entry on screen has to be able to end that.
  useEffect(() => {
    if (roomId === null || entries === undefined) return;
    usePendingPostStore.getState().settleMany(
      roomId,
      entries.map((entry) => entry.id)
    );
  }, [roomId, entries]);

  return query;
}

/**
 * The room's history **this client already holds** — never a request.
 *
 * For decoration: a surface that can say something better when the history
 * happens to be loaded, and must say something true when it is not. The room
 * sheet's "last spoke" line is the case — worth printing over an open room,
 * never worth a history GET on its own.
 *
 * Two reasons it does not simply call {@link useRoomEntries}:
 *
 * - **It would fetch.** The trailing page of a room nobody has open is a real
 *   payload to decorate one line of a dialog with, and this is the same
 *   restraint the presence line keeps by not opening a second SSE stream.
 * - **It could overwrite live entries.** Mounting a second observer on a stale
 *   query starts a background refetch, and that response lands over anything the
 *   room's socket delivered while it was in flight. The history belongs to the
 *   stream; a decoration does not get to race it.
 *
 * Still reactive: it observes the same cache entry, so an arriving message
 * updates the line without anybody asking the server twice.
 *
 * @param roomId - The room to look at, or `null` when nothing is selected.
 * @returns The loaded page, or `undefined` when this client has never read it.
 */
export function useLoadedRoomEntries(roomId: string | null): RoomEntry[] | undefined {
  const transport = useTransport();
  return useQuery({ ...roomEntriesQuery(transport, roomId), enabled: false }).data;
}
