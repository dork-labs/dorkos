import { renderChatMessage } from '../../session/chat-messages/chat-message-fence.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { authors, roomEntries, rooms, messages, searchSources, eq, type Db } from '@dorkos/db';
import type BetterSqlite3 from 'better-sqlite3';
import { DISCOVERY_FAILURE_KEY } from '../frontier-store.js';
import { SearchIndexer } from '../indexer.js';
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

/**
 * The query the search route will run — `snippet()` included, deliberately.
 *
 * Delimiters match `MATCH_OPEN`/`MATCH_CLOSE` in `../query.ts`: sentinel
 * control characters (U+0001/U+0002), not the `<mark>` literal a chat message
 * could actually contain (DOR-1552).
 */
function search(query: string): { origin_key: string; excerpt: string }[] {
  return raw
    .prepare(
      "SELECT m.origin_key, snippet(messages_fts, 0, '\u0001', '\u0002', '…', 12) AS excerpt\n" +
        '       FROM messages_fts f JOIN messages m ON m.id = f.rowid\n' +
        '       WHERE messages_fts MATCH ? ORDER BY bm25(messages_fts) LIMIT 20'
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
      'doe',
    ]);
  });
});

describe('one source having a bad day', () => {
  it('does not stop the sources swept after it', async () => {
    // Each mechanism degrades per container, and since DOR-709 each also
    // degrades on its own discovery — so a container list that will not read is
    // attributed by the mechanism (`DISCOVERY_FAILURE_KEY`, and a stamp on the
    // containers that exist) rather than escaping to the reconciler's wrap.
    // That wrap is still the backstop for whatever no mechanism catches, and
    // `SOURCE_FAILURE_KEY` is what it records; the test below is where it shows.
    const exploding: RowSource = {
      id: 'exploding',
      mechanism: 'rows',
      corpus: 'dorkos',
      listContainers: () => {
        throw new Error('the container list would not read');
      },
      readSince: () => ({ messages: [], skipped: 0 }),
    };

    seedRoom('room-a');
    say('room-a', 'the room still indexes');

    const result = await new SearchIndexer(db, [exploding, roomsSource]).sweep();

    expect(result.failures).toEqual([
      {
        sourceId: 'exploding',
        originKey: DISCOVERY_FAILURE_KEY,
        message: 'the container list would not read',
      },
    ]);
    // The ordering is the point: `roomsSource` comes AFTER the thrower, and its
    // row is in the index anyway.
    expect(result.indexed).toBe(1);
    expect(indexedMessages()).toEqual([
      expect.objectContaining({ source_id: 'rooms', body: 'the room still indexes' }),
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

  it('records why a source produced nothing, and indexes the others anyway', async () => {
    // The ADR's sharpest negative: a projection an upstream format change broke
    // produces no rows, and so does a source with nothing new. `last_error` is
    // what tells the two apart.
    seedRoom('room-a');
    say('room-a', 'this room is fine');

    const broken: RowSource = {
      mechanism: 'rows',
      corpus: 'dorkos',
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
    expect(hits.map((hit) => hit.excerpt).join(' ')).toContain('\u0001');
    expect(hits.some((hit) => hit.excerpt.includes('\u0001dog\u0002'))).toBe(true);
  });

  it('strips a raw sentinel byte out of a message body before it reaches the index (DOR-1552)', async () => {
    // The invariant `search-excerpt.ts` and `query.ts` document — no message
    // body can carry U+0001/U+0002 — used to be an ASSUMPTION about what chat
    // text happens to contain. This is the enforcement: whatever a person (or
    // a corrupted source) actually typed, the bytes that would masquerade as
    // real match markers never survive into `messages.body`.
    seedRoom('room-sentinel');
    say('room-sentinel', 'careful\u0001 with\u0002 this word');
    await new SearchIndexer(db, [roomsSource]).sweep();

    const [row] = indexedMessages() as { body: string }[];
    expect(row!.body).not.toContain('\u0001');
    expect(row!.body).not.toContain('\u0002');
    // Stripped, not replaced with a space — the surrounding text is untouched.
    expect(row!.body).toBe('careful with this word');
  });

  // DOR-3060: a message another chat sent is fenced for the model, and search
  // must find and show the sender's words, never the envelope.
  it('indexes a fenced chat message as its words, not its envelope', async () => {
    seedRoom('room-fenced');
    const { text } = renderChatMessage(
      { agentName: 'Security', agentId: 'agent-sec', chatId: 'chat-sec', chatTitle: 'Review' },
      'message',
      'Please hold the walrus release.',
      'c0ffee12'
    );
    say('room-fenced', text);
    await new SearchIndexer(db, [roomsSource]).sweep();

    const [row] = indexedMessages() as { body: string }[];
    expect(row!.body).toBe('Please hold the walrus release.');
    expect(row!.body).not.toContain('BEGIN CHAT');
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
});
