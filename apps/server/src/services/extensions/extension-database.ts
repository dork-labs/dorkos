/**
 * Per-extension SQLite connection management.
 *
 * Each extension owns a single `store.db` file, opened with the same house
 * pragmas as `@dorkos/db` (`createDb`) — WAL journaling, NORMAL sync, a 5s busy
 * timeout, and foreign-key enforcement. Unlike `@dorkos/db`, this layer bundles
 * no Drizzle schema: the schema is extension-owned and declared as manifest
 * migrations, so we open the raw `better-sqlite3` handle directly.
 *
 * `better-sqlite3` is a native addon already externalized in the CLI/desktop
 * bundlers; its import is confined to `apps/server` service code (never the
 * client / FSD layers), exactly like `@dorkos/db`.
 *
 * @module services/extensions/extension-database
 */
import Database from 'better-sqlite3';

/** Reserved meta table name (the `_dork_` prefix keeps it out of the author's namespace). */
const META_TABLE = '_dork_meta';

/** Meta-table key holding the highest applied migration version. */
const SCHEMA_VERSION_KEY = 'schema_version';

/** Default upper bound on simultaneously-cached extension connections. */
const DEFAULT_MAX_CONNECTIONS = 32;

/**
 * Open (or create) an extension's SQLite database with the DorkOS house pragmas.
 *
 * Mirrors `@dorkos/db`'s `createDb`: WAL journaling, `synchronous = NORMAL`, a
 * 5-second busy timeout, and foreign-key enforcement. The caller owns the
 * returned handle's lifecycle (close it, or hand it to {@link ExtensionDbCache}).
 *
 * @param dbPath - Absolute path to `store.db`, or `':memory:'` for tests
 */
export function openExtensionDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
}

/**
 * Create the reserved `_dork_meta` table if it does not already exist. Idempotent.
 *
 * @param db - An open extension database handle
 */
export function ensureMeta(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${META_TABLE} (
       key   TEXT PRIMARY KEY,
       value TEXT NOT NULL
     )`
  );
}

/** True if the reserved meta table exists in this database. */
function metaTableExists(db: Database.Database): boolean {
  const row = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(META_TABLE);
  return row !== undefined;
}

/**
 * Read the highest applied migration version from `_dork_meta`.
 *
 * Returns `0` when the meta table or the `schema_version` row is absent — i.e.
 * a database that has never been migrated is at version 0.
 *
 * @param db - An open extension database handle
 */
export function getSchemaVersion(db: Database.Database): number {
  if (!metaTableExists(db)) return 0;
  const row = db
    .prepare(`SELECT value FROM ${META_TABLE} WHERE key = ?`)
    .get(SCHEMA_VERSION_KEY) as { value: string } | undefined;
  if (!row) return 0;
  return Number.parseInt(row.value, 10);
}

/**
 * Write (upsert) the `schema_version` row in `_dork_meta`.
 *
 * Requires {@link ensureMeta} to have created the table first (the migrator
 * always does so within its transaction).
 *
 * @param db - An open extension database handle
 * @param version - The highest applied migration version to record
 */
export function setSchemaVersion(db: Database.Database, version: number): void {
  db.prepare(
    `INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(SCHEMA_VERSION_KEY, String(version));
}

/**
 * Measure the on-disk byte size of a database as `page_count * page_size`.
 *
 * This is the quota metric enforced on the write path — it reflects committed
 * pages including any WAL frames checkpointed into the main file.
 *
 * @param db - An open extension database handle
 */
export function measureBytes(db: Database.Database): number {
  const pageCount = db.pragma('page_count', { simple: true }) as number;
  const pageSize = db.pragma('page_size', { simple: true }) as number;
  return pageCount * pageSize;
}

/**
 * Bounded LRU cache of open extension connections, keyed by absolute `dbPath`.
 *
 * Opening a SQLite handle is cheap but non-zero, and a hot extension (e.g. a
 * CRM shape) queries repeatedly — so connections are reused. When the cache
 * exceeds its size bound the least-recently-used handle is evicted and closed.
 * `Map` insertion order is the recency order: a cache hit re-inserts the key to
 * move it to the most-recently-used end.
 */
export class ExtensionDbCache {
  private readonly cache = new Map<string, Database.Database>();
  private readonly maxSize: number;

  /**
   * Construct an empty cache.
   *
   * @param maxSize - Maximum simultaneously-open connections before eviction
   */
  constructor(maxSize: number = DEFAULT_MAX_CONNECTIONS) {
    this.maxSize = maxSize;
  }

  /**
   * Return the cached connection for `dbPath`, opening one if absent. The
   * returned handle is marked most-recently-used.
   *
   * @param dbPath - Absolute path to the extension's `store.db`
   */
  get(dbPath: string): Database.Database {
    const existing = this.cache.get(dbPath);
    if (existing) {
      // Re-insert to mark as most-recently-used (Map preserves insertion order).
      this.cache.delete(dbPath);
      this.cache.set(dbPath, existing);
      return existing;
    }
    const db = openExtensionDb(dbPath);
    this.cache.set(dbPath, db);
    this.evictIfNeeded();
    return db;
  }

  /** Number of currently-open cached connections. */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Close and forget the connection for `dbPath`, if cached.
   *
   * @param dbPath - Absolute path whose handle should be closed
   */
  close(dbPath: string): void {
    const db = this.cache.get(dbPath);
    if (db) {
      this.cache.delete(dbPath);
      db.close();
    }
  }

  /** Close every cached connection — call on server shutdown. */
  closeAll(): void {
    for (const db of this.cache.values()) {
      db.close();
    }
    this.cache.clear();
  }

  /** Evict and close least-recently-used handles until within the size bound. */
  private evictIfNeeded(): void {
    while (this.cache.size > this.maxSize) {
      const oldestKey = this.cache.keys().next().value as string;
      const oldest = this.cache.get(oldestKey);
      this.cache.delete(oldestKey);
      oldest?.close();
    }
  }
}

/** Process-wide default connection cache for hot extension query paths. */
export const extensionDbCache = new ExtensionDbCache();
