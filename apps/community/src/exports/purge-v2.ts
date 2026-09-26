import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { transaction } from '../data.js';
import { dropSegments } from './store.js';

/**
 * Backout for background exports (specs/community-export-any-size): cancel every open job and
 * delete every version 2 export, queueing their segments for the pending-deletion sweep, so the
 * code from before can run on a database that only holds version 1 archives. Idempotent.
 *
 * @returns how many version 2 exports were removed.
 */
export async function purgeVersionTwoExports(pool: Pool): Promise<number> {
  let removed = 0;
  while (true) {
    const batch = await transaction(pool, async (client) => {
      const rows = await client.query<{ id: string; community_id: string }>(
        `SELECT id,community_id FROM export_archives WHERE format_version=2
         ORDER BY id LIMIT 100 FOR UPDATE`
      );
      for (const row of rows.rows) {
        await dropSegments(client, row.id, row.community_id);
        await client.query('DELETE FROM export_archives WHERE id=$1', [row.id]);
      }
      return rows.rows.length;
    });
    removed += batch;
    if (batch < 100) return removed;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const databaseUrl = process.env.COMMUNITY_DATABASE_URL;
  if (!databaseUrl) {
    process.stderr.write('COMMUNITY_DATABASE_URL is required.\n');
    process.exitCode = 1;
  } else {
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const removed = await purgeVersionTwoExports(pool);
      process.stdout.write(
        `Removed ${removed} version 2 exports. Their files are deleted by the running cleanup, or on the next start.\n`
      );
    } catch {
      process.stderr.write('Removing exports failed. Check database access, then run it again.\n');
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  }
}
