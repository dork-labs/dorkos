/**
 * Saying where you are looking, for whoever is following you (spec
 * `canvas-agent-seat` §6).
 *
 * The leader's half of follow mode, and the one place the "publish only while
 * followed" rule is kept: until the room says somebody is following this viewer,
 * the hook sends nothing at all — not a heartbeat, not an empty frame, nothing.
 * A room where nobody follows anybody costs no traffic.
 *
 * **Debounced and coalesced.** At most one position every
 * {@link ROOM_FOLLOW_PUBLISH_MS}, and only the latest is ever in flight: a
 * position from a moment ago is not worth sending, and a queue of them is a
 * queue of wrong answers.
 *
 * **And re-stated on the beat, whether or not it moved.** Signals never replay,
 * so a follower's belief expires {@link ROOM_FOLLOW_TTL_MS} after the last frame
 * it heard. Publishing only on CHANGE meant that somebody reading one page for
 * half a minute — the ordinary case, not a corner — silently stopped being
 * followed: the follower's toggle flipped back with nothing said. So while
 * somebody is following, the current position goes out every
 * {@link ROOM_FOLLOW_REFRESH_MS}, through the same coalescing gate the change
 * path uses, which is exactly what the presence republisher does one lane over.
 * The beat runs ONLY while followed, so a room nobody follows still costs
 * nothing.
 *
 * **Published from real state, never from an intention.** What goes out is where
 * this viewer's panel actually is — the document it is showing, the page in the
 * frame, the scroll offset of the panel — read at the moment of sending.
 *
 * @module entities/room/model/live/use-room-view-publish
 */
import { useEffect, useRef } from 'react';
import type { RoomSignalView } from '@dorkos/shared/room-schemas';
import { useTransport } from '@/layers/shared/model';
import {
  ROOM_FOLLOW_PUBLISH_MS,
  ROOM_FOLLOW_REFRESH_MS,
  ROOM_FOLLOW_TTL_MS,
  useIsFollowed,
  useRoomFollowStore,
} from './use-room-follow';

/** What this viewer's panel is showing, as a position worth sharing. */
export interface RoomViewSource {
  /** The room, or `null` where there is none. */
  roomId: string | null;
  /** Who this viewer is, or `null` before the room has loaded. */
  viewerAuthorId: string | null;
  /** The document on screen, or `null` when the panel is empty. */
  documentId: string | null;
  /** The page the frame is showing, when the document is a browser page. */
  url?: string | undefined;
  /**
   * Read the panel's scroll offset at send time.
   *
   * A function rather than a number, so a scroll does not re-render every
   * component between here and the panel just to move a position that is about
   * to be debounced anyway.
   */
  readScrollY?: () => number;
  /**
   * Subscribe to whatever else should send a position — a scroll, a resize.
   *
   * Returns its own unsubscribe. Optional: a surface with nothing else to watch
   * still publishes on every document and page change.
   */
  subscribe?: (onMoved: () => void) => () => void;
}

/**
 * Share this viewer's position while somebody is following them.
 *
 * @param source - What the panel is showing, and how to watch it move.
 */
export function useRoomViewPublish(source: RoomViewSource): void {
  const transport = useTransport();
  const { roomId, viewerAuthorId, documentId, url, readScrollY, subscribe } = source;
  const followed = useIsFollowed(roomId, viewerAuthorId);

  // Read inside the timer rather than captured in it, so the debounced send
  // always carries the LATEST position rather than the one that armed it.
  const latest = useRef({ roomId, documentId, url, readScrollY });
  latest.current = { roomId, documentId, url, readScrollY };

  // The timer and the last send survive a re-run of the effect below, and that
  // is what makes the debounce real: a document or page changing re-runs the
  // effect, and a fresh timer each time would send on every keystroke in an
  // address bar rather than once every 250 ms.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentAt = useRef(0);

  useEffect(() => {
    if (!followed || roomId === null || documentId === null) return;

    const send = () => {
      timer.current = null;
      sentAt.current = Date.now();
      const held = latest.current;
      if (held.roomId === null || held.documentId === null) return;
      const room = held.roomId;
      const view: RoomSignalView = {
        documentId: held.documentId,
        ...(held.url !== undefined ? { url: held.url } : {}),
        ...(held.readScrollY ? { scrollY: Math.max(0, Math.round(held.readScrollY())) } : {}),
      };
      void transport
        .publishRoomView(room, view)
        .then((answer) => {
          // The server's own stop signal, honoured rather than discarded. It
          // says nobody is following, which means this client is holding a claim
          // the room no longer has — a release frame that never arrived because
          // the socket cycled. Dropping the belief here ends the beat on the
          // next render instead of thirty seconds from now.
          if (!answer.followed && viewerAuthorId !== null) {
            useRoomFollowStore.getState().noteNobodyFollowing(room, viewerAuthorId);
          }
        })
        .catch(() => {
          // A refused position is not worth a sentence: the next one goes out in
          // 250 ms, and the person being followed did nothing wrong.
        });
    };

    const moved = () => {
      // Coalesced, not queued: a send already armed will carry the latest
      // position when it fires, so a second arming would be a duplicate.
      if (timer.current !== null) return;
      const waited = Date.now() - sentAt.current;
      if (waited >= ROOM_FOLLOW_PUBLISH_MS) {
        send();
        return;
      }
      timer.current = setTimeout(send, ROOM_FOLLOW_PUBLISH_MS - waited);
    };

    moved();
    const stop = subscribe?.(moved);
    // The beat. `moved` rather than `send`, so a re-state that lands inside the
    // debounce window of a real move is coalesced with it rather than doubling
    // it — one position in flight, always.
    const beat = setInterval(moved, ROOM_FOLLOW_REFRESH_MS);
    return () => {
      clearInterval(beat);
      stop?.();
    };
    // `url` and `documentId` are in the list on purpose: a change to either is a
    // move, and re-running this effect is how it reaches the wire. `subscribe`
    // must be stable — wrap it in `useCallback` — or every render resubscribes.
  }, [transport, followed, roomId, viewerAuthorId, documentId, url, subscribe]);

  // The armed send is cleared when this surface goes away for good, never
  // between two runs of the effect above — which is where the debounce lives.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    []
  );
}
