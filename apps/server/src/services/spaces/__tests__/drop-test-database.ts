import type { Pool } from 'pg';

/**
 * Drop a throwaway test database once every session on it has closed (DOR-3696).
 *
 * `Pool.end()`, including the one inside `migrate()`, resolves before its connections finish
 * closing, and `WITH (FORCE)` terminates a connection mid-close into an uncaught 57P01 that fails
 * the whole run. So this waits for `pg_stat_activity` to drain first. Bounded at 100 × 50 ms: a
 * connection the test leaked still gets dropped, loudly, rather than hanging.
 *
 * The one place a test may write a FORCE drop; `force-drop-guard.test.ts` refuses any other.
 *
 * @param admin - A pool on the server's maintenance database, not on `name`.
 * @param name - The database to drop: a generated lower-case identifier, quoted before it reaches
 *   SQL. Anything else is refused, so this can never drop a database a test did not name.
 * @throws Error when `name` is not a plain lower-case identifier.
 */
export async function dropTestDatabase(admin: Pool, name: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(`dropTestDatabase refuses "${name}": not a generated test database name`);
  }
  for (let tries = 0; tries < 100; tries++) {
    const open = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1',
      [name]
    );
    if (open.rows[0].n === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
}
