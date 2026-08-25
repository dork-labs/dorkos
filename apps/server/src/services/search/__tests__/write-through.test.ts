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
import { messages, searchSources, and, eq, type Db } from '@dorkos/db';
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

  it('keeps up across several posts without re-indexing what it already has', () => {
    subsystem.service.post(roomId, { authorId: human, text: 'first kestrel' });
    subsystem.service.post(roomId, { authorId: human, text: 'second kestrel' });
    subsystem.service.post(roomId, { authorId: human, text: 'third kestrel' });

    expect(find('kestrel')).toHaveLength(3);
    // Three entries, three rows — not three plus the re-reads a write-through
    // that ignored the watermark would have made. The unique index would absorb
    // a duplicate silently, so the count is the only thing that tells them apart.
    expect(db.select().from(messages).all()).toHaveLength(3);
    expect(watermark()).toBe(3);
  });

  it('advances the frontier past a notice, which is never indexed', () => {
    subsystem.service.post(roomId, { authorId: human, text: 'a kestrel post' });
    subsystem.service.postNotice(roomId, { text: 'the room speaking for itself' });

    // The notice is seq 2 and projects to nothing (a notice is not something
    // somebody said), but the room HAS been read to seq 2 — a watermark left at
    // 1 would re-read it on every sweep forever.
    expect(db.select().from(messages).all()).toHaveLength(1);
    expect(watermark()).toBe(2);
  });

  it('leaves the sweep with nothing to do', async () => {
    subsystem.service.post(roomId, { authorId: human, text: 'a kestrel post' });

    const sweep = await new SearchIndexer(db, [roomsSource]).sweep();

    // The reconciler and the write-through agree about what has been read, so
    // the sweep after a write-through is a no-op rather than a second pass over
    // the same rows. `indexed: 0` is the assertion an unchanged `count(*)` could
    // not make — that would pass for a sweep that re-read and re-upserted
    // everything.
    expect(sweep.indexed).toBe(0);
    expect(sweep.failures).toEqual([]);
    expect(find('kestrel')).toEqual([1]);
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

  it('leaves the message unfindable until the sweep catches up — and then findable', async () => {
    subsystem.service.post(roomId, { authorId: human, text: 'the kestrel migration is done' });
    // The negative half, stated so the positive half below cannot pass for the
    // wrong reason: nothing was indexed at post time.
    expect(find('kestrel')).toEqual([]);

    vi.restoreAllMocks();
    const sweep = await new SearchIndexer(db, [roomsSource]).sweep();

    expect(sweep.indexed).toBe(1);
    expect(find('kestrel')).toEqual([1]);
  });

  it('records no failure anywhere, because nothing failed', async () => {
    subsystem.service.post(roomId, { authorId: human, text: 'a kestrel post' });

    // A write-through that degraded by writing `last_error` would make a room
    // that is merely a few minutes behind look broken in the search envelope,
    // which is a warning nobody can act on.
    expect(
      db
        .select({ lastError: searchSources.lastError })
        .from(searchSources)
        .where(eq(searchSources.sourceId, 'rooms'))
        .all()
        .filter((row) => row.lastError !== null)
    ).toEqual([]);
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
