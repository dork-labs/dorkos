/**
 * The write-through: a message is findable the moment it is said, and an index
 * that cannot be written never costs anybody a post (message-search spec §5,
 * Amendment 6).
 *
 * Two properties, and they pull in opposite directions, which is why both are
 * here. The index has to be written on the post path to be fresh; and the post
 * path has to survive that write failing, because the room log is the truth and
 * the index is a copy of it. A test for either one alone would be satisfied by
 * an implementation that gets the other badly wrong.
 *
 * Driven through the REAL rooms subsystem — the production composition, wired
 * exactly as `index.ts` wires it — because the subject is the wiring. A test
 * that called `indexRoomEntry` itself would prove only that the function works,
 * which is not the claim.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { searchSources, and, eq, type Db } from '@dorkos/db';
import { createRoomSubsystem, type RoomSubsystem } from '../../rooms/index.js';
import { SearchIndexer } from '../indexer.js';
import { roomsSource } from '../registry.js';
import { searchMessages } from '../query.js';
import * as rowFrontier from '../row-frontier.js';

let db: Db;
let subsystem: RoomSubsystem;
let human: string;
let roomId: string;

/** Search this room the way `search_room_history` does, from the beginning. */
function find(query: string): number[] {
  return searchMessages(db, {
    scopes: [
      { sourceId: roomsSource.id, visibility: 'containers', containers: [{ originKey: roomId }] },
    ],
    query,
    limit: 20,
  }).map((hit) => hit.ordinal);
}

/** What the frontier says it has read of this room. */
function watermark(): number | null {
  return (
    db
      .select({ lastOrdinal: searchSources.lastOrdinal })
      .from(searchSources)
      .where(and(eq(searchSources.sourceId, 'rooms'), eq(searchSources.originKey, roomId)))
      .get()?.lastOrdinal ?? null
  );
}

beforeEach(() => {
  db = createTestDb();
  subsystem = createRoomSubsystem({ db });
  human = subsystem.authors.localHuman().id;
  roomId = subsystem.service.createRoom(
    { kind: 'channel', title: 'Backend', members: [], agentPaths: [] },
    human
  ).id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a message is findable the moment it is said', () => {
  it('indexes a post with no sweep at all', () => {
    subsystem.service.post(roomId, { authorId: human, text: 'the kestrel migration is done' });

    // No `SearchIndexer` anywhere in this test. If the write-through is not
    // wired, nothing has read `room_entries` and this is empty.
    expect(find('kestrel')).toEqual([1]);
  });
});

describe('a room the index is far behind on', () => {
  it('is left to the sweep rather than caught up inside a post', async () => {
    // A room with a long unindexed backlog — a fresh index, a restored database, a
    // room that has been quiet since before search existed. The write-through
    // resumes where the index stopped, so without the bound the FIRST post into
    // this room would project every one of these entries synchronously inside
    // `publishEntry`, with a person waiting on it (measured at 406 ms for 20,000
    // entries).
    const service = subsystem.service;
    vi.spyOn(rowFrontier, 'indexRowContainer').mockImplementation(() => {
      throw new Error('the index must not be written inline for a backlogged room');
    });
    for (let i = 0; i < 400; i += 1) {
      service.post(roomId, { authorId: human, text: `backlog entry ${i} about kestrels` });
    }
    vi.restoreAllMocks();

    // The post that crosses the bound: it must not throw, and it must not index.
    service.post(roomId, { authorId: human, text: 'the kestrel migration is done' });
    expect(find('kestrel')).toEqual([]);
    expect(watermark()).toBeNull();

    // And the deferral is exactly the tested degradation: the sweep catches up.
    const sweep = await new SearchIndexer(db, [roomsSource]).sweep();
    expect(sweep.indexed).toBe(401);
    expect(find('migration')).toEqual([401]);
  });
});

describe('an index that cannot be written', () => {
  beforeEach(() => {
    // The shipped write-through, with the write under it broken — a locked
    // database, a migration half-applied, an FTS5 index in a state SQLite
    // refuses. What the failure IS does not matter; that the post survives it
    // does.
    vi.spyOn(rowFrontier, 'indexRowContainer').mockImplementation(() => {
      throw new Error('database is locked');
    });
  });

  it('does not fail the post', () => {
    expect(() =>
      subsystem.service.post(roomId, { authorId: human, text: 'the kestrel migration is done' })
    ).not.toThrow();

    // The room has it. The log is the truth, and the truth was written.
    expect(subsystem.service.entriesAfter(roomId, 0).map((entry) => entry.seq)).toEqual([1]);
  });
});

describe('a write-through port that throws', () => {
  it('is caught by the room service itself, not only by the implementation', async () => {
    // Defense in depth, driven rather than asserted in prose. The shipped
    // implementation promises never to throw; this is the guard that keeps the
    // promise true for whatever is wired in next.
    const { createRoomHarness } = await import('../../rooms/__tests__/room-test-harness.js');
    const harness = createRoomHarness({
      agents: { byPath: () => null },
      indexEntry: () => {
        throw new Error('a port that does not keep its word');
      },
    });
    const room = harness.service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: [] },
      harness.human
    );

    expect(() =>
      harness.service.post(room.id, { authorId: harness.human, text: 'still posted' })
    ).not.toThrow();
    expect(harness.service.entriesAfter(room.id, 0)).toHaveLength(1);
  });
});
