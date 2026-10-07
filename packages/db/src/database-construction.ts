/** Private new-engine construction. No existing Db/engine/callback may be supplied. */
import type Database from 'better-sqlite3';
import { openProtectedRoomDatabase } from './room-spend-witness.js';

/** Report a failed database open with its original cause and operator-facing path. */
export class DatabaseOpenError extends Error {
  /** Absolute path of the database that could not be opened. */
  readonly dbPath: string;

  /**
   * Build the operator-facing message: what failed, and what DorkOS did not do
   * about it.
   *
   * @param dbPath - Path that failed to open
   * @param cause - The underlying SQLite or filesystem error
   */
  constructor(dbPath: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Could not open the DorkOS database at ${dbPath}: ${detail}\n` +
        'Your data has not been touched — DorkOS never recreates, renames or repairs a ' +
        'database it cannot open. Restore the newest snapshot from the "backups" folder ' +
        'beside it, or move the file aside yourself if you accept losing what it holds, ' +
        'then start DorkOS again.',
      { cause }
    );
    this.name = 'DatabaseOpenError';
    this.dbPath = dbPath;
  }
}

/** Open the protected native database and construct its original Drizzle handle. */
export function constructDatabase(dbPath: string) {
  let sqlite: Database.Database;
  let opened: ReturnType<typeof openProtectedRoomDatabase>;
  try {
    opened = openProtectedRoomDatabase(dbPath);
    sqlite = opened.sqlite;
  } catch (err) {
    throw new DatabaseOpenError(dbPath, err);
  }

  try {
    const db = configureAndWrap(sqlite, opened.wrap);
    return Object.freeze({
      db,
      roomDocStorage: opened.roomDocStorage,
      nativeOrigin: opened.nativeOrigin,
      serverNativeRoomConstruction: opened.serverNativeRoomConstruction,
      serverNativeRelayConstruction: opened.serverNativeRelayConstruction,
    });
  } catch (err) {
    // better-sqlite3 opens lazily, so a file that is not a database gets past
    // the constructor and fails on the first pragma instead. Close the handle we
    // opened; leave the file alone.
    sqlite.close();
    throw new DatabaseOpenError(dbPath, err);
  }
}

function configureAndWrap(
  sqlite: Database.Database,
  wrap: ReturnType<typeof openProtectedRoomDatabase>['wrap']
) {
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = ON');
  // WITHOUT THIS, `INSERT OR REPLACE` SILENTLY CORRUPTS THE MESSAGE-SEARCH INDEX.
  //
  // SQLite fires a table's DELETE triggers for rows that REPLACE conflict
  // resolution removes ONLY when recursive_triggers is on. It defaults to OFF,
  // and OFF was measured here (`PRAGMA recursive_triggers` returned 0 before
  // this line existed). So a REPLACE onto `messages` dropped the old row
  // without ever running `messages_fts_ad`, leaving the FTS5 index holding
  // terms for text that no longer exists anywhere.
  //
  // What made it worth a pragma rather than a rule is that NOTHING REPORTS IT.
  // Measured on the migrated database, after one REPLACE: `MATCH 'dog'` returns
  // a hit for the deleted text, `bm25()` scores it without complaint, and BOTH
  // integrity checks — `PRAGMA integrity_check` and FTS5's own
  // `INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')` — report
  // `ok`. Only `snippet()` fails, with `database disk image is malformed`. A
  // convention would have to be obeyed by every future writer to hold; this
  // holds by itself.
  //
  // Safe to turn on for THIS database, and the reason is structural rather than
  // a headcount. The three triggers in migration 0037 are the only ones in the
  // migration history, and the operator's production database carries none at
  // all — but "there are no other triggers" is not the argument, because
  // extensions may declare their own: a manifest migration is the one place
  // third-party `CREATE TRIGGER` is allowed
  // (`packages/extension-api/src/manifest-schema.ts`). Those live in a separate
  // `store.db` on a separate connection opened by `openExtensionDb`, which
  // deliberately does NOT set this pragma and says so. So no trigger this
  // pragma can reach is one DorkOS did not write.
  //
  // The rest follows: none of the three writes to a table carrying triggers, so
  // none can recurse, and SQLite defines foreign key actions as unaffected by
  // this pragma.
  //
  // It is per-connection, so it protects connections opened through here and no
  // others. Anything writing `messages` must come through `createDb`.
  sqlite.pragma('recursive_triggers = ON');
  // Deleted content is overwritten with zeros, not left in the file for a later write to cover.
  //
  // A Community message that was deleted, removed by a moderator or a host, or erased with its
  // author has to leave this machine's copy too (specs/community-member-erasure task 2.1), and a
  // row update or delete alone only unlinks the old bytes. Replacing them at that moment is not
  // enough either: SQLite also leaves old bytes behind whenever it reorganizes a page — a leaf
  // split into an interior page keeps its former cells in the unused area — and that happens on
  // ordinary writes long before anyone asks for a deletion. Only a connection that zeroes as it
  // goes never leaves such remnants, so it is on for every write rather than for the sync.
  // It costs extra writes only where pages are freed, which on this mostly-append database is
  // rare; it is the default on several platforms' own SQLite builds.
  sqlite.pragma('secure_delete = ON');
  return wrap();
}
