/**
 * The reads migration 0134 indexed, pinned by `EXPLAIN QUERY PLAN` rather than timed: a timing
 * at unit scale proves nothing, and the plan is what changes when an index goes missing.
 * DorkOS never runs `ANALYZE`, so these plans are the ones a real install gets. Each query is
 * the shape its store sends; the store is named beside it.
 *
 * The last test keeps the schema free of an index that only repeats the leading columns of
 * another: two of those sat here until 0134, each a second b-tree write on every insert.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createDb, runMigrations } from '../index.js';

let raw: Database.Database;

beforeAll(() => {
  const db = createDb(':memory:');
  runMigrations(db);
  raw = db.$client;
});

/** The plan SQLite chooses for `query`, one step per line. */
function plan(query: string, ...params: unknown[]): string {
  return (raw.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...params) as { detail: string }[])
    .map((row) => row.detail)
    .join('\n');
}

interface KeyColumn {
  name: string | null;
  desc: number;
  coll: string;
}

/**
 * Non-unique, non-partial indexes whose key columns (name, sort direction and collation) are
 * the leading key columns of another non-partial index on the same table. Such an index serves
 * no lookup the other does not, and costs a b-tree write on every insert.
 */
function redundantIndexes(db: Database.Database): string[] {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%'"
    )
    .all() as { name: string }[];
  const same = (a: KeyColumn, b: KeyColumn | undefined) =>
    b !== undefined && a.name === b.name && a.desc === b.desc && a.coll === b.coll;
  const redundant: string[] = [];
  for (const { name: table } of tables) {
    const indexes = (
      db.prepare('SELECT name, "unique", partial FROM pragma_index_list(?)').all(table) as {
        name: string;
        unique: number;
        partial: number;
      }[]
    ).map((index) => ({
      ...index,
      keys: db
        .prepare(
          'SELECT name, "desc", coll FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno'
        )
        .all(index.name) as KeyColumn[],
    }));
    for (const index of indexes) {
      if (index.unique || index.partial || index.keys.some((key) => key.name === null)) continue;
      for (const other of indexes) {
        if (other.name === index.name || other.partial) continue;
        if (index.keys.every((key, position) => same(key, other.keys[position])))
          redundant.push(`${index.name} (covered by ${other.name})`);
      }
    }
  }
  return redundant;
}

describe('migration 0134 query indexes', () => {
  it('finds every room an author is in without reading the roster (listMembershipsFor)', () => {
    const detail = plan('SELECT * FROM room_members WHERE author_id = ?', 'agent-1');
    expect(detail).toContain('idx_room_members_author');
    expect(detail).not.toMatch(/SCAN room_members/);
  });

  it("finds everyone's cursor on one thread without reading every cursor (listForThread)", () => {
    const detail = plan(
      'SELECT * FROM read_cursors WHERE thread_kind = ? AND thread_id = ?',
      'room',
      'room-1'
    );
    expect(detail).toContain('idx_read_cursors_thread');
    expect(detail).not.toMatch(/SCAN read_cursors/);
  });

  it("finds an agent's sessions without reading every session (listSessionIdsForAgentPath)", () => {
    const detail = plan('SELECT session_id FROM session_metadata WHERE agent_path = ?', '/p');
    expect(detail).toContain('session_metadata_agent_path_idx');
    expect(detail).not.toMatch(/SCAN session_metadata/);
  });

  it('finds the local copies of one Community entry from the outbox (localCopiesOf)', () => {
    const detail = plan(
      `SELECT local_entry_id FROM community_outbox
       WHERE community_ref = ? AND remote_room_id = ? AND owner_author_id = ? AND remote_entry_id = ?`,
      'c',
      'r',
      'a',
      'e'
    );
    expect(detail).toContain('idx_community_outbox_remote_entry');
  });

  it('pages a mirrored room in order from the index, without a sort (cachedEntriesForOwner)', () => {
    const detail = plan(
      `SELECT entry_json FROM community_mirror_entries
       WHERE community_ref = ? AND remote_room_id = ? AND local_room_id = ? AND remote_seq > ?
       ORDER BY remote_seq LIMIT 200`,
      'c',
      'r',
      'room',
      0
    );
    expect(detail).toContain('community_mirror_entries_room_remote_seq_unique');
    expect(detail).not.toContain('TEMP B-TREE');
  });

  it('reads the first page of a mirrored room in order too (cachedEntriesForOwner, no cursor)', () => {
    const detail = plan(
      `SELECT entry_json FROM community_mirror_entries
       WHERE community_ref = ? AND remote_room_id = ? AND local_room_id = ?
       ORDER BY remote_seq LIMIT 200`,
      'c',
      'r',
      'room'
    );
    expect(detail).toContain('community_mirror_entries_room_remote_seq_unique');
    expect(detail).not.toContain('TEMP B-TREE');
  });

  it('answers "did this author post in this thread" from one covering lookup (listThreadsForMember)', () => {
    const detail = plan(
      `SELECT 1 FROM room_entries AS participation
       WHERE participation.room_id = ? AND participation.thread_root_entry_id = ?
         AND participation.author_id = ?`,
      'room',
      'root',
      'author'
    );
    expect(detail).toContain(
      'COVERING INDEX idx_room_entries_author_room (author_id=? AND room_id=? AND thread_root_entry_id=?)'
    );
  });

  it('keeps no index that only repeats the leading columns of another', () => {
    expect(redundantIndexes(raw)).toEqual([]);
  });

  it('tells a real duplicate from an index with another sort order or collation', () => {
    const scratch = new Database(':memory:');
    scratch.exec(`
      CREATE TABLE t (a TEXT, b TEXT);
      CREATE INDEX t_ab ON t (a, b);
      CREATE INDEX t_a ON t (a);
      CREATE INDEX t_a_desc ON t (a DESC);
      CREATE INDEX t_a_nocase ON t (a COLLATE NOCASE);
    `);
    expect(redundantIndexes(scratch)).toEqual(['t_a (covered by t_ab)']);
    scratch.close();
  });
});
