/**
 * The reads migration 0132 indexed, pinned by `EXPLAIN QUERY PLAN` rather than timed: a timing
 * at unit scale proves nothing, and the plan is what changes when an index goes missing.
 * DorkOS never runs `ANALYZE`, so these plans are the ones a real install gets. Each query is
 * the shape its store sends; the store is named beside it.
 *
 * The last test keeps the schema free of an index that only repeats the leading columns of
 * another: two of those sat here until 0132, each a second b-tree write on every insert.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
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

describe('migration 0132 query indexes', () => {
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
    const tables = raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%'"
      )
      .all() as { name: string }[];
    const redundant: string[] = [];
    for (const { name: table } of tables) {
      const indexes = (
        raw.prepare('SELECT name, "unique", partial FROM pragma_index_list(?)').all(table) as {
          name: string;
          unique: number;
          partial: number;
        }[]
      ).map((index) => ({
        ...index,
        columns: (
          raw.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(index.name) as {
            name: string | null;
          }[]
        ).map((column) => column.name),
      }));
      for (const index of indexes) {
        if (index.unique || index.partial || index.columns.includes(null)) continue;
        for (const other of indexes) {
          if (other.name === index.name || other.partial) continue;
          if (index.columns.every((column, position) => other.columns[position] === column))
            redundant.push(`${index.name} (covered by ${other.name})`);
        }
      }
    }
    expect(redundant).toEqual([]);
  });
});
