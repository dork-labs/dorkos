/**
 * Keep the open thread and the room's URL saying the same thing.
 *
 * @module widgets/room-view/model/use-thread-url-sync
 */
import { useEffect, useRef } from 'react';
import { useInPlaceNavigate } from '@/layers/shared/model';
import { replyRootFor, useRoomOpenThreadStore, type RoomEntry } from '@/layers/entities/room';

/**
 * The routes a room can be read at, and therefore the addresses `?thread=` can
 * be mirrored into.
 *
 * Two, because the same room widget is reached from two places: `/channels`
 * addresses any room by search param, and `/` IS the #team room
 * (team-room-home spec D3.2). Writing the wrong one would navigate a reader off
 * the page they are on every time they opened a thread.
 */
export type ThreadRoute = '/' | '/channels';

/** What the page knows that the open thread and the URL have to agree with. */
export interface ThreadUrlSync {
  /** The room on screen, or `null` when none is. */
  roomId: string | null;
  /** The address this room is being read at. */
  route: ThreadRoute;
  /** `?thread=` as it arrived. */
  urlThreadId: string | undefined;
  /** The thread the store currently has open. */
  openThreadId: string | undefined;
  /** The room's history, for resolving a link that names a reply. */
  entries: readonly RoomEntry[];
  /** Whether that history has actually arrived. */
  historyLoaded: boolean;
}

/**
 * Mirror the open thread into `?thread=`, and seed it back on the way in.
 *
 * **A panel you cannot link to is a panel you lose on every refresh.** The
 * thread is a place now, so it needs an address — paste the URL to somebody and
 * they land on the same thread, reload and it is still open.
 *
 * The store is the source of truth and the URL is the mirror, not the other way
 * round: what opens a thread is an action on a message, and those are rendered
 * far from the router (the entry capsule is exercised by the Dev Playground
 * under a different route entirely). So the write goes store → URL, and the
 * read runs once per room on the way in.
 *
 * `replace: true`, deliberately: opening and closing a thread is reading, not
 * navigating. Pushing an entry per open would make Back walk through every
 * thread somebody glanced at instead of leaving the room.
 *
 * Note the param is genuinely NEW. `?thread=` existed under the retired
 * threads-as-rooms model and was dropped from the schema when a thread stopped
 * being a room (ADR 260728-022013) — nothing has read it since, and the router
 * comment saying zod discards it was accurate. It is added back here for a
 * different meaning: the entry a thread hangs off, not a room id. An ancient
 * bookmark carrying an old room id now opens a panel that finds no root and
 * says the start of the thread is gone, which is the honest answer.
 *
 * **A link that names a REPLY opens that reply's thread.** Copying a link off
 * a reply is the ordinary way one gets shared, and the id in it is then not a
 * root. Taken literally it opened a panel drawing that reply as though it
 * headed a thread — no replies under it, because nothing points at a reply —
 * and every send from its composer came back `NESTED_THREAD` 400, because the
 * server refuses a thread rooted on a reply. So the seeded id is resolved
 * through `replyRootFor` once the history is here to resolve it against, which
 * corrects the store, the panel, the composer and the URL in one move. An id
 * that is in no loaded history is left exactly as it is: that is the orphaned
 * thread, which the panel already says the honest thing about.
 *
 * @param sync - The room, the address it is read at, the URL, the open thread,
 * and the history.
 */
export function useThreadUrlSync({
  roomId,
  route,
  urlThreadId,
  openThreadId,
  entries,
  historyLoaded,
}: ThreadUrlSync): void {
  const inPlaceNavigate = useInPlaceNavigate();

  // Which room has already been seeded, so the URL is read once on the way in
  // and never again — otherwise closing the panel would immediately re-open it
  // from the `?thread=` still sitting in the address bar.
  const seededRef = useRef<string | null>(null);

  // **Seeding and writing share one effect, and the order inside it is the
  // whole point.** Seeding during render looks tidier and is wrong: the store
  // update it schedules has not been applied yet when this render's effects
  // flush, so the write below would read `openThreadId` as `undefined`, decide
  // the URL disagrees, and strip the very `?thread=` it had just read — killing
  // the deep link on arrival and then navigating back to it a render later.
  // Seeding here instead means the write is never reached on the pass that
  // seeds, and the pass after it finds the two already in agreement.
  useEffect(() => {
    if (roomId === null) return;

    if (seededRef.current !== roomId) {
      seededRef.current = roomId;
      if (urlThreadId !== undefined) {
        useRoomOpenThreadStore.getState().openThread(roomId, urlThreadId);
        return;
      }
    }

    // Normalise before mirroring, so the URL is corrected rather than the wrong
    // id written back out. Only reachable from a link — every other way in has
    // already been through `replyRootFor`.
    if (historyLoaded && openThreadId !== undefined) {
      const target = entries.find((entry) => entry.id === openThreadId);
      const root = target === undefined ? undefined : replyRootFor(target);
      if (root !== undefined && root !== openThreadId) {
        const held = useRoomOpenThreadStore.getState().open[roomId];
        useRoomOpenThreadStore.getState().openThread(roomId, root, held?.focusComposer ?? false);
        return;
      }
    }

    if (openThreadId === urlThreadId) return;
    // Mirroring the open thread into `?thread=` is reading, not navigating, so it
    // goes through the in-place navigator: a lookup in flight when the thread
    // panel syncs its URL must not read as a departure (DOR-931). `null` only in
    // the router-less embed, which never mounts this routed room view.
    inPlaceNavigate?.({
      to: route,
      search: (prev: Record<string, unknown>) => ({ ...prev, thread: openThreadId }),
      replace: true,
    });
    // `entries` and `historyLoaded` are dependencies, not noise: the history
    // arrives AFTER the seed on every deep link, and the resolution above
    // cannot happen until it does. Without them the effect never re-ran on the
    // load that made the answer knowable, so a link naming a reply stayed
    // unresolved exactly when it mattered.
  }, [roomId, route, openThreadId, urlThreadId, entries, historyLoaded, inPlaceNavigate]);
}
