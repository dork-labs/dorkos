import type { Pool, PoolClient } from 'pg';
import type { Context } from 'hono';
import type { CommunityAuth } from './auth.js';
import { ApiError } from './http.js';
import { hashSecret, readCookie, verifyValue } from './security.js';
import type { CommunityConfig } from './config.js';

/** Live human identity derived from a session and member row. */
export interface Member {
  id: string;
  user_id: string;
  display_name: string;
  role: 'owner' | 'admin' | 'member';
  community_id: string;
}

/** Require a current Better Auth session and a live admitted member row. */
export async function requireMember(c: Context, auth: CommunityAuth, pool: Pool): Promise<Member> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  const result = await pool.query<Member>(
    'SELECT id,user_id,display_name,role,community_id FROM members WHERE user_id=$1 AND active',
    [session.user.id]
  );
  if (!result.rows[0]) throw new ApiError(403, 'FORBIDDEN', 'You have not joined this community.');
  return result.rows[0];
}

/** Require a session for owner claim while allowing an unadmitted account. */
export async function requireSessionUser(
  c: Context,
  auth: CommunityAuth
): Promise<{ id: string; name: string }> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  return { id: session.user.id, name: session.user.name };
}

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
    'SELECT id FROM bootstrap_grants WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE',
    [hashSecret(token)]
  );
  if (!result.rows[0])
    throw new ApiError(403, 'FORBIDDEN', 'The owner grant has expired or was used.');
  return result.rows[0].id;
}

/** Lock a channel before a post or membership change and hide unauthorized private rooms. */
export async function lockChannel(client: PoolClient, channelId: string, member: Member) {
  const result = await client.query<{
    id: string;
    name: string;
    description: string | null;
    visibility: 'public' | 'private';
    archived: boolean;
    last_seq: string;
    epoch: number;
    created_at: Date;
  }>(`SELECT c.* FROM channels c WHERE c.id=$1 AND c.community_id=$2 FOR UPDATE OF c`, [
    channelId,
    member.community_id,
  ]);
  const row = result.rows[0];
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Channel not found.');
  // Membership must be read in a new statement after any competing channel lock commits.
  const membership = await client.query(
    'SELECT 1 FROM channel_members WHERE channel_id=$1 AND member_id=$2',
    [row.id, member.id]
  );
  const channel = { ...row, joined: Boolean(membership.rowCount) };
  if (!channel || (channel.visibility === 'private' && !channel.joined)) {
    throw new ApiError(404, 'NOT_FOUND', 'Channel not found.');
  }
  return channel;
}

/** Require current channel membership for history, posting and live streams. */
export function requireJoined(channel: { joined: boolean }): void {
  if (!channel.joined) throw new ApiError(403, 'FORBIDDEN', 'Join this channel first.');
}

/** Execute a transaction and release its pooled connection on every path. */
export async function transaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
