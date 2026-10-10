import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createDb, runMigrations } from '../index';
import { bridgeLegacyDocMigrationHistory } from '../doc-migration-history';

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
        ...(historicalTags.includes(entry.tag) ||
        entry.tag === '20261009202012_sleepy_killer_shrike' ||
        entry.tag === '20261010100703_long_shocker'
          ? ['legacy-doc']
          : []),
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
  for (const entry of journal.entries.slice(149, 153)) {
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

const publishedRoom = {
  idx: 150,
  version: '6',
  when: 1791577212201,
  tag: '20261009202012_sleepy_killer_shrike',
  breakpoints: true,
  hash: '44321f0c067d6ce35619f22ac071fcd08bdddd8dec4a7b099f8ce31998b1324f',
};
const reportBackHash = 'fff2ecc577b7f440a07aace5577ba21aa0e47817616155d41b6b4f15cee99361';

/** Build the actual published c55 chain, not manually accepted history rows. */
function publishedDatabase(source: Entry = publishedRoom) {
  const db = createDb(':memory:');
  migrate(db, {
    migrationsFolder: migrationFolder([...journal.entries.slice(0, source.idx), source]),
  });
  seed(db, true);
  db.$client
    .prepare(
      `INSERT INTO canvas_doc_grants
    (grant_id, document_id, route_id, normalized_route, route_hash, declaration_hash,
     approved_by, approval_evidence, limits, allowed_types, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'preserved-grant',
      'preserved-document',
      'preserved-route',
      '{}',
      'a'.repeat(64),
      'b'.repeat(64),
      'operator',
      '{}',
      '{}',
      '[]',
      '2026-10-09T00:00:00Z'
    );
  db.$client
    .prepare(
      `INSERT INTO canvas_doc_batches
    (batch_id, document_id, scope, route_id, grant_id, grant_revision, generation,
     input_event_ids, effective_payload, due_at, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'preserved-batch',
      'preserved-document',
      'workspace',
      'preserved-route',
      'preserved-grant',
      1,
      'generation',
      '[]',
      '{}',
      '2026-10-09T00:00:00Z',
      'turn_started',
      '2026-10-09T00:00:00Z',
      '2026-10-09T00:00:00Z'
    );
  db.$client
    .prepare(
      `INSERT INTO canvas_doc_room_pending_sources
    (document_id, batch_id, generation, source_json, source_hash, due_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'preserved-document',
      'preserved-batch',
      'generation',
      '{"preserved":true}',
      'c'.repeat(64),
      '2026-10-09T00:00:00Z',
      '2026-10-09T00:00:00Z'
    );
  db.$client
    .prepare(
      `INSERT INTO session_started_by
    (session_id, kind, origin_extension_id, created_at) VALUES (?, ?, ?, ?)`
    )
    .run('preserved-start', 'extension', 'preserved-extension', '2026-10-09T00:00:00Z');
  return db;
}

describe('published consolidated Room150 across shipped report_back150', () => {
  it('preserves populated published c55 rows and history, installs report_back once, and restarts', () => {
    const db = publishedDatabase();
    try {
      const before = history(db),
        data = rows(db, true);
      const pending = db.$client.prepare('SELECT * FROM canvas_doc_room_pending_sources').all();
      const batches = db.$client.prepare('SELECT * FROM canvas_doc_batches').all();
      const start = db.$client.prepare('SELECT * FROM session_started_by').get();
      runMigrations(db);
      expect(history(db).slice(0, before.length)).toEqual(
        before.map((row) =>
          row.hash === publishedRoom.hash ? { ...row, created_at: journal.entries[152]!.when } : row
        )
      );
      expect(rows(db, true)).toEqual(data);
      expect(db.$client.prepare('SELECT * FROM canvas_doc_room_pending_sources').all()).toEqual(
        pending
      );
      expect(db.$client.prepare('SELECT * FROM canvas_doc_batches').all()).toEqual(batches);
      expect(db.$client.prepare('SELECT * FROM session_started_by').get()).toMatchObject(start!);
      expect(db.$client.prepare('SELECT report_back FROM session_started_by').get()).toEqual({
        report_back: 1,
      });
      expect(history(db).filter((row) => row.hash === publishedRoom.hash)).toEqual([
        { ...before[150]!, created_at: journal.entries[152]!.when },
      ]);
      expect(history(db).filter((row) => row.hash === reportBackHash)).toHaveLength(1);
      const canonicalRoom = history(db).find((row) => row.hash === publishedRoom.hash)!;
      const report = history(db).find((row) => row.hash === reportBackHash)!;
      expect(canonicalRoom.rowIdentity).toBe(before[150]!.rowIdentity);
      expect(canonicalRoom.id).toBe(before[150]!.id);
      expect(canonicalRoom.rowIdentity).toBeLessThan(report.rowIdentity);
      verifyFinal(db);
    } finally {
      db.$client.close();
    }
  });

  it('rolls back shipped DDL and new history together if covered152 bookkeeping fails, then resumes', () => {
    const db = publishedDatabase();
    try {
      const final = journal.entries[152]!;
      const finalHash = createHash('sha256')
        .update(readFileSync(path.join(folder, `${final.tag}.sql`)))
        .digest('hex');
      db.$client.exec(`CREATE TRIGGER owned_report_back_abort
        BEFORE UPDATE OF created_at ON __drizzle_migrations WHEN OLD.hash = '${finalHash}'
        BEGIN SELECT RAISE(ABORT, 'owned-report-back-abort'); END;`);
      const before = history(db),
        beforeSchema = schema(db),
        data = rows(db, true);
      expect(() => runMigrations(db)).toThrow(/owned-report-back-abort/);
      expect(history(db)).toEqual(before);
      expect(schema(db)).toEqual(beforeSchema);
      expect(rows(db, true)).toEqual(data);
      db.$client.exec('DROP TRIGGER owned_report_back_abort');
      runMigrations(db);
      expect(rows(db, true)).toEqual(data);
      verifyFinal(db);
    } finally {
      db.$client.close();
    }
  });

  for (const invalid of [
    'wrong published stamp',
    'unknown published hash',
    'duplicate published row',
    'unbacked canonical stamp',
    'missing shipped prefix',
    'unknown newer row',
  ] as const) {
    it(`refuses ${invalid} without changing data, schema, or history`, () => {
      const db = publishedDatabase();
      try {
        if (invalid === 'wrong published stamp')
          db.$client
            .prepare('UPDATE __drizzle_migrations SET created_at = created_at + 1 WHERE hash = ?')
            .run(publishedRoom.hash);
        else if (invalid === 'unknown published hash')
          db.$client
            .prepare('UPDATE __drizzle_migrations SET hash = ? WHERE hash = ?')
            .run('not-reviewed', publishedRoom.hash);
        else if (invalid === 'unbacked canonical stamp')
          db.$client
            .prepare('UPDATE __drizzle_migrations SET created_at = ? WHERE hash = ?')
            .run(journal.entries[152]!.when, publishedRoom.hash);
        else if (invalid === 'duplicate published row')
          db.$client
            .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
            .run(publishedRoom.hash, publishedRoom.when);
        else if (invalid === 'missing shipped prefix')
          db.$client.prepare('DELETE FROM __drizzle_migrations WHERE rowid = 149').run();
        else
          db.$client
            .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
            .run('unknown-newer', publishedRoom.when + 1);
        const before = history(db),
          beforeSchema = schema(db),
          data = rows(db, true);
        expect(() => runMigrations(db)).toThrow(/legacy Doc migration history/i);
        expect(history(db)).toEqual(before);
        expect(schema(db)).toEqual(beforeSchema);
        expect(rows(db, true)).toEqual(data);
      } finally {
        db.$client.close();
      }
    });
  }
});

const publishedRoom151 = {
  idx: 151,
  version: '6',
  when: 1791626823308,
  tag: '20261010100703_long_shocker',
  breakpoints: true,
  hash: '44321f0c067d6ce35619f22ac071fcd08bdddd8dec4a7b099f8ce31998b1324f',
};
const agentReportsHash = 'a7f1de118e0678648345368108a441c4ff7d76cf8be40320eca8127b58c9fa04';

/** Populate an agent before Main151's nullable columns exist. */
function seedPublishedAgent(db: ReturnType<typeof createDb>) {
  db.$client
    .prepare(
      `INSERT INTO agents
    (id, name, runtime, project_path, registered_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      'preserved-agent',
      'preserved-name',
      'claude-code',
      '/preserved-agent',
      '2026-10-09T00:00:00Z',
      '2026-10-09T00:01:00Z'
    );
}

/** Reproduce the shipped150-to151 bridge retaining its actual physical Room row. */
function previouslyBridged151() {
  const db = publishedDatabase();
  const report = journal.entries[150]!;
  for (const statement of readFileSync(path.join(folder, `${report.tag}.sql`), 'utf8').split(
    '--> statement-breakpoint'
  ))
    if (statement.trim()) db.$client.exec(statement);
  db.$client
    .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
    .run(reportBackHash, report.when);
  db.$client
    .prepare('UPDATE __drizzle_migrations SET created_at = ? WHERE hash = ? AND created_at = ?')
    .run(publishedRoom151.when, publishedRoom.hash, publishedRoom.when);
  return db;
}

for (const variant of ['published150', 'fresh151', 'bridged151'] as const) {
  const build = () =>
    variant === 'published150'
      ? publishedDatabase()
      : variant === 'fresh151'
        ? publishedDatabase(publishedRoom151)
        : previouslyBridged151();
  describe(`${variant} across shipped agent151 and canonical Room152`, () => {
    it('preserves populated data and original Room row identity, installs missing Main once and restarts', () => {
      const db = build();
      try {
        seedPublishedAgent(db);
        const before = history(db),
          data = rows(db, true);
        const agent = db.$client
          .prepare('SELECT * FROM agents WHERE id=?')
          .get('preserved-agent') as Record<string, unknown>;
        const pending = db.$client.prepare('SELECT * FROM canvas_doc_room_pending_sources').all();
        const batches = db.$client.prepare('SELECT * FROM canvas_doc_batches').all();
        const original = before.find((row) => row.hash === publishedRoom.hash)!;
        if (variant === 'bridged151')
          expect(original.rowIdentity).toBeLessThan(
            before.find((row) => row.hash === reportBackHash)!.rowIdentity
          );
        if (variant === 'fresh151')
          expect(original.rowIdentity).toBeGreaterThan(
            before.find((row) => row.hash === reportBackHash)!.rowIdentity
          );
        runMigrations(db);
        expect(history(db).slice(0, before.length)).toEqual(
          before.map((row) =>
            row.hash === publishedRoom.hash
              ? { ...row, created_at: journal.entries[152]!.when }
              : row
          )
        );
        expect(rows(db, true)).toEqual(data);
        expect(db.$client.prepare('SELECT * FROM canvas_doc_room_pending_sources').all()).toEqual(
          pending
        );
        expect(db.$client.prepare('SELECT * FROM canvas_doc_batches').all()).toEqual(batches);
        expect(
          db.$client.prepare('SELECT * FROM agents WHERE id=?').get('preserved-agent')
        ).toEqual({
          ...agent,
          reports_to: null,
          created_by: null,
        });
        expect(history(db).filter((row) => row.hash === publishedRoom.hash)).toEqual([
          { ...original, created_at: journal.entries[152]!.when },
        ]);
        expect(history(db).filter((row) => row.hash === reportBackHash)).toHaveLength(1);
        expect(history(db).filter((row) => row.hash === agentReportsHash)).toHaveLength(1);
        verifyFinal(db);
        runMigrations(db);
        verifyFinal(db);
      } finally {
        db.$client.close();
      }
    });

    it('rolls back all missing shipped DDL and history if original Room retiming aborts', () => {
      const db = build();
      try {
        seedPublishedAgent(db);
        db.$client.exec(`CREATE TRIGGER owned_room152_abort
          BEFORE UPDATE OF created_at ON __drizzle_migrations WHEN OLD.hash = '${publishedRoom.hash}'
          BEGIN SELECT RAISE(ABORT, 'owned-room152-abort'); END;`);
        const before = history(db),
          beforeSchema = schema(db),
          data = rows(db, true);
        const agents = db.$client.prepare('SELECT * FROM agents').all();
        expect(() => runMigrations(db)).toThrow(/owned-room152-abort/);
        expect(history(db)).toEqual(before);
        expect(schema(db)).toEqual(beforeSchema);
        expect(rows(db, true)).toEqual(data);
        expect(db.$client.prepare('SELECT * FROM agents').all()).toEqual(agents);
        db.$client.exec('DROP TRIGGER owned_room152_abort');
        runMigrations(db);
        verifyFinal(db);
      } finally {
        db.$client.close();
      }
    });

    for (const invalid of [
      'wrong-stamp',
      'duplicate-other-Room-stamp',
      'missing-Main150',
      'unbacked-agent-columns',
      'unknown-newer',
    ] as const) {
      if (variant === 'published150' && invalid === 'missing-Main150') continue;
      it(`refuses ${invalid} before changing schema, data or history`, () => {
        const db = build();
        try {
          seedPublishedAgent(db);
          if (invalid === 'wrong-stamp')
            db.$client
              .prepare('UPDATE __drizzle_migrations SET created_at=created_at+1 WHERE hash=?')
              .run(publishedRoom.hash);
          else if (invalid === 'duplicate-other-Room-stamp')
            db.$client
              .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
              .run(
                publishedRoom.hash,
                variant === 'published150' ? publishedRoom151.when : publishedRoom.when
              );
          else if (invalid === 'missing-Main150')
            db.$client.prepare('DELETE FROM __drizzle_migrations WHERE hash=?').run(reportBackHash);
          else if (invalid === 'unbacked-agent-columns')
            db.$client.exec(
              'ALTER TABLE agents ADD reports_to text; ALTER TABLE agents ADD created_by text;'
            );
          else
            db.$client
              .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
              .run('unknown-room152', journal.entries[152]!.when + 1);
          const before = history(db),
            beforeSchema = schema(db),
            data = rows(db, true),
            agents = db.$client.prepare('SELECT * FROM agents').all();
          expect(() => runMigrations(db)).toThrow(/legacy Doc migration history/i);
          expect(history(db)).toEqual(before);
          expect(schema(db)).toEqual(beforeSchema);
          expect(rows(db, true)).toEqual(data);
          expect(db.$client.prepare('SELECT * FROM agents').all()).toEqual(agents);
        } finally {
          db.$client.close();
        }
      });
    }
  });
}

it('upgrades populated shipped Main151 preserving existing reports-to values', () => {
  const db = createDb(':memory:');
  try {
    migrate(db, { migrationsFolder: migrationFolder(journal.entries.slice(0, 152)) });
    seed(db, false);
    seedPublishedAgent(db);
    db.$client
      .prepare('UPDATE agents SET reports_to=?, created_by=? WHERE id=?')
      .run('preserved-manager', 'preserved-owner', 'preserved-agent');
    const before = history(db),
      agents = db.$client.prepare('SELECT * FROM agents').all(),
      data = rows(db, false);
    runMigrations(db);
    expect(history(db).slice(0, before.length)).toEqual(before);
    expect(db.$client.prepare('SELECT * FROM agents').all()).toEqual(agents);
    expect(rows(db, false)).toEqual(data);
    verifyFinal(db);
  } finally {
    db.$client.close();
  }
});

it.each(['missing', 'changed'] as const)(
  'refuses %s archived published151 SQL without any writes',
  (invalid) => {
    const db = publishedDatabase(publishedRoom151);
    try {
      const isolated = migrationFolder(journal.entries);
      mkdirSync(path.join(isolated, 'legacy-doc'));
      for (const tag of [...historicalTags, publishedRoom.tag, publishedRoom151.tag])
        copyFileSync(
          path.join(folder, 'legacy-doc', `${tag}.sql`),
          path.join(isolated, 'legacy-doc', `${tag}.sql`)
        );
      if (invalid === 'missing')
        rmSync(path.join(isolated, 'legacy-doc', `${publishedRoom151.tag}.sql`));
      else
        writeFileSync(
          path.join(isolated, 'legacy-doc', `${publishedRoom151.tag}.sql`),
          'forged archive'
        );
      const before = history(db),
        beforeSchema = schema(db),
        data = rows(db, true);
      expect(() => bridgeLegacyDocMigrationHistory(db, isolated)).toThrow();
      expect(history(db)).toEqual(before);
      expect(schema(db)).toEqual(beforeSchema);
      expect(rows(db, true)).toEqual(data);
    } finally {
      db.$client.close();
    }
  }
);

/** Real future SQL is applied by the public migrator, not by a schema-only surrogate. */
function futureMigrationFolder() {
  const isolated = migrationFolder(journal.entries);
  mkdirSync(path.join(isolated, 'legacy-doc'));
  for (const tag of [...historicalTags, publishedRoom.tag, publishedRoom151.tag])
    copyFileSync(
      path.join(folder, 'legacy-doc', `${tag}.sql`),
      path.join(isolated, 'legacy-doc', `${tag}.sql`)
    );
  const first: Entry = {
    idx: 153,
    version: '6',
    when: journal.entries[152]!.when + 1,
    tag: 'test_future_owned_table',
    breakpoints: true,
  };
  const second: Entry = {
    ...first,
    idx: 154,
    when: first.when + 1,
    tag: 'test_future_owned_column',
  };
  const firstSql = 'CREATE TABLE owned_future_restart (id text PRIMARY KEY NOT NULL, value text);';
  const secondSql = 'ALTER TABLE owned_future_restart ADD extra text;';
  writeFileSync(path.join(isolated, `${first.tag}.sql`), firstSql);
  writeFileSync(path.join(isolated, `${second.tag}.sql`), secondSql);
  writeFileSync(
    path.join(isolated, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: [...journal.entries, first, second] })
  );
  return {
    isolated,
    first,
    second,
    firstHash: createHash('sha256').update(firstSql).digest('hex'),
    secondHash: createHash('sha256').update(secondSql).digest('hex'),
  };
}

it('restarts across exact applied future table and column migrations while pending later entries remain unapplied', () => {
  const db = createDb(':memory:');
  try {
    runMigrations(db);
    const { isolated, first, second } = futureMigrationFolder();
    // The later journal prefix is pending: restart must compare only recorded152.
    const initial = history(db),
      initialSchema = schema(db);
    bridgeLegacyDocMigrationHistory(db, isolated);
    expect(history(db)).toEqual(initial);
    expect(schema(db)).toEqual(initialSchema);
    // Apply the first real future migration while second remains pending.
    const fullJournal = readFileSync(path.join(isolated, 'meta/_journal.json'));
    writeFileSync(
      path.join(isolated, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries: [...journal.entries, first] })
    );
    migrate(db, { migrationsFolder: isolated });
    writeFileSync(path.join(isolated, 'meta/_journal.json'), fullJournal);
    db.$client
      .prepare('INSERT INTO owned_future_restart (id, value) VALUES (?, ?)')
      .run('retained', 'first');
    const firstHistory = history(db),
      firstSchema = schema(db);
    bridgeLegacyDocMigrationHistory(db, isolated);
    expect(history(db)).toEqual(firstHistory);
    expect(schema(db)).toEqual(firstSchema);
    migrate(db, { migrationsFolder: isolated });
    db.$client
      .prepare('UPDATE owned_future_restart SET extra=? WHERE id=?')
      .run('second', 'retained');
    const finalHistory = history(db),
      finalSchema = schema(db);
    for (let attempt = 0; attempt < 2; attempt++) {
      bridgeLegacyDocMigrationHistory(db, isolated);
      migrate(db, { migrationsFolder: isolated });
      expect(history(db)).toEqual(finalHistory);
      expect(schema(db)).toEqual(finalSchema);
      expect(db.$client.prepare('SELECT * FROM owned_future_restart').all()).toEqual([
        { id: 'retained', value: 'first', extra: 'second' },
      ]);
    }
    expect(finalHistory.slice(-2).map((row) => row.created_at)).toEqual([first.when, second.when]);
  } finally {
    db.$client.close();
  }
});

it.each(['gap', 'wrong-stamp', 'duplicate', 'unbacked-schema'] as const)(
  'refuses %s future schema history without writes',
  (invalid) => {
    const db = createDb(':memory:');
    try {
      runMigrations(db);
      const { isolated, firstHash, secondHash } = futureMigrationFolder();
      migrate(db, { migrationsFolder: isolated });
      if (invalid === 'gap')
        db.$client.prepare('DELETE FROM __drizzle_migrations WHERE hash=?').run(firstHash);
      else if (invalid === 'wrong-stamp')
        db.$client
          .prepare('UPDATE __drizzle_migrations SET created_at=created_at+1 WHERE hash=?')
          .run(secondHash);
      else if (invalid === 'duplicate')
        db.$client
          .prepare(
            'INSERT INTO __drizzle_migrations (hash, created_at) SELECT hash, created_at FROM __drizzle_migrations WHERE hash=?'
          )
          .run(secondHash);
      else db.$client.exec('ALTER TABLE owned_future_restart ADD forged text;');
      const before = history(db),
        beforeSchema = schema(db);
      expect(() => bridgeLegacyDocMigrationHistory(db, isolated)).toThrow(
        /legacy Doc migration history/i
      );
      expect(history(db)).toEqual(before);
      expect(schema(db)).toEqual(beforeSchema);
    } finally {
      db.$client.close();
    }
  }
);
