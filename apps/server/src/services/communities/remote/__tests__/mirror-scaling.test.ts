/**
 * A mirrored Community room must not get slower to fill or to read as it grows (DOR-2573).
 *
 * Timings at test scale prove nothing, so these pin what makes the cost grow: the number of
 * statements one import runs, and the plan SQLite chooses for the SQL the room store actually
 * sends. Both were measured on a 100,000-entry mirrored room when this was fixed; the numbers are
 * in the PR that did it.
 *
 * @module services/communities/remote/__tests__/mirror-scaling
 */
import type Database from 'better-sqlite3';
import type { CommunityEntry, CommunityRef } from '@dorkos/shared/community-adapter';
import { describe, expect, it } from 'vitest';
import { RoomStore } from '../../../rooms/room-store.js';
import { agentLookupFor, createRoomHarness } from '../../../rooms/__tests__/room-test-harness.js';
import { RemoteMirrorStore, type NativeMirrorEntry } from '../mirror-store.js';

const REF = 'remote_a' as CommunityRef;

function native(seq: number, relation: { parent?: number; root?: number } = {}): NativeMirrorEntry {
  const entry: CommunityEntry = {
    community: REF,
    roomId: 'general',
    id: `entry-${seq}`,
    authorId: 'remote-human',
    text: `remote ${seq}`,
    mentions: [],
    parentEntryId: relation.parent === undefined ? null : `entry-${relation.parent}`,
    threadRootEntryId: relation.root === undefined ? null : `entry-${relation.root}`,
    depth: relation.parent === undefined ? 0 : 1,
    cursor: `cursor-${seq}` as CommunityEntry['cursor'],
    createdAt: new Date(Date.UTC(2026, 8, 16) + seq * 1000).toISOString(),
  };
  return {
    entry,
    remoteSeq: seq,
    author: { memberId: 'remote-human', displayName: 'Remote human', kind: 'human' },
  };
}

function setup() {
  const harness = createRoomHarness({ agents: agentLookupFor({}) });
  const mirrors = new RemoteMirrorStore(harness.db, harness.store, harness.authors);
  const room = mirrors.ensureRoom({
    communityRef: REF,
    remoteRoomId: 'general',
    title: 'General',
    topic: null,
    ownerAuthorId: harness.human,
    accessors: [],
    authorizedAt: '2026-09-16T00:00:00.000Z',
  });
  const sqlite = (harness.db as unknown as { $client: Database.Database }).$client;
  return { harness, mirrors, room, sqlite };
}

/**
 * Record every statement run on the connection while `run` executes, with its parameters.
 * Wraps `prepare`, so it sees exactly what drizzle sends.
 */
function recording(sqlite: Database.Database, run: () => void) {
  const statements: { sql: string; params: unknown[] }[] = [];
  const prepare = sqlite.prepare.bind(sqlite);
  const patched = sqlite as unknown as { prepare: (source: string) => Database.Statement };
  patched.prepare = (source: string) => {
    const statement = prepare(source);
    for (const method of ['all', 'get', 'run'] as const) {
      const original = statement[method].bind(statement) as (...args: unknown[]) => unknown;
      (statement as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
        statements.push({ sql: source, params: args });
        return original(...args);
      };
    }
    return statement;
  };
  try {
    run();
  } finally {
    patched.prepare = prepare;
  }
  return statements;
}

/** The plan SQLite chooses for a recorded statement. */
function plan(sqlite: Database.Database, statement: { sql: string; params: unknown[] }): string {
  return (
    sqlite.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).all(...statement.params) as {
      detail: string;
    }[]
  )
    .map((row) => row.detail)
    .join('\n');
}

describe('mirrored room import', () => {
  it('runs the same statements for one entry whatever the size of the room', () => {
    const { mirrors, sqlite } = setup();
    mirrors.importEntries(REF, 'general', [native(1)]);
    const small = recording(sqlite, () =>
      mirrors.importEntries(REF, 'general', [native(2, { parent: 1, root: 1 })])
    ).length;

    mirrors.importEntries(
      REF,
      'general',
      Array.from({ length: 300 }, (_, i) => native(i + 3, i % 3 ? {} : { parent: 1, root: 1 }))
    );
    const large = recording(sqlite, () =>
      mirrors.importEntries(REF, 'general', [native(1000, { parent: 1, root: 1 })])
    ).length;

    // The old import re-read and rewrote every cached entry of the room on each import.
    expect(large).toBe(small);
  });

  it('links a reply of a reply whose parent and thread root arrive pages later', () => {
    const { harness, mirrors, room } = setup();
    // A history backfill reads newest first: the deepest reply lands before both entries it
    // names, and its parent before the thread root.
    mirrors.importEntries(REF, 'general', [native(9, { parent: 5, root: 1 })]);
    mirrors.importEntries(REF, 'general', [native(5, { parent: 1, root: 1 }), native(6)]);
    mirrors.importEntries(REF, 'general', [native(1)]);

    const byText = new Map(
      harness.store.listEntries(room.id, { limit: 10 }).map((entry) => [entry.body.text, entry])
    );
    const root = byText.get('remote 1')!;
    const reply = byText.get('remote 5')!;
    const deep = byText.get('remote 9')!;
    expect([reply.parentEntryId, reply.threadRootEntryId]).toEqual([root.id, root.id]);
    expect([deep.parentEntryId, deep.threadRootEntryId]).toEqual([reply.id, root.id]);
    expect(byText.get('remote 6')!.parentEntryId).toBeNull();
    expect(root.parentEntryId).toBeNull();
    expect([...byText.keys()]).toEqual(['remote 1', 'remote 5', 'remote 6', 'remote 9']);
  });

  it('refuses a page with a foreign entry before storing any of it', () => {
    const { harness, mirrors, room } = setup();
    const foreign = native(3);
    foreign.entry = { ...foreign.entry, roomId: 'elsewhere' };
    expect(() => mirrors.importEntries(REF, 'general', [native(1), native(2), foreign])).toThrow(
      'does not belong to this mirror'
    );
    expect(harness.store.listEntries(room.id, { limit: 10 })).toEqual([]);
  });

  it('refuses a page whose entry reuses a cached sequence, and keeps nothing from it', () => {
    const { harness, mirrors, room } = setup();
    mirrors.importEntries(REF, 'general', [native(1)]);
    const clash = native(1);
    clash.entry = { ...clash.entry, id: 'another-entry' };
    expect(() => mirrors.importEntries(REF, 'general', [native(2), clash])).toThrow(
      'cannot share a remote sequence'
    );
    expect(harness.store.listEntries(room.id, { limit: 10 }).map((e) => e.body.text)).toEqual([
      'remote 1',
    ]);
  });
});

describe('mirrored room reads', () => {
  function filled() {
    const context = setup();
    const { harness, mirrors, room } = context;
    // Newest page first, then older history, then a local post: arrival order is not the
    // timeline's order, which is what the reads must restore.
    mirrors.importEntries(
      REF,
      'general',
      Array.from({ length: 20 }, (_, i) => native(i + 21))
    );
    harness.service.post(room.id, { authorId: harness.human, text: 'local one' });
    mirrors.importEntries(
      REF,
      'general',
      Array.from({ length: 20 }, (_, i) => native(i + 1, i % 4 === 3 ? { parent: 1, root: 1 } : {}))
    );
    harness.service.post(room.id, { authorId: harness.human, text: 'local two' });
    return context;
  }

  it('places a post written here after the remote history, and a Community entry at its sequence', () => {
    const { mirrors, room, sqlite } = filled();
    mirrors.importEntries(REF, 'general', [native(41)]);
    const rows = sqlite
      .prepare(
        `SELECT json_extract(body, '$.text') AS text, timeline_band AS band, timeline_pos AS pos, seq
         FROM room_entries WHERE room_id = ? ORDER BY timeline_band, timeline_pos`
      )
      .all(room.id) as { text: string; band: number; pos: number; seq: number }[];
    expect(rows.every((row) => row.band !== null)).toBe(true);
    const local = rows.filter((row) => row.band === 1);
    expect(local.map((row) => row.text)).toEqual(['local one', 'local two']);
    for (const row of local) expect(row.pos).toBe(row.seq);
    const remote = rows.filter((row) => row.band === 0);
    expect(remote.map((row) => row.pos)).toEqual(Array.from({ length: 41 }, (_, i) => i + 1));
  });

  it('keeps an ordinary room out of the mirror timeline', () => {
    const { harness, sqlite } = setup();
    const room = harness.service.createRoom(
      { kind: 'channel', title: 'Plain', members: [], agentPaths: [] },
      harness.human
    );
    harness.service.post(room.id, { authorId: harness.human, text: 'hello' });
    expect(
      sqlite
        .prepare('SELECT timeline_band AS band FROM room_entries WHERE room_id = ?')
        .all(room.id)
    ).toEqual([{ band: null }]);
  });

  it('pages the timeline in order from its index, with no sort, whatever the cursor', () => {
    const { harness, room, sqlite } = filled();
    const store = harness.store;
    const newest = store.listEntries(room.id, { limit: 5 });
    const middle = store.listEntries(room.id, { limit: 5, before: newest[0]!.seq });
    const cases: [string, () => unknown][] = [
      ['first page', () => store.listEntries(room.id, { limit: 5 })],
      [
        'a page before a local post',
        () => store.listEntries(room.id, { limit: 5, before: newest[0]!.seq }),
      ],
      [
        'a page before a Community entry',
        () => store.listEntries(room.id, { limit: 5, before: middle[0]!.seq }),
      ],
      [
        'an export page',
        () => store.listEntriesForExport(room.id, { afterSeq: middle[0]!.seq, limit: 5 }),
      ],
      [
        'the top level from a cursor',
        () => store.listEntriesFrom(room.id, { afterSeq: middle[0]!.seq, limit: 5 }),
      ],
    ];
    for (const [name, read] of cases) {
      const statements = recording(sqlite, read).filter(
        (statement) => /from "room_entries"/i.test(statement.sql) && /order by/i.test(statement.sql)
      );
      expect(statements, name).toHaveLength(1);
      const detail = plan(sqlite, statements[0]!);
      expect(detail, name).toContain('idx_room_entries_mirror_timeline');
      expect(detail, name).not.toContain('TEMP B-TREE');
      // The Community sequence was once looked up per row, in a subquery, to sort the room.
      expect(statements[0]!.sql, name).not.toMatch(/community_mirror_entries/);
    }
  });

  it('reads the same pages after a restart', () => {
    const { harness, room } = filled();
    const before = harness.store.listEntries(room.id, { limit: 50 }).map((e) => e.body.text);
    const restarted = new RoomStore(harness.db);
    new RemoteMirrorStore(harness.db, restarted, harness.authors);
    expect(restarted.listEntries(room.id, { limit: 50 }).map((e) => e.body.text)).toEqual(before);
    expect(before).toEqual([
      ...Array.from({ length: 40 }, (_, i) => `remote ${i + 1}`),
      'local one',
      'local two',
    ]);
  });
});
