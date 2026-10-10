/**
 * The real posts nobody answered (DOR-2823), replayed against the engaged window.
 *
 * Each case rebuilds one real channel's log up to and including the post a
 * person wrote without an @mention, then asks whether the agent they were
 * talking to is engaged in that post's thread scope at the moment it landed.
 * The logs are in `real-room-misses.fixture.ts`, reduced to timing and shape.
 *
 * Six of the twelve misses were a follow-up inside a thread whose ROOT had
 * named the agent with an @mention: the window never counted the root, so the thread had
 * no mention in it at all. Those six are pinned here. The other six were the
 * clock running out, which is a routing change rather than a store bug.
 *
 * @module server/services/rooms/tests/real-room-misses
 */
import { describe, it, expect } from 'vitest';
import { authors } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import { engagementFor, type EngagedWindow } from '../engagement.js';
import { RoomStore } from '../room-store.js';
import { ROOM_A, ROOM_B, type FixtureEntry } from './real-room-misses.fixture.js';

const ROOM = 'room-real';
const IDS = {
  HUMAN: 'human',
  AGENT: 'agent',
  OTHER_AGENT: 'other-agent',
  SYSTEM: 'system-author',
} as const;
const MENTION_IDS = { AGENT: IDS.AGENT, HUMAN: IDS.HUMAN, OTHER: IDS.OTHER_AGENT } as const;

/** The shipped ceilings. */
const SHIPPED: EngagedWindow = { minutes: 10, posts: 5 };
/** The operator's stopgap config on 2026-10-09. */
const STOPGAP: EngagedWindow = { minutes: 60, posts: 15 };

/** The entry id a fixture `seq` is stored under. */
const idOf = (seq: number): string => `e${seq}`;

/**
 * A store holding `log` up to and including `seq`, and that entry.
 *
 * @param log - One room's fixture log.
 * @param seq - The post being weighed.
 */
function replayUpTo(
  log: readonly FixtureEntry[],
  seq: number
): { store: RoomStore; target: FixtureEntry } {
  const db = createTestDb();
  db.insert(authors)
    .values({
      id: IDS.SYSTEM,
      kind: 'system',
      naturalKey: 'system',
      displayName: 'DorkOS',
      createdAt: log[0]!.at,
    })
    .run();
  const store = new RoomStore(db);
  store.createRoom(
    { id: ROOM, kind: 'channel', slug: 'real', title: 'Real', topic: null, createdAt: log[0]!.at },
    []
  );
  for (const row of log) {
    if (row.seq > seq) break;
    store.appendEntry({
      roomId: ROOM,
      id: idOf(row.seq),
      authorId: IDS[row.author],
      kind: row.kind,
      body: { text: '' },
      mentions: (row.mentions ?? []).map((m) => MENTION_IDS[m]),
      sessionId: null,
      cascadeRoot: idOf(row.seq),
      cascadeDepth: 0,
      parentEntryId: row.root === undefined ? null : idOf(row.root),
      threadRootEntryId: row.root === undefined ? null : idOf(row.root),
      createdAt: row.at,
    });
  }
  const target = log.find((row) => row.seq === seq);
  if (!target) throw new Error(`no seq ${seq} in the fixture`);
  return { store, target };
}

/**
 * Is the agent engaged in `seq`'s thread scope when `seq` lands?
 *
 * @param log - One room's fixture log.
 * @param seq - The unmentioned post by the person.
 * @param window - The ceilings to weigh against.
 */
function engagedAt(log: readonly FixtureEntry[], seq: number, window: EngagedWindow): boolean {
  const { store, target } = replayUpTo(log, seq);
  return (
    engagementFor(
      { store },
      {
        roomId: ROOM,
        threadRootEntryId: target.root === undefined ? null : idOf(target.root),
        authorId: IDS.AGENT,
        window,
        now: new Date(target.at),
      }
    ) !== null
  );
}

describe('the real posts nobody answered (DOR-2823)', () => {
  describe('a thread whose root @mentioned the agent', () => {
    it.each([
      ['room A', ROOM_A, 48],
      ['room B', ROOM_B, 289],
      ['room B', ROOM_B, 297],
      ['room B', ROOM_B, 303],
      ['room B', ROOM_B, 308],
    ])('%s seq %i reaches the agent at the shipped window', (_room, log, seq) => {
      expect(engagedAt(log, seq, SHIPPED)).toBe(true);
    });

    // 27 minutes after the root: inside the operator's stopgap window, outside
    // the shipped one. Following the conversation rather than the clock is what
    // answers it at the shipped settings.
    it('room B seq 279 reaches the agent at a 60-minute window', () => {
      expect(engagedAt(ROOM_B, 279, STOPGAP)).toBe(true);
    });
  });

  describe('the posts that were answered still are', () => {
    it.each([
      ['room A', ROOM_A, 38],
      ['room B', ROOM_B, 282],
      ['room B', ROOM_B, 293],
      ['room B', ROOM_B, 314],
    ])('%s seq %i', (_room, log, seq) => {
      expect(engagedAt(log, seq, SHIPPED)).toBe(true);
    });
  });
});
