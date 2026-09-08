/**
 * Lazy Neon Postgres + Drizzle client for the site's Node.js routes.
 *
 * The WebSocket Pool supports interactive transactions: managed authority reads,
 * row locks and dependent writes must share one connection until commit/rollback.
 * The HTTP driver cannot run these callbacks. Node.js 22+ supplies WebSocket.
 *
 * @module db/transaction-client
 */
import { Pool } from '@neondatabase/serverless';
import { attachDatabasePool } from '@vercel/functions/db-connections';
import { drizzle, type NeonDatabase } from 'drizzle-orm/neon-serverless';

import * as schema from './schema';

let cached: NeonDatabase<typeof schema> | null = null;

/**
 * Return the shared transaction-capable client, creating its pool on first use.
 *
 * @throws Error when DATABASE_URL is absent.
 */
export function getTransactionDb(): NeonDatabase<typeof schema> {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Configure the Neon integration in Vercel or your local .env.'
    );
  }
  const pool = new Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
  });
  // Fluid compute reuses this pool across concurrent requests. Keep the function
  // alive after a release until idle sockets close, rather than leaking them
  // when the instance suspends.
  attachDatabasePool(pool);
  // Idle socket errors have no awaiting caller. Do not log the error object:
  // driver messages can include connection details or SQL parameter values.
  pool.on('error', () => console.error('A database connection closed unexpectedly.'));
  const db = drizzle(pool, { schema });
  // Drizzle 0.45's Pool transaction acquires a client, then awaits BEGIN before
  // its release finally block. Own that checkout here so a failed BEGIN cannot
  // exhaust the pool. The client-backed driver still owns the real transaction,
  // including rollback, savepoints and the original error semantics.
  db.transaction = async (transaction, config) => {
    const client = await pool.connect();
    let failed = false;
    try {
      return await drizzle(client, { schema }).transaction(transaction, config);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      // A failed rollback or interrupted commit can leave session state unknown.
      // Discard that connection rather than making it available to another request.
      client.release(failed);
    }
  };
  cached = db;
  return db;
}
