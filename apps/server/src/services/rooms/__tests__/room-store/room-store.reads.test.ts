/**
 * room-store: the reads a turn and the sidebar make.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { RoomStore, type NewRoomEntry } from '../../room-store.js';
import { toLastLine } from '../../manage/room-list-reads.js';
import { ROOM_LAST_LINE_MAX_CHARS, ROOM_MENTION_COUNT_CAP } from '@dorkos/shared/room-schemas';

import { entry, ROOM_ID, seedRoom } from './room-store.fixtures.js';

describe('RoomStore.listUnreadEntries', () => {
  /** A room holding `total` entries by `author`, plus the seeded room row. */
  function roomWith(total: number, authorId = 'human'): RoomStore {
    const store = new RoomStore(createTestDb());
    seedRoom(store);
    for (let i = 1; i <= total; i += 1) {
      store.appendEntry(entry({ id: `e-${i}`, authorId, body: { text: `m${i}` } }));
    }
    return store;
  }

  it('returns the NEWEST entries above the cursor, oldest first', () => {
    const store = roomWith(10);
    const rows = store.listUnreadEntries(ROOM_ID, {
      afterSeq: 0,
      throughSeq: Number.MAX_SAFE_INTEGER,
      excludeAuthorId: 'ana',
      excludeEntryIds: [],
      limit: 3,
    });
    expect(rows.map((e) => e.body.text)).toEqual(['m8', 'm9', 'm10']);
  });

  it('returns a bounded page from an unbounded log', () => {
    // The quadratic shape this replaced: `listEntriesAfter` plus a `slice` in
    // JS, over a cursor that is 0 for every agent until RP3 advances it — so
    // every turn read the whole log to keep the tail of it. Both reads are put
    // side by side because the contrast is the measurement: one is bounded by
    // its argument, the other by the room's history.
    const store = roomWith(500);
    const page = store.listUnreadEntries(ROOM_ID, {
      afterSeq: 0,
      throughSeq: Number.MAX_SAFE_INTEGER,
      excludeAuthorId: 'ana',
      excludeEntryIds: [],
      limit: 31,
    });
    expect(page).toHaveLength(31);
    expect(page[page.length - 1].body.text).toBe('m500');
    expect(store.listEntriesAfter(ROOM_ID, 0)).toHaveLength(500);
  });

  it('excludes the reading author own entries and the triggering entry', () => {
    const store = new RoomStore(createTestDb());
    seedRoom(store);
    store.appendEntry(entry({ id: 'from-human', authorId: 'human' }));
    store.appendEntry(entry({ id: 'from-ana', authorId: 'ana' }));
    store.appendEntry(entry({ id: 'the-trigger', authorId: 'human' }));

    const rows = store.listUnreadEntries(ROOM_ID, {
      afterSeq: 0,
      throughSeq: Number.MAX_SAFE_INTEGER,
      excludeAuthorId: 'ana',
      excludeEntryIds: ['the-trigger'],
      limit: 30,
    });
    expect(rows.map((e) => e.id)).toEqual(['from-human']);
  });

  it('honours the cursor', () => {
    const store = roomWith(5);
    const rows = store.listUnreadEntries(ROOM_ID, {
      afterSeq: 3,
      throughSeq: Number.MAX_SAFE_INTEGER,
      excludeAuthorId: 'ana',
      excludeEntryIds: [],
      limit: 30,
    });
    expect(rows.map((e) => e.body.text)).toEqual(['m4', 'm5']);
  });

  it('closes the window at the top too, so a turn never sees past its trigger', () => {
    // The ceiling is what makes the claim-time cursor advance safe: a message
    // that lands while a turn is being assembled belongs to the NEXT turn's
    // window, because the cursor the claim wrote stops at the trigger. Without
    // it the newest-first page would reach past the ceiling and hand the same
    // entry to two turns in a row (room-participation spec §8.3).
    const store = roomWith(10);
    const rows = store.listUnreadEntries(ROOM_ID, {
      afterSeq: 3,
      throughSeq: 6,
      excludeAuthorId: 'ana',
      excludeEntryIds: [],
      limit: 30,
    });
    expect(rows.map((e) => e.body.text)).toEqual(['m4', 'm5', 'm6']);
  });
});

describe('RoomStore top-level channel reads', () => {
  const BOUNDS = {
    throughSeq: Number.MAX_SAFE_INTEGER,
    excludeAuthorId: 'ana',
    excludeEntryId: 'none',
  };

  /** A room with one top-level post per text, plus whatever `extra` adds. */
  function roomWith(texts: string[], extra: NewRoomEntry[] = []): RoomStore {
    const store = new RoomStore(createTestDb());
    seedRoom(store);
    texts.forEach((text, i) => {
      store.appendEntry(entry({ id: `t-${i + 1}`, authorId: 'human', body: { text } }));
    });
    for (const row of extra) store.appendEntry(row);
    return store;
  }

  it('returns the NEWEST top-level entries above the floor, oldest first', () => {
    const store = roomWith(['c1', 'c2', 'c3', 'c4']);
    const rows = store.listRecentTopLevelEntries(ROOM_ID, {
      ...BOUNDS,
      afterSeq: 0,
      limit: 2,
    });
    expect(rows.map((e) => e.body.text)).toEqual(['c3', 'c4']);
  });

  it('reads nothing at all for a limit of zero or less', () => {
    // A caller asking for no rows must not reach SQLite: a negative LIMIT is
    // UNLIMITED there, so the one number most obviously meaning "nothing" would
    // return the whole room.
    const store = roomWith(['c1', 'c2']);
    expect(store.listRecentTopLevelEntries(ROOM_ID, { ...BOUNDS, afterSeq: 0, limit: 0 })).toEqual(
      []
    );
    expect(store.listRecentTopLevelEntries(ROOM_ID, { ...BOUNDS, afterSeq: 0, limit: -1 })).toEqual(
      []
    );
  });

  it('honours the floor, so nothing said before the member joined is read', () => {
    const store = roomWith(['c1', 'c2', 'c3']);
    const rows = store.listRecentTopLevelEntries(ROOM_ID, { ...BOUNDS, afterSeq: 2, limit: 5 });
    expect(rows.map((e) => e.body.text)).toEqual(['c3']);
  });

  it('closes the window at the trigger, exactly as the unread window does', () => {
    const store = roomWith(['c1', 'c2', 'c3', 'c4']);
    const rows = store.listRecentTopLevelEntries(ROOM_ID, {
      ...BOUNDS,
      throughSeq: 2,
      afterSeq: 0,
      limit: 5,
    });
    expect(rows.map((e) => e.body.text)).toEqual(['c1', 'c2']);
  });

  it('reads posts only, so no notice eats a slot in the glance', () => {
    // Five slots is the whole budget, and a notice is the room narrating itself
    // rather than anybody talking. Reading posts only also subsumes the
    // subject filter `listUnreadEntries` needs: `subjectAuthorId` is written
    // exactly when `kind === 'notice'`, so a notice ABOUT the reader — the room
    // saying "Ana was busy" back to Ana — cannot reach this read either.
    const store = roomWith(
      ['c1'],
      [
        entry({
          id: 'notice-about-ana',
          authorId: 'system',
          kind: 'notice',
          body: { text: 'Ana was busy', subjectAuthorId: 'ana' },
        }),
        entry({
          id: 'notice-about-bo',
          authorId: 'system',
          kind: 'notice',
          body: { text: 'Bo was busy', subjectAuthorId: 'bo' },
        }),
      ]
    );
    const rows = store.listRecentTopLevelEntries(ROOM_ID, { ...BOUNDS, afterSeq: 0, limit: 5 });
    expect(rows.map((e) => e.id)).toEqual(['t-1']);
  });

  it('reads the channel only, never a thread reply hanging off it', () => {
    const store = roomWith(
      ['c1'],
      [
        entry({
          id: 'reply',
          authorId: 'human',
          body: { text: 'in the thread' },
          parentEntryId: 't-1',
          threadRootEntryId: 't-1',
        }),
      ]
    );
    const rows = store.listRecentTopLevelEntries(ROOM_ID, { ...BOUNDS, afterSeq: 0, limit: 5 });
    expect(rows.map((e) => e.body.text)).toEqual(['c1']);
  });

  it('excludes the reading agent own posts and the one named entry', () => {
    const store = new RoomStore(createTestDb());
    seedRoom(store);
    store.appendEntry(entry({ id: 'from-human', authorId: 'human' }));
    store.appendEntry(entry({ id: 'from-ana', authorId: 'ana' }));
    store.appendEntry(entry({ id: 'the-root', authorId: 'human' }));

    const rows = store.listRecentTopLevelEntries(ROOM_ID, {
      ...BOUNDS,
      excludeEntryId: 'the-root',
      afterSeq: 0,
      limit: 5,
    });
    expect(rows.map((e) => e.id)).toEqual(['from-human']);
  });

  it('counts exactly what the list would have returned without a limit', () => {
    // The two reads answer "show me five" and "how many are there", and the
    // omitted count is their difference — so a predicate that drifted between
    // them would report a number about a different set of messages.
    const store = roomWith(
      ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'],
      [
        entry({
          id: 'notice',
          authorId: 'system',
          kind: 'notice',
          body: { text: 'Ana was busy', subjectAuthorId: 'ana' },
        }),
        entry({ id: 'mine', authorId: 'ana', body: { text: 'my own' } }),
        entry({
          id: 'reply',
          authorId: 'human',
          body: { text: 'threaded' },
          parentEntryId: 't-1',
          threadRootEntryId: 't-1',
        }),
      ]
    );
    const opts = { ...BOUNDS, excludeEntryId: 't-1', afterSeq: 1 };
    const all = store.listRecentTopLevelEntries(ROOM_ID, { ...opts, limit: 100 });
    expect(store.countRecentTopLevelEntries(ROOM_ID, opts)).toBe(all.length);
    expect(all.map((e) => e.body.text)).toEqual(['c2', 'c3', 'c4', 'c5', 'c6']);
  });
});

describe('RoomStore.rewindReadCursor', () => {
  /** A room with one member whose cursor has been advanced to `at`. */
  function memberAt(at: number): RoomStore {
    const store = new RoomStore(createTestDb());
    seedRoom(store);
    store.addMember({
      roomId: ROOM_ID,
      authorId: 'ana',
      responseMode: 'always',
      joinedAt: '2026-07-26T11:00:00.000Z',
    });
    store.setReadCursor(ROOM_ID, 'ana', at);
    return store;
  }

  it('puts the cursor back when it is still where the caller left it', () => {
    const store = memberAt(7);
    expect(store.rewindReadCursor(ROOM_ID, 'ana', { from: 7, to: 2 })?.lastReadSeq).toBe(2);
  });

  it('refuses when something else has moved it since', () => {
    // The whole reason this is a compare-and-set. A refused turn may release long
    // after a SECOND turn was claimed for the same member — and that turn WAS
    // shown its window, so walking its cursor back would replay the conversation
    // to it. The stale rewind has to miss, silently.
    const store = memberAt(7);
    store.setReadCursor(ROOM_ID, 'ana', 9);

    expect(store.rewindReadCursor(ROOM_ID, 'ana', { from: 7, to: 2 })?.lastReadSeq).toBe(9);
  });

  it('is what setReadCursor cannot do, which is why it is its own method', () => {
    // Pins the monotonic guarantee this deliberately does not relax: the mark-read
    // route must stay unable to un-read a room for a second client.
    const store = memberAt(7);
    expect(store.setReadCursor(ROOM_ID, 'ana', 2)?.lastReadSeq).toBe(7);
  });
});

describe('RoomStore.listEntriesByAuthor', () => {
  it('returns only that author newest entries, oldest first within the page', () => {
    const store = new RoomStore(createTestDb());
    seedRoom(store);
    // Interleaved, so a query that ignored the author would come back in a
    // different order AND with the wrong rows.
    for (let i = 1; i <= 6; i += 1) {
      store.appendEntry(entry({ id: `ana-${i}`, authorId: 'ana', body: { text: `ana ${i}` } }));
      store.appendEntry(entry({ id: `bo-${i}`, authorId: 'bo', body: { text: `bo ${i}` } }));
    }

    const recent = store.listEntriesByAuthor(ROOM_ID, 'ana', 3);
    expect(recent.map((e) => e.body.text)).toEqual(['ana 4', 'ana 5', 'ana 6']);
  });

  it('is scoped to one room', () => {
    const store = new RoomStore(createTestDb());
    seedRoom(store);
    seedRoom(store, 'room-2');
    store.appendEntry(entry({ id: 'here', authorId: 'ana' }));
    store.appendEntry(entry({ id: 'there', authorId: 'ana', roomId: 'room-2' }));

    expect(store.listEntriesByAuthor(ROOM_ID, 'ana', 10).map((e) => e.id)).toEqual(['here']);
  });

  it('is empty for an author that has said nothing', () => {
    const store = new RoomStore(createTestDb());
    seedRoom(store);
    store.appendEntry(entry({ id: 'a', authorId: 'ana' }));
    expect(store.listEntriesByAuthor(ROOM_ID, 'bo', 10)).toEqual([]);
  });
});

describe('RoomListReads.roomsPostedInBy', () => {
  it('names every room an author wrote in, and no room they only sat in', () => {
    const store = new RoomStore(createTestDb());
    seedRoom(store);
    seedRoom(store, 'room-2');
    seedRoom(store, 'room-3');
    store.appendEntry(entry({ id: 'a', authorId: 'ana' }));
    store.appendEntry(entry({ id: 'b', authorId: 'ana', roomId: 'room-2' }));
    // Somebody else talking in room-3 must not put it in Ana's set.
    store.appendEntry(entry({ id: 'c', authorId: 'bo', roomId: 'room-3' }));

    expect([...store.listReads.roomsPostedInBy('ana')].sort()).toEqual([ROOM_ID, 'room-2']);
    expect([...store.listReads.roomsPostedInBy('bo')]).toEqual(['room-3']);
  });

  it('is empty for somebody who has never written anywhere', () => {
    // The fresh-install answer, and the one the sidebar's "say hi" suggestion
    // turns on — so it must be an empty set rather than an absent one.
    const store = new RoomStore(createTestDb());
    seedRoom(store);
    store.appendEntry(entry({ id: 'a', authorId: 'ana' }));

    expect(store.listReads.roomsPostedInBy('bo').size).toBe(0);
  });

  it('reads the author index instead of scanning the whole log', () => {
    // The point of `idx_room_entries_author_room`: proving "never posted" is
    // otherwise a full scan of every room's entries, on a query the sidebar
    // runs on every room list. A returned value cannot show which, so ask
    // SQLite. Reds if the index is dropped and the migration with it.
    const db = createTestDb();
    const store = new RoomStore(db);
    seedRoom(store);
    store.appendEntry(entry({ id: 'a', authorId: 'ana' }));

    const sqlite = (db as unknown as { $client: import('better-sqlite3').Database }).$client;
    const plan = sqlite
      .prepare('EXPLAIN QUERY PLAN SELECT DISTINCT room_id FROM room_entries WHERE author_id = ?')
      .all('ana') as { detail: string }[];
    const detail = plan.map((row) => row.detail).join('; ');

    expect(detail).toContain('idx_room_entries_author_room');
    expect(detail).not.toContain('SCAN room_entries');
  });
});

describe('RoomListReads.countUnreadMentions', () => {
  let store: RoomStore;

  beforeEach(() => {
    store = new RoomStore(createTestDb());
    seedRoom(store);
  });

  it('counts only entries above the cursor that name the reader', () => {
    store.appendEntry(entry({ id: 'e1', authorId: 'bo', mentions: ['ana'] })); // seq 1
    store.appendEntry(entry({ id: 'e2', authorId: 'bo', mentions: [] })); // seq 2
    store.appendEntry(entry({ id: 'e3', authorId: 'bo', mentions: ['ana', 'cy'] })); // seq 3

    expect(store.listReads.countUnreadMentions(ROOM_ID, 0, 'ana')).toBe(2);
    // The cursor is exclusive: seq 1 is read once the cursor sits on it.
    expect(store.listReads.countUnreadMentions(ROOM_ID, 1, 'ana')).toBe(1);
    expect(store.listReads.countUnreadMentions(ROOM_ID, 3, 'ana')).toBe(0);
  });

  it("does not count somebody else's mentions", () => {
    store.appendEntry(entry({ id: 'e1', authorId: 'bo', mentions: ['cy'] }));
    expect(store.listReads.countUnreadMentions(ROOM_ID, 0, 'ana')).toBe(0);
    expect(store.listReads.countUnreadMentions(ROOM_ID, 0, 'cy')).toBe(1);
  });

  it('counts a mention in a thread reply, which the room cursor also covers', () => {
    store.appendEntry(entry({ id: 'root', authorId: 'bo' }));
    store.appendEntry(
      entry({
        id: 'reply',
        authorId: 'bo',
        mentions: ['ana'],
        parentEntryId: 'root',
        threadRootEntryId: 'root',
      })
    );
    expect(store.listReads.countUnreadMentions(ROOM_ID, 0, 'ana')).toBe(1);
  });

  it('does not count a reader naming themselves', () => {
    store.appendEntry(entry({ id: 'e1', authorId: 'ana', mentions: ['ana'] }));
    expect(store.listReads.countUnreadMentions(ROOM_ID, 0, 'ana')).toBe(0);
  });

  it('stops counting at the cap, since nothing reads past 9+', () => {
    for (let i = 0; i < 14; i += 1) {
      store.appendEntry(entry({ id: `m${i}`, authorId: 'bo', mentions: ['ana'] }));
    }
    expect(store.listReads.countUnreadMentions(ROOM_ID, 0, 'ana')).toBe(ROOM_MENTION_COUNT_CAP);
  });

  it('is scoped to one room', () => {
    seedRoom(store, 'room-2');
    store.appendEntry(entry({ id: 'e1', roomId: 'room-2', authorId: 'bo', mentions: ['ana'] }));
    expect(store.listReads.countUnreadMentions(ROOM_ID, 0, 'ana')).toBe(0);
    expect(store.listReads.countUnreadMentions('room-2', 0, 'ana')).toBe(1);
  });
});

describe('RoomListReads.lastLines', () => {
  let db: ReturnType<typeof createTestDb>;
  let store: RoomStore;
  /** The whole log of every room, from the top. */
  const whole = (...roomIds: string[]) => roomIds.map((roomId) => ({ roomId, floor: 0 }));

  beforeEach(() => {
    db = createTestDb();
    store = new RoomStore(db);
    seedRoom(store);
    seedRoom(store, 'room-2');
    seedRoom(store, 'room-3');
  });

  it('gives each room its newest top-level message, skipping later thread replies', () => {
    store.appendEntry(entry({ id: 'old', body: { text: 'first' } }));
    store.appendEntry(entry({ id: 'root', body: { text: 'the latest word' } }));
    store.appendEntry(
      entry({
        id: 'reply',
        body: { text: 'a reply in a thread' },
        parentEntryId: 'root',
        threadRootEntryId: 'root',
      })
    );
    store.appendEntry(entry({ id: 'r2', roomId: 'room-2', body: { text: 'over here' } }));

    const lines = store.listReads.lastLines(whole(ROOM_ID, 'room-2', 'room-3'));
    expect(lines.get(ROOM_ID)).toBe('the latest word');
    expect(lines.get('room-2')).toBe('over here');
    // A room nobody has written in has no line.
    expect(lines.get('room-3')).toBeNull();
  });

  it('never reads at or below the floor, so a late joiner sees nothing from before', () => {
    store.appendEntry(entry({ id: 'e1', body: { text: 'before you came' } })); // seq 1
    store.appendEntry(entry({ id: 'e2', body: { text: 'also before' } })); // seq 2
    expect(store.listReads.lastLines([{ roomId: ROOM_ID, floor: 2 }]).get(ROOM_ID)).toBeNull();

    store.appendEntry(entry({ id: 'e3', body: { text: 'after you came' } })); // seq 3
    expect(store.listReads.lastLines([{ roomId: ROOM_ID, floor: 2 }]).get(ROOM_ID)).toBe(
      'after you came'
    );
  });

  it('collapses whitespace and cuts a long line without an ellipsis', () => {
    store.appendEntry(entry({ id: 'e1', body: { text: `  two\n\nlines\t${'x'.repeat(300)}` } }));
    const line = store.listReads.lastLines(whole(ROOM_ID)).get(ROOM_ID);
    expect(line?.startsWith('two lines x')).toBe(true);
    expect(line).toHaveLength(ROOM_LAST_LINE_MAX_CHARS);
    expect(line?.endsWith('…')).toBe(false);
  });

  it('answers null for a newest message with no text', () => {
    store.appendEntry(entry({ id: 'e1', body: { text: '   ' } }));
    expect(store.listReads.lastLines(whole(ROOM_ID)).get(ROOM_ID)).toBeNull();
  });

  it('asks nothing for an empty list', () => {
    expect(store.listReads.lastLines([]).size).toBe(0);
  });

  it('searches the primary key per room and never scans the log', () => {
    // The shape that matters is invisible in the value returned: a version
    // that started from `room_entries` read every room's whole log. So ask
    // SQLite for the plan of the exact statement `lastLines` prepares.
    store.appendEntry(entry({ id: 'e1', body: { text: 'hello' } }));
    const sqlite = (db as unknown as { $client: import('better-sqlite3').Database }).$client;
    const prepare = vi.spyOn(sqlite, 'prepare');
    store.listReads.lastLines(whole(ROOM_ID, 'room-2'));
    const statement = prepare.mock.calls
      .map(([text]) => String(text))
      .find((text) => text.includes('json_each'));
    prepare.mockRestore();
    expect(statement).toBeDefined();

    const plan = sqlite
      .prepare(`EXPLAIN QUERY PLAN ${statement}`)
      .all(JSON.stringify([[ROOM_ID, 0]])) as { detail: string }[];
    const detail = plan.map((row) => row.detail).join('; ');
    expect(detail).toMatch(/SEARCH n USING (INDEX|PRIMARY KEY)/);
    expect(detail).not.toMatch(/SCAN (room_entries|n)\b/);
  });
});

describe('toLastLine', () => {
  it('never ends on half of an emoji', () => {
    const text = `${'a'.repeat(ROOM_LAST_LINE_MAX_CHARS - 1)}🙂 and more`;
    const line = toLastLine(text);
    expect(line).toBe('a'.repeat(ROOM_LAST_LINE_MAX_CHARS - 1));
  });

  it('takes out the markdown people type, keeping the words', () => {
    expect(toLastLine('**Shipped** the `fix`, see [the PR](https://x.test/1)')).toBe(
      'Shipped the fix, see the PR'
    );
    expect(toLastLine('```ts\nconst a = 1;\n```')).toBe('const a = 1;');
    expect(toLastLine('# Plan\n> quoted ~~old~~ ![chart](c.png)')).toBe('Plan quoted old chart');
  });

  it('strips before it cuts, so syntax never eats the budget', () => {
    const line = toLastLine(`**${'b'.repeat(ROOM_LAST_LINE_MAX_CHARS)}**`);
    expect(line).toBe('b'.repeat(ROOM_LAST_LINE_MAX_CHARS));
  });

  it('answers null for a message that was only markdown', () => {
    expect(toLastLine('```\n```')).toBeNull();
  });
});
