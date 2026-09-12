/**
 * Who is following whom in a room, as this browser holds it (spec
 * `canvas-agent-seat` §6).
 *
 * Three pieces of live state, none of them persisted and none of them durable:
 *
 * 1. **Who this viewer has chosen to follow**, per room. Local intent. It is off
 *    by default, it is never written down, and a reload starts it over — a
 *    follow that survived a refresh would be somebody's screen moving for a
 *    reason they no longer remember choosing.
 * 2. **Who is following whom**, learned from the room's own stream. A person
 *    only starts sharing where they are looking once they see a claim naming
 *    them here, which is what keeps a room where nobody follows anybody free of
 *    extra traffic.
 * 3. **Where each followed person last was.** Positions age out: nothing
 *    restated within {@link ROOM_FOLLOW_TTL_MS} is still true, and a follower
 *    whose leader has gone silent that long stops following rather than sitting
 *    frozen on a stale page.
 *
 * The claims and the positions both arrive as `presence` signals, which are live
 * only and never replayed — so every frame is self-contained, and this store
 * expires rather than remembers.
 *
 * @module entities/room/model/live/use-room-follow
 */
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { ROOM_LIVE_BEAT_MS, ROOM_LIVE_TTL_MS } from '@dorkos/shared/room-schemas';
import type { RoomSignalEvent, RoomSignalView } from '@dorkos/shared/room-schemas';

/**
 * How often a follower says it is still there, and a followed person re-states
 * where they are.
 *
 * The room's one ephemeral beat — an alias for {@link ROOM_LIVE_BEAT_MS} rather
 * than a browser-side copy of 10 000, because the server's claim TTL is three of
 * these and two numbers that must agree are one edit away from disagreeing.
 */
export const ROOM_FOLLOW_REFRESH_MS = ROOM_LIVE_BEAT_MS;

/**
 * How long a claim, or a position, stays true without being restated.
 *
 * Three beats. Past it the person being followed has gone quiet — closed the
 * tab, lost the network, put the laptop to sleep — and following a page that
 * stopped moving half a minute ago is worse than not following at all.
 *
 * **A leader who is simply STILL is not silent.** They re-state their position
 * on the beat above whether or not it changed, so this expires a leader who has
 * gone away, never one who is reading (`use-room-view-publish.ts`).
 */
export const ROOM_FOLLOW_TTL_MS = ROOM_LIVE_TTL_MS;

/** How often the store drops what has aged out. */
export const ROOM_FOLLOW_SWEEP_MS = 1_000;

/**
 * The smallest gap between two positions going out.
 *
 * The same 250 ms the preview shim batches its own messages on. Coalesced, not
 * queued: only the latest position is ever in flight, because an old one is not
 * worth sending and a queue of them is a queue of wrong answers.
 */
export const ROOM_FOLLOW_PUBLISH_MS = 250;

/** What this viewer is following in one room. */
export interface FollowIntent {
  /** The person being followed. */
  leaderId: string;
  /** When they were last heard from — the moment the follow began, then each position. */
  heardAt: number;
}

/** One claim somebody else has open in a room. */
export interface FollowClaim {
  /** Who they are following. */
  leaderId: string;
  /** When the claim was last restated. */
  at: number;
}

/** Where one followed person last was. */
export interface FollowPosition {
  /** The document, page and scroll offset. */
  view: RoomSignalView;
  /** When it arrived. */
  at: number;
}

/** Everything this browser holds about following. */
interface RoomFollowState {
  /** Room id → what this viewer is following there. */
  intent: Record<string, FollowIntent | undefined>;
  /** Room id → follower's author id → their claim. */
  claims: Record<string, Record<string, FollowClaim> | undefined>;
  /** Room id → the followed person's author id → where they are. */
  positions: Record<string, Record<string, FollowPosition> | undefined>;
}

/** Ways that state changes. */
interface RoomFollowActions {
  /**
   * Start following somebody in a room, replacing whoever was being followed.
   *
   * @param roomId - The room.
   * @param leaderId - The person to follow.
   * @param now - The clock, for tests.
   */
  startFollowing: (roomId: string, leaderId: string, now?: number) => void;
  /**
   * Stop following in a room.
   *
   * @param roomId - The room.
   */
  stopFollowing: (roomId: string) => void;
  /**
   * Take in one `presence` signal that carries a follow payload.
   *
   * Frames with neither payload are ignored here and handled by the presence
   * store instead, so the two readers never both act on one frame.
   *
   * @param roomId - The room the frame arrived on.
   * @param event - The signal.
   * @param now - The clock, for tests.
   */
  observe: (roomId: string, event: RoomSignalEvent, now?: number) => void;
  /**
   * Drop every claim and position nothing has restated inside the TTL, and stop
   * following anybody who has gone silent for that long.
   *
   * @param now - The clock, for tests.
   */
  sweep: (now?: number) => void;
  /**
   * Forget everything about one room — what a reader leaving it does.
   *
   * @param roomId - The room.
   */
  forgetRoom: (roomId: string) => void;
  /**
   * Drop every claim naming this person, because the SERVER said nobody is
   * following them.
   *
   * The answer to sharing a position carries `followed`, and `false` is the
   * server correcting a client that believes something stale — a claim frame
   * that arrived, followed by a release frame that did not (the socket cycled,
   * the tab slept). Without this the leader would keep sending until the claim
   * aged out thirty seconds later, which is thirty seconds of a room paying for
   * nothing.
   *
   * @param roomId - The room.
   * @param leaderId - The person nobody is following.
   */
  noteNobodyFollowing: (roomId: string, leaderId: string) => void;
}

/** The follow store. Read it through the hooks below. */
export const useRoomFollowStore = create<RoomFollowState & RoomFollowActions>()(
  devtools(
    (set) => ({
      intent: {},
      claims: {},
      positions: {},

      startFollowing: (roomId, leaderId, now = Date.now()) =>
        set(
          (held) => ({
            intent: { ...held.intent, [roomId]: { leaderId, heardAt: now } },
            // The old leader's last position goes with the old claim: keeping it
            // would let a switch land on where the PREVIOUS person was.
            positions: { ...held.positions, [roomId]: {} },
          }),
          false,
          'roomFollow/start'
        ),

      stopFollowing: (roomId) =>
        set(
          (held) => {
            if (held.intent[roomId] === undefined) return held;
            const intent = { ...held.intent };
            delete intent[roomId];
            const positions = { ...held.positions };
            delete positions[roomId];
            return { intent, positions };
          },
          false,
          'roomFollow/stop'
        ),

      observe: (roomId, event, now = Date.now()) =>
        set(
          (held) => {
            if (event.follows !== undefined) {
              const inRoom = { ...(held.claims[roomId] ?? {}) };
              if (event.follows === null) delete inRoom[event.authorId];
              else inRoom[event.authorId] = { leaderId: event.follows, at: now };
              return { claims: { ...held.claims, [roomId]: inRoom } };
            }
            if (event.view === undefined) return held;
            const intent = held.intent[roomId];
            const next: Partial<RoomFollowState> = {
              positions: {
                ...held.positions,
                [roomId]: {
                  ...(held.positions[roomId] ?? {}),
                  [event.authorId]: { view: event.view, at: now },
                },
              },
            };
            // Hearing from the person you follow is what keeps the follow alive.
            if (intent?.leaderId === event.authorId) {
              next.intent = { ...held.intent, [roomId]: { ...intent, heardAt: now } };
            }
            return next;
          },
          false,
          'roomFollow/observe'
        ),

      sweep: (now = Date.now()) =>
        set(
          (held) => {
            const claims = pruneRooms(held.claims, now);
            const positions = pruneRooms(held.positions, now);
            const intent = { ...held.intent };
            let intentChanged = false;
            for (const [roomId, held0] of Object.entries(intent)) {
              if (held0 && now - held0.heardAt >= ROOM_FOLLOW_TTL_MS) {
                delete intent[roomId];
                intentChanged = true;
              }
            }
            if (claims === held.claims && positions === held.positions && !intentChanged) {
              return held;
            }
            return { claims, positions, ...(intentChanged ? { intent } : {}) };
          },
          false,
          'roomFollow/sweep'
        ),

      noteNobodyFollowing: (roomId, leaderId) =>
        set(
          (held) => {
            const inRoom = held.claims[roomId];
            if (!inRoom) return held;
            const kept = Object.fromEntries(
              Object.entries(inRoom).filter(([, claim]) => claim.leaderId !== leaderId)
            );
            if (Object.keys(kept).length === Object.keys(inRoom).length) return held;
            return { claims: { ...held.claims, [roomId]: kept } };
          },
          false,
          'roomFollow/nobodyFollowing'
        ),

      forgetRoom: (roomId) =>
        set(
          (held) => {
            const intent = { ...held.intent };
            const claims = { ...held.claims };
            const positions = { ...held.positions };
            delete intent[roomId];
            delete claims[roomId];
            delete positions[roomId];
            return { intent, claims, positions };
          },
          false,
          'roomFollow/forget'
        ),
    }),
    { name: 'room-follow' }
  )
);

/**
 * Drop every entry in every room that has aged past the TTL.
 *
 * Returns the ORIGINAL object when nothing aged out, so a sweep that found
 * nothing to do re-renders nothing.
 */
function pruneRooms<T extends { at: number }>(
  rooms: Record<string, Record<string, T> | undefined>,
  now: number
): Record<string, Record<string, T> | undefined> {
  let changed = false;
  const next: Record<string, Record<string, T> | undefined> = {};
  for (const [roomId, entries] of Object.entries(rooms)) {
    if (!entries) continue;
    const kept: Record<string, T> = {};
    for (const [key, value] of Object.entries(entries)) {
      if (now - value.at < ROOM_FOLLOW_TTL_MS) kept[key] = value;
      else changed = true;
    }
    if (Object.keys(kept).length > 0) next[roomId] = kept;
    else if (Object.keys(entries).length > 0) changed = true;
  }
  return changed ? next : rooms;
}

/**
 * Whether a `presence` signal is one this store owns.
 *
 * The room stream hands every signal to both readers, so each has to say which
 * frames are its own. A frame carrying neither payload belongs to the presence
 * store; the schema refuses one carrying both.
 *
 * @param event - The signal.
 * @returns Whether it carries a follow claim or a follow position.
 */
export function isFollowSignal(event: RoomSignalEvent): boolean {
  return event.follows !== undefined || event.view !== undefined;
}

/**
 * Who this viewer is following in one room, or `null`.
 *
 * @param roomId - The room, or `null` off a room route.
 * @returns The person being followed, or `null`.
 */
export function useFollowedMember(roomId: string | null): string | null {
  return useRoomFollowStore((s) => (roomId ? (s.intent[roomId]?.leaderId ?? null) : null));
}

/**
 * Where the person this viewer follows last was, or `null` when nobody is being
 * followed or they have not moved yet.
 *
 * @param roomId - The room, or `null` off a room route.
 * @returns Their view, or `null`.
 */
export function useFollowedView(roomId: string | null): RoomSignalView | null {
  return useRoomFollowStore((s) => {
    if (!roomId) return null;
    const leaderId = s.intent[roomId]?.leaderId;
    if (leaderId === undefined) return null;
    return s.positions[roomId]?.[leaderId]?.view ?? null;
  });
}

/**
 * Whether anybody is following this viewer in this room right now.
 *
 * This is the gate on publishing: until it is true, a client sends nothing at
 * all, which is what keeps a room nobody is following free of extra traffic.
 *
 * @param roomId - The room, or `null` off a room route.
 * @param viewerAuthorId - Who this viewer is, or `null` before the room loads.
 * @returns Whether a live claim names them.
 */
export function useIsFollowed(roomId: string | null, viewerAuthorId: string | null): boolean {
  return useRoomFollowStore((s) => {
    if (!roomId || !viewerAuthorId) return false;
    const inRoom = s.claims[roomId];
    if (!inRoom) return false;
    return Object.values(inRoom).some((claim) => claim.leaderId === viewerAuthorId);
  });
}
