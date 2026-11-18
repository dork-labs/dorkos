/** Real registered migration preserves one immutable recovery constraint per failed source. */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, runMigrations, type Db } from '../index.js';
let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
  runMigrations(db);
});
afterEach(() => db.$client.close());
const downSql = () =>
  readFileSync(
    new URL('../down/20261118033257_room_seat_launch_requirements.down.sql', import.meta.url),
    'utf8'
  ).replace(/^\.bail on\n/u, '');
const insert = (id: string, destination: string, dispatch: string, source = 'old', end = 8) =>
  db.$client
    .prepare(
      'INSERT INTO room_seat_launch_requirements (id,destination_session_id,source_session_id,source_dispatch_id,start_seq,end_seq,payload,state,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
    )
    .run(id, destination, source, dispatch, 1, end, '{}', 'pending', '2026-11-15');
describe('required room launch migration', () => {
  it('defaults ordinary sessions to no requirement and enforces source/destination uniqueness', () => {
    db.$client.exec(
      "INSERT INTO session_metadata (session_id,created_at) VALUES ('ordinary','2026-11-15')"
    );
    expect(db.$client.prepare('SELECT required_launch_id FROM session_metadata').get()).toEqual({
      required_launch_id: null,
    });
    insert('a', 'fresh', 'dispatch');
    expect(() => insert('b', 'fresh', 'different', 'different')).toThrow();
    expect(() => insert('c', 'different', 'dispatch', 'different')).toThrow();
    expect(() => insert('d', 'different', 'different')).toThrow();
  });
  it('refuses downgrade while any addressable recovery constraint remains', () => {
    insert('a', 'fresh', 'dispatch');
    expect(() => db.$client.exec(downSql())).toThrow();
    db.$client.exec('ROLLBACK');
    expect(db.$client.prepare('SELECT id FROM room_seat_launch_requirements').get()).toEqual({
      id: 'a',
    });
  });
  it('downgrades an empty requirement horizon while preserving ordinary sessions', () => {
    db.$client.exec(
      "INSERT INTO session_metadata (session_id,created_at) VALUES ('ordinary','2026-11-16')"
    );
    db.$client.exec(downSql());
    expect(db.$client.prepare('SELECT session_id FROM session_metadata').get()).toEqual({
      session_id: 'ordinary',
    });
    expect(
      db.$client
        .prepare("SELECT name FROM sqlite_master WHERE name='room_seat_launch_requirements'")
        .get()
    ).toBeUndefined();
    expect(db.$client.prepare('PRAGMA table_info(session_metadata)').all()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'required_launch_id' })])
    );
    expect(db.$client.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  });
  it('refuses downgrade when metadata alone still addresses a launch requirement', () => {
    db.$client.exec(
      "INSERT INTO session_metadata (session_id,created_at,required_launch_id) VALUES ('ordinary','2026-11-16','retained-constraint')"
    );
    expect(() => db.$client.exec(downSql())).toThrow();
    db.$client.exec('ROLLBACK');
    expect(db.$client.prepare('SELECT required_launch_id FROM session_metadata').get()).toEqual({
      required_launch_id: 'retained-constraint',
    });
  });
  it('refuses downgrade past a later migration even with no retained constraints', () => {
    db.$client.exec(
      "INSERT INTO __drizzle_migrations (hash,created_at) SELECT 'fabricated-later', MAX(created_at)+1 FROM __drizzle_migrations"
    );
    expect(() => db.$client.exec(downSql())).toThrow();
    db.$client.exec('ROLLBACK');
    expect(
      db.$client
        .prepare("SELECT name FROM sqlite_master WHERE name='room_seat_launch_requirements'")
        .get()
    ).toEqual({ name: 'room_seat_launch_requirements' });
  });
});
