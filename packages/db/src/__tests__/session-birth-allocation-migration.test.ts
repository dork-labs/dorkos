/** Exercise registered migration DDL through real SQLite, including writes that bypass Drizzle types. */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, createDbFromImage, sessionBirthAllocations, type Db } from '../index.js';

const migrationDirectory = fileURLToPath(new URL('../../drizzle/', import.meta.url));
const directories: string[] = [];
const stamp = '2026-11-19T00:00:00.000Z';
let image: Buffer;
let db: Db;
let migrationTag: string;

type Journal = { entries: { idx: number; tag: string }[] };

/** Find the generated registered DDL rather than guessing its timestamp or journal index. */
function migrationsThroughBirth(includeBirth: boolean): string {
  const journal = JSON.parse(
    readFileSync(join(migrationDirectory, 'meta/_journal.json'), 'utf8')
  ) as Journal;
  const targets = journal.entries.filter((entry) =>
    /CREATE TABLE [`"]?session_birth_allocations[`"]?\s*\(/u.test(
      readFileSync(join(migrationDirectory, `${entry.tag}.sql`), 'utf8')
    )
  );
  if (targets.length !== 1) throw new Error('Expected one registered birth allocation migration');
  const target = targets[0]!;
  migrationTag = target.tag;
  const entries = journal.entries.filter((entry) =>
    includeBirth ? entry.idx <= target.idx : entry.idx < target.idx
  );
  const directory = mkdtempSync(join(tmpdir(), 'session-birth-migrations-'));
  directories.push(directory);
  mkdirSync(join(directory, 'meta'));
  for (const entry of entries)
    copyFileSync(join(migrationDirectory, `${entry.tag}.sql`), join(directory, `${entry.tag}.sql`));
  writeFileSync(join(directory, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  return directory;
}

beforeAll(() => {
  const prepared = createDb(':memory:');
  try {
    migrate(prepared, { migrationsFolder: migrationsThroughBirth(true) });
    image = prepared.$client.serialize();
  } finally {
    prepared.$client.close();
  }
});
beforeEach(() => {
  db = createDbFromImage(image);
});
afterEach(() => db.$client.close());
afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

type RawAllocation = {
  session_id: string;
  version: number | string | null;
  created_at: string | null;
  source_kind: string | null;
  owner_id: string | null;
  location_id: string | null;
  registered_agent_id: string | null;
  recorded_registered_path: string | null;
  internal_source: string | null;
};
const location = (session = 'fresh'): RawAllocation => ({
  session_id: session,
  version: 1,
  created_at: stamp,
  source_kind: 'person-location',
  owner_id: 'person',
  location_id: 'folder',
  registered_agent_id: null,
  recorded_registered_path: null,
  internal_source: null,
});
function insert(row: RawAllocation, target = db): void {
  target.$client
    .prepare(
      'INSERT INTO session_birth_allocations (session_id,version,created_at,source_kind,owner_id,location_id,registered_agent_id,recorded_registered_path,internal_source) VALUES (@session_id,@version,@created_at,@source_kind,@owner_id,@location_id,@registered_agent_id,@recorded_registered_path,@internal_source)'
    )
    .run(row);
}
function internal(payload: unknown): RawAllocation {
  return {
    ...location(),
    source_kind: 'internal',
    owner_id: null,
    location_id: null,
    internal_source: JSON.stringify(payload),
  };
}
const receipt = {
  kind: 'chat-message',
  receiptId: 'actual-receipt-key',
  queueMessageId: 'actual-queue-key',
  mintedToSessionId: 'fresh',
  fromSessionId: 'sender',
};
const seat = {
  kind: 'room-seat',
  roomId: 'room',
  authorId: 'author',
  boundSessionId: 'fresh',
  seatCreatedAt: stamp,
};

describe('session birth allocation migration', () => {
  it('preserves old bound, preference-only and imported metadata with null lifecycle', () => {
    const legacy = createDb(':memory:');
    try {
      migrate(legacy, { migrationsFolder: migrationsThroughBirth(false) });
      legacy.$client.exec(`
        INSERT INTO session_metadata (session_id,runtime,model,permission_mode,created_at)
        VALUES ('bound','codex','chosen','default','old'),
               ('preferences',NULL,'explicit','plan','old'),
               ('imported','opencode',NULL,NULL,'old');
      `);
      const before = legacy.$client
        .prepare('SELECT * FROM session_metadata ORDER BY session_id')
        .all();
      const indexes = () =>
        legacy.$client
          .prepare(
            "SELECT name,sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'session_metadata' ORDER BY name"
          )
          .all();
      const indexesBefore = indexes();
      expect(indexesBefore).toContainEqual({
        name: 'session_metadata_agent_path_idx',
        sql: expect.stringMatching(/WHERE.*agent_path.*IS NOT NULL/iu),
      });
      migrate(legacy, { migrationsFolder: migrationsThroughBirth(true) });
      expect(indexes()).toEqual(indexesBefore);
      const after = legacy.$client
        .prepare('SELECT * FROM session_metadata ORDER BY session_id')
        .all();
      expect(after).toEqual(
        before.map((row) => ({ ...(row as Record<string, unknown>), model_launch_state: null }))
      );
      expect(legacy.$client.prepare('SELECT * FROM session_birth_allocations').all()).toEqual([]);
    } finally {
      legacy.$client.close();
    }
  });

  it.each([
    ['location', location()],
    [
      'registered agent',
      {
        ...location(),
        source_kind: 'person-agent',
        location_id: null,
        registered_agent_id: 'agent',
        recorded_registered_path: '/registered/agent',
      },
    ],
    ['receipt', internal(receipt)],
    ['seat', internal(seat)],
    ['run', internal({ kind: 'task-run', runId: 'run', mintedSessionId: 'fresh' })],
    [
      'beat',
      internal({
        kind: 'heartbeat',
        agentId: 'agent',
        chatDate: '2026-11-19',
        mintedSessionId: 'fresh',
      }),
    ],
    [
      'subscription',
      internal({
        kind: 'connector-subscription',
        subscriptionId: 'subscription',
        mintedSessionId: 'fresh',
      }),
    ],
    [
      'recovery',
      internal({
        kind: 'required-recovery',
        requirementId: 'requirement',
        mintedSessionId: 'fresh',
      }),
    ],
    [
      'server mint',
      internal({ kind: 'server-mint', owner: 'extension-start', mintedSessionId: 'fresh' }),
    ],
  ] as const)('stores the %s shape without creating metadata or queued work', (_name, row) => {
    const counts = () => ({
      metadata: db.$client.prepare('SELECT count(*) AS n FROM session_metadata').get(),
      queue: db.$client.prepare('SELECT count(*) AS n FROM session_message_queue').get(),
    });
    const before = counts();
    insert(row);
    expect(db.select().from(sessionBirthAllocations).all()).toHaveLength(1);
    expect(counts()).toEqual(before);
    // These structural keys deliberately have no corresponding receipt/seat/agent rows.
    // Task 1.2 must authenticate the actual persisted source inside its write transaction.
    expect(
      db.$client.prepare('SELECT * FROM session_metadata WHERE session_id = ?').get('fresh')
    ).toBeUndefined();
  });

  it.each([
    ['missing owner', { owner_id: null }],
    ['empty owner', { owner_id: '' }],
    ['missing folder', { location_id: null }],
    ['mixed public variants', { registered_agent_id: 'agent' }],
    ['mixed internal source', { internal_source: JSON.stringify(receipt) }],
    ['unknown source', { source_kind: 'unknown' }],
    ['missing source', { source_kind: null }],
    ['future version', { version: 2 }],
    ['fractional version', { version: 1.5 }],
    ['text version', { version: 'unknown' }],
    ['missing version', { version: null }],
    ['empty id', { session_id: '' }],
    ['missing date', { created_at: null }],
  ] as const)('rejects raw SQL with %s', (_name, patch) => {
    expect(() => insert({ ...location(), ...patch })).toThrow(/constraint/i);
    expect(db.select().from(sessionBirthAllocations).all()).toEqual([]);
  });

  it.each([
    ['missing owner', { owner_id: null }],
    ['missing agent', { registered_agent_id: null }],
    ['missing recorded path', { recorded_registered_path: null }],
    ['extra folder', { location_id: 'folder' }],
  ] as const)('rejects registered-agent %s', (_name, patch) => {
    expect(() =>
      insert({
        ...location(),
        source_kind: 'person-agent',
        location_id: null,
        registered_agent_id: 'agent',
        recorded_registered_path: '/registered/agent',
        ...patch,
      })
    ).toThrow(/constraint/i);
  });

  it.each([
    ['malformed JSON', '{'],
    ['JSON null', 'null'],
    ['array', '[]'],
    ['empty object', '{}'],
    ['unsupported source', JSON.stringify({ kind: 'unknown' })],
    ['missing receipt key', JSON.stringify({ ...receipt, receiptId: undefined })],
    ['null receipt key', JSON.stringify({ ...receipt, receiptId: null })],
    ['extra field', JSON.stringify({ ...receipt, permission: 'full' })],
    ['wrong receiving id', JSON.stringify({ ...receipt, mintedToSessionId: 'other' })],
    ['wrong seat generation shape', JSON.stringify({ ...seat, seatCreatedAt: null })],
    [
      'unknown mint owner',
      JSON.stringify({ kind: 'server-mint', owner: 'arbitrary', mintedSessionId: 'fresh' }),
    ],
  ])('rejects internal %s through raw SQLite', (_name, payload) => {
    expect(() => insert({ ...internal(receipt), internal_source: payload })).toThrow(/constraint/i);
    expect(db.select().from(sessionBirthAllocations).all()).toEqual([]);
  });

  it('allows multiple drafts for a source and preserves the winner on id collision', () => {
    insert(location('first'));
    insert(location('second'));
    expect(() => insert({ ...location('first'), owner_id: 'other' })).toThrow(/constraint/i);
    expect(
      db.$client
        .prepare('SELECT owner_id FROM session_birth_allocations WHERE session_id = ?')
        .get('first')
    ).toEqual({ owner_id: 'person' });
    expect(db.select().from(sessionBirthAllocations).all()).toHaveLength(2);
  });

  it('accepts only the three lifecycle values and keeps legacy null', () => {
    db.$client.exec("INSERT INTO session_metadata (session_id,created_at) VALUES ('chat','old')");
    const update = db.$client.prepare(
      'UPDATE session_metadata SET model_launch_state = ? WHERE session_id = ?'
    );
    expect(db.$client.prepare('SELECT model_launch_state FROM session_metadata').get()).toEqual({
      model_launch_state: null,
    });
    for (const state of ['pending-v1', 'attempted-v1', 'established-v1']) {
      update.run(state, 'chat');
      expect(db.$client.prepare('SELECT model_launch_state FROM session_metadata').get()).toEqual({
        model_launch_state: state,
      });
    }
    for (const invalid of ['', 'pending-v2', 'initialized'])
      expect(() => update.run(invalid, 'chat')).toThrow(/constraint/i);
    update.run(null, 'chat');
  });

  it('keeps unconsumed allocations across a real close and reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'session-birth-persistence-'));
    directories.push(directory);
    const file = join(directory, 'dork.db');
    const first = createDb(file);
    try {
      migrate(first, { migrationsFolder: migrationsThroughBirth(true) });
      insert(location('saved-draft'), first);
    } finally {
      first.$client.close();
    }
    const reopened = createDb(file);
    try {
      expect(
        reopened.$client
          .prepare('SELECT session_id,created_at FROM session_birth_allocations')
          .get()
      ).toEqual({ session_id: 'saved-draft', created_at: stamp });
      expect(reopened.$client.prepare('SELECT count(*) AS n FROM session_metadata').get()).toEqual({
        n: 0,
      });
    } finally {
      reopened.$client.close();
    }
  });

  it('rolls back an allocation transaction that fails before publication', () => {
    expect(() =>
      db.transaction(() => {
        insert(location());
        throw new Error('publication failed');
      })
    ).toThrow('publication failed');
    expect(db.select().from(sessionBirthAllocations).all()).toEqual([]);
    expect(migrationTag).toBeTruthy();
  });
});
