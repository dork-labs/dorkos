import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

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
    const applied = await client.query(
      'SELECT version FROM community_migrations WHERE version = 1'
    );
    if (applied.rowCount === 0) {
      const sql = await readFile(
        fileURLToPath(new URL('../migrations/0001_foundation.sql', import.meta.url)),
        'utf8'
      );
      await client.query(sql);
      await client.query('INSERT INTO community_migrations(version) VALUES (1)');
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
