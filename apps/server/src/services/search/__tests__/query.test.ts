import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { messages, type Db } from '@dorkos/db';
import { searchMessages } from '../query.js';

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
});

describe('searchMessages — a scope past SQLite’s variable limit', () => {
  it('answers a container list longer than one statement can bind', () => {
    // An agent may read thousands of sessions. Bound one variable each, 40,000
    // keys is past SQLite's limit (32,766) and the query refuses to run.
    say('claude-code', 'session-39999', 1, 'the heron migration');
    const containers = Array.from({ length: 40_000 }, (_, i) => ({
      originKey: `session-${i}`,
    }));
    const hits = searchMessages(db, {
      scopes: [{ sourceId: 'claude-code', visibility: 'containers', containers }],
      query: 'heron',
      limit: 10,
    });

    expect(coordinates(hits)).toEqual(['claude-code:session-39999:1']);
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
});
