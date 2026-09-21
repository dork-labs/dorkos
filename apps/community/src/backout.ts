import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

/** A diagnostic for rehearsing a pre-tenancy snapshot, never permission to overwrite live data. */
export interface BackoutReadiness {
  eligible: boolean;
  reason:
    | 'single-community'
    | 'community-count'
    | 'multiple-memberships'
    | 'multiple-communities-used'
    | 'history-unavailable';
}

/** Inspect the whole host in one consistent read without returning identities or credentials. */
export async function inspectBackout(pool: Pool): Promise<BackoutReadiness> {
  const result = await pool.query<{
    community_count: number;
    multiple_memberships: boolean;
    history_count: number;
    first_matches: boolean;
    multiple_used: boolean;
  }>(`SELECT
    (SELECT count(*)::int FROM communities) AS community_count,
    EXISTS(SELECT 1 FROM members GROUP BY user_id HAVING count(*) > 1) AS multiple_memberships,
    (SELECT count(*)::int FROM community_backout_fence) AS history_count,
    EXISTS(SELECT 1 FROM community_backout_fence f JOIN communities c ON c.id=f.first_community_id) AS first_matches,
    EXISTS(SELECT 1 FROM community_backout_fence WHERE multiple_communities_used) AS multiple_used`);
  const row = result.rows[0];
  if (!row || row.history_count !== 1) return { eligible: false, reason: 'history-unavailable' };
  if (row.multiple_used) return { eligible: false, reason: 'multiple-communities-used' };
  if (row.community_count !== 1) return { eligible: false, reason: 'community-count' };
  if (row.multiple_memberships) return { eligible: false, reason: 'multiple-memberships' };
  if (!row.first_matches) return { eligible: false, reason: 'history-unavailable' };
  return { eligible: true, reason: 'single-community' };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // Offline recovery needs only the database, not the web app's authentication/storage secrets.
  // eslint-disable-next-line no-restricted-syntax -- This standalone command has a separate, minimal environment contract.
  const url = process.env.COMMUNITY_DATABASE_URL;
  if (!url) {
    process.stderr.write('COMMUNITY_DATABASE_URL is required.\n');
    process.exitCode = 1;
  } else {
    const pool = new Pool({
      connectionString: url,
      connectionTimeoutMillis: 10_000,
      query_timeout: 10_000,
    });
    try {
      const result = await inspectBackout(pool);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (!result.eligible) process.exitCode = 1;
    } catch {
      // Driver errors can include connection strings. Never print them here.
      process.stderr.write('Cannot check recovery history. No restore is approved.\n');
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  }
}
