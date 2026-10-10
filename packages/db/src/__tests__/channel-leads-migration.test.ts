/**
 * Migration `channel_leads` — every existing channel with agents gets a lead
 * (DOR-2823).
 *
 * It carries no DDL, so `db:check` sees an empty diff whatever it does; this
 * test is the gate. It builds the shape every earlier migration left, by
 * running the repo's own history, then applies the real migration through
 * drizzle's migrator and asserts about rows. Same construction as
 * `engaged-channel-default-migration.test.ts`.
 *
 * @module db/tests/channel-leads-migration
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle } from 'drizzle-orm/better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = path.join(__dirname, '../../drizzle');

/** The migration under test. */
const TAG = '20261010155953_channel_leads';

type Raw = Database.Database;

/** A database at the shape every migration before this one left. */
function databaseAtOldShape(): Raw {
  const folder = mkdtempSync(path.join(tmpdir(), 'dorkos-channel-leads-'));
  mkdirSync(path.join(folder, 'meta'));
  const journal = JSON.parse(
    readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf-8')
  ) as { entries: { idx: number; tag: string }[] };
  const own = journal.entries.find((e) => e.tag === TAG);
  expect(own).toBeDefined();
  const before = journal.entries.filter((e) => e.idx < own!.idx);
  for (const entry of before) {
    copyFileSync(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));
  }
  writeFileSync(
    path.join(folder, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: before })
  );
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  try {
    migrate(drizzle(sqlite), { migrationsFolder: folder });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  return sqlite;
}

const NOW = new Date().toISOString();
const DAYS_AGO = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

function author(raw: Raw, id: string, kind: string, handle: string | null, name = id): void {
  raw
    .prepare(
      'INSERT INTO authors (id, kind, natural_key, display_name, handle, created_at) VALUES (?,?,?,?,?,?)'
    )
    .run(id, kind, id, name, handle, NOW);
}

function room(
  raw: Raw,
  id: string,
  opts: { kind?: string; topic?: string | null; lead?: string | null } = {}
): void {
  raw
    .prepare(
      'INSERT INTO rooms (id, kind, slug, title, topic, created_at, last_activity_at, fallback_seat_author_id) VALUES (?,?,?,?,?,?,?,?)'
    )
    .run(
      id,
      opts.kind ?? 'channel',
      opts.kind === 'dm' ? null : id,
      id,
      opts.topic ?? null,
      NOW,
      NOW,
      opts.lead ?? null
    );
}

function member(raw: Raw, roomId: string, authorId: string): void {
  raw
    .prepare(
      'INSERT INTO room_members (room_id, author_id, response_mode, joined_at) VALUES (?,?,?,?)'
    )
    .run(roomId, authorId, 'engaged', NOW);
}

let seq = 0;
/** A person's post, then `answers` replies to it by `agent`, `daysAgo` old. */
function exchange(raw: Raw, roomId: string, agent: string, answers: number, daysAgo = 1): void {
  const ask = `ask-${++seq}`;
  const insert = raw.prepare(
    'INSERT INTO room_entries (room_id, seq, id, author_id, kind, body, cascade_root, cascade_depth, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
  );
  insert.run(roomId, ++seq, ask, 'person', 'post', '{"text":""}', ask, 0, DAYS_AGO(daysAgo));
  for (let i = 0; i < answers; i++) {
    insert.run(
      roomId,
      ++seq,
      `ans-${seq}`,
      agent,
      'post',
      '{"text":""}',
      ask,
      1,
      DAYS_AGO(daysAgo)
    );
  }
}

function leadOf(raw: Raw, roomId: string): string | null {
  return (
    raw.prepare('SELECT fallback_seat_author_id AS lead FROM rooms WHERE id = ?').get(roomId) as {
      lead: string | null;
    }
  ).lead;
}

function fixture(): Raw {
  const raw = databaseAtOldShape();
  author(raw, 'person', 'human', 'dorian');
  author(raw, 'ana', 'agent', 'ana');
  author(raw, 'bo', 'agent', 'bo');
  author(raw, 'steward', 'agent', null, 'LifeOS');
  return raw;
}

describe('channel_leads migration', () => {
  it('gives a channel the agent that answered people most in the last 14 days', () => {
    const raw = fixture();
    room(raw, 'poster');
    for (const id of ['person', 'ana', 'bo']) member(raw, 'poster', id);
    exchange(raw, 'poster', 'ana', 1);
    exchange(raw, 'poster', 'bo', 3);
    migrate(drizzle(raw), { migrationsFolder: DRIZZLE_DIR });
    expect(leadOf(raw, 'poster')).toBe('bo');
  });

  it('ignores answers older than 14 days, then falls back to the topic’s steward', () => {
    const raw = fixture();
    room(raw, 'lab', { topic: 'Lab testing · steward: LifeOS · interests: x' });
    for (const id of ['person', 'ana', 'steward']) member(raw, 'lab', id);
    exchange(raw, 'lab', 'ana', 5, 20);
    migrate(drizzle(raw), { migrationsFolder: DRIZZLE_DIR });
    expect(leadOf(raw, 'lab')).toBe('steward');
  });

  it('matches a steward by handle, and only one on the roster', () => {
    const raw = fixture();
    room(raw, 'by-handle', { topic: 'steward: bo' });
    room(raw, 'not-here', { topic: 'steward: bo' });
    for (const id of ['person', 'ana', 'bo']) member(raw, 'by-handle', id);
    for (const id of ['person', 'ana']) member(raw, 'not-here', id);
    migrate(drizzle(raw), { migrationsFolder: DRIZZLE_DIR });
    expect(leadOf(raw, 'by-handle')).toBe('bo');
    expect(leadOf(raw, 'not-here')).toBeNull();
  });

  it('leaves a channel that already has a lead, and every direct message, alone', () => {
    const raw = fixture();
    room(raw, 'team', { lead: 'ana' });
    room(raw, 'dm', { kind: 'dm' });
    for (const id of ['person', 'ana', 'bo']) member(raw, 'team', id);
    for (const id of ['person', 'bo']) member(raw, 'dm', id);
    exchange(raw, 'team', 'bo', 4);
    exchange(raw, 'dm', 'bo', 4);
    migrate(drizzle(raw), { migrationsFolder: DRIZZLE_DIR });
    expect(leadOf(raw, 'team')).toBe('ana');
    expect(leadOf(raw, 'dm')).toBeNull();
  });

  it('never picks an agent that is no longer in the channel', () => {
    const raw = fixture();
    room(raw, 'left');
    for (const id of ['person', 'ana']) member(raw, 'left', id);
    exchange(raw, 'left', 'bo', 4);
    migrate(drizzle(raw), { migrationsFolder: DRIZZLE_DIR });
    expect(leadOf(raw, 'left')).toBeNull();
  });

  it('matches a steward name exactly, never as the start of a longer name', () => {
    const raw = fixture();
    author(raw, 'bobby', 'agent', 'bobby');
    room(raw, 'exact', { topic: 'steward: bobby · interests: x' });
    for (const id of ['person', 'bo', 'bobby']) member(raw, 'exact', id);
    room(raw, 'prefix', { topic: 'steward: bobcat' });
    for (const id of ['person', 'bo']) member(raw, 'prefix', id);
    migrate(drizzle(raw), { migrationsFolder: DRIZZLE_DIR });
    expect(leadOf(raw, 'exact')).toBe('bobby');
    expect(leadOf(raw, 'prefix')).toBeNull();
  });

  it('never gives a lead to a channel connected to an outside chat', () => {
    const raw = fixture();
    room(raw, 'telegram-group');
    for (const id of ['person', 'ana']) member(raw, 'telegram-group', id);
    exchange(raw, 'telegram-group', 'ana', 3);
    const columns = (
      raw
        .prepare('SELECT name, "notnull" AS required FROM pragma_table_info(\'room_bridges\')')
        .all() as {
        name: string;
        required: number;
      }[]
    ).filter((c) => c.required === 1);
    const values: Record<string, string> = {
      room_id: 'telegram-group',
      adapter_id: 'tg',
      chat_id: '-100',
    };
    const names = columns.map((c) => c.name);
    raw
      .prepare(
        `INSERT INTO room_bridges (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`
      )
      .run(...names.map((name) => values[name] ?? NOW));
    migrate(drizzle(raw), { migrationsFolder: DRIZZLE_DIR });
    expect(leadOf(raw, 'telegram-group')).toBeNull();
  });
});
