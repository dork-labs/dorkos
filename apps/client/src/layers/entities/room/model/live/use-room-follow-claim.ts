/**
 * Holding a follow claim open, and letting it go (spec `canvas-agent-seat` §6).
 *
 * The follower's half of follow mode. While this viewer is following somebody,
 * the hook says so to the server on a beat; the moment it stops — the toggle
 * goes off, the panel closes, the room changes, the window loses focus, the tab
 * goes away — it says so once and stops.
 *
 * **The beat is the mechanism, not a nicety.** The server drops a claim nobody
 * has restated within thirty seconds, so a browser that crashed, a laptop that
 * slept and a network that went away all stop being a follow without anything
 * having to notice. The explicit release is the fast path, not the only one.
 *
 * @module entities/room/model/live/use-room-follow-claim
 */
import { useCallback, useEffect } from 'react';
import { useTransport } from '@/layers/shared/model';
import {
  ROOM_FOLLOW_REFRESH_MS,
  ROOM_FOLLOW_SWEEP_MS,
  useRoomFollowStore,
} from './use-room-follow';

/**
 * Forget everything this browser holds about following one room, when the reader
 * leaves it.
 *
 * **Mounted by the room VIEW, not by the panel**, and that is the whole point.
 * The claim hook lives on the Browser tab and releases the server's claim when
 * that tab goes away — but the local choice survived, so coming back to the room
 * within the TTL resumed a follow nobody re-chose. Worse, the sweep that expires
 * it only runs while that tab is mounted, so with no room open the stale choice
 * outlived its own TTL indefinitely.
 *
 * Following is off by default and never persisted (spec `canvas-agent-seat` §6).
 * Leaving the room is leaving it.
 *
 * @param roomId - The room on screen, or `null` where there is none.
 */
export function useForgetRoomFollowOnLeave(roomId: string | null): void {
  const forgetRoom = useRoomFollowStore((s) => s.forgetRoom);
  useEffect(() => {
    if (roomId === null) return;
    return () => forgetRoom(roomId);
  }, [roomId, forgetRoom]);
}

/** What a surface gets for turning following on and off. */
export interface RoomFollowControls {
  /** Who this viewer is following here, or `null`. */
  following: string | null;
  /**
   * Follow somebody, replacing whoever was being followed.
   *
   * @param memberId - The person to follow.
   */
  follow: (memberId: string) => void;
  /** Stop following. */
  stop: () => void;
}

/**
 * Follow somebody in one room, for as long as this surface is on screen.
 *
 * @param roomId - The room, or `null` where there is none.
 * @returns Who is being followed, and the two ways to change it.
 */
export function useRoomFollowClaim(roomId: string | null): RoomFollowControls {
  const transport = useTransport();
  const following = useRoomFollowStore((s) =>
    roomId ? (s.intent[roomId]?.leaderId ?? null) : null
  );
  const startFollowing = useRoomFollowStore((s) => s.startFollowing);
  const stopFollowing = useRoomFollowStore((s) => s.stopFollowing);
  const sweep = useRoomFollowStore((s) => s.sweep);

  const follow = useCallback(
    (memberId: string) => {
      if (roomId) startFollowing(roomId, memberId);
    },
    [roomId, startFollowing]
  );
  const stop = useCallback(() => {
    if (roomId) stopFollowing(roomId);
  }, [roomId, stopFollowing]);

  // Everything that has aged out goes here, in one place: a claim somebody else
  // dropped while this tab was asleep, a position nobody restated, and this
  // viewer's own follow when the person it names has gone quiet for the TTL.
  useEffect(() => {
    const timer = setInterval(() => sweep(), ROOM_FOLLOW_SWEEP_MS);
    return () => clearInterval(timer);
  }, [sweep]);

  useEffect(() => {
    if (!roomId || following === null) return;

    let live = true;
    const say = () => {
      void transport.followRoomMember(roomId, following).catch(() => {
        // The room refused it — the person left, or this install is holding as
        // many claims as it will. Stop rather than retry: the toggle goes back
        // off, which is the honest thing for the person to see.
        if (live) stopFollowing(roomId);
      });
    };
    say();
    const beat = setInterval(say, ROOM_FOLLOW_REFRESH_MS);

    // Looking away is not following. The claim is dropped rather than merely
    // paused, so the person being followed goes quiet instead of publishing to
    // a window nobody is looking at.
    const onBlur = () => stopFollowing(roomId);
    window.addEventListener('blur', onBlur);
    // `pagehide` rather than `unload`: it is the one a modern browser still
    // fires when a tab goes away, including into the back/forward cache.
    window.addEventListener('pagehide', onBlur);

    return () => {
      live = false;
      clearInterval(beat);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('pagehide', onBlur);
      void transport.unfollowRoomMember(roomId).catch(() => {
        // Nothing to do about it, and nothing to say: the claim lapses on its
        // own within thirty seconds either way.
      });
    };
  }, [transport, roomId, following, stopFollowing]);

  return { following, follow, stop };
}
