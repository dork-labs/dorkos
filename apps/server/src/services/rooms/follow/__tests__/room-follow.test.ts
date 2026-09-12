/**
 * Following somebody's browser in a room, and the claim that makes it possible
 * (spec `canvas-agent-seat` §6).
 *
 * Four properties, each a live defect if it breaks:
 *
 * - **Nothing is published until somebody is following.** The whole bandwidth
 *   argument for the feature rests on it, so it is asserted on the room's real
 *   stream rather than on a return value.
 * - **People only, both ends.** An agent has no viewport and nothing to follow
 *   with. The refusal lives in the service, so a hand-written request meets it
 *   exactly as the app's toggle does.
 * - **A claim lapses on its own.** Memory-only, no timer, judged at read time —
 *   which is what makes a closed tab, a crashed browser and a lost network the
 *   same event.
 * - **None of it enters the log, and none of it wakes anybody.** A follow is
 *   live state; a room's record is what somebody should be able to read later,
 *   and "Ana scrolled" is not that.
 *
 * Seeded defects, each run red before the code stood: dropping the `isFollowed`
 * gate in `publishView` reddens "publishes nothing while nobody is following";
 * making `requirePerson` always pass reddens both people-only cases; making the
 * TTL infinite reddens "lets a claim lapse".
 *
 * @module server/services/rooms/follow/tests/room-follow
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { RoomEvent } from '@dorkos/shared/room-schemas';
import { RoomError } from '../../room-errors.js';
import { FOLLOW_CLAIM_TTL_MS, FOLLOW_REFRESH_MS } from '../room-follow-service.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  type RoomHarness,
} from '../../__tests__/room-test-harness.js';

const ANA = '/agents/ana';
const agents = agentLookupFor({
  [ANA]: { name: 'ana', displayName: 'Ana', responseMode: 'always' },
});

describe('following somebody in a room', () => {
  let harness: RoomHarness;
  let roomId: string;
  /** The install's owner — the person who does the following. */
  let owner: string;
  /** A second person in the room, the one being followed. */
  let kai: string;
  /** The agent, which may neither follow nor be followed. */
  let ana: string;
  /** Frames the room really fanned out, in order. */
  let frames: RoomEvent[];
  let stop: AbortController;
  /** The clock the claim TTL is judged against. */
  let clock: number;

  /** Mint a person and put them in the room. */
  const person = (key: string, name: string): string => {
    const id = harness.authors.resolve({ kind: 'human', naturalKey: key, displayName: name }).id;
    harness.service.addMember(roomId, owner, { authorId: id });
    return id;
  };

  beforeEach(async () => {
    clock = 1_000_000;
    harness = createRoomHarness({
      agents,
      runner: scriptedRunner(() => null),
      canvasNow: () => clock,
    });
    owner = harness.human;
    roomId = harness.service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: [ANA] },
      owner
    ).id;
    kai = person('person:kai', 'Kai');
    ana = harness.authors.resolveAgent(ANA, 'Ana').id;

    frames = [];
    stop = new AbortController();
    const live = harness.broadcaster.subscribe(roomId, stop.signal);
    void (async () => {
      for await (const frame of live) frames.push(frame);
    })();
    // Let the subscription register before anything publishes.
    await Promise.resolve();
  });

  afterEach(() => stop.abort());

  /**
   * Every ephemeral signal the room really fanned out.
   *
   * Awaited, because the broadcaster hands its readers an async iterable: a
   * publish queues synchronously and the loop above drains on a later turn of
   * the event loop. Reading the array without waiting would assert on an empty
   * one and pass for the wrong reason.
   */
  const signals = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return frames.filter((f) => f.type === 'signal');
  };

  it('publishes nothing at all while nobody is following', async () => {
    // The leader says where it is looking without being followed. The room
    // carries zero frames: not a dropped one, not an empty one — none.
    expect(
      harness.service.follow.publishView(roomId, kai, { documentId: 'doc-1', scrollY: 40 })
    ).toBe(false);
    expect(await signals()).toEqual([]);
  });

  it('tells the room a claim opened, then carries the position', async () => {
    harness.service.follow.follow(roomId, owner, kai);
    expect(await signals()).toEqual([
      expect.objectContaining({ signal: 'presence', authorId: owner, follows: kai }),
    ]);

    expect(
      harness.service.follow.publishView(roomId, kai, {
        documentId: 'doc-1',
        url: 'http://localhost:5173/',
        scrollY: 120,
      })
    ).toBe(true);
    const last = (await signals()).at(-1);
    expect(last).toMatchObject({
      signal: 'presence',
      authorId: kai,
      view: { documentId: 'doc-1', url: 'http://localhost:5173/', scrollY: 120 },
    });
    // The two payloads never travel together: a reader branches on one field.
    expect(last && 'state' in last).toBe(false);
  });

  it('stops carrying the position the moment the follower lets go', async () => {
    harness.service.follow.follow(roomId, owner, kai);
    harness.service.follow.unfollow(roomId, owner);
    expect((await signals()).at(-1)).toMatchObject({ authorId: owner, follows: null });
    expect(harness.service.follow.publishView(roomId, kai, { documentId: 'doc-1' })).toBe(false);
  });

  it('lets a claim lapse when nobody refreshes it', () => {
    harness.service.follow.follow(roomId, owner, kai);
    clock += FOLLOW_CLAIM_TTL_MS - 1;
    expect(harness.service.follow.isFollowed(roomId, kai)).toBe(true);
    clock += 1;
    expect(harness.service.follow.isFollowed(roomId, kai)).toBe(false);
    expect(harness.service.follow.publishView(roomId, kai, { documentId: 'doc-1' })).toBe(false);
    expect(harness.service.follow.size()).toBe(0);
  });

  it('keeps a claim alive while the follower keeps saying it is there', () => {
    harness.service.follow.follow(roomId, owner, kai);
    for (let beat = 0; beat < 5; beat += 1) {
      clock += FOLLOW_REFRESH_MS;
      harness.service.follow.follow(roomId, owner, kai);
    }
    expect(harness.service.follow.isFollowed(roomId, kai)).toBe(true);
  });

  it('moves one claim rather than stacking two when the follower switches', async () => {
    const sam = person('person:sam', 'Sam');
    harness.service.follow.follow(roomId, owner, kai);
    harness.service.follow.follow(roomId, owner, sam);
    expect(harness.service.follow.size()).toBe(1);
    expect(harness.service.follow.isFollowed(roomId, kai)).toBe(false);
    expect(harness.service.follow.isFollowed(roomId, sam)).toBe(true);
    // The person who WAS being followed is told, so their browser goes quiet
    // rather than waiting out the TTL.
    expect((await signals()).map((f) => (f.type === 'signal' ? f.follows : undefined))).toEqual([
      kai,
      null,
      sam,
    ]);
  });

  it('refuses to let an agent follow anybody', async () => {
    expect(() => harness.service.follow.follow(roomId, ana, kai)).toThrow(
      expect.objectContaining({ code: 'PEOPLE_ONLY' })
    );
    expect(await signals()).toEqual([]);
  });

  it('refuses to let anybody follow an agent', async () => {
    expect(() => harness.service.follow.follow(roomId, owner, ana)).toThrow(
      expect.objectContaining({ code: 'PEOPLE_ONLY' })
    );
    expect(harness.service.follow.isFollowed(roomId, ana)).toBe(false);
    expect(await signals()).toEqual([]);
  });

  it('refuses an agent trying to share a view of its own', () => {
    harness.service.follow.follow(roomId, owner, kai);
    expect(() => harness.service.follow.publishView(roomId, ana, { documentId: 'doc-1' })).toThrow(
      expect.objectContaining({ code: 'PEOPLE_ONLY' })
    );
  });

  it('refuses somebody who is not in the room, without saying the room exists', () => {
    const stranger = harness.authors.resolve({
      kind: 'human',
      naturalKey: 'person:stranger',
      displayName: 'Stranger',
    }).id;
    expect(() => harness.service.follow.follow(roomId, stranger, kai)).toThrow(
      expect.objectContaining({ code: 'ROOM_NOT_FOUND' })
    );
    // …and the same answer for a room that never existed, so an id is no probe.
    expect(() => harness.service.follow.follow('nope', owner, kai)).toThrow(
      expect.objectContaining({ code: 'ROOM_NOT_FOUND' })
    );
  });

  it('refuses a claim on somebody who is not in the room', () => {
    const outsider = harness.authors.resolve({
      kind: 'human',
      naturalKey: 'person:outsider',
      displayName: 'Outsider',
    }).id;
    expect(() => harness.service.follow.follow(roomId, owner, outsider)).toThrow(
      expect.objectContaining({ code: 'ROOM_NOT_FOUND' })
    );
  });

  it('refuses a claim on yourself', () => {
    expect(() => harness.service.follow.follow(roomId, owner, owner)).toThrow(
      expect.objectContaining({ code: 'CANNOT_FOLLOW_YOURSELF' })
    );
  });

  it('never writes anything to the room’s log and asks nobody to take a turn', () => {
    harness.service.follow.follow(roomId, owner, kai);
    harness.service.follow.publishView(roomId, kai, { documentId: 'doc-1', scrollY: 9 });
    harness.service.follow.unfollow(roomId, owner);
    expect(frames.filter((f) => f.type === 'entry')).toEqual([]);
    expect(harness.service.readHistory(roomId, owner, { limit: 50 })).toEqual([]);
    expect(harness.runner.turns).toEqual([]);
  });

  it('refuses once it is holding as many claims as it will', () => {
    // Two hundred people following somebody at once is not a room; it is a loop.
    // The bound is what stops a client asking for memory without end.
    let first = '';
    for (let n = 0; n < 200; n += 1) {
      const follower = person(`person:crowd-${n}`, `Crowd ${n}`);
      if (n === 0) first = follower;
      harness.service.follow.follow(roomId, follower, kai);
    }
    expect(() => harness.service.follow.follow(roomId, owner, kai)).toThrow(
      expect.objectContaining({ code: 'TOO_MANY_FOLLOWERS' })
    );
    // …and somebody already following may still refresh, or a full house would
    // drop the very people who filled it honestly.
    expect(() => harness.service.follow.follow(roomId, first, kai)).not.toThrow();
  });

  it('reports every refusal as a RoomError the routes already know how to send', () => {
    expect(() => harness.service.follow.follow(roomId, owner, ana)).toThrow(RoomError);
  });
});
