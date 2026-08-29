/**
 * The engaged window (room-participation spec §9.2, §9.6).
 *
 * Table-driven over a real {@link RoomStore} on a real database, because the
 * predicate is three SQL clauses and a `findIndex` — a fake store would only
 * prove the `findIndex`, and the clauses are the half that decides whether a
 * notice, an agent's own post, or a reply in another thread decays a window.
 *
 * The clock is injected, so nothing here sleeps.
 *
 * @module server/services/rooms/tests/engagement
 */
import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { authors, type Db } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import { engagementFor, type EngagedWindow } from '../engagement.js';
import { RoomStore } from '../room-store.js';

const ROOM = 'room-1';
const ANA = 'ana';
const BO = 'bo';
const HUMAN = 'dorian';

/** The shipped ceilings, which is what most of these are about. */
const WINDOW: EngagedWindow = { minutes: 10, posts: 5 };

/** `2026-07-28T12:00:00.000Z`, and every timestamp below is an offset from it. */
const T0 = Date.parse('2026-07-28T12:00:00.000Z');

/** An ISO timestamp `minutes` before {@link NOW}. */
function minutesAgo(minutes: number): string {
  return new Date(T0 - minutes * 60_000).toISOString();
}

/** The instant every case is evaluated at. */
const NOW = new Date(T0);

/** A store with one channel in it, ready to be written to. */
function freshRoom(): { db: Db; store: RoomStore } {
  const db = createTestDb();
  const store = new RoomStore(db);
  store.createRoom(
    {
      id: ROOM,
      kind: 'channel',
      slug: 'general',
      title: 'General',
      topic: null,
      createdAt: minutesAgo(600),
    },
    []
  );
  return { db, store };
}

/** Most cases only need the store. */
function freshStore(): RoomStore {
  return freshRoom().store;
}

/** Append one entry, defaulting to a top-level post by the human. */
function write(
  store: RoomStore,
  entry: {
    id: string;
    authorId?: string;
    kind?: 'post' | 'notice';
    mentions?: string[];
    threadRootEntryId?: string | null;
    minutesAgo?: number;
  }
): void {
  store.appendEntry({
    roomId: ROOM,
    id: entry.id,
    authorId: entry.authorId ?? HUMAN,
    kind: entry.kind ?? 'post',
    body: { text: entry.id },
    mentions: entry.mentions ?? [],
    sessionId: null,
    cascadeRoot: entry.id,
    cascadeDepth: 0,
    parentEntryId: entry.threadRootEntryId ?? null,
    threadRootEntryId: entry.threadRootEntryId ?? null,
    createdAt: minutesAgo(entry.minutesAgo ?? 0),
  });
}

/** Is Ana engaged at the channel's top level right now? */
function isEngaged(store: RoomStore, window: EngagedWindow = WINDOW): boolean {
  return (
    engagementFor(
      { store },
      { roomId: ROOM, threadRootEntryId: null, authorId: ANA, window, now: NOW }
    ) !== null
  );
}

describe('the engaged window', () => {
  it('is closed in a room where nobody has ever addressed the agent', () => {
    const store = freshStore();
    write(store, { id: 'e1' });
    expect(isEngaged(store)).toBe(false);
  });

  describe('decaying on messages from other people', () => {
    /**
     * Mention, then `others` further posts by somebody else. The spec's own
     * table: four is engaged, five is not.
     */
    function afterOtherPosts(others: number): boolean {
      const store = freshStore();
      write(store, { id: 'mention', mentions: [ANA], minutesAgo: 1 });
      for (let i = 0; i < others; i++) write(store, { id: `after-${i}`, minutesAgo: 1 });
      return isEngaged(store);
    }

    it.each([
      [0, true],
      [1, true],
      [4, true],
      [5, false],
      [9, false],
    ])('mention then %i posts by others -> engaged: %s', (others, expected) => {
      expect(afterOtherPosts(others)).toBe(expected);
    });

    it('does not decay on the agent’s own posts, however many it writes', () => {
      const store = freshStore();
      write(store, { id: 'mention', mentions: [ANA], minutesAgo: 1 });
      for (let i = 0; i < 20; i++) write(store, { id: `ana-${i}`, authorId: ANA, minutesAgo: 1 });
      expect(isEngaged(store)).toBe(true);
    });

    it('does not decay on notices, which are the room talking about the conversation', () => {
      const store = freshStore();
      write(store, { id: 'mention', mentions: [ANA], minutesAgo: 1 });
      for (let i = 0; i < 20; i++) {
        write(store, { id: `notice-${i}`, authorId: 'system', kind: 'notice', minutesAgo: 1 });
      }
      expect(isEngaged(store)).toBe(true);
    });

    it('counts a second agent’s posts, because they are somebody else’s turns', () => {
      const store = freshStore();
      write(store, { id: 'mention', mentions: [ANA], minutesAgo: 1 });
      for (let i = 0; i < 5; i++) write(store, { id: `bo-${i}`, authorId: BO, minutesAgo: 1 });
      expect(isEngaged(store)).toBe(false);
    });

    /**
     * The count the agent is told, which has to be the count the predicate will
     * enforce — the two disagreeing by one is the classic off-by-one, and it is
     * invisible until somebody counts messages in a real room.
     */
    it.each([
      [0, 4],
      [1, 3],
      [4, 0],
    ])('after %i posts by others, reports %i more before it closes', (others, left) => {
      const store = freshStore();
      write(store, { id: 'mention', mentions: [ANA], minutesAgo: 1 });
      for (let i = 0; i < others; i++) write(store, { id: `after-${i}`, minutesAgo: 1 });
      expect(
        engagementFor(
          { store },
          { roomId: ROOM, threadRootEntryId: null, authorId: ANA, window: WINDOW, now: NOW }
        )?.postsLeft
      ).toBe(left);
    });

    it('closes on the message after the last one it said was left', () => {
      const store = freshStore();
      write(store, { id: 'mention', mentions: [ANA], minutesAgo: 1 });
      for (let i = 0; i < 4; i++) write(store, { id: `after-${i}`, minutesAgo: 1 });
      // It reported 0 left above; one more message is what that promised.
      write(store, { id: 'one-more', minutesAgo: 1 });
      expect(isEngaged(store)).toBe(false);
    });

    it('re-opens on a new mention, whatever came before it', () => {
      const store = freshStore();
      write(store, { id: 'mention', mentions: [ANA], minutesAgo: 30 });
      for (let i = 0; i < 9; i++) write(store, { id: `after-${i}`, minutesAgo: 20 });
      expect(isEngaged(store)).toBe(false);

      write(store, { id: 'again', mentions: [ANA], minutesAgo: 1 });
      expect(isEngaged(store)).toBe(true);
    });
  });

  describe('decaying on time', () => {
    it.each([
      [1, true],
      [9, true],
      [10, false],
      [11, false],
    ])('a mention %i minutes ago -> engaged: %s', (age, expected) => {
      const store = freshStore();
      write(store, { id: 'mention', mentions: [ANA], minutesAgo: age });
      expect(isEngaged(store)).toBe(expected);
    });

    it('reports when the window closes, which is the mention plus the ceiling', () => {
      const store = freshStore();
      write(store, { id: 'mention', mentions: [ANA], minutesAgo: 4 });
      const open = engagementFor(
        { store },
        { roomId: ROOM, threadRootEntryId: null, authorId: ANA, window: WINDOW, now: NOW }
      );
      expect(open?.until.toISOString()).toBe(new Date(T0 + 6 * 60_000).toISOString());
    });
  });

  describe('thread scoping', () => {
    /**
     * The property §3.2 exists for: a thread is a position inside a channel, so
     * being addressed in one engages an agent THERE and nowhere else. Without
     * it, one `@ana` in a side thread makes Ana answer every message in the
     * channel for ten minutes.
     */
    it('engages inside the thread it happened in, and not at the channel top level', () => {
      const store = freshStore();
      write(store, { id: 'root', minutesAgo: 5 });
      write(store, { id: 'in-thread', mentions: [ANA], threadRootEntryId: 'root', minutesAgo: 1 });

      expect(
        engagementFor(
          { store },
          { roomId: ROOM, threadRootEntryId: 'root', authorId: ANA, window: WINDOW, now: NOW }
        )
      ).not.toBeNull();
      expect(isEngaged(store)).toBe(false);
    });

    it('engages at the channel top level, and not inside an open thread', () => {
      const store = freshStore();
      write(store, { id: 'root', minutesAgo: 5 });
      write(store, { id: 'top', mentions: [ANA], minutesAgo: 1 });

      expect(isEngaged(store)).toBe(true);
      expect(
        engagementFor(
          { store },
          { roomId: ROOM, threadRootEntryId: 'root', authorId: ANA, window: WINDOW, now: NOW }
        )
      ).toBeNull();
    });

    it('keeps two threads apart', () => {
      const store = freshStore();
      write(store, { id: 'root-a', minutesAgo: 6 });
      write(store, { id: 'root-b', minutesAgo: 6 });
      write(store, { id: 'in-a', mentions: [ANA], threadRootEntryId: 'root-a', minutesAgo: 1 });

      const inThread = (root: string): boolean =>
        engagementFor(
          { store },
          { roomId: ROOM, threadRootEntryId: root, authorId: ANA, window: WINDOW, now: NOW }
        ) !== null;
      expect(inThread('root-a')).toBe(true);
      expect(inThread('root-b')).toBe(false);
    });

    it('does not decay a thread window with traffic in the channel around it', () => {
      const store = freshStore();
      write(store, { id: 'root', minutesAgo: 6 });
      write(store, { id: 'in-thread', mentions: [ANA], threadRootEntryId: 'root', minutesAgo: 5 });
      for (let i = 0; i < 20; i++) write(store, { id: `top-${i}`, minutesAgo: 1 });

      expect(
        engagementFor(
          { store },
          { roomId: ROOM, threadRootEntryId: 'root', authorId: ANA, window: WINDOW, now: NOW }
        )
      ).not.toBeNull();
    });
  });

  describe('what the agent itself cannot do', () => {
    it('does not engage on a mention the agent wrote about itself', () => {
      const store = freshStore();
      write(store, { id: 'self', authorId: ANA, mentions: [ANA], minutesAgo: 1 });
      expect(isEngaged(store)).toBe(false);
    });

    it('ignores a mention of somebody else entirely', () => {
      const store = freshStore();
      write(store, { id: 'for-bo', mentions: [BO], minutesAgo: 1 });
      expect(isEngaged(store)).toBe(false);
    });
  });

  describe('a window turned off', () => {
    it.each([
      ['minutes', { minutes: 0, posts: 5 }],
      ['posts', { minutes: 10, posts: 0 }],
      ['both', { minutes: 0, posts: 0 }],
    ])('never engages when %s is zero', (_label, window) => {
      const store = freshStore();
      write(store, { id: 'mention', mentions: [ANA], minutesAgo: 0 });
      expect(isEngaged(store, window)).toBe(false);
    });
  });

  describe('the room’s own voice never decays a window', () => {
    /**
     * The regression `project-rooms` §3.6 introduced and this closes.
     *
     * A notice was already excluded by `kind = 'post'`, and it was easy to read
     * that as "the room's own voice is handled". It was not: the system author
     * writes POSTS too — a milestone (`postMoment`) and, since the merge tool, a
     * merge event — and those were counted as messages by others. In a project
     * room merges are the ORDINARY traffic, so five of them stood an engaged
     * agent down in the middle of a conversation with the person who had just
     * addressed it.
     *
     * Seeded defect: dropping the author-kind clause from
     * `RoomStore.listRecentPostsByOthers` reddens both cases below.
     */
    const SYSTEM = 'system-author';

    /** A store whose `authors` table knows which id is the room's own voice. */
    function roomWithSystemAuthor(): RoomStore {
      const { db, store } = freshRoom();
      db.insert(authors)
        .values({
          id: SYSTEM,
          kind: 'system',
          naturalKey: 'system',
          displayName: 'DorkOS',
          createdAt: minutesAgo(600),
        })
        .run();
      return store;
    }

    it('keeps an open window open through a burst of merge entries', () => {
      const store = roomWithSystemAuthor();
      write(store, { id: 'mention', authorId: HUMAN, mentions: [ANA], minutesAgo: 1 });
      // Five is exactly the ceiling: five messages by other MEMBERS would close
      // it. These are the room reporting, and they are not messages by anybody.
      for (let i = 0; i < 5; i++) {
        write(store, { id: `merge-${i}`, authorId: SYSTEM, minutesAgo: 0 });
      }

      expect(isEngaged(store)).toBe(true);
    });

    it('still closes on that many messages from a real member', () => {
      // The control, so the case above cannot pass by the window never closing.
      const store = roomWithSystemAuthor();
      write(store, { id: 'mention', authorId: HUMAN, mentions: [ANA], minutesAgo: 1 });
      for (let i = 0; i < 5; i++) {
        write(store, { id: `said-${i}`, authorId: BO, minutesAgo: 0 });
      }

      expect(isEngaged(store)).toBe(false);
    });
  });

  describe('the cost of asking', () => {
    it('asks for no more rows than the post ceiling plus one', () => {
      const { store } = freshRoom();
      write(store, { id: 'mention', mentions: [ANA], minutesAgo: 1 });
      for (let i = 0; i < 300; i++) write(store, { id: `filler-${i}`, minutesAgo: 1 });

      // This pins the LIMIT arithmetic and nothing else. Rows returned is not
      // rows scanned — the two disagreed by four orders of magnitude until
      // migration 0040, and only the query plan below can see that.
      let rows = 0;
      const counting = {
        listRecentPostsByOthers: (
          roomId: string,
          opts: { threadRootEntryId: string | null; excludeAuthorId: string; limit: number }
        ) => {
          const page = store.listRecentPostsByOthers(roomId, opts);
          rows += page.length;
          return page;
        },
      };
      engagementFor(
        { store: counting },
        { roomId: ROOM, threadRootEntryId: null, authorId: ANA, window: WINDOW, now: NOW }
      );
      expect(rows).toBe(WINDOW.posts + 1);
    });

    /**
     * The assertion that would have been red before migration 0040.
     *
     * A thread is a handful of rows scattered through a long log, so a
     * `(room_id, seq)` primary-key walk reads the WHOLE room before it collects
     * `limit` of them — 5.5ms per call on a 50k-entry channel, once per engaged
     * agent per message. The planner chose that walk because `ORDER BY seq DESC`
     * was something the two-column partial index could not satisfy, and nothing
     * in DorkOS runs `ANALYZE`, so it had no statistics to know better. Putting
     * `seq` in the index fixed both halves at once.
     *
     * Asserted on the SQL the STORE actually issues, captured off the driver,
     * rather than on a query written here — a plan test against a hand-written
     * copy of the query certifies the copy.
     */
    it('reads a thread scope through the thread index, in order, with no sort', () => {
      const { db, store } = freshRoom();
      write(store, { id: 'root', minutesAgo: 30 });
      write(store, { id: 'in-thread', mentions: [ANA], threadRootEntryId: 'root', minutesAgo: 1 });
      for (let i = 0; i < 300; i++) write(store, { id: `filler-${i}`, minutesAgo: 1 });

      const [plan, ...rest] = plansOf(db, () =>
        engagementFor(
          { store },
          { roomId: ROOM, threadRootEntryId: 'root', authorId: ANA, window: WINDOW, now: NOW }
        )
      );
      // One read, so the plan below is unambiguously the one that matters.
      expect(rest).toEqual([]);
      expect(plan).toContain('idx_room_entries_thread_root');
      // The primary key is the wrong index HERE and the right one below, so
      // naming it is the discriminating half of this assertion.
      expect(plan).not.toContain('sqlite_autoindex_room_entries_1');
      // A sort would mean the index answered the filter but not the order, so
      // every matching row in the thread is read before `limit` applies.
      expect(plan).not.toContain('TEMP B-TREE');
    });

    it('reads the channel top level off the primary key, which is already in seq order', () => {
      const { db, store } = freshRoom();
      write(store, { id: 'mention', mentions: [ANA], minutesAgo: 1 });
      for (let i = 0; i < 300; i++) write(store, { id: `filler-${i}`, minutesAgo: 1 });

      // The partial index deliberately does not cover this scope, and does not
      // need to: most rows in a channel ARE top-level posts, so walking the
      // primary key backwards meets `limit` of them almost immediately.
      const [plan] = plansOf(db, () =>
        engagementFor(
          { store },
          { roomId: ROOM, threadRootEntryId: null, authorId: ANA, window: WINDOW, now: NOW }
        )
      );
      expect(plan).toContain('sqlite_autoindex_room_entries_1');
      expect(plan).not.toContain('TEMP B-TREE');
    });
  });
});

/**
 * The query plan of every `SELECT` run inside `body`, in the order they ran.
 *
 * Reaches through drizzle to the `better-sqlite3` handle and wraps `prepare`,
 * so what is explained is the statement the store issued — text and bindings
 * both. Restored afterwards, so one test cannot leak the wrapper into another.
 *
 * @param db - The test database.
 * @param body - What to run while listening.
 */
function plansOf(db: Db, body: () => void): string[] {
  const client = (db as unknown as { $client: Database.Database }).$client;
  const prepare = client.prepare.bind(client);
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  client.prepare = ((source: string) => {
    const statement = prepare(source);
    if (!/^\s*select/i.test(source)) return statement;
    const all = statement.all.bind(statement);
    statement.all = ((...params: unknown[]) => {
      seen.push({ sql: source, params });
      return all(...(params as never[])) as unknown[];
    }) as typeof statement.all;
    return statement;
  }) as typeof client.prepare;
  try {
    body();
  } finally {
    client.prepare = prepare;
  }
  return seen.map(({ sql, params }) =>
    (prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as { detail: string }[])
      .map((row) => row.detail)
      .join(' | ')
  );
}
