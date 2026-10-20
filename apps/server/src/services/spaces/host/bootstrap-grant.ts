import type { Context } from 'hono';
import type { PoolClient } from 'pg';
import type { CommunityConfig } from '../config.js';
import { ApiError } from '../http.js';
import { hashSecret, readCookie, verifyValue } from '../security.js';

/** Assert the bootstrap cookie still maps to an unconsumed live row. */
export async function bootstrapGrant(
  c: Context,
  client: PoolClient,
  config: CommunityConfig
): Promise<string> {
  const token = verifyValue(
    readCookie(c.req.header('cookie') ?? null, 'community_bootstrap'),
    config.authSecret
  );
  if (!token) throw new ApiError(403, 'FORBIDDEN', 'The owner grant is missing or invalid.');
  const result = await client.query<{ id: string }>(
    `SELECT id FROM bootstrap_grants WHERE token_hash=$1 AND purpose='first_install'
       AND community_id IS NULL AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`,
    [hashSecret(token)]
  );
  if (!result.rows[0])
    throw new ApiError(403, 'FORBIDDEN', 'The owner grant has expired or was used.');
  return result.rows[0].id;
}
