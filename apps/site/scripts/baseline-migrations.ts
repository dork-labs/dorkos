/**
 * Pre-migrate step for `pnpm db:migrate`: record each history's baseline as
 * applied on a database that already has its tables.
 *
 * Runs before the two `drizzle-kit migrate` calls in the site's `db:migrate`
 * script (and therefore before every Vercel build). On a database built by the
 * frozen pre-split `drizzle/` history it writes one journal row per history and
 * changes nothing else; on a fresh database it writes nothing and the baselines
 * run normally; on a database that has already been through this once it writes
 * nothing again. The decision itself, and why the row is shaped the way it is,
 * live in `./migration-histories.ts`.
 *
 * Exits non-zero on any failure, so a bad state stops the build rather than
 * letting `drizzle-kit migrate` replay DDL against live data.
 *
 * @module scripts/baseline-migrations
 */
import { Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';

import { MIGRATION_HISTORIES, markBaselineApplied } from './migration-histories';

/** Connect, walk both histories, report what each one decided. */
async function main(): Promise<void> {
  // Same preference as the drizzle configs: Neon's pooler can choke on DDL and
  // advisory locks, so take the direct connection when the integration offers it.
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Configure the Neon integration in Vercel or your local .env.'
    );
  }

  const pool = new Pool({ connectionString: url });
  try {
    const db = drizzle(pool);
    // Own the checkout, exactly as src/db/transaction-client.ts does and for the
    // same measured reason: drizzle 0.45's Pool transaction acquires a client and
    // then awaits BEGIN, both BEFORE its own release `finally`. A connection that
    // dies in that window leaks the client, and `pool.end()` below would then wait
    // on a client that is never released — turning a failure this script is
    // supposed to report into a build that hangs.
    db.transaction = async (transaction, config) => {
      const client = await pool.connect();
      let failed = false;
      try {
        return await drizzle(client).transaction(transaction, config);
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        // A failed rollback or interrupted commit leaves session state unknown —
        // and this connection may still hold the advisory lock. Discard it rather
        // than returning it to the pool.
        client.release(failed);
      }
    };
    for (const history of MIGRATION_HISTORIES) {
      const outcome = await markBaselineApplied(db, history);
      console.log(`[baseline] ${history.id}: ${outcome} (${history.migrationsTable})`);
    }
  } finally {
    await pool.end();
  }
}

await main();
