/**
 * The follow store: which frames it owns, what it remembers, and what it forgets
 * (spec `canvas-agent-seat` §6).
 *
 * Three properties:
 *
 * - **Two readers, one frame, no overlap.** A `presence` signal carrying a
 *   follow payload is this store's; one carrying an agent's work state is the
 *   presence store's. A frame read by both would draw a follow position as an
 *   agent working.
 * - **Everything ages out.** Claims, positions, and this viewer's own follow.
 *   Signals never replay, so anything not restated inside the TTL is not true
 *   any more — and a follower frozen on a page that stopped moving half a minute
 *   ago is worse off than one that stopped following.
 * - **Switching leaders forgets the old position**, or a switch would land on
 *   where the previous person was.
 *
 * Seeded defects: making `isFollowSignal` always true reddens the split;
 * removing the TTL from `sweep` reddens all three ageing cases; keeping the
 * positions map on `startFollowing` reddens the switch.
 *
 * @module entities/room/tests/use-room-follow
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { RoomSignalEvent } from '@dorkos/shared/room-schemas';
import {
  isFollowSignal,
  ROOM_FOLLOW_TTL_MS,
  useRoomFollowStore,
} from '../model/live/use-room-follow';

const ROOM = 'room-1';
const KAI = 'author-kai';
const ANA = 'author-ana';
const YOU = 'author-you';
const AT = '2026-09-12T10:00:00.000Z';

/** One signal frame, as the room stream delivers it. */
const frame = (over: Partial<RoomSignalEvent>): RoomSignalEvent =>
  ({ type: 'signal', signal: 'presence', authorId: KAI, at: AT, ...over }) as RoomSignalEvent;

beforeEach(() => {
  useRoomFollowStore.setState({ intent: {}, claims: {}, positions: {} });
});

describe('which frames the follow store owns', () => {
  it('claims a presence frame carrying a follow claim or a position', () => {
    expect(isFollowSignal(frame({ follows: KAI }))).toBe(true);
    expect(isFollowSignal(frame({ follows: null }))).toBe(true);
    expect(isFollowSignal(frame({ view: { documentId: 'doc-1' } }))).toBe(true);
  });

  it('leaves an agent’s work claim to the presence store', () => {
    expect(
      isFollowSignal(frame({ signal: 'progress', state: 'working', entryId: 'e1', since: AT }))
    ).toBe(false);
    expect(isFollowSignal(frame({ signal: 'typing' }))).toBe(false);
  });
});

describe('what the follow store remembers', () => {
  it('records a claim, and forgets it when it is withdrawn', () => {
    const store = useRoomFollowStore.getState();
    store.observe(ROOM, frame({ authorId: YOU, follows: KAI }), 1_000);
    expect(useRoomFollowStore.getState().claims[ROOM]).toEqual({
      [YOU]: { leaderId: KAI, at: 1_000 },
    });

    store.observe(ROOM, frame({ authorId: YOU, follows: null }), 1_100);
    expect(useRoomFollowStore.getState().claims[ROOM]).toEqual({});
  });

  it('records where a followed person is, and keeps their follow alive', () => {
    const store = useRoomFollowStore.getState();
    store.startFollowing(ROOM, KAI, 1_000);
    store.observe(ROOM, frame({ authorId: KAI, view: { documentId: 'doc-1' } }), 5_000);

    expect(useRoomFollowStore.getState().positions[ROOM]?.[KAI]).toEqual({
      view: { documentId: 'doc-1' },
      at: 5_000,
    });
    expect(useRoomFollowStore.getState().intent[ROOM]).toEqual({ leaderId: KAI, heardAt: 5_000 });
  });

  it('does not revive a follow from somebody else’s position', () => {
    const store = useRoomFollowStore.getState();
    store.startFollowing(ROOM, KAI, 1_000);
    store.observe(ROOM, frame({ authorId: ANA, view: { documentId: 'doc-9' } }), 9_000);
    expect(useRoomFollowStore.getState().intent[ROOM]?.heardAt).toBe(1_000);
  });

  it('forgets the old position when the follower switches', () => {
    const store = useRoomFollowStore.getState();
    store.startFollowing(ROOM, KAI, 1_000);
    store.observe(ROOM, frame({ authorId: KAI, view: { documentId: 'doc-1' } }), 1_100);
    store.startFollowing(ROOM, ANA, 2_000);

    expect(useRoomFollowStore.getState().positions[ROOM]).toEqual({});
    expect(useRoomFollowStore.getState().intent[ROOM]?.leaderId).toBe(ANA);
  });
});

describe('what the follow store forgets', () => {
  it('drops a claim, a position and a follow that have aged out', () => {
    const store = useRoomFollowStore.getState();
    store.startFollowing(ROOM, KAI, 1_000);
    store.observe(ROOM, frame({ authorId: YOU, follows: KAI }), 1_000);
    store.observe(ROOM, frame({ authorId: KAI, view: { documentId: 'doc-1' } }), 1_000);

    store.sweep(1_000 + ROOM_FOLLOW_TTL_MS - 1);
    expect(useRoomFollowStore.getState().intent[ROOM]).toBeDefined();
    expect(useRoomFollowStore.getState().claims[ROOM]?.[YOU]).toBeDefined();

    store.sweep(1_000 + ROOM_FOLLOW_TTL_MS);
    const held = useRoomFollowStore.getState();
    expect(held.intent[ROOM]).toBeUndefined();
    expect(held.claims[ROOM]).toBeUndefined();
    expect(held.positions[ROOM]).toBeUndefined();
  });

  it('changes nothing when there is nothing to drop', () => {
    const store = useRoomFollowStore.getState();
    store.observe(ROOM, frame({ authorId: YOU, follows: KAI }), 1_000);
    const before = useRoomFollowStore.getState().claims;
    store.sweep(1_500);
    // The same object, so a sweep that found nothing re-renders nothing.
    expect(useRoomFollowStore.getState().claims).toBe(before);
  });

  it('forgets a whole room when a reader leaves it', () => {
    const store = useRoomFollowStore.getState();
    store.startFollowing(ROOM, KAI, 1_000);
    store.observe(ROOM, frame({ authorId: YOU, follows: KAI }), 1_000);
    store.forgetRoom(ROOM);
    const held = useRoomFollowStore.getState();
    expect(held.intent[ROOM]).toBeUndefined();
    expect(held.claims[ROOM]).toBeUndefined();
  });
});
