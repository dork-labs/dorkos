/**
 * The ranked query, and the scope clause that is the whole access model
 * (message-search spec §6.1).
 *
 * These run against a real FTS5 index built by the real migrator, with rows
 * inserted the way the indexer inserts them, because every claim here is about
 * SQL: which rows a predicate lets through, and in what order. A fake would only
 * prove the fake agrees with itself.
 *
 * The per-container floor is tested in BOTH directions on purpose. A floor test
 * that only asserts absence passes for a working floor, for an empty index, and
 * for a broken query — so every "must not surface" here is paired with a "must
 * still surface" over the same seeded rows.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { messages, sql, type Db } from '@dorkos/db';
import { searchMessages, MATCH_OPEN, MATCH_CLOSE } from '../query.js';

let db: Db;

beforeEach(() => {
  db = createTestDb();
});

/** Put one message in the index, the way a projection would. */
function say(
  sourceId: string,
  originKey: string,
  ordinal: number,
  body: string,
  opts: { role?: 'user' | 'assistant'; createdAt?: string; messageId?: string } = {}
): void {
  db.insert(messages)
    .values({
      sourceId,
      originKey,
      ordinal,
      role: opts.role ?? 'user',
      createdAt: opts.createdAt ?? '2026-07-29T10:00:00.000Z',
      body,
      // Absent by default, which is what a room row holds: the sources that
      // carry one are the transcripts, and the cases about it pass it in.
      ...(opts.messageId === undefined ? {} : { messageId: opts.messageId }),
    })
    .run();
}

/** Just the coordinates, for assertions that are about which rows came back. */
function coordinates(hits: ReturnType<typeof searchMessages>): string[] {
  return hits.map((hit) => `${hit.sourceId}:${hit.originKey}:${hit.ordinal}`);
}

describe('searchMessages — the per-container floor', () => {
  beforeEach(() => {
    // `early` is a room this caller was in from the start; `late` is one they
    // joined at seq 2. Both say the same word, so the only thing that can
    // separate them is the floor.
    say('rooms', 'early', 1, 'the migration plan we agreed');
    say('rooms', 'early', 2, 'migration notes from later');
    say('rooms', 'late', 1, 'migration talk before they arrived');
    say('rooms', 'late', 2, 'more migration before they arrived');
    say('rooms', 'late', 3, 'migration after they arrived');
  });

  it('hides what a late-joined room said before the caller arrived', () => {
    const hits = searchMessages(db, {
      scopes: [
        {
          sourceId: 'rooms',
          visibility: 'containers',
          containers: [
            { originKey: 'early', afterOrdinal: 0 },
            { originKey: 'late', afterOrdinal: 2 },
          ],
        },
      ],
      query: 'migration',
      limit: 10,
    });

    expect(coordinates(hits).sort()).toEqual(['rooms:early:1', 'rooms:early:2', 'rooms:late:3']);
  });

  it('still returns the early-joined room’s oldest messages', () => {
    // The positive half of the pair above, stated as its own case: a single
    // global floor of 2 — the highest of the two — would swallow `early:1`, and
    // that row is the one this asserts is still there.
    const hits = searchMessages(db, {
      scopes: [
        {
          sourceId: 'rooms',
          visibility: 'containers',
          containers: [
            { originKey: 'early', afterOrdinal: 0 },
            { originKey: 'late', afterOrdinal: 2 },
          ],
        },
      ],
      query: 'migration',
      limit: 10,
    });

    expect(coordinates(hits)).toContain('rooms:early:1');
  });

  it('treats a missing floor as no floor', () => {
    const hits = searchMessages(db, {
      scopes: [
        { sourceId: 'rooms', visibility: 'containers', containers: [{ originKey: 'late' }] },
      ],
      query: 'migration',
      limit: 10,
    });

    expect(coordinates(hits).sort()).toEqual(['rooms:late:1', 'rooms:late:2', 'rooms:late:3']);
  });

  it('groups containers that share a floor without losing any of them', () => {
    // Three containers, two floors. The predicate collapses same-floor keys into
    // one `IN (...)`, and this is what says the collapse keeps every key.
    say('rooms', 'third', 1, 'migration in a third room');
    const hits = searchMessages(db, {
      scopes: [
        {
          sourceId: 'rooms',
          visibility: 'containers',
          containers: [
            { originKey: 'early', afterOrdinal: 0 },
            { originKey: 'third', afterOrdinal: 0 },
            { originKey: 'late', afterOrdinal: 2 },
          ],
        },
      ],
      query: 'migration',
      limit: 10,
    });

    expect(coordinates(hits).sort()).toEqual([
      'rooms:early:1',
      'rooms:early:2',
      'rooms:late:3',
      'rooms:third:1',
    ]);
  });
});

describe('searchMessages — the scope clause', () => {
  beforeEach(() => {
    // The collision the source-scoping rule exists for: a room and a session
    // that happen to carry the SAME opaque container id.
    say('rooms', 'shared-key', 1, 'said in a room about pelicans');
    say('claude-code', 'shared-key', 1, 'said in a session about pelicans');
  });

  it('never lets a container key match across sources', () => {
    const hits = searchMessages(db, {
      scopes: [
        {
          sourceId: 'rooms',
          visibility: 'containers',
          containers: [{ originKey: 'shared-key' }],
        },
      ],
      query: 'pelicans',
      limit: 10,
    });

    expect(coordinates(hits)).toEqual(['rooms:shared-key:1']);
  });

  it('reaches everything in a source scoped `all`, with no container list', () => {
    say('claude-code', 'another-session', 7, 'more about pelicans');
    const hits = searchMessages(db, {
      scopes: [{ sourceId: 'claude-code', visibility: 'all' }],
      query: 'pelicans',
      limit: 10,
    });

    expect(coordinates(hits).sort()).toEqual([
      'claude-code:another-session:7',
      'claude-code:shared-key:1',
    ]);
  });

  it('ranks across several sources in one list', () => {
    const hits = searchMessages(db, {
      scopes: [
        { sourceId: 'rooms', visibility: 'containers', containers: [{ originKey: 'shared-key' }] },
        { sourceId: 'claude-code', visibility: 'all' },
      ],
      query: 'pelicans',
      limit: 10,
    });

    expect(coordinates(hits).sort()).toEqual(['claude-code:shared-key:1', 'rooms:shared-key:1']);
  });

  it('matches nothing when the caller is in no containers', () => {
    const hits = searchMessages(db, {
      scopes: [{ sourceId: 'rooms', visibility: 'containers', containers: [] }],
      query: 'pelicans',
      limit: 10,
    });

    expect(hits).toEqual([]);
  });

  it('matches nothing when there is no scope at all', () => {
    expect(searchMessages(db, { scopes: [], query: 'pelicans', limit: 10 })).toEqual([]);
  });
});

describe('searchMessages — what a hit carries', () => {
  beforeEach(() => {
    say('rooms', 'general', 4, 'we should rewrite the scheduler this quarter', {
      role: 'assistant',
      createdAt: '2026-07-29T11:30:00.000Z',
    });
  });

  it('carries the row’s own facts', () => {
    const [hit] = searchMessages(db, {
      scopes: [{ sourceId: 'rooms', visibility: 'all' }],
      query: 'scheduler',
      limit: 10,
    });

    expect(hit).toEqual({
      sourceId: 'rooms',
      originKey: 'general',
      ordinal: 4,
      messageId: null,
      role: 'assistant',
      createdAt: '2026-07-29T11:30:00.000Z',
      excerpt: null,
    });
  });

  it('brings back the message id a transcript row was indexed with', () => {
    // The second coordinate (DOR-1579): `ordinal` addresses the container's
    // position, this addresses the message. Red if the column is dropped from
    // the SELECT — the hit still comes back, and the landing silently stops
    // working.
    say('claude-code', 'sess-1', 1, 'the scheduler question', { messageId: 'uuid-9' });

    const hits = searchMessages(db, {
      scopes: [{ sourceId: 'claude-code', visibility: 'all' }],
      query: 'scheduler',
      limit: 10,
    });

    expect(hits.map((hit) => hit.messageId)).toEqual(['uuid-9']);
  });

  it('brings back null for a row indexed without one', () => {
    // The paired control: `null` has to survive as `null` rather than becoming
    // the previous row's id or an empty string.
    say('claude-code', 'sess-2', 1, 'another scheduler question');

    const hits = searchMessages(db, {
      scopes: [{ sourceId: 'claude-code', visibility: 'all' }],
      query: 'scheduler',
      limit: 10,
    });

    expect(hits.map((hit) => hit.messageId)).toEqual([null]);
  });

  it('marks the match when an excerpt is asked for', () => {
    // This is also the column-name trap from spec §4: with `content='messages'`,
    // FTS5 re-reads the text BY COLUMN NAME, so a mismatch fails here — and only
    // here — while MATCH and bm25() keep working. A MATCH-only test passes it.
    const [hit] = searchMessages(db, {
      scopes: [{ sourceId: 'rooms', visibility: 'all' }],
      query: 'scheduler',
      limit: 10,
      excerpts: true,
    });

    expect(hit?.excerpt).toContain(`${MATCH_OPEN}scheduler${MATCH_CLOSE}`);
  });
});

describe('searchMessages — the plan a narrow scope gets', () => {
  it('drives the join from the FTS index, not from the container', () => {
    // The one word of SQL that is load-bearing, asserted where it can be seen.
    // Without `CROSS JOIN`, SQLite believes `messages` is the selective side of a
    // single-container scope, drives from the covering index and probes FTS5 once
    // per row — 7,786 ms against 4.5 ms on a 40,000-row index, and the same plan
    // `search_room_history` has been running since DOR-680.
    //
    // Read off `EXPLAIN QUERY PLAN` rather than timed: a timing assertion at unit
    // scale would need a corpus big enough to be slow, and would still be a
    // wall-clock number on a shared machine. The plan is the thing that changed.
    say('rooms', 'general', 1, 'the kestrel migration');
    const plan = db
      .all<{ detail: string }>(
        sql`EXPLAIN QUERY PLAN ${sql.raw(
          `SELECT m.id FROM messages_fts f CROSS JOIN messages m ON m.id = f.rowid
           WHERE messages_fts MATCH '"kestrel"'
             AND (m.source_id = 'rooms' AND (m.origin_key IN ('general') AND m.ordinal > 0))
           ORDER BY bm25(messages_fts) LIMIT 20`
        )}`
      )
      .map((row) => row.detail);

    // The FTS table is scanned first — `f` is its alias — and `messages` is then
    // reached one row at a time by rowid, which is the cheap direction.
    expect(plan[0]).toMatch(/^SCAN f VIRTUAL TABLE/);
    expect(plan.join(' | ')).toContain('SEARCH m USING INTEGER PRIMARY KEY');
    expect(plan.join(' | ')).not.toMatch(/SEARCH m USING COVERING INDEX/);
  });

  it('ships that directive in the query it actually runs', () => {
    // The pair to the case above, and the half that would otherwise be missing:
    // explaining a statement written HERE proves what the plan does with the
    // word, not that the shipped query still carries it. `searchMessages` builds
    // its SQL through drizzle and runs it, so the source is where the shipped
    // text can be seen. Deleting the word passes the plan test and fails this one.
    const source = readFileSync(new URL('../query.ts', import.meta.url), 'utf8');
    expect(source).toContain('CROSS JOIN messages m ON m.id = f.rowid');
    expect(source).not.toMatch(/\n\s*JOIN messages m ON m\.id = f\.rowid/);
  });
});

describe('searchMessages — matching and ranking', () => {
  it('matches word stems rather than substrings', () => {
    say('rooms', 'general', 1, 'one dog');
    say('rooms', 'general', 2, 'two dogs');
    say('rooms', 'general', 3, 'utterly DOGGED about it');
    say('rooms', 'general', 4, 'nothing relevant here');

    const scopes = [{ sourceId: 'rooms', visibility: 'all' as const }];
    expect(searchMessages(db, { scopes, query: 'dogs', limit: 10 })).toHaveLength(3);
    // The honest cost of stemming, asserted rather than left to be discovered.
    expect(searchMessages(db, { scopes, query: 'ogs', limit: 10 })).toEqual([]);
  });

  it('returns nothing for a query with no word in it', () => {
    say('rooms', 'general', 1, 'something searchable');
    expect(
      searchMessages(db, {
        scopes: [{ sourceId: 'rooms', visibility: 'all' }],
        query: '!!! ???',
        limit: 10,
      })
    ).toEqual([]);
  });

  it('honours the limit', () => {
    for (let seq = 1; seq <= 5; seq += 1) say('rooms', 'general', seq, 'repeated word');
    const hits = searchMessages(db, {
      scopes: [{ sourceId: 'rooms', visibility: 'all' }],
      query: 'repeated',
      limit: 2,
    });
    expect(hits).toHaveLength(2);
  });

  it('puts the better match first', () => {
    // bm25 rewards the shorter document for the same term, so the terse row
    // outranks the padded one. The assertion is about ORDER, which a query
    // missing its `ORDER BY` answers by rowid — the order these were inserted
    // in, which is deliberately the opposite.
    say('rooms', 'general', 1, `padding ${'filler '.repeat(60)} kestrel more padding`);
    say('rooms', 'general', 2, 'kestrel');

    const hits = searchMessages(db, {
      scopes: [{ sourceId: 'rooms', visibility: 'all' }],
      query: 'kestrel',
      limit: 10,
    });
    expect(coordinates(hits)).toEqual(['rooms:general:2', 'rooms:general:1']);
  });
});
