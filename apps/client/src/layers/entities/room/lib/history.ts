/**
 * Joining the wire's two arrays into the one history a room is read from.
 *
 * `GET /api/rooms/:id/entries` answers a PAGE and the thread roots that page
 * points at from outside itself (DOR-690). Above this seam the room's history
 * is one array in `seq` order — grouping, the live stream's cursor and the read
 * cursor all work on that and nothing else — so this module is where the two
 * become one, and the only place that knows they were ever two.
 *
 * @module entities/room/lib/history
 */
import type { RoomEntry, RoomEntryListResponse } from '@dorkos/shared/room-schemas';

/**
 * Merge a page of history into what a room already holds, in `seq` order.
 *
 * **Prepend-only in effect, and that is the invariant everything above depends
 * on.** A page is either the trailing window (the first read) or a window
 * strictly older than what is held (`?before=`), and the roots that ride with
 * it are older still — so nothing this function adds can ever land after the
 * newest entry held. Two readers rely on that literally: `useMarkRoomRead` and
 * the live stream's resume cursor both take the LAST element of the merged
 * array, and reading further back must not move either of them.
 *
 * **A duplicate is resolved in favour of the arriving row.** A root fetched
 * from behind the page comes back a second time as an ordinary entry once the
 * reader loads the window it lives in, and that copy is the fresher read of the
 * same message — same id, same `seq`, reactions and files as the server has
 * them now. Deduping on `id` rather than `seq` because id is what a thread
 * points at; the two agree, and this is the one that fails loudly if they ever
 * stop.
 *
 * @param held - The history this client already has, oldest first. Empty or
 *   `undefined` on the first read.
 * @param page - The envelope as the route answered it.
 * @returns One array, oldest first, with no entry twice.
 */
export function mergeRoomHistory(
  held: readonly RoomEntry[] | undefined,
  page: RoomEntryListResponse
): RoomEntry[] {
  const byId = new Map<string, RoomEntry>();
  for (const entry of held ?? []) byId.set(entry.id, entry);
  // Arriving rows overwrite held ones — see above. Roots first only so an
  // envelope that somehow carried a root twice resolves the same way.
  for (const entry of page.threadRoots) byId.set(entry.id, entry);
  for (const entry of page.entries) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * The cursor that reads the page directly older than this one, or `null` when
 * there is nothing older to ask for.
 *
 * **Read off `entries` alone, never off the merged history**, and that is the
 * whole reason the envelope survives this far up. A root riding with a page is
 * older than the page by an arbitrary distance — sixty messages, six hundred —
 * so a cursor taken from the merged array's first element would ask for the
 * page below the ROOT and silently make everything between it and the page
 * floor unreachable for good.
 *
 * `null` for an empty page, which is how the reader learns it has reached the
 * beginning of what it may see: there is no `seq` to page from, and asking
 * again with the same cursor would fetch the same nothing forever.
 *
 * @param page - The envelope as the route answered it.
 */
export function olderCursor(page: RoomEntryListResponse): number | null {
  return page.entries[0]?.seq ?? null;
}

/**
 * Whether this page reached the beginning of what the reader may see.
 *
 * **A short page is definitive on this route**, and that is a property of the
 * route rather than an assumption about pages in general: `RoomStore.listEntries`
 * is one `WHERE` with an `ORDER BY` and a `LIMIT`, with nothing filtered out
 * afterwards. So the only way it answers fewer rows than it was asked for is
 * that there were fewer rows to answer with — there is no "short for other
 * reasons" case here, and treating one as possible costs every room in the
 * product a control offering history it does not have.
 *
 * It is asked against the limit the CALLER sent, never against the route's own
 * default, so this cannot quietly start lying the day that default changes.
 *
 * The exactly-full last page is the one case it gets wrong, and it self-corrects
 * on the next press: the read that follows comes back empty, and an empty page
 * is short by any measure.
 *
 * @param page - The envelope as the route answered it.
 * @param requestedLimit - The `limit` this read asked for.
 */
export function pageReachesTheBeginning(
  page: RoomEntryListResponse,
  requestedLimit: number
): boolean {
  return page.entries.length < requestedLimit;
}
