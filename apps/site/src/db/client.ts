/**
 * Lazy Neon Postgres + Drizzle client for apps/site.
 *
 * The client is created on first call and cached for the lifetime of the
 * process (the Edge runtime keeps it warm between invocations on the same
 * region). `getDb()` throws if `DATABASE_URL` is not set so misconfiguration
 * fails loudly at the first query rather than silently returning `undefined`.
 *
 * Re-exports the schema namespace as `schema` so callers can write
 * `db.select().from(schema.marketplaceInstallEvents)` without a second import.
 *
 * @module db/client
 */
import { neon } from '@neondatabase/serverless';
import { drizzle, type NeonHttpDatabase } from 'drizzle-orm/neon-http';

import * as schema from './schema';

export { schema };

let cached: NeonHttpDatabase<typeof schema> | null = null;

/**
 * Return the shared Drizzle client, creating it on first call.
 *
 * @throws Error when `DATABASE_URL` is not set in the environment.
 */
export function getDb(): NeonHttpDatabase<typeof schema> {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Configure the Neon integration in Vercel or your local .env.'
    );
  }
  const sql = neon(url);
  cached = drizzle(sql, { schema });
  return cached;
}
