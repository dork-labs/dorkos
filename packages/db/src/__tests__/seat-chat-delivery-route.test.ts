import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
/** Real migration coverage for private seat route ownership and malformed scope refusal. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, runMigrations, type Db } from '../index.js';
const TAG = '20261116110632_seat_chat_delivery_route';
const migrationDirectory = fileURLToPath(new URL('../../drizzle/', import.meta.url));
const directories: string[] = [];
let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
  migrate(db, { migrationsFolder: migrationsThroughSeatRoute() });
});
afterEach(() => {
  db.$client.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** Positive down cases begin where this migration is latest, including every real predecessor. */
function migrationsThroughSeatRoute(): string {
  const directory = mkdtempSync(join(tmpdir(), 'seat-chat-route-'));
  directories.push(directory);
  mkdirSync(join(directory, 'meta'));
  const journal = JSON.parse(
    readFileSync(join(migrationDirectory, 'meta/_journal.json'), 'utf8')
  ) as { entries: { idx: number; tag: string }[] };
  const target = journal.entries.find((entry) => entry.tag === TAG);
  if (!target) throw new Error('Missing seat chat route migration');
  const entries = journal.entries.filter((entry) => entry.idx <= target.idx);
  for (const entry of entries)
    copyFileSync(join(migrationDirectory, `${entry.tag}.sql`), join(directory, `${entry.tag}.sql`));
  writeFileSync(join(directory, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  return directory;
}
const insert = `INSERT INTO chat_messages (id,to_session_id,from_session_id,from_agent_path,from_agent_name,kind,text,delivery,status,ceiling_json,created_at,updated_at) VALUES ('ordinary','target','sender','/agents/a','A','message','hello','queue','queued','"none"','2026-11-15','2026-11-15')`;

const WHEN = 1794827192742;

/** Run only the shell-safe SQL, with the production latest-migration guard intact. */
function runDown(): void {
  const down = readFileSync(
    new URL('../down/20261116110632_seat_chat_delivery_route.down.sql', import.meta.url),
    'utf8'
  );
  db.$client.exec(down.replace(/^\.bail on\n/u, ''));
}

describe('seat delivery route migration', () => {
  it('defaults legacy-shaped inserts to the unchanged ordinary route', () => {
    runDown();
    db.$client.exec(insert);
    runMigrations(db);
    expect(
      db.$client
        .prepare('SELECT delivery_route,seat_room_id,seat_session_id FROM chat_messages')
        .get()
    ).toEqual({ delivery_route: 'chat', seat_room_id: null, seat_session_id: null });
  });
  it('cannot turn a receipt into a seat route without all authoritative scope fields', () => {
    db.$client.exec(insert);
    expect(() => db.$client.exec("UPDATE chat_messages SET delivery_route='seat'")).toThrow();
    expect(() => db.$client.exec("UPDATE chat_messages SET delivery_route='anything'")).toThrow();
    db.$client.exec(
      "UPDATE chat_messages SET delivery_route='seat',seat_room_id='room',seat_author_id='author',seat_joined_at='2026-11-15',seat_session_id='original-seat'"
    );
    expect(db.$client.prepare('SELECT delivery_route FROM chat_messages').get()).toEqual({
      delivery_route: 'seat',
    });
  });
  it('downgrades seat receipts truthfully and preserves main canvas and due-history data', () => {
    const dueHistory = {
      due_at: '2026-11-18T10:00:00.000Z',
      original_due_at: '2026-11-16T10:00:00.000Z',
      score_due_at: '2026-11-16T10:00:00.000Z',
      move_count: 2,
    };
    db.$client
      .prepare(
        `INSERT INTO todos
      (id, agent_id, what, due_at, original_due_at, score_due_at, move_count, state,
       created_at, assigned_by_kind, assigned_by, authority, authority_marks,
       chain_depth, chain_agents, title_from_source)
      VALUES ('due-history', 'agent-a', 'Ship the fix', ?, ?, ?, ?, 'open',
       '2026-11-15T10:00:00.000Z', 'agent', 'agent-a', 'self', '{}', 0, '[]', 0)`
      )
      .run(
        dueHistory.due_at,
        dueHistory.original_due_at,
        dueHistory.score_due_at,
        dueHistory.move_count
      );
    const readDueHistory = () =>
      db.$client
        .prepare(
          "SELECT due_at,original_due_at,score_due_at,move_count FROM todos WHERE id='due-history'"
        )
        .get();
    expect(readDueHistory()).toEqual(dueHistory);
    db.$client.exec(insert);
    db.$client.exec(
      "UPDATE chat_messages SET delivery_route='seat',seat_room_id='room',seat_author_id='author',seat_joined_at='2026-11-15',seat_session_id='original-seat',status='working'"
    );
    runDown();
    expect(readDueHistory()).toEqual(dueHistory);
    expect(db.$client.prepare('SELECT status,failure_reason FROM chat_messages').get()).toEqual({
      status: 'failed',
      failure_reason: 'Private seat delivery interrupted by downgrade.',
    });
    expect(
      db.$client
        .prepare('SELECT count(*) AS n FROM __drizzle_migrations WHERE created_at=?')
        .get(WHEN)
    ).toEqual({ n: 0 });
    expect(
      (db.$client.prepare("PRAGMA table_info('canvas_documents')").all() as { name: string }[]).map(
        (column) => column.name
      )
    ).toContain('opened_by_extension_id');
    runMigrations(db);
    expect(readDueHistory()).toEqual(dueHistory);
    expect(db.$client.prepare('SELECT status,delivery_route FROM chat_messages').get()).toEqual({
      status: 'failed',
      delivery_route: 'chat',
    });
  });

  it('refuses its down without changes once a later migration exists', () => {
    db.$client
      .prepare('INSERT INTO __drizzle_migrations(hash,created_at) VALUES (?,?)')
      .run('later', WHEN + 1);
    expect(() => runDown()).toThrow();
    db.$client.exec('ROLLBACK');
    expect(
      db.$client
        .prepare('SELECT count(*) AS n FROM __drizzle_migrations WHERE created_at=?')
        .get(WHEN)
    ).toEqual({ n: 1 });
    expect(
      (db.$client.prepare("PRAGMA table_info('chat_messages')").all() as { name: string }[]).map(
        (column) => column.name
      )
    ).toContain('delivery_route');
  });
});
