/**
 * room-store: the append log, seq allocation, threads and sessions.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { type Db } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import { RoomStore, type NewRoomEntry } from '../../room-store.js';
import { EVENT_LOG_MAX_EVENTS } from '../../../session/replay/event-log.js';

import { entry, ROOM_ID, seedRoom } from './room-store.fixtures.js';

describe('RoomStore.commitAnnouncements (spec `agent-home-desk` §6.2)', () => {
  it('names each commit from the entry that announced it, in this room only', () => {
    const store = new RoomStore(createTestDb());
    seedRoom(store);
    seedRoom(store, 'room-2');
    const merge = 'a'.repeat(40);
    const edit = 'b'.repeat(40);
    const elsewhere = 'c'.repeat(40);
    store.appendEntry(
      entry({
        id: 'm1',
        body: {
          text: 'Bo merged',
          subjectAuthorId: 'author-bo',
          merge: { branch: 'room/bo-1', commit: merge, files: 1, insertions: 1, deletions: 0 },
        },
      })
    );
    store.appendEntry(
      entry({
        id: 'f1',
        body: {
          text: 'Dee edited ROOM.md',
          subjectAuthorId: 'author-dee',
          fileChange: { kind: 'edit', paths: ['ROOM.md'], pathCount: 1, commit: edit },
        },
      })
    );
    store.appendEntry(
      entry({
        id: 'x1',
        roomId: 'room-2',
        body: {
          text: 'elsewhere',
          subjectAuthorId: 'author-eve',
          fileChange: { kind: 'edit', paths: ['a.md'], pathCount: 1, commit: elsewhere },
        },
      })
    );

    const found = store.commitAnnouncements(ROOM_ID, [merge, edit, elsewhere, 'd'.repeat(40)]);

    expect([...found.entries()].sort()).toEqual([
      [merge, { kind: 'merge', subjectAuthorId: 'author-bo' }],
      [edit, { kind: 'person', subjectAuthorId: 'author-dee' }],
    ]);
    expect(store.commitAnnouncements(ROOM_ID, []).size).toBe(0);
  });
});

describe('RoomStore forward paging', () => {
  let store: RoomStore;

  beforeEach(() => {
    store = new RoomStore(createTestDb());
    seedRoom(store);
    store.appendEntry(entry({ id: 'e1' }));
    store.appendEntry(entry({ id: 'e2' }));
    store.appendEntry(entry({ id: 'r1', parentEntryId: 'e1', threadRootEntryId: 'e1' }));
    store.appendEntry(entry({ id: 'r2', parentEntryId: 'e1', threadRootEntryId: 'e1' }));
  });

  it('pages the top level oldest-first, and a thread reply is not on it', () => {
    // The default timeline is `parent_entry_id IS NULL`: a reply lives in this
    // room's log but belongs to its thread, not to the timeline.
    expect(store.listEntriesFrom(ROOM_ID, { afterSeq: 0, limit: 10 }).map((e) => e.id)).toEqual([
      'e1',
      'e2',
    ]);
    expect(store.listEntriesFrom(ROOM_ID, { afterSeq: 0, limit: 1 }).map((e) => e.id)).toEqual([
      'e1',
    ]);
    expect(store.listEntriesFrom(ROOM_ID, { afterSeq: 1, limit: 10 }).map((e) => e.id)).toEqual([
      'e2',
    ]);
  });

  it('pages one thread, scoped to its root', () => {
    expect(
      store
        .listEntriesFrom(ROOM_ID, { afterSeq: 0, limit: 10, threadRootEntryId: 'e1' })
        .map((e) => e.id)
    ).toEqual(['r1', 'r2']);
    expect(
      store.listEntriesFrom(ROOM_ID, { afterSeq: 0, limit: 10, threadRootEntryId: 'e2' }),
      'a root with no replies has an empty thread, not the room'
    ).toEqual([]);
  });

  it('rolls several threads up in one read, and never counts a root in its own replies', () => {
    const summaries = store.countThreadRepliesFor(ROOM_ID, ['e1', 'e2']);
    expect(summaries.get('e1')?.replyCount).toBe(2);
    expect(summaries.get('e1')?.lastReplyAt).toBe('2026-07-26T12:00:00.000Z');
    expect(summaries.has('e2'), 'a root with no replies is absent, not zero').toBe(false);
    expect(store.countThreadRepliesFor(ROOM_ID, []).size, 'an empty ask reads nothing').toBe(0);
  });
});

describe('RoomStore seq allocation', () => {
  let db: Db;
  let store: RoomStore;

  beforeEach(() => {
    db = createTestDb();
    store = new RoomStore(db);
    seedRoom(store);
  });

  it('allocates 1, 2, 3 … with no gaps', () => {
    const seqs = ['a', 'b', 'c'].map((id) => store.appendEntry(entry({ id })).seq);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('allocates per room, not globally', () => {
    seedRoom(store, 'room-2');
    expect(store.appendEntry(entry({ id: 'a' })).seq).toBe(1);
    expect(store.appendEntry(entry({ id: 'b', roomId: 'room-2' })).seq).toBe(1);
    expect(store.appendEntry(entry({ id: 'c' })).seq).toBe(2);
  });

  it('does not consume a seq when the insert rolls back', () => {
    store.appendEntry(entry({ id: 'a' }));
    // A duplicate entry id violates `room_entries_room_id_entry_id_unique`, so
    // the whole transaction rolls back — including the seq it had read.
    expect(() => store.appendEntry(entry({ id: 'a' }))).toThrow();
    expect(store.appendEntry(entry({ id: 'b' })).seq).toBe(2);
    expect(store.maxSeq(ROOM_ID)).toBe(2);
  });

  it('bumps the room activity in the same transaction as the entry', () => {
    store.appendEntry(entry({ id: 'a', createdAt: '2026-07-26T13:00:00.000Z' }));
    expect(store.getRoom(ROOM_ID)?.lastActivityAt).toBe('2026-07-26T13:00:00.000Z');
  });
});

describe('RoomStore thread pointers and the counters over them', () => {
  let store: RoomStore;

  beforeEach(() => {
    store = new RoomStore(createTestDb());
    seedRoom(store);
  });

  it('round-trips both pointers through the insert', () => {
    store.appendEntry(entry({ id: 'root' }));
    store.appendEntry(entry({ id: 'reply', parentEntryId: 'root', threadRootEntryId: 'root' }));

    const stored = store.getEntryById(ROOM_ID, 'reply');
    expect(stored?.parentEntryId).toBe('root');
    expect(stored?.threadRootEntryId).toBe('root');
    // And the root stays outside its own thread, which is what makes the count
    // below mean "replies".
    expect(store.getEntryById(ROOM_ID, 'root')?.threadRootEntryId).toBeNull();
  });

  it('counts one thread replies, not the room, and not another thread', () => {
    store.appendEntry(entry({ id: 'root-a' }));
    store.appendEntry(entry({ id: 'root-b' }));
    store.appendEntry(entry({ id: 'top-level' }));
    for (const id of ['a1', 'a2', 'a3']) {
      store.appendEntry(entry({ id, parentEntryId: 'root-a', threadRootEntryId: 'root-a' }));
    }
    store.appendEntry(entry({ id: 'b1', parentEntryId: 'root-b', threadRootEntryId: 'root-b' }));

    expect(store.countThreadReplies(ROOM_ID, 'root-a')).toBe(3);
    expect(store.countThreadReplies(ROOM_ID, 'root-b')).toBe(1);
    // A root nobody answered has no replies — not "the room's entries".
    expect(store.countThreadReplies(ROOM_ID, 'top-level')).toBe(0);
  });

  it('is scoped to one room', () => {
    seedRoom(store, 'room-2');
    store.appendEntry(entry({ id: 'root' }));
    store.appendEntry(entry({ id: 'here', parentEntryId: 'root', threadRootEntryId: 'root' }));
    store.appendEntry(
      entry({ id: 'there', roomId: 'room-2', parentEntryId: 'root', threadRootEntryId: 'root' })
    );

    expect(store.countThreadReplies(ROOM_ID, 'root')).toBe(1);
    expect(store.countThreadReplies('room-2', 'root')).toBe(1);
  });

  it('keeps countUnread counting every entry, thread replies included', () => {
    // **Pinned deliberately, because filtering this is the tempting mistake**
    // (DOR-634). The read cursor is only ever advanced to the newest entry in
    // the array the client was handed, and that array is unfiltered — so a count
    // that excluded thread replies would leave a badge nothing can clear.
    store.appendEntry(entry({ id: 'root' }));
    store.appendEntry(entry({ id: 'r1', parentEntryId: 'root', threadRootEntryId: 'root' }));
    store.appendEntry(entry({ id: 'r2', parentEntryId: 'root', threadRootEntryId: 'root' }));

    expect(store.countUnread(ROOM_ID, 0)).toBe(3);
    expect(store.countUnread(ROOM_ID, 1)).toBe(2);
    // The room's true max seq, which is what the mark-read path writes: reading
    // the room clears the badge, threads and all.
    expect(store.countUnread(ROOM_ID, store.maxSeq(ROOM_ID))).toBe(0);
  });
});

describe('RoomStore.turnsByAuthorInCascade counts turns, not messages', () => {
  /** A cascade rooted at `root`, so every entry lands in the same count. */
  function inCascade(id: string, authorId: string, dispatchId?: string): NewRoomEntry {
    return entry({ id, authorId, cascadeRoot: 'root', cascadeDepth: 1, ...{ dispatchId } });
  }

  it('collapses every entry one turn wrote into a single turn', () => {
    // The DOR-1434 property, at the grain the query decides it: an agent that
    // says what it is doing three times and then answers has taken ONE turn.
    // Under the shipped `COUNT(*)` this read 4, which taxed an agent for being
    // legible about its work.
    const store = new RoomStore(createTestDb());
    seedRoom(store);
    store.appendEntry(entry({ id: 'root', authorId: 'human' }));
    store.appendEntry(inCascade('n1', 'ana', 'dsp_1'));
    store.appendEntry(inCascade('n2', 'ana', 'dsp_1'));
    store.appendEntry(inCascade('n3', 'ana', 'dsp_1'));
    store.appendEntry(inCascade('answer', 'ana', 'dsp_1'));

    expect(store.turnsByAuthorInCascade(ROOM_ID, 'root').get('ana')).toBe(1);
  });

  it('counts each turn once and adds them up', () => {
    const store = new RoomStore(createTestDb());
    seedRoom(store);
    store.appendEntry(entry({ id: 'root', authorId: 'human' }));
    store.appendEntry(inCascade('a1', 'ana', 'dsp_1'));
    store.appendEntry(inCascade('a2', 'ana', 'dsp_1'));
    store.appendEntry(inCascade('a3', 'ana', 'dsp_2'));
    store.appendEntry(inCascade('b1', 'bo', 'dsp_3'));

    expect(store.turnsByAuthorInCascade(ROOM_ID, 'root').get('ana')).toBe(2);
    expect(store.turnsByAuthorInCascade(ROOM_ID, 'root').get('bo')).toBe(1);
  });

  it('charges an unmarked row one turn each, so old rows keep counting as they did', () => {
    // Rows written before `dispatch_id` existed carry null, and so does every
    // post with no turn behind it. Each costs one — which is exactly the
    // message-counting behaviour those rows shipped under, so a database that
    // predates this column is not silently re-interpreted.
    const store = new RoomStore(createTestDb());
    seedRoom(store);
    store.appendEntry(entry({ id: 'root', authorId: 'human' }));
    store.appendEntry(inCascade('legacy1', 'ana'));
    store.appendEntry(inCascade('legacy2', 'ana'));
    store.appendEntry(inCascade('legacy3', 'ana'));

    expect(store.turnsByAuthorInCascade(ROOM_ID, 'root').get('ana')).toBe(3);
  });

  it('adds marked turns and unmarked rows together', () => {
    // The mixed cascade a real install upgrades into: some of Ana's rows predate
    // the column, and the turn she has taken since is one more on top.
    const store = new RoomStore(createTestDb());
    seedRoom(store);
    store.appendEntry(entry({ id: 'root', authorId: 'human' }));
    store.appendEntry(inCascade('legacy1', 'ana'));
    store.appendEntry(inCascade('legacy2', 'ana'));
    store.appendEntry(inCascade('now1', 'ana', 'dsp_1'));
    store.appendEntry(inCascade('now2', 'ana', 'dsp_1'));

    expect(store.turnsByAuthorInCascade(ROOM_ID, 'root').get('ana')).toBe(3);
  });

  it('never counts another cascade or another room', () => {
    const store = new RoomStore(createTestDb());
    seedRoom(store);
    seedRoom(store, 'room-2');
    store.appendEntry(entry({ id: 'root', authorId: 'human' }));
    store.appendEntry(inCascade('mine', 'ana', 'dsp_1'));
    store.appendEntry(entry({ id: 'other', authorId: 'ana', cascadeRoot: 'other-root' }));
    store.appendEntry(
      entry({ id: 'elsewhere', authorId: 'ana', roomId: 'room-2', cascadeRoot: 'root' })
    );

    expect(store.turnsByAuthorInCascade(ROOM_ID, 'root').get('ana')).toBe(1);
  });
});

describe('RoomStore never trims the log', () => {
  // Deliberately heavy: proving the absence of a trim means writing past the cap
  // through the real append path, which is 5000+ IMMEDIATE transactions. The
  // default 5s budget is not enough for that on a loaded machine, and a timeout
  // here would read as "the log trims" — the exact thing this test denies.
  it(`keeps more than EVENT_LOG_MAX_EVENTS (${EVENT_LOG_MAX_EVENTS}) entries`, () => {
    const store = new RoomStore(createTestDb());
    seedRoom(store);
    const total = EVENT_LOG_MAX_EVENTS + 5;
    for (let i = 0; i < total; i++) store.appendEntry(entry({ id: `e-${i}` }));

    // The in-memory EventLog and session_events both evict oldest at this cap.
    // A room that forgot what was said would not be a room, so this one does not.
    expect(store.maxSeq(ROOM_ID)).toBe(total);
    expect(store.listEntriesAfter(ROOM_ID, 0)).toHaveLength(total);
    expect(store.listEntries(ROOM_ID, { limit: 1, before: 2 })[0].seq).toBe(1);
  }, 60_000);
});

describe('RoomStore per-room agent sessions', () => {
  let store: RoomStore;

  beforeEach(() => {
    store = new RoomStore(createTestDb());
  });

  it('binds first-write-wins and rebinds last-write-wins', () => {
    // Two writes, two different rules, and the difference is the point. The
    // bind resolves a race between two posts arriving before the first reply,
    // so it must not overwrite. The rebind records which session the turn ACTUALLY
    // ran on, so it must.
    const first = store.bindRoomSession(
      ROOM_ID,
      'author-ana',
      'placeholder',
      '2026-07-30T10:00:00.000Z'
    );
    const second = store.bindRoomSession(
      ROOM_ID,
      'author-ana',
      'a-later-guess',
      '2026-07-30T10:00:00.000Z'
    );
    expect(first).toBe('placeholder');
    expect(second).toBe('placeholder');

    store.rebindRoomSession(ROOM_ID, 'author-ana', 'sdk-canonical-9f3c');
    expect(store.getRoomSession(ROOM_ID, 'author-ana')).toBe('sdk-canonical-9f3c');
  });

  it('keeps each agent in the room to its own session', () => {
    store.bindRoomSession(ROOM_ID, 'author-ana', 'ana-1', '2026-07-30T10:00:00.000Z');
    store.bindRoomSession(ROOM_ID, 'author-bo', 'bo-1', '2026-07-30T10:00:00.000Z');

    store.rebindRoomSession(ROOM_ID, 'author-ana', 'ana-canonical');

    expect(store.getRoomSession(ROOM_ID, 'author-ana')).toBe('ana-canonical');
    expect(store.getRoomSession(ROOM_ID, 'author-bo')).toBe('bo-1');
  });

  it('writes nothing for an agent that has no binding yet', () => {
    // An UPDATE, never an upsert: a rebind is a correction to a binding that
    // exists, and inventing one here would resurrect a session for an agent
    // whose membership was just removed.
    store.rebindRoomSession(ROOM_ID, 'author-ana', 'sdk-canonical-9f3c');
    expect(store.getRoomSession(ROOM_ID, 'author-ana')).toBeNull();
  });
});

describe('RoomStore.listRooms ordering', () => {
  let store: RoomStore;

  beforeEach(() => {
    store = new RoomStore(createTestDb());
  });

  /** The agent whose membership scopes {@link RoomStore.listRoomsForMember}. */
  const ANA = 'author-ana';

  /** A channel created — and so last active — at `at`, with Ana on its roster. */
  function channelAt(id: string, at: string): void {
    store.createRoom(
      {
        id,
        kind: 'channel',
        slug: id,
        title: `#${id}`,
        topic: null,
        createdAt: at,
      },
      [{ authorId: ANA, responseMode: 'always', joinedAt: at }]
    );
  }

  it('answers newest activity first', () => {
    channelAt('old', '2026-07-26T10:00:00.000Z');
    channelAt('new', '2026-07-26T12:00:00.000Z');
    channelAt('mid', '2026-07-26T11:00:00.000Z');

    expect(store.listRooms().map((room) => room.id)).toEqual(['new', 'mid', 'old']);
  });

  it('breaks a tie on the id rather than leaving it to SQLite', () => {
    // Ties are the common case, not the corner: a room that has never been
    // posted in has `lastActivityAt === createdAt`, so any batch seeded in one
    // pass ties outright. Inserted a, c, b — an untied ORDER BY hands those back
    // in whatever order it likes, and the sidebar reshuffles on every refetch.
    const tied = '2026-07-26T10:00:00.000Z';
    channelAt('a', tied);
    channelAt('c', tied);
    channelAt('b', tied);

    expect(store.listRooms().map((room) => room.id)).toEqual(['c', 'b', 'a']);
  });

  it('orders an agent-scoped listing identically, ties included', () => {
    // `listRoomsForMember` is the agent-facing sibling and feeds the SAME
    // endpoint. Asserting only `listRooms` left this half free to drift, and
    // "the two must not disagree about what newest-first means" is the entire
    // reason its ORDER BY was touched — so it gets the same proof, not a
    // comment promising it.
    const tied = '2026-07-26T10:00:00.000Z';
    channelAt('a', tied);
    channelAt('c', tied);
    channelAt('b', tied);
    channelAt('newest', '2026-07-26T12:00:00.000Z');

    const scoped = store.listRoomsForMember(ANA).map((room) => room.id);
    expect(scoped).toEqual(['newest', 'c', 'b', 'a']);
    expect(scoped).toEqual(store.listRooms().map((room) => room.id));
  });
});
