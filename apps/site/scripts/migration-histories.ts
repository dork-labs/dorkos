/**
 * The site's two Drizzle migration histories, and the one operation that is not
 * `drizzle-kit migrate`: recording a baseline as already applied.
 *
 * The site schema is split in two halves over ONE Neon database
 * (`src/db/public-schema.ts` and `src/db/control-plane-schema.ts`). Each half has
 * its own migration folder and its own journal table, declared in its own
 * drizzle config. Two things follow, and both are the whole reason this file
 * exists:
 *
 * 1. **The journal tables must be distinct.** Drizzle's default is
 *    `drizzle.__drizzle_migrations` for every config. Two configs sharing it
 *    would read each other's rows — and the frozen `drizzle/` history's 17 rows
 *    are already in that default table on the live database, so a second config
 *    landing there would compare against them and decide wrongly.
 *
 * 2. **Each half's `0000_baseline` may already be true.** The live database was
 *    built by the frozen `drizzle/` history and already has every one of these
 *    tables. Running either baseline against it would fail on the first
 *    `CREATE TABLE`. So on such a database the baseline is *recorded* rather than
 *    executed: {@link markBaselineApplied} writes the row `drizzle-kit migrate`
 *    would have written, and the migrate that follows then skips it.
 *
 * The row it writes is byte-for-byte the row the migrator writes — `hash` is the
 * SHA-256 of the migration file's exact bytes, `created_at` is the `when` from
 * the folder's `meta/_journal.json` — because the migrator's skip test is
 * `Number(lastDbMigration.created_at) < migration.folderMillis`. Writing the
 * baseline's own `folderMillis` skips the baseline and nothing after it.
 *
 * On a fresh database this does nothing at all: there is no journal and none of
 * the baseline's tables, so the baseline runs as an ordinary migration. Both
 * paths, and the half-built database that is neither, are proven against a real
 * database in
 * `src/db/__tests__/migration-histories.test.ts`.
 *
 * @module scripts/migration-histories
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';

/** Absolute path of `apps/site`, resolved from this file rather than `cwd`. */
const SITE_ROOT = fileURLToPath(new URL('../', import.meta.url));

/** One of the two migration histories the site's single database carries. */
export type MigrationHistory = {
  /** Stable id used in log lines and test names. */
  readonly id: 'public' | 'control-plane';
  /** Absolute path of the migration folder (the drizzle config's `out`). */
  readonly folder: string;
  /** Drizzle config file that owns this history, relative to `apps/site`. */
  readonly config: string;
  /** Journal table name — must differ per history; never the drizzle default. */
  readonly migrationsTable: string;
  /** Schema the journal table lives in. */
  readonly migrationsSchema: string;
};

/**
 * Both histories, in the order `db:migrate` applies them.
 *
 * Keep this in sync with `drizzle.public.config.ts` and
 * `drizzle.control-plane.config.ts`; `src/db/__tests__/migration-histories.test.ts`
 * fails if the two ever disagree.
 */
export const MIGRATION_HISTORIES: readonly MigrationHistory[] = [
  {
    id: 'public',
    folder: join(SITE_ROOT, 'drizzle-public'),
    config: 'drizzle.public.config.ts',
    migrationsTable: '__drizzle_migrations_public',
    migrationsSchema: 'drizzle',
  },
  {
    id: 'control-plane',
    folder: join(SITE_ROOT, 'drizzle-control-plane'),
    config: 'drizzle.control-plane.config.ts',
    migrationsTable: '__drizzle_migrations_control_plane',
    migrationsSchema: 'drizzle',
  },
];

/**
 * The frozen pre-split history. No config points at it any more and nothing
 * appends to it; it is kept as the record of how the live database was built,
 * and as the seed the split's own test migrates from.
 */
export const FROZEN_HISTORY = {
  folder: join(SITE_ROOT, 'drizzle'),
  migrationsTable: '__drizzle_migrations',
  migrationsSchema: 'drizzle',
} as const;

/** Shape of `meta/_journal.json` — only the fields this module reads. */
type Journal = { entries: { idx: number; when: number; tag: string }[] };

/** The `hash` and `created_at` the migrator would write for a migration file. */
export type JournalRow = { hash: string; createdAt: number; tag: string };

/**
 * Read the journal row the Drizzle migrator would write for `history`'s first
 * migration.
 *
 * @param history - The history whose baseline to describe.
 * @returns The baseline's tag, content hash and `created_at`.
 * @throws Error when the folder has no journal or no entries.
 */
export function readBaselineRow(history: MigrationHistory): JournalRow {
  const journalPath = join(history.folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal;
  const baseline = journal.entries.find((entry) => entry.idx === 0);
  if (!baseline) {
    throw new Error(`${history.id}: ${journalPath} has no entry at idx 0`);
  }
  // Exactly what drizzle-orm's readMigrationFiles hashes: the raw file bytes,
  // read as a string, before any statement splitting.
  const content = readFileSync(join(history.folder, `${baseline.tag}.sql`), 'utf8');
  return {
    tag: baseline.tag,
    hash: createHash('sha256').update(content).digest('hex'),
    createdAt: baseline.when,
  };
}

/**
 * Every table `history`'s baseline creates, read out of the baseline SQL itself.
 *
 * Derived rather than hand-listed on purpose: a hand-list is a second source of
 * truth that goes stale the first time a baseline is regenerated, and the whole
 * safety argument below rests on this set being complete.
 *
 * @param history - The history whose baseline to read.
 * @returns The table names, sorted.
 * @throws Error when the baseline creates no tables, which would make the
 *   "already true of this database" check vacuous.
 */
export function readBaselineTables(history: MigrationHistory): string[] {
  const { tag } = readBaselineRow(history);
  const sqlText = readFileSync(join(history.folder, `${tag}.sql`), 'utf8');
  const tables = [...sqlText.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? "([^"]+)"/g)].map(
    (match) => match[1]
  );
  if (tables.length === 0) {
    throw new Error(`${history.id}: ${tag}.sql creates no tables, so it cannot be baselined`);
  }
  return [...new Set(tables)].sort();
}

/**
 * The minimum a database handle must offer here. Both the Neon driver used in
 * production and the PGlite instance used in tests satisfy it.
 */
export type SqlExecutor = { execute(query: ReturnType<typeof sql>): Promise<unknown> };

/** What {@link markBaselineApplied} decided to do, for logging and assertions. */
export type BaselineOutcome =
  /** The journal already has rows — this history has run here before. */
  | 'already-tracked'
  /** No journal rows and none of the baseline's tables: let the baseline run. */
  | 'fresh-database'
  /** Every baseline table is there: the row was written, the SQL not executed. */
  | 'marked-applied';

/** Normalize the several row-container shapes drizzle drivers return. */
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const { rows } = result as { rows: unknown };
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}

/**
 * A pair of signed 32-bit advisory-lock keys derived from a name, so two
 * concurrent builds serialize on the same history instead of racing
 * check-then-insert.
 *
 * Two int4s rather than one int8 because this file compiles at an ES2017 target
 * where BigInt literals are unavailable, and `pg_advisory_lock(int4, int4)` is
 * the same lock space either way.
 */
function advisoryLockKeys(name: string): [number, number] {
  const digest = createHash('sha256').update(name).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

/**
 * Record `history`'s baseline as applied when — and only when — the database
 * already has ALL of its tables but no journal for it.
 *
 * Three outcomes, and the reason the check is all-or-nothing:
 *
 * - journal has rows → `already-tracked`, nothing written.
 * - none of the baseline's tables present → `fresh-database`, nothing written,
 *   and `drizzle-kit migrate` runs the baseline normally.
 * - every one of the baseline's tables present → `marked-applied`.
 *
 * A **partial** match throws. Marking a baseline applied tells the migrator to
 * skip 22 `CREATE TABLE`s; if only some of those tables exist, skipping creates
 * none of the missing ones, the build exits 0, and the gap is discovered later
 * by a query that fails in production. There is no safe guess between "already
 * done" and "not started", so this refuses rather than choosing.
 *
 * Idempotent and safe to run concurrently: the check and the insert are taken
 * under a transaction-scoped advisory lock keyed on the journal table, so two
 * builds racing the same database serialize and the second sees the first's row.
 *
 * @param db - A database handle able to execute raw SQL.
 * @param history - The history to consider.
 * @returns Which of the three cases applied.
 * @throws Error when only some of the baseline's tables exist.
 */
export async function markBaselineApplied(
  db: SqlExecutor,
  history: MigrationHistory
): Promise<BaselineOutcome> {
  const schemaId = sql.identifier(history.migrationsSchema);
  const tableId = sql.identifier(history.migrationsTable);
  const qualified = `${history.migrationsSchema}.${history.migrationsTable}`;

  // Create the journal exactly as the migrator does, so the migrate that follows
  // finds the table it expects whichever of us got here first.
  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS ${schemaId}`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ${schemaId}.${tableId} (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);

  const expected = readBaselineTables(history);

  // Session-scoped, because the drivers here do not guarantee one connection for
  // one statement outside an explicit transaction; released in `finally`.
  const [lockA, lockB] = advisoryLockKeys(qualified);
  await db.execute(sql`SELECT pg_advisory_lock(${lockA}, ${lockB})`);
  try {
    // Ask whether the journal has ROWS, not whether the table exists. We may have
    // just created it, and an empty journal from an interrupted earlier run must
    // still be fillable.
    const tracked = rowsOf(await db.execute(sql`SELECT 1 FROM ${schemaId}.${tableId} LIMIT 1`));
    if (tracked.length > 0) return 'already-tracked';

    // Catalog lookup rather than `to_regclass('public.user')`: one of these
    // tables is named `user`, a reserved word, which the regclass cast parses as
    // the keyword and rejects.
    const present = rowsOf(
      await db.execute(sql`
        SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
          AND c.relname IN (${sql.join(
            expected.map((name) => sql`${name}`),
            sql`, `
          )})
      `)
    ).map((row) => String(row.relname));

    if (present.length === 0) return 'fresh-database';
    if (present.length !== expected.length) {
      const missing = expected.filter((name) => !present.includes(name));
      throw new Error(
        `${history.id}: refusing to baseline a half-built database. ` +
          `${present.length} of ${expected.length} tables from this history's baseline exist, ` +
          `but these do not: ${missing.join(', ')}. Marking the baseline applied would skip ` +
          `creating them silently. Investigate the database before running this again.`
      );
    }

    const baseline = readBaselineRow(history);
    // Conditional insert, not a plain VALUES: the advisory lock orders writers on
    // separate connections, but two calls sharing ONE connection (the lock is
    // re-entrant within a session) would both pass the check above. `WHERE NOT
    // EXISTS` makes the journal's emptiness part of the write itself, and
    // RETURNING says which call actually wrote.
    const inserted = rowsOf(
      await db.execute(sql`
        INSERT INTO ${schemaId}.${tableId} ("hash", "created_at")
        SELECT ${baseline.hash}, ${baseline.createdAt}
        WHERE NOT EXISTS (SELECT 1 FROM ${schemaId}.${tableId})
        RETURNING id
      `)
    );
    return inserted.length > 0 ? 'marked-applied' : 'already-tracked';
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(${lockA}, ${lockB})`);
  }
}
