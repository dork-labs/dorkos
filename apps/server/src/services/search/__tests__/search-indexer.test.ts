import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { authors, roomEntries, rooms, messages, searchSources, eq, type Db } from '@dorkos/db';
import type BetterSqlite3 from 'better-sqlite3';
import { SearchIndexer, SEARCH_RECONCILE_INTERVAL_MS } from '../indexer.js';
import { roomsSource, SEARCH_SOURCES } from '../registry.js';
import type { RowSource } from '../types.js';

/**
 * These run against a database built by the real migrator, through the real
 * registry row, with only the clock and the source list injectable. The point of
 * the suite is the recovery story in this task's title: the index is derived and
 * disposable, so throwing away EITHER of its two tables has to end with the same
 * rows incremental indexing would have left behind — and an off-by-one watermark
 * shows up there and nowhere else.
 */

const AUTHORS = [
  { id: 'author-human', kind: 'human', naturalKey: 'local', displayName: 'You' },
  { id: 'author-agent', kind: 'agent', naturalKey: '/agents/ana', displayName: 'Ana' },
  { id: 'author-system', kind: 'system', naturalKey: 'system', displayName: 'DorkOS' },
];

let db: Db;
let raw: BetterSqlite3.Database;

beforeEach(() => {
  db = createTestDb();
  raw = db.$client;
  for (const author of AUTHORS) {
    db.insert(authors)
      .values({ ...author, createdAt: '2026-07-28T09:00:00.000Z' })
      .run();
  }
});

/** Open a room. Deliberately sets only the columns every room shape has. */
function seedRoom(id: string, title = id): void {
  db.insert(rooms)
    .values({
      id,
      kind: 'channel',
      slug: id,
      title,
      topic: null,
      workspaceId: null,
      createdAt: '2026-07-28T09:00:00.000Z',
      lastActivityAt: '2026-07-28T09:00:00.000Z',
    })
    .run();
}

/** Append one entry at an explicit ordinal. */
function sayAt(
  roomId: string,
  seq: number,
  text: string,
  opts: { author?: string; kind?: 'post' | 'notice'; rawBody?: string } = {}
): void {
  db.insert(roomEntries)
    .values({
      roomId,
      seq,
      id: `${roomId}-${seq}`,
      authorId: opts.author ?? 'author-human',
      kind: opts.kind ?? 'post',
      body: opts.rawBody ?? JSON.stringify({ text }),
      mentions: '[]',
      sessionId: null,
      cascadeRoot: `${roomId}-${seq}`,
      cascadeDepth: 0,
      createdAt: `2026-07-28T10:00:${String(seq % 60).padStart(2, '0')}.000Z`,
    })
    .run();
}

/** Append one entry, allocating `seq` the way the room store does. */
function say(
  roomId: string,
  text: string,
  opts: { author?: string; kind?: 'post' | 'notice'; rawBody?: string } = {}
): number {
  const seq =
    (
      raw
        .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM room_entries WHERE room_id = ?')
        .get(roomId) as { m: number }
    ).m + 1;
  sayAt(roomId, seq, text, opts);
  return seq;
}

/** Every indexed message, in the index's own order, without the rowid. */
function indexedMessages(): unknown[] {
  return raw
    .prepare(
      `SELECT source_id, origin_key, ordinal, role, created_at, body FROM messages
       ORDER BY source_id, origin_key, ordinal`
    )
    .all();
}

/** Every frontier row, without the wall-clock column two runs can never share. */
function frontierRows(): unknown[] {
  return raw
    .prepare(
      `SELECT source_id, origin_key, byte_offset, size_bytes, mtime_ms, last_ordinal,
              container_path, last_error
       FROM search_sources ORDER BY source_id, origin_key`
    )
    .all();
}

/** The query the search route will run — `snippet()` included, deliberately. */
function search(query: string): { origin_key: string; excerpt: string }[] {
  return raw
    .prepare(
      `SELECT m.origin_key, snippet(messages_fts, 0, '<mark>', '</mark>', '…', 12) AS excerpt
       FROM messages_fts f JOIN messages m ON m.id = f.rowid
       WHERE messages_fts MATCH ? ORDER BY bm25(messages_fts) LIMIT 20`
    )
    .all(query) as { origin_key: string; excerpt: string }[];
}

describe('the registry the indexer sweeps by default', () => {
  it('is exactly rooms, then claude-code, then codex, then opencode', () => {
    // An exact array, not a `toContain`. Every other test in this file passes a
    // source list explicitly — which is right, because a room test has no
    // business reading the operator's transcripts — and the cost of that is that
    // NOTHING else here would notice a source being dropped from the registry.
    // A whole indexed corpus can be deleted from this array and leave a fully
    // green suite behind: the feature ships, and indexes nothing.
    //
    // The order is asserted too, because it is the sweep order: rooms are
    // DorkOS's own write and cheap to reconcile, so they land before a
    // filesystem walk that can take seconds on a cold index. The two file
    // sources go largest corpus first — 19,124 messages against 214 — so the
    // one carrying 99% of the answers is not queued behind the one carrying 1%.
    // OpenCode goes last: it copies a whole file before it reads one, and it
    // carries the fewest messages of the three.
    expect(SEARCH_SOURCES.map((source) => source.id)).toEqual([
      'rooms',
      'claude-code',
      'codex',
      'opencode',
    ]);
  });

  it('names each mechanism on the row rather than leaving it to be inferred', () => {
    // Three mechanisms across four sources — Claude Code and Codex share M1.
    // M3's arrival is what the design named as the trigger for promoting this
    // array to a `SearchAdapter` port; the promotion was refused with evidence,
    // and ADR 260825-110420 carries the next trigger.
    expect(SEARCH_SOURCES.map((source) => source.mechanism)).toEqual([
      'rows',
      'jsonl',
      'jsonl',
      'sqlite-snapshot',
    ]);
  });
});

describe('SearchIndexer over the room log', () => {
  it('rebuilds to exactly what three incremental sweeps produced', async () => {
    // THE test that makes "start the index again" a recovery rather than a hope:
    // the only one that compares the WHOLE index, frontier included, built two
    // different ways. It goes red for an off-by-one in the read predicate
    // (`seq > afterOrdinal + 1`) and for an incremental write that never lands.
    //
    // THIS test does not go red for an over-advanced watermark — `resumeFrom` is
    // clamped by what the index demonstrably holds, so one written too high is
    // corrected on the next pass rather than leaving a hole here. **Four other
    // tests in this file do go red for it**, so the suite catches it; only this
    // comparison is blind to it, and the distinction is worth stating because
    // reading it as a claim about the suite got the opposite conclusion drawn
    // once already.
    //
    // Nor can any of this duplicate a row — the unique key forbids it. So the
    // ticket's "a duplicated or missing row" is, in the shipped design, only ever
    // a missing one.
    seedRoom('room-a');
    seedRoom('room-b');
    const indexer = new SearchIndexer(db, [roomsSource]);

    say('room-a', 'the first thing anyone said');
    say('room-b', 'a different room entirely', { author: 'author-agent' });
    await indexer.sweep();

    say('room-a', 'a second thing', { author: 'author-agent' });
    say('room-a', 'the room hit its limit', { author: 'author-system', kind: 'notice' });
    await indexer.sweep();

    say('room-b', 'one more for the other room');
    say('room-a', 'and a last word');
    await indexer.sweep();

    const incrementalMessages = indexedMessages();
    const incrementalFrontier = frontierRows();
    expect(incrementalMessages).toHaveLength(5);

    raw.prepare('DELETE FROM messages').run();
    raw.prepare('DELETE FROM search_sources').run();
    expect(indexedMessages()).toHaveLength(0);

    const rebuild = await indexer.sweep();

    expect(rebuild.indexed).toBe(5);
    expect(indexedMessages()).toEqual(incrementalMessages);
    expect(frontierRows()).toEqual(incrementalFrontier);
  });

  it('recovers when only the messages are deleted and the bookkeeping is left', async () => {
    // `messages` is the half anyone would actually think to throw away, and
    // `search_sources` is bookkeeping nobody would know to touch. Keying the
    // no-op branch on the watermark alone left every container reporting
    // "nothing new" forever: search went to zero hits and stayed there, with no
    // error recorded anywhere and every sweep declaring success.
    seedRoom('room-a');
    seedRoom('room-b');
    say('room-a', 'a message about pineapples');
    say('room-a', 'another about pineapples', { author: 'author-agent' });
    say('room-b', 'pineapples elsewhere');
    const indexer = new SearchIndexer(db, [roomsSource]);
    await indexer.sweep();
    const before = indexedMessages();
    expect(search('pineapples')).toHaveLength(3);

    raw.prepare('DELETE FROM messages').run();
    expect(search('pineapples')).toHaveLength(0);

    const healed = await indexer.sweep();

    expect(healed.indexed).toBe(3);
    expect(indexedMessages()).toEqual(before);
    expect(search('pineapples')).toHaveLength(3);
    // And it stays healed rather than oscillating.
    expect((await indexer.sweep()).indexed).toBe(0);
  });

  it('recovers when a single container loses its messages', async () => {
    // The same hole, one container wide — the shape a partial cleanup leaves.
    seedRoom('room-a');
    seedRoom('room-b');
    say('room-a', 'kept throughout');
    say('room-b', 'deleted from the index only');
    const indexer = new SearchIndexer(db, [roomsSource]);
    await indexer.sweep();
    const before = indexedMessages();

    raw.prepare("DELETE FROM messages WHERE origin_key = 'room-b'").run();
    const healed = await indexer.sweep();

    expect(healed.indexed).toBe(1);
    expect(indexedMessages()).toEqual(before);
  });

  it('reports zero new rows on a sweep with nothing new', async () => {
    // Asserting an unchanged count(*) instead would pass for a sweep that
    // correctly did nothing AND for one that re-read and re-upserted every row.
    seedRoom('room-a');
    say('room-a', 'something worth finding');
    const indexer = new SearchIndexer(db, [roomsSource]);

    expect((await indexer.sweep()).indexed).toBe(1);
    expect((await indexer.sweep()).indexed).toBe(0);
    expect((await indexer.sweep()).indexed).toBe(0);
  });

  it('still records the attempt on a container it did no work for', async () => {
    // An unchanged container costs no transaction of its own, but the sweep must
    // still be able to say when it last looked — otherwise "the indexer is
    // stuck" and "nothing has happened" read identically.
    seedRoom('room-a');
    say('room-a', 'said once');
    const indexer = new SearchIndexer(db, [roomsSource]);
    await indexer.sweep();
    const first = raw.prepare('SELECT last_indexed_at AS t FROM search_sources').get();

    await new Promise((resolve) => setTimeout(resolve, 2));
    await indexer.sweep();

    expect(raw.prepare('SELECT last_indexed_at AS t FROM search_sources').get()).not.toEqual(first);
  });

  it('rebuilds a container whose frontier row was deleted, without duplicating it', async () => {
    // The other half of "delete the index": dropping a frontier row is how an
    // invalidation says "re-read this container". The unique key is what makes
    // the re-read idempotent, so this asserts the rows are identical rather than
    // merely present.
    seedRoom('room-a');
    say('room-a', 'said once and only once');
    say('room-a', 'and a second time', { author: 'author-agent' });
    const indexer = new SearchIndexer(db, [roomsSource]);
    await indexer.sweep();
    const before = indexedMessages();

    raw.prepare("DELETE FROM search_sources WHERE source_id = 'rooms'").run();
    const healed = await indexer.sweep();

    expect(healed.indexed).toBe(2);
    expect(indexedMessages()).toEqual(before);
    expect(search('said')).toHaveLength(1);
  });

  it('drops the stale rows when a container is genuinely renumbered', async () => {
    // A REAL reallocation: the same five messages move from ordinals 10–14 down
    // to 1–5. Faking a stale watermark and re-reading the same rows onto the same
    // ordinals proves nothing here — the delete is a no-op and the upsert hides
    // its absence. Only moving the ordinals leaves rows that nothing will ever
    // overwrite, which is what the delete exists to remove: without it this ends
    // with ten rows, five of them searchable text backed by no entry at all.
    seedRoom('room-a');
    const texts = [
      'alpha herring',
      'beta herring',
      'gamma herring',
      'delta herring',
      'eps herring',
    ];
    texts.forEach((text, i) => sayAt('room-a', 10 + i, text));
    const indexer = new SearchIndexer(db, [roomsSource]);
    await indexer.sweep();
    expect(search('herring')).toHaveLength(5);

    db.delete(roomEntries).where(eq(roomEntries.roomId, 'room-a')).run();
    texts.forEach((text, i) => sayAt('room-a', 1 + i, text));

    const healed = await indexer.sweep();

    expect(healed.rebuilt).toBe(1);
    expect(healed.indexed).toBe(5);
    expect(indexedMessages()).toHaveLength(5);
    expect(search('herring')).toHaveLength(5);
    expect(
      raw
        .prepare('SELECT ordinal FROM messages ORDER BY ordinal')
        .all()
        .map((r) => (r as { ordinal: number }).ordinal)
    ).toEqual([1, 2, 3, 4, 5]);
    expect(
      raw.prepare("SELECT last_ordinal AS o FROM search_sources WHERE origin_key = 'room-a'").get()
    ).toEqual({ o: 5 });
  });

  it('drops the stale rows when the frontier is gone AND the container renumbered', async () => {
    // An invalidation and a shrink at once, which is the state the two are
    // reached through separately: something drops the frontier row to force a
    // re-read, and the container it forces a re-read of has meanwhile moved its
    // ordinals down. There is then no watermark left to notice the shrink with —
    // only the rows already in the index can say the container has moved
    // underneath them. Without that, this ends with twenty rows where fifteen are
    // correct, and the five strays are searchable text backed by no entry.
    seedRoom('room-a');
    const texts = ['alpha marlin', 'beta marlin', 'gamma marlin', 'delta marlin', 'eps marlin'];
    texts.forEach((text, i) => sayAt('room-a', 10 + i, text));
    const indexer = new SearchIndexer(db, [roomsSource]);
    await indexer.sweep();
    expect(search('marlin')).toHaveLength(5);

    raw.prepare("DELETE FROM search_sources WHERE source_id = 'rooms'").run();
    db.delete(roomEntries).where(eq(roomEntries.roomId, 'room-a')).run();
    texts.forEach((text, i) => sayAt('room-a', 1 + i, text));

    const healed = await indexer.sweep();

    expect(healed.rebuilt).toBe(1);
    expect(indexedMessages()).toHaveLength(5);
    expect(search('marlin')).toHaveLength(5);
    expect(
      raw
        .prepare('SELECT ordinal FROM messages ORDER BY ordinal')
        .all()
        .map((r) => (r as { ordinal: number }).ordinal)
    ).toEqual([1, 2, 3, 4, 5]);
  });

  it('records what it actually read when discovery reported less than the read returned', async () => {
    // Discovery and the read are two separate statements, so a source whose
    // writer can commit between them hands back rows above the `maxOrdinal`
    // discovery reported. The watermark has to record what was READ, or it ends
    // up behind the index — and the rebuild guard, which keys on the index
    // holding rows the container does not, would then fire every sweep on a
    // container that only ever grew. Rooms cannot reach this (two synchronous
    // statements on one connection, under the instance lock); a filesystem walk
    // can, so the mechanism answers it rather than the source.
    let discovered = 5;
    const laggy: RowSource = {
      mechanism: 'rows',
      id: 'laggy',
      listContainers: () => [{ originKey: 'c', containerPath: null, maxOrdinal: discovered }],
      readSince: (_db, _key, after) => ({
        skipped: 0,
        messages: Array.from({ length: 8 - after }, (_unused, i) => ({
          originKey: 'c',
          ordinal: after + i + 1,
          role: 'user' as const,
          createdAt: null,
          body: `row ${after + i + 1}`,
        })),
      }),
    };
    const indexer = new SearchIndexer(db, [laggy]);

    expect((await indexer.sweep()).indexed).toBe(8);
    expect(raw.prepare('SELECT last_ordinal AS o FROM search_sources').get()).toEqual({ o: 8 });

    discovered = 8;
    const settled = await indexer.sweep();
    expect(settled.rebuilt).toBe(0);
    expect(settled.indexed).toBe(0);
  });

  it('records why a source produced nothing, and indexes the others anyway', async () => {
    // The ADR's sharpest negative: a projection an upstream format change broke
    // produces no rows, and so does a source with nothing new. `last_error` is
    // what tells the two apart.
    seedRoom('room-a');
    say('room-a', 'this room is fine');

    const broken: RowSource = {
      mechanism: 'rows',
      id: 'broken',
      listContainers: () => [{ originKey: 'container-x', containerPath: null, maxOrdinal: 7 }],
      readSince: () => {
        throw new Error('unexpected record shape at line 12');
      },
    };

    const result = await new SearchIndexer(db, [roomsSource, broken]).sweep();

    expect(result.failures).toEqual([
      {
        sourceId: 'broken',
        originKey: 'container-x',
        message: 'unexpected record shape at line 12',
      },
    ]);

    const brokenRow = db
      .select()
      .from(searchSources)
      .where(eq(searchSources.sourceId, 'broken'))
      .get();
    expect(brokenRow?.lastError).toContain('unexpected record shape');
    // Not advanced: the next pass must retry the same rows, not skip them.
    expect(brokenRow?.lastOrdinal).toBe(0);
    expect(db.select().from(messages).where(eq(messages.sourceId, 'broken')).all()).toEqual([]);

    // The other source is untouched by its neighbour's failure.
    expect(result.indexed).toBe(1);
    expect(db.select().from(messages).where(eq(messages.sourceId, 'rooms')).all()).toHaveLength(1);
  });

  it('clears last_error once the source reads cleanly again', async () => {
    seedRoom('room-a');
    say('room-a', 'still here');
    let failing = true;
    const flaky: RowSource = {
      mechanism: 'rows',
      id: 'flaky',
      listContainers: () => [{ originKey: 'container-x', containerPath: null, maxOrdinal: 1 }],
      readSince: () => {
        if (failing) throw new Error('upstream format changed');
        return {
          skipped: 0,
          messages: [
            {
              originKey: 'container-x',
              ordinal: 1,
              role: 'user' as const,
              createdAt: null,
              body: 'recovered',
            },
          ],
        };
      },
    };
    const indexer = new SearchIndexer(db, [flaky]);

    await indexer.sweep();
    failing = false;
    await indexer.sweep();

    const row = db.select().from(searchSources).where(eq(searchSources.sourceId, 'flaky')).get();
    expect(row?.lastError).toBeNull();
    expect(row?.lastOrdinal).toBe(1);
  });

  it('counts a row whose shape drifted, without erroring and without indexing it', async () => {
    // The quiet half of the same problem. `last_error` is the wrong instrument —
    // one drifted row must not stop a room — but silence is worse, because a
    // projection that has stopped recognising its own source looks exactly like a
    // room where nobody is talking.
    seedRoom('room-a');
    say('room-a', 'an ordinary message');
    say('room-a', '', { rawBody: JSON.stringify({ blocks: [{ type: 'text', value: 'hi' }] }) });

    const result = await new SearchIndexer(db, [roomsSource]).sweep();

    expect(result.skipped).toBe(1);
    expect(result.indexed).toBe(1);
    expect(result.failures).toEqual([]);
    expect(
      db.select().from(searchSources).where(eq(searchSources.sourceId, 'rooms')).get()?.lastError
    ).toBeNull();
    // The container's own field names never became searchable prose.
    expect(search('blocks')).toEqual([]);
    expect(search('value')).toEqual([]);
  });

  it('drops a room that is gone, out of messages and out of the FTS index', async () => {
    // Prune, case one of the two the word hides: a container that no longer
    // exists. This alone is the whole answer to a room being retired underneath
    // the index. The DELETE has to be a plain statement so `messages_fts_ad`
    // fires — an external-content index keeps no copy of its own, so a snippet()
    // query is the only thing that can tell whether the terms were retracted.
    seedRoom('room-a');
    seedRoom('room-doomed');
    say('room-a', 'a message that stays');
    say('room-doomed', 'a message about pineapples');
    const indexer = new SearchIndexer(db, [roomsSource]);
    await indexer.sweep();
    expect(search('pineapples')).toHaveLength(1);

    db.delete(roomEntries).where(eq(roomEntries.roomId, 'room-doomed')).run();
    db.delete(rooms).where(eq(rooms.id, 'room-doomed')).run();
    const pruning = await indexer.sweep();

    expect(pruning.pruned).toBe(1);
    expect(search('pineapples')).toEqual([]);
    expect(indexedMessages()).toHaveLength(1);
    expect(frontierRows()).toHaveLength(1);
  });

  it('answers snippet() and stems, which is what makes the promise true', async () => {
    // `snippet()` and not only MATCH: with content='messages' FTS5 re-reads the
    // original text by column NAME, so a mismatch leaves MATCH and bm25() working
    // and fails only here — a MATCH-only test passes straight through it.
    seedRoom('room-a');
    say('room-a', 'we spent the afternoon talking about a dog');
    say('room-a', 'two dogs actually', { author: 'author-agent' });
    say('room-a', 'nothing relevant in this one');
    await new SearchIndexer(db, [roomsSource]).sweep();

    const hits = search('dogs');

    expect(hits).toHaveLength(2);
    expect(hits.map((hit) => hit.excerpt).join(' ')).toContain('<mark>');
    expect(hits.some((hit) => hit.excerpt.includes('<mark>dog</mark>'))).toBe(true);
  });

  it('indexes a container far past SQLite s parameter ceiling for one statement', async () => {
    // 6,000 rows bind 36,000 host parameters, and SQLite refuses a statement above
    // 32,766. Chunking is what keeps a single container from failing outright, so
    // this is the size that makes an unchunked insert throw rather than merely be
    // slower. Seeded through raw SQL in one transaction to keep it quick.
    seedRoom('room-big');
    const insert = raw.prepare(
      `INSERT INTO room_entries (room_id, seq, id, author_id, kind, body, mentions, session_id,
        cascade_root, cascade_depth, created_at)
       VALUES ('room-big', ?, ?, 'author-human', 'post', ?, '[]', NULL, ?, 0, '2026-07-28T10:00:00Z')`
    );
    raw.transaction(() => {
      for (let i = 1; i <= 6000; i++) {
        insert.run(i, `e${i}`, JSON.stringify({ text: `walrus number ${i}` }), `e${i}`);
      }
    })();

    const result = await new SearchIndexer(db, [roomsSource]).sweep();

    expect(result.indexed).toBe(6000);
    expect(indexedMessages()).toHaveLength(6000);
    // Every one of the 6,000 matches, so the query returns its whole `LIMIT 20`.
    // `toBeGreaterThan(0)` here would be satisfied by one row surviving.
    expect(search('walrus')).toHaveLength(20);
  });

  it('still indexes an entry whose author row has gone missing', async () => {
    // `room_entries.author_id` carries no foreign key, so a dangling author is a
    // shape the database permits. The read joins LEFT for that reason: an inner
    // join would drop a real message on the floor, and nothing would say so.
    seedRoom('room-a');
    say('room-a', 'written by somebody the authors table has lost', { author: 'author-ghost' });

    const result = await new SearchIndexer(db, [roomsSource]).sweep();

    expect(result.indexed).toBe(1);
    expect(search('lost')).toHaveLength(1);
  });

  it('indexes a room with no entries as a container and reads nothing', async () => {
    seedRoom('room-empty');
    const result = await new SearchIndexer(db, [roomsSource]).sweep();

    expect(result.containers).toBe(1);
    expect(result.indexed).toBe(0);
    expect(frontierRows()).toEqual([
      {
        source_id: 'rooms',
        origin_key: 'room-empty',
        byte_offset: null,
        size_bytes: null,
        mtime_ms: null,
        last_ordinal: 0,
        // A room is not a directory. NULL here is why §6.4's never-prune-a-
        // vanished-cwd rule has nothing to do for a row-backed source.
        container_path: null,
        last_error: null,
      },
    ]);
  });

  it('does not stall behind a run of entries that project to nothing', async () => {
    // The watermark tracks the CONTAINER, not the projection. Three notices in a
    // row produce no messages; a watermark that only advanced to the last row
    // that produced one would re-read a growing tail on every sweep, forever.
    seedRoom('room-a');
    say('room-a', 'a real message');
    say('room-a', 'limit reached', { author: 'author-system', kind: 'notice' });
    say('room-a', 'limit reached again', { author: 'author-system', kind: 'notice' });
    const indexer = new SearchIndexer(db, [roomsSource]);

    await indexer.sweep();

    expect(
      raw.prepare("SELECT last_ordinal AS o FROM search_sources WHERE origin_key = 'room-a'").get()
    ).toEqual({ o: 3 });
    expect((await indexer.sweep()).indexed).toBe(0);
  });

  it('sweeps every five minutes, matching the three reconcilers that already exist', () => {
    // Imported rather than re-typed, so a stray edit to the timer is red here
    // instead of a silent five-minute-to-five-second change in how hard this
    // process works.
    expect(SEARCH_RECONCILE_INTERVAL_MS).toBe(300_000);
  });
});

describe('SearchIndexer scheduling', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('indexes once at startup without waiting for the first interval', async () => {
    seedRoom('room-a');
    say('room-a', 'said before the server was even listening');
    const indexer = new SearchIndexer(db, [roomsSource]);

    indexer.start();
    await vi.waitFor(() => expect(indexedMessages()).toHaveLength(1));
    indexer.stop();
  });

  it('keeps sweeping on the interval, and stops when it is told to', async () => {
    vi.useFakeTimers();
    let sweeps = 0;
    const counting: RowSource = {
      mechanism: 'rows',
      id: 'counting',
      listContainers: () => {
        sweeps += 1;
        return [];
      },
      readSince: () => ({ messages: [], skipped: 0 }),
    };
    const indexer = new SearchIndexer(db, [counting], 1_000);

    indexer.start();
    expect(sweeps).toBe(1);

    await vi.advanceTimersByTimeAsync(2_500);
    expect(sweeps).toBe(3);

    indexer.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sweeps).toBe(3);
  });
});
