/**
 * Pre-migrate step: record the named history's baseline as applied on a
 * database that already has its tables.
 *
 *   tsx scripts/baseline-migrations.ts public          # `pnpm db:migrate`, every Vercel build
 *   tsx scripts/baseline-migrations.ts control-plane   # `pnpm db:migrate:control-plane`, local/test only
 *
 * Runs before the matching `drizzle-kit migrate`. On a database built by the
 * frozen pre-split `drizzle/` history it writes one journal row and changes
 * nothing else; on a fresh database it writes nothing and the baseline runs
 * normally; on a database that has already been through this once it writes
 * nothing again. The decision itself, and why the row is shaped the way it is,
 * live in `./migration-histories.ts`.
 *
 * The history is named on the command line rather than walked: a deploy must
 * never touch the control-plane journal, and asking for it inside a Vercel
 * build is refused before anything connects (`./control-plane-deploy-guard.ts`).
 *
 * Exits non-zero on any failure, so a bad state stops the build rather than
 * letting `drizzle-kit migrate` replay DDL against live data.
 *
 * @module scripts/baseline-migrations
 */
import { Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';

import { markBaselineApplied, selectHistories } from './migration-histories';

/** Connect, baseline each named history, report what each one decided. */
async function main(): Promise<void> {
  // Before the connection string is even read: a refused history must not get
  // as far as opening a connection.
  const histories = selectHistories(process.argv.slice(2));

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
    for (const history of histories) {
      const outcome = await markBaselineApplied(db, history);
      console.log(`[baseline] ${history.id}: ${outcome} (${history.migrationsTable})`);
    }
  } finally {
    await pool.end();
  }
}

await main();
