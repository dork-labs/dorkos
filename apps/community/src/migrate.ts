import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

/** Every migration, in order. Versions are contiguous from 1; a test keeps them so. */
export const COMMUNITY_MIGRATIONS = [
  [1, '0001_foundation.sql'],
  [2, '0002_admission.sql'],
  [3, '0003_files.sql'],
  [4, '0004_cleanup_backoff.sql'],
  [5, '0005_tenant_expand.sql'],
  [6, '0006_tenant_backfill.sql'],
  [7, '0007_tenant_relations.sql'],
  [8, '0008_tenant_contract.sql'],
  [9, '0009_backout_fence.sql'],
  [10, '0010_administration.sql'],
  [11, '0011_membership_protocol.sql'],
  [12, '0012_host_keys_and_limits.sql'],
  [13, '0013_member_erasure.sql'],
  [14, '0014_host_hold.sql'],
  [15, '0015_short_names.sql'],
  [16, '0016_entry_removal.sql'],
  [17, '0017_export_jobs.sql'],
  [18, '0018_host_legal_hold.sql'],
] as const;

/**
 * Refuse to run when a listed migration below the newest applied one was never applied. That
 * happens when two branches took the same number and one was renumbered after a database had
 * already applied the other: running the older file out of order would apply schema changes
 * in an order nobody tested, so stop and say which versions are missing.
 */
export function assertNoMigrationGap(applied: ReadonlySet<number>): void {
  const newest = Math.max(0, ...applied);
  const missing = COMMUNITY_MIGRATIONS.map(([version]) => version).filter(
    (version) => version < newest && !applied.has(version)
  );
  if (missing.length)
    throw new Error(
      `Community migrations ${missing.join(', ')} were never applied, but ${newest} was. Restore a backup taken before ${newest} or apply them by hand; they will not run out of order.`
    );
}

/** Apply versioned community SQL migrations in a single database transaction. */
export async function migrate(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(77281502)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS community_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
    );
    const applied = new Set(
      (
        await client.query<{ version: number }>('SELECT version FROM community_migrations')
      ).rows.map((row) => row.version)
    );
    assertNoMigrationGap(applied);
    for (const [version, filename] of COMMUNITY_MIGRATIONS) {
      if (applied.has(version)) continue;
      const sql = await readFile(
        fileURLToPath(new URL(`../migrations/${filename}`, import.meta.url)),
        'utf8'
      );
      await client.query(sql);
      await client.query('INSERT INTO community_migrations(version) VALUES ($1)', [version]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const databaseUrl = process.env.COMMUNITY_DATABASE_URL;
  if (!databaseUrl) throw new Error('COMMUNITY_DATABASE_URL is required');
  await migrate(databaseUrl);
}
