import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createDb, runMigrations } from '../index';

const folder = fileURLToPath(new URL('../../drizzle/', import.meta.url));
type Entry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
const journal = JSON.parse(readFileSync(path.join(folder, 'meta/_journal.json'), 'utf8')) as {
  version: string;
  dialect: string;
  entries: Entry[];
};
const oldTimes = [1791414422000, 1791414423000, 1791414424000];
const hashes = [
  'c156544a648a0d5dd48a5147f2488420d8460da5ea9e0c596afdd407486adc84',
  '934167d31e86442927414b4ef1790e60ddc3d1d7af51285b59411d135514fc49',
  'f85a83fc7fc5adc1764d1c10e089acdd3d0ea874139c5757bbff58ca77ed0825',
];
const canonicalDocTimes = [1791478832000, 1791478833000, 1791478834000];
const historicalTags = [
  '20261008170032_doc_room_admissions',
  '20261008170033_doc_room_pending_sources',
  '20261008170034_lowly_molecule_man',
];
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Use the public migrator and unchanged SQL, including historical Doc timestamps. */
function migrationFolder(entries: Entry[]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dorkos-doc-upgrade-'));
  dirs.push(dir);
  mkdirSync(path.join(dir, 'meta'));
  writeFileSync(path.join(dir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  for (const entry of entries) {
    copyFileSync(
      path.join(
        folder,
        ...(historicalTags.includes(entry.tag) ? ['legacy-doc'] : []),
        `${entry.tag}.sql`
      ),
      path.join(dir, `${entry.tag}.sql`)
    );
  }
  return dir;
}

function history(db: ReturnType<typeof createDb>) {
  return db.$client
    .prepare(
      'SELECT rowid AS rowIdentity, id, hash, created_at FROM __drizzle_migrations ORDER BY rowid'
    )
    .all() as {
    rowIdentity: number;
    id: number | null;
    hash: string;
    created_at: number;
  }[];
}

function schema(db: ReturnType<typeof createDb>) {
  return db.$client
    .prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name')
    .all();
}

function legacyEntries(count: number): Entry[] {
  return [
    ...journal.entries.slice(0, 148),
    ...historicalTags.slice(0, count).map((tag, i) => ({
      idx: 148 + i,
      version: '6',
      when: oldTimes[i]!,
      tag,
      breakpoints: true,
    })),
  ];
}

function seed(db: ReturnType<typeof createDb>, hasDoc: boolean) {
  db.$client
    .prepare(
      'INSERT INTO session_metadata (session_id, runtime, agent_path, created_at) VALUES (?, ?, ?, ?)'
    )
    .run('preserved-session', 'claude-code', '/preserved-agent', '2026-10-07T00:00:00Z');
  if (hasDoc) {
    db.$client
      .prepare(
        'INSERT INTO canvas_doc_channels (document_id, scope, created_at, updated_at) VALUES (?, ?, ?, ?)'
      )
      .run('preserved-document', 'workspace', '2026-10-07T00:00:00Z', '2026-10-07T00:00:00Z');
    db.$client
      .prepare(
        'INSERT INTO canvas_doc_channel_tokens (token_id, token_hash, document_id, allowed_types, directions, permissions, creator_id, created_at, expires_at, binding_version, document_scope, document_generation, document_birth, document_incarnation, declaration_hash, approved_grant_bindings, issuer_binding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        'preserved-token',
        'preserved-hash',
        'preserved-document',
        '[]',
        '[]',
        '[]',
        'preserved-owner',
        '2026-10-07T00:00:00Z',
        '2026-10-09T00:00:00Z',
        1,
        'workspace',
        'generation',
        'birth',
        'incarnation',
        'declaration',
        '[]',
        '{}'
      );
  }
}

function rows(db: ReturnType<typeof createDb>, hasDoc: boolean) {
  return {
    session: db.$client
      .prepare("SELECT * FROM session_metadata WHERE session_id = 'preserved-session'")
      .get(),
    document: hasDoc
      ? db.$client
          .prepare("SELECT * FROM canvas_doc_channels WHERE document_id = 'preserved-document'")
          .get()
      : undefined,
    token: hasDoc
      ? db.$client
          .prepare("SELECT * FROM canvas_doc_channel_tokens WHERE token_id = 'preserved-token'")
          .get()
      : undefined,
  };
}

function verifyFinal(db: ReturnType<typeof createDb>) {
  const applied = history(db);
  const legacy = applied.some((row) => hashes.includes(row.hash));
  expect(applied).toHaveLength(journal.entries.length + (legacy ? 3 : 0));
  for (const [i, hash] of hashes.entries()) {
    const matching = applied.filter((row) => row.hash === hash);
    expect(matching).toHaveLength(legacy ? 1 : 0);
    if (legacy) expect(matching[0]!.created_at).toBe(canonicalDocTimes[i]);
  }
  const main = journal.entries[148]!;
  const mainHash = createHash('sha256')
    .update(readFileSync(path.join(folder, `${main.tag}.sql`)))
    .digest('hex');
  expect(applied.filter((row) => row.hash === mainHash)).toHaveLength(1);
  for (const entry of journal.entries.slice(149, 151)) {
    const hash = createHash('sha256')
      .update(readFileSync(path.join(folder, `${entry.tag}.sql`)))
      .digest('hex');
    expect(applied.filter((row) => row.hash === hash)).toHaveLength(1);
  }
  expect(
    db.$client.prepare("SELECT name FROM sqlite_master WHERE name='chat_messages'").get()
  ).toBeDefined();
  expect(
    db.$client
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_touches'")
      .get()
  ).toBeDefined();
  const finalSchema = schema(db);
  runMigrations(db);
  expect(history(db)).toEqual(applied);
  expect(schema(db)).toEqual(finalSchema);
  expect(db.$client.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
}

describe('Doc migration history across shipped session touches', () => {
  it('migrates a fresh database and restarts without duplicate migrations', () => {
    const db = createDb(':memory:');
    try {
      runMigrations(db);
      verifyFinal(db);
    } finally {
      db.$client.close();
    }
  });

  it('upgrades shipped Main148 while preserving session-touch data', () => {
    const db = createDb(':memory:');
    try {
      migrate(db, { migrationsFolder: migrationFolder(journal.entries.slice(0, 149)) });
      seed(db, false);
      db.$client
        .prepare('INSERT INTO session_touches (session_id, opened_at, wrote_at) VALUES (?, ?, ?)')
        .run('preserved-session', '2026-10-08T00:00:00Z', '2026-10-08T00:01:00Z');
      const before = history(db);
      const touches = db.$client.prepare('SELECT * FROM session_touches').all();
      const data = rows(db, false);
      runMigrations(db);
      expect(history(db).slice(0, before.length)).toEqual(before);
      expect(rows(db, false)).toEqual(data);
      expect(db.$client.prepare('SELECT * FROM session_touches').all()).toEqual(touches);
      verifyFinal(db);
    } finally {
      db.$client.close();
    }
  });

  for (const count of [0, 1, 2, 3]) {
    for (const mainAlreadyApplied of count === 0 ? [false] : [false, true]) {
      it(`upgrades historical Doc prefix ${count}${mainAlreadyApplied ? ' after a committed Main bridge' : ''} preserving IDs and data`, () => {
        const db = createDb(':memory:');
        try {
          migrate(db, { migrationsFolder: migrationFolder(legacyEntries(count)) });
          seed(db, count > 0);
          const before = history(db);
          const data = rows(db, count > 0);
          if (mainAlreadyApplied) {
            // The public Main migration committed; the process stopped before ledger retiming.
            migrate(db, { migrationsFolder: migrationFolder([journal.entries[148]!]) });
          }
          runMigrations(db);
          expect(history(db).slice(0, before.length)).toEqual(
            before.map((row) => {
              const doc = hashes.indexOf(row.hash);
              return doc < 0 ? row : { ...row, created_at: canonicalDocTimes[doc]! };
            })
          );
          expect(rows(db, count > 0)).toEqual(data);
          verifyFinal(db);
        } finally {
          db.$client.close();
        }
      });
    }
  }

  it('upgrades the published canonical three-Doc history without replaying its DDL or changing its rows', () => {
    const db = createDb(':memory:');
    try {
      const entries = [
        ...journal.entries.slice(0, 149),
        ...historicalTags.map((tag, i) => ({
          idx: 149 + i,
          version: '6',
          when: canonicalDocTimes[i]!,
          tag,
          breakpoints: true,
        })),
      ];
      migrate(db, { migrationsFolder: migrationFolder(entries) });
      seed(db, true);
      const before = history(db),
        data = rows(db, true);
      runMigrations(db);
      expect(history(db).slice(0, before.length)).toEqual(before);
      expect(rows(db, true)).toEqual(data);
      verifyFinal(db);
    } finally {
      db.$client.close();
    }
  });

  it('rolls back every legacy timestamp on retime failure and resumes after the committed Main migration', () => {
    const db = createDb(':memory:');
    try {
      migrate(db, { migrationsFolder: migrationFolder(legacyEntries(2)) });
      seed(db, true);
      // Reproduce the real durable boundary before retiming, with original Main SQL.
      migrate(db, { migrationsFolder: migrationFolder([journal.entries[148]!]) });
      const before = history(db);
      const data = rows(db, true);
      // An owned SQLite failure on row two must roll back the earlier row-one update.
      db.$client.exec(`
        CREATE TRIGGER owned_doc_retime_abort
        BEFORE UPDATE OF created_at ON __drizzle_migrations
        WHEN OLD.hash = '${hashes[1]}'
        BEGIN
          SELECT RAISE(ABORT, 'owned-retime-abort');
        END;
      `);
      const beforeSchema = schema(db);
      expect(() => runMigrations(db)).toThrow(/owned-retime-abort/);
      expect(history(db)).toEqual(before);
      expect(rows(db, true)).toEqual(data);
      expect(schema(db)).toEqual(beforeSchema);
      db.$client.exec('DROP TRIGGER owned_doc_retime_abort');
      runMigrations(db);
      expect(rows(db, true)).toEqual(data);
      expect(history(db).slice(0, before.length)).toEqual(
        before.map((row) => {
          const doc = hashes.indexOf(row.hash);
          return doc < 0 ? row : { ...row, created_at: canonicalDocTimes[doc]! };
        })
      );
      verifyFinal(db);
    } finally {
      db.$client.close();
    }
  });

  for (const invalid of ['wrong timestamp', 'non-prefix', 'duplicate'] as const) {
    it(`refuses ${invalid} historical Doc bookkeeping before any schema or history change`, () => {
      const db = createDb(':memory:');
      try {
        migrate(db, { migrationsFolder: migrationFolder(legacyEntries(1)) });
        if (invalid === 'wrong timestamp') {
          db.$client
            .prepare('UPDATE __drizzle_migrations SET created_at = ? WHERE hash = ?')
            .run(oldTimes[0]! + 1, hashes[0]!);
        } else if (invalid === 'non-prefix') {
          db.$client
            .prepare('UPDATE __drizzle_migrations SET hash = ?, created_at = ? WHERE hash = ?')
            .run(hashes[1]!, oldTimes[1]!, hashes[0]!);
        } else {
          db.$client
            .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
            .run(hashes[0]!, oldTimes[0]!);
        }
        const before = history(db);
        const beforeSchema = schema(db);
        expect(() => runMigrations(db)).toThrow(/legacy Doc migration history/i);
        expect(history(db)).toEqual(before);
        expect(schema(db)).toEqual(beforeSchema);
      } finally {
        db.$client.close();
      }
    });
  }

  it('keeps the shipped snapshot and a lexically latest full Doc schema chain', () => {
    const readSnapshot = (tag: string) =>
      JSON.parse(
        readFileSync(path.join(folder, 'meta', `${tag.split('_')[0]}_snapshot.json`), 'utf8')
      );
    const main = readSnapshot(journal.entries[148]!.tag);
    expect(main.id).toBe('4781c5d1-5724-4b21-997d-22e32403c8c8');
    let previous = main.id;
    for (const entry of journal.entries.slice(149)) {
      const snapshot = readSnapshot(entry.tag);
      expect(snapshot.prevId).toBe(previous);
      expect(snapshot.tables.session_touches).toEqual(main.tables.session_touches);
      expect(snapshot.tables.canvas_doc_channels).toBeDefined();
      previous = snapshot.id;
    }
  });
});
