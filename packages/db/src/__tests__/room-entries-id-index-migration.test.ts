/**
 * Migration 218 (DOR-5196): finding which room holds a message from its id alone is an index
 * lookup. A `dork:entry:<id>` link carries no room, and every other `room_entries` index leads
 * with `room_id`, so before this index SQLite read every message of every room per lookup.
 *
 * Pinned by `EXPLAIN QUERY PLAN` rather than timed, like `query-indexes-migration.test.ts`: DorkOS
 * never runs `ANALYZE`, so the plan here is the plan a real install gets.
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

describe('room_entries(id) index (migration 218)', () => {
  it('finds the room that holds a message by its id without scanning every message', () => {
    const detail = plan('SELECT room_id FROM room_entries WHERE id = ?', 'entry-1');
    expect(detail).toContain('SEARCH room_entries USING INDEX idx_room_entries_id (id=?)');
    expect(detail).not.toMatch(/SCAN room_entries/);
  });

  it('serves the link resolver shape too (entryLocations: ordered, capped)', () => {
    const detail = plan(
      `SELECT room_id, seq, thread_root_entry_id FROM room_entries
       WHERE id = ? ORDER BY room_id, seq LIMIT 4`,
      'entry-1'
    );
    expect(detail).toContain('SEARCH room_entries USING INDEX idx_room_entries_id (id=?)');
    expect(detail).not.toMatch(/SCAN room_entries/);
  });
});
