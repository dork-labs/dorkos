import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import {
  createDb,
  databaseHoldsUserData,
  DatabaseOpenError,
  pruneSnapshots,
  readMigrationState,
  runMigrations,
  snapshotBeforeExtensionMigration,
  snapshotBeforeMigrations,
  snapshotDaily,
  snapshotSqlite,
  SnapshotFailedError,
  SNAPSHOT_RETENTION,
} from '../index';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = path.join(__dirname, '../../drizzle');

/** Every tag in the shipped journal, in the order the migrator applies them. */
const JOURNAL_TAGS = (
  JSON.parse(readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf-8')) as {
    entries: { idx: number; tag: string }[];
  }
).entries.map((entry) => entry.tag);

/**
 * Journal index a partially-migrated fixture is built through. Any index short
 * of the last one works; this one is old enough that several migrations are
 * still pending after it.
 */
const PARTIAL_MIGRATION_IDX = 60;

/** Temp directories to remove after each test. */
const tempDirs: string[] = [];

/** A throwaway directory, cleaned up after the test. */
function tempDir(prefix = 'dorkos-backup-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Build a migrations folder holding only migrations up to and including `idx`,
 * so a test can stand a database up at an older schema version. Mirrors the
 * helper in `migrations.test.ts`.
 */
function migrationsFolderThrough(idx: number): string {
  const dir = tempDir('dorkos-drizzle-');
  mkdirSync(path.join(dir, 'meta'));

  const journal = JSON.parse(
    readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf-8')
  ) as { entries: { idx: number; tag: string }[] };
  journal.entries = journal.entries.filter((e) => e.idx <= idx);
  writeFileSync(path.join(dir, 'meta/_journal.json'), JSON.stringify(journal));

  for (const entry of journal.entries) {
    copyFileSync(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), path.join(dir, `${entry.tag}.sql`));
  }
  return dir;
}

describe('readMigrationState', () => {
  it('calls a never-migrated database fresh, with the whole journal pending', () => {
    const db = createDb(':memory:');

    const state = readMigrationState(db);

    expect(state.fresh).toBe(true);
    expect(state.pending).toEqual(JOURNAL_TAGS);
  });

  it('reports nothing pending once every migration has been applied', () => {
    const db = createDb(':memory:');
    runMigrations(db);

    expect(readMigrationState(db)).toEqual({ pending: [], fresh: false });
  });

  it('reports exactly the migrations a partially-migrated database still owes', () => {
    const db = createDb(':memory:');
    migrate(db, { migrationsFolder: migrationsFolderThrough(PARTIAL_MIGRATION_IDX) });

    const state = readMigrationState(db);

    expect(state.fresh).toBe(false);
    // Same boundary Drizzle itself uses: everything stamped after the newest
    // applied entry, in journal order.
    expect(state.pending).toEqual(JOURNAL_TAGS.slice(PARTIAL_MIGRATION_IDX + 1));
    expect(state.pending.length).toBeGreaterThan(0);
  });

  it('treats an empty migrations ledger as a first boot, the way Drizzle does', () => {
    // Reachable: Drizzle creates `__drizzle_migrations` OUTSIDE its migration
    // transaction, so a first run that rolls back leaves the ledger behind,
    // present and empty. Drizzle reads no row and applies everything; if this
    // were read as "has migrated" the state would be wrong in the direction that
    // skips a snapshot.
    const db = createDb(':memory:');
    db.$client.exec(
      'CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)'
    );

    expect(readMigrationState(db)).toEqual({ pending: JOURNAL_TAGS, fresh: true });
  });

  it('treats a NULL created_at as nothing applied, the way Drizzle does', () => {
    // Drizzle compares `Number(lastDbMigration[2]) < folderMillis`, and
    // `Number(null)` is 0, so a NULL-stamped row means every migration applies.
    const db = createDb(':memory:');
    db.$client.exec(
      'CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)'
    );
    db.$client
      .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, NULL)')
      .run('whatever');

    expect(readMigrationState(db).pending).toEqual(JOURNAL_TAGS);
  });

  it('calls a database with tables in it not fresh, whatever the ledger says', () => {
    // `fresh` is measured, not inferred: a database holding a year of rooms with
    // an empty ledger must still be snapshotted before anything migrates it.
    const db = createDb(':memory:');
    runMigrations(db);
    db.$client.exec('DELETE FROM __drizzle_migrations');

    const state = readMigrationState(db);

    expect(state.fresh).toBe(false);
    expect(state.pending).toEqual(JOURNAL_TAGS);
    expect(databaseHoldsUserData(db)).toBe(true);
  });
});

describe('snapshotBeforeMigrations', () => {
  it('writes a snapshot named for the first pending migration', () => {
    const home = tempDir();
    const db = createDb(path.join(home, 'dork.db'));
    migrate(db, { migrationsFolder: migrationsFolderThrough(PARTIAL_MIGRATION_IDX) });
    const backups = path.join(home, 'backups');

    const written = snapshotBeforeMigrations(db, {
      dir: backups,
      now: new Date('2026-08-15T09:07:03Z'),
    });

    expect(written).toBe(
      path.join(backups, `dork-20260815-090703-pre-${JOURNAL_TAGS[PARTIAL_MIGRATION_IDX + 1]}.db`)
    );
    expect(existsSync(written!)).toBe(true);
  });

  it('captures the schema as it was before the migrations ran', () => {
    const home = tempDir();
    const dbPath = path.join(home, 'dork.db');
    const db = createDb(dbPath);
    migrate(db, { migrationsFolder: migrationsFolderThrough(PARTIAL_MIGRATION_IDX) });
    const backups = path.join(home, 'backups');

    const written = snapshotBeforeMigrations(db, { dir: backups })!;
    runMigrations(db);

    // The live database has the tables the pending migrations added...
    const live = db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'room_session_retirements'"
      )
      .get();
    expect(live).toBeDefined();

    // ...and the snapshot, opened on its own, has the schema from before them.
    const snapshot = new Database(written);
    try {
      expect(
        snapshot
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'room_session_retirements'"
          )
          .get()
      ).toBeUndefined();
    } finally {
      snapshot.close();
    }
  });

  it('captures rows that live only in the WAL, which a file copy loses', () => {
    // This is the whole reason snapshots go through VACUUM INTO. In WAL mode a
    // committed row can sit in `dork.db-wal` with nothing of it in `dork.db`, so
    // a copy of the main file is a silently incomplete backup.
    const home = tempDir();
    const dbPath = path.join(home, 'dork.db');
    const db = createDb(dbPath);
    runMigrations(db);
    // Start from a checkpointed base so the row below is unambiguously WAL-only.
    db.$client.pragma('wal_checkpoint(TRUNCATE)');
    db.$client
      .prepare(
        "INSERT INTO rooms (id, kind, slug, title, topic, workspace_id, archived, created_at, last_activity_at) VALUES ('01WALROOM', 'channel', 'backend', '#backend', NULL, NULL, 0, '2026-08-15T10:00:00Z', '2026-08-15T10:00:00Z')"
      )
      .run();

    const naiveCopy = path.join(home, 'naive-copy.db');
    copyFileSync(dbPath, naiveCopy);
    const snapshot = snapshotBeforeExtensionMigration(db.$client, {
      dbPath: path.join(home, 'store.db'),
      toVersion: 1,
    });

    const copied = new Database(naiveCopy);
    const vacuumed = new Database(snapshot);
    try {
      // The naive copy is missing the row entirely — the failure mode this
      // module exists to avoid.
      expect(copied.prepare("SELECT id FROM rooms WHERE id = '01WALROOM'").get()).toBeUndefined();
      expect(vacuumed.prepare("SELECT id FROM rooms WHERE id = '01WALROOM'").get()).toEqual({
        id: '01WALROOM',
      });
    } finally {
      copied.close();
      vacuumed.close();
    }
  });

  it('writes nothing for a fresh database, which has nothing to lose yet', () => {
    const home = tempDir();
    const db = createDb(path.join(home, 'dork.db'));
    const backups = path.join(home, 'backups');

    expect(snapshotBeforeMigrations(db, { dir: backups })).toBeNull();
    // Not even the directory. Whether the PRODUCT leaves a first boot with no
    // backups folder is a separate question this cannot answer, because the
    // daily snapshot is a different call: `index.ts` is what has to skip it, and
    // it does, keyed on `databaseHoldsUserData` read before migrations run.
    expect(existsSync(backups)).toBe(false);
  });

  it('writes nothing when the database is already up to date', () => {
    const home = tempDir();
    const db = createDb(path.join(home, 'dork.db'));
    runMigrations(db);
    const backups = path.join(home, 'backups');

    expect(snapshotBeforeMigrations(db, { dir: backups })).toBeNull();
    expect(existsSync(backups)).toBe(false);
  });

  it('accepts the snapshot a crash-looping restart already took in the same second', () => {
    // The pre-migration snapshot is fatal on failure, so a name collision must
    // never become a server that will not start. Two boots inside one second
    // capture the same state; the second one reuses it.
    const home = tempDir();
    const db = createDb(path.join(home, 'dork.db'));
    migrate(db, { migrationsFolder: migrationsFolderThrough(PARTIAL_MIGRATION_IDX) });
    const backups = path.join(home, 'backups');
    const now = new Date('2026-08-15T09:07:03Z');

    const first = snapshotBeforeMigrations(db, { dir: backups, now });
    const second = snapshotBeforeMigrations(db, { dir: backups, now });

    expect(second).toBe(first);
    expect(readdirSync(backups)).toHaveLength(1);
  });

  it('rejects a zero-byte decoy at its destination and takes a real snapshot', () => {
    // THE FAILURE THIS EXISTS FOR. An interrupted `VACUUM INTO` leaves a
    // zero-byte file, and a zero-byte file is a VALID EMPTY SQLite database: it
    // opens and `integrity_check` says ok. Trusting it by existence alone means
    // boot 2 logs "snapshot taken" and migrates with no snapshot at all.
    const home = tempDir();
    const db = createDb(path.join(home, 'dork.db'));
    migrate(db, { migrationsFolder: migrationsFolderThrough(PARTIAL_MIGRATION_IDX) });
    const backups = path.join(home, 'backups');
    const now = new Date('2026-08-15T09:07:03Z');
    const dest = path.join(
      backups,
      `dork-20260815-090703-pre-${JOURNAL_TAGS[PARTIAL_MIGRATION_IDX + 1]}.db`
    );
    mkdirSync(backups, { recursive: true });
    writeFileSync(dest, '');

    // The decoy really does pass the naive checks, or this proves nothing.
    expect(existsSync(dest)).toBe(true);
    const decoy = new Database(dest);
    expect(decoy.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    decoy.close();

    const written = snapshotBeforeMigrations(db, { dir: backups, now });

    expect(written).toBe(dest);
    expect(statSync(dest).size).toBeGreaterThan(0);
    const snapshot = new Database(dest, { readonly: true });
    try {
      expect(
        snapshot.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rooms'").get()
      ).toBeDefined();
    } finally {
      snapshot.close();
    }
  });

  it('leaves nothing behind when the snapshot write fails', () => {
    // A failed VACUUM INTO must not leave a partial file, or the next boot
    // inherits exactly the decoy the test above has to defend against.
    const home = tempDir();
    const db = createDb(path.join(home, 'dork.db'));
    runMigrations(db);
    const locked = path.join(home, 'locked');
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o500);

    try {
      const target = path.join(locked, 'snap.db');

      expect(() => snapshotSqlite(db.$client, target)).toThrow();

      expect(existsSync(target)).toBe(false);
      expect(readdirSync(locked)).toEqual([]);
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it('throws rather than letting a migration run unprotected', () => {
    const home = tempDir();
    const db = createDb(path.join(home, 'dork.db'));
    migrate(db, { migrationsFolder: migrationsFolderThrough(PARTIAL_MIGRATION_IDX) });
    // A file where the backups directory should be: the snapshot cannot be
    // written, and the caller must find that out.
    const blocked = path.join(home, 'backups');
    writeFileSync(blocked, 'not a directory');

    let thrown: unknown;
    try {
      snapshotBeforeMigrations(db, { dir: blocked });
    } catch (err) {
      thrown = err;
    }

    // Typed, and addressed to the operator: this stops a boot, so the message is
    // the only thing standing between them and a server that will not start for
    // reasons it never explained.
    expect(thrown).toBeInstanceOf(SnapshotFailedError);
    const error = thrown as SnapshotFailedError;
    expect(error.backupsDir).toBe(blocked);
    expect(error.message).toContain(blocked);
    expect(error.message).toMatch(/Nothing was changed and your data has not been touched/);
    expect(error.message).toMatch(/Free up disk space/);
  });

  it('keeps only the ten newest pre-migration snapshots', () => {
    const home = tempDir();
    const db = createDb(path.join(home, 'dork.db'));
    migrate(db, { migrationsFolder: migrationsFolderThrough(PARTIAL_MIGRATION_IDX) });
    const backups = path.join(home, 'backups');

    const written: string[] = [];
    for (let day = 1; day <= 13; day++) {
      written.push(
        path.basename(
          snapshotBeforeMigrations(db, {
            dir: backups,
            now: new Date(`2026-08-${String(day).padStart(2, '0')}T00:00:00Z`),
          })!
        )
      );
    }

    expect(readdirSync(backups).sort()).toEqual(written.slice(-SNAPSHOT_RETENTION.preMigration));
  });
});

describe('snapshotDaily', () => {
  it('writes one snapshot per UTC day, however often it is called', () => {
    const home = tempDir();
    const db = createDb(path.join(home, 'dork.db'));
    runMigrations(db);
    const backups = path.join(home, 'backups');

    const first = snapshotDaily(db, { dir: backups, now: new Date('2026-08-15T00:00:01Z') });
    const again = snapshotDaily(db, { dir: backups, now: new Date('2026-08-15T23:59:59Z') });
    const nextDay = snapshotDaily(db, { dir: backups, now: new Date('2026-08-16T04:00:00Z') });

    expect(path.basename(first!)).toBe('dork-20260815-daily.db');
    expect(again).toBeNull();
    expect(path.basename(nextDay!)).toBe('dork-20260816-daily.db');
    expect(readdirSync(backups).sort()).toEqual([
      'dork-20260815-daily.db',
      'dork-20260816-daily.db',
    ]);
  });

  it('keeps a week of days and drops the oldest', () => {
    const home = tempDir();
    const db = createDb(path.join(home, 'dork.db'));
    runMigrations(db);
    const backups = path.join(home, 'backups');

    for (let day = 1; day <= 10; day++) {
      snapshotDaily(db, {
        dir: backups,
        now: new Date(`2026-08-${String(day).padStart(2, '0')}T12:00:00Z`),
      });
    }

    expect(readdirSync(backups).sort()).toEqual([
      'dork-20260804-daily.db',
      'dork-20260805-daily.db',
      'dork-20260806-daily.db',
      'dork-20260807-daily.db',
      'dork-20260808-daily.db',
      'dork-20260809-daily.db',
      'dork-20260810-daily.db',
    ]);
    expect(readdirSync(backups)).toHaveLength(SNAPSHOT_RETENTION.daily);
  });

  it('retakes a day whose snapshot is a zero-byte decoy', () => {
    // Without this, one disk-full failure marks the UTC day permanently
    // "covered" by an empty file — silently, and while holding one of the seven
    // slots a real snapshot would otherwise occupy.
    const home = tempDir();
    const db = createDb(path.join(home, 'dork.db'));
    runMigrations(db);
    const backups = path.join(home, 'backups');
    const now = new Date('2026-08-15T12:00:00Z');
    const dest = path.join(backups, 'dork-20260815-daily.db');
    mkdirSync(backups, { recursive: true });
    writeFileSync(dest, '');

    const written = snapshotDaily(db, { dir: backups, now });

    expect(written).toBe(dest);
    expect(statSync(dest).size).toBeGreaterThan(0);
    // And a real one on the same day is still left alone.
    expect(snapshotDaily(db, { dir: backups, now })).toBeNull();
  });

  it('opens on its own, holding what the database held', () => {
    const home = tempDir();
    const db = createDb(path.join(home, 'dork.db'));
    runMigrations(db);
    db.$client
      .prepare(
        "INSERT INTO rooms (id, kind, slug, title, topic, workspace_id, archived, created_at, last_activity_at) VALUES ('01DAILY', 'channel', 'general', '#general', NULL, NULL, 0, '2026-08-15T10:00:00Z', '2026-08-15T10:00:00Z')"
      )
      .run();

    const written = snapshotDaily(db, { dir: path.join(home, 'backups') })!;

    const snapshot = new Database(written);
    try {
      expect(snapshot.prepare('SELECT id, slug FROM rooms').all()).toEqual([
        { id: '01DAILY', slug: 'general' },
      ]);
      expect(snapshot.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    } finally {
      snapshot.close();
    }
  });
});

describe('pruneSnapshots', () => {
  /** Write a real (tiny but valid) snapshot file at `dir/name`. */
  function plantSnapshot(dir: string, name: string): void {
    const source = new Database(':memory:');
    source.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    mkdirSync(dir, { recursive: true });
    snapshotSqlite(source, path.join(dir, name));
    source.close();
  }

  it('deletes only files matching its own pattern', () => {
    const dir = tempDir();
    for (const name of [
      'dork-20260801-daily.db',
      'dork-20260802-daily.db',
      'dork-20260803-daily.db',
      'dork-20260801-120000-pre-0001_thing.db',
    ]) {
      plantSnapshot(dir, name);
    }
    writeFileSync(path.join(dir, 'notes.txt'), 'x');

    const deleted = pruneSnapshots(dir, /^dork-\d{8}-daily\.db$/, 1);

    expect(deleted).toEqual(['dork-20260801-daily.db', 'dork-20260802-daily.db']);
    expect(readdirSync(dir).sort()).toEqual(
      ['dork-20260803-daily.db', 'dork-20260801-120000-pre-0001_thing.db', 'notes.txt'].sort()
    );
  });

  it('sweeps wreckage first, so a decoy never costs a real snapshot its slot', () => {
    // A process killed mid-VACUUM leaves a zero-byte file under a name nothing
    // will ever write again. Counting it toward `keep` would quietly shrink how
    // far back the operator can reach, for as long as it took to age out.
    const dir = tempDir();
    plantSnapshot(dir, 'dork-20260801-daily.db');
    plantSnapshot(dir, 'dork-20260802-daily.db');
    writeFileSync(path.join(dir, 'dork-20260731-daily.db'), '');

    const deleted = pruneSnapshots(dir, /^dork-\d{8}-daily\.db$/, 2);

    // The decoy goes even though the pool is only at its limit once it is gone.
    expect(deleted).toEqual(['dork-20260731-daily.db']);
    expect(readdirSync(dir).sort()).toEqual(['dork-20260801-daily.db', 'dork-20260802-daily.db']);
  });

  it('is a no-op on a directory that does not exist', () => {
    expect(pruneSnapshots(path.join(tempDir(), 'nope'), /.*/, 0)).toEqual([]);
  });
});

describe('snapshotSqlite', () => {
  it('refuses to overwrite an existing snapshot', () => {
    const home = tempDir();
    const db = createDb(path.join(home, 'dork.db'));
    runMigrations(db);
    const dest = path.join(home, 'backups', 'snap.db');

    snapshotSqlite(db.$client, dest);
    const sizeBefore = statSync(dest).size;

    expect(() => snapshotSqlite(db.$client, dest)).toThrow(/already exists/i);

    // And the refusal leaves the snapshot it refused to overwrite ALONE. The
    // failure cleanup only removes a file this call created — tidying up after a
    // write that never started would destroy a good backup.
    expect(statSync(dest).size).toBe(sizeBefore);
    const survivor = new Database(dest, { readonly: true });
    try {
      expect(survivor.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    } finally {
      survivor.close();
    }
  });
});

describe('snapshotBeforeExtensionMigration', () => {
  it('writes beside the store, named for the version about to be applied', () => {
    const home = tempDir();
    const dbPath = path.join(home, 'extension-data', 'crm-lite', 'store.db');
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const store = new Database(dbPath);
    store.exec('CREATE TABLE contacts (id TEXT PRIMARY KEY)');
    store.prepare("INSERT INTO contacts (id) VALUES ('c1')").run();

    const written = snapshotBeforeExtensionMigration(store, {
      dbPath,
      toVersion: 3,
      now: new Date('2026-08-15T09:07:03Z'),
    });
    store.close();

    expect(written).toBe(
      path.join(path.dirname(dbPath), 'backups', 'store-20260815-090703-pre-v3.db')
    );
    const snapshot = new Database(written);
    try {
      expect(snapshot.prepare('SELECT id FROM contacts').all()).toEqual([{ id: 'c1' }]);
    } finally {
      snapshot.close();
    }
  });

  it('keeps only the five newest', () => {
    const home = tempDir();
    const dbPath = path.join(home, 'store.db');
    const store = new Database(dbPath);
    store.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');

    for (let minute = 1; minute <= 8; minute++) {
      snapshotBeforeExtensionMigration(store, {
        dbPath,
        toVersion: minute,
        now: new Date(`2026-08-15T09:${String(minute).padStart(2, '0')}:00Z`),
      });
    }
    store.close();

    const kept = readdirSync(path.join(home, 'backups')).sort();
    expect(kept).toHaveLength(SNAPSHOT_RETENTION.extension);
    expect(kept[0]).toBe('store-20260815-090400-pre-v4.db');
    expect(kept[4]).toBe('store-20260815-090800-pre-v8.db');
  });
});

describe('a database that will not open', () => {
  it('fails loudly and leaves the file exactly as it found it', () => {
    // The rule this pins (ADR 260815-*): DorkOS never backs a broken database up
    // and recreates it, because the common causes — an unmounted volume, a
    // half-finished copy, the wrong path — are all recoverable until something
    // "helpfully" starts fresh over the top.
    const home = tempDir();
    const dbPath = path.join(home, 'dork.db');
    writeFileSync(dbPath, 'this is not a sqlite database');
    const before = readFileSync(dbPath);
    const sizeBefore = statSync(dbPath).size;

    let thrown: unknown;
    try {
      createDb(dbPath);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(DatabaseOpenError);
    const error = thrown as DatabaseOpenError;
    expect(error.dbPath).toBe(dbPath);
    // The message has to be actionable: it names the file and says outright that
    // nothing was touched, because the operator's next move depends on it.
    expect(error.message).toContain(dbPath);
    expect(error.message).toMatch(/never recreates, renames or repairs/);

    // Nothing was written, renamed, journalled or backed up.
    expect(readFileSync(dbPath).equals(before)).toBe(true);
    expect(statSync(dbPath).size).toBe(sizeBefore);
    expect(readdirSync(home)).toEqual(['dork.db']);
  });

  it('still creates a database when the path simply does not exist yet', () => {
    // The counterpart: refusing to recreate a BROKEN file must not stop a first
    // boot from making its first database.
    const home = tempDir();
    const dbPath = path.join(home, 'dork.db');

    const db = createDb(dbPath);
    runMigrations(db);

    expect(existsSync(dbPath)).toBe(true);
    expect(readMigrationState(db)).toEqual({ pending: [], fresh: false });
  });
});
