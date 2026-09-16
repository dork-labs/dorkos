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

/** Authenticated human or agent principal for room read/post operations. */
export interface Principal {
  kind: 'human' | 'agent';
  id: string;
  ownerMemberId: string;
  display_name: string;
  community_id: string;
  credentialHash?: string;
  credentialKind?: 'grant' | 'agent';
}

function bearer(c: Context): string | null {
  const header = c.req.header('authorization');
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
}

/** Require a live scoped personal connection token; cookies cannot issue agent secrets. */
export async function requireConnectionGrant(
  c: Context,
  pool: Pool,
  scope: 'read' | 'post' | 'enroll-agent'
) {
  const token = bearer(c);
  if (!token) throw new ApiError(401, 'UNAUTHENTICATED', 'A connected local install is required.');
  const tokenHash = hashSecret(token);
  const result = await pool.query<Member & { scopes: string[]; grant_id: string }>(
    `SELECT m.id,m.user_id,m.display_name,m.role,m.community_id,g.scopes,g.id AS grant_id
     FROM connection_grants g JOIN members m ON m.id=g.member_id
     WHERE g.token_hash=$1 AND g.revoked_at IS NULL AND m.active`,
    [tokenHash]
  );
  const member = result.rows[0];
  if (!member || !member.scopes.includes(scope))
    throw new ApiError(401, 'UNAUTHENTICATED', 'This connection is unavailable or lacks access.');
  await pool.query('UPDATE connection_grants SET last_used_at=now() WHERE id=$1', [
    member.grant_id,
  ]);
  return { member, tokenHash };
}

/** Resolve a cookie or a scoped bearer without accepting an acting-member hint. */
export async function requirePrincipal(
  c: Context,
  auth: CommunityAuth,
  pool: Pool,
  scope: 'read' | 'post',
  touch = true
): Promise<Principal> {
  const token = bearer(c);
  if (!token) {
    const member = await requireMember(c, auth, pool);
    return {
      kind: 'human',
      id: member.id,
      ownerMemberId: member.id,
      display_name: member.display_name,
      community_id: member.community_id,
    };
  }
  const tokenHash = hashSecret(token);
  const human = await pool.query<{
    id: string;
    display_name: string;
    community_id: string;
    scopes: string[];
  }>(
    `SELECT m.id,m.display_name,m.community_id,g.scopes FROM connection_grants g
     JOIN members m ON m.id=g.member_id WHERE g.token_hash=$1 AND g.revoked_at IS NULL AND m.active`,
    [tokenHash]
  );
  if (human.rows[0]) {
    if (!human.rows[0].scopes.includes(scope))
      throw new ApiError(403, 'FORBIDDEN', 'This connection cannot perform that action.');
    if (touch)
      await pool.query(
        "UPDATE connection_grants SET last_used_at=now() WHERE token_hash=$1 AND revoked_at IS NULL AND (last_used_at IS NULL OR last_used_at<now()-interval '1 minute')",
        [tokenHash]
      );
    return {
      kind: 'human',
      id: human.rows[0].id,
      ownerMemberId: human.rows[0].id,
      display_name: human.rows[0].display_name,
      community_id: human.rows[0].community_id,
      credentialHash: tokenHash,
      credentialKind: 'grant',
    };
  }
  const agent = await pool.query<{
    id: string;
    display_name: string;
    community_id: string;
    owner_member_id: string;
  }>(
    `SELECT a.id,a.display_name,a.community_id,a.owner_member_id FROM agent_credentials ac
     JOIN agents a ON a.id=ac.agent_id JOIN members m ON m.id=a.owner_member_id
     WHERE ac.token_hash=$1 AND ac.revoked_at IS NULL AND a.active AND m.active`,
    [tokenHash]
  );
  if (!agent.rows[0]) throw new ApiError(401, 'UNAUTHENTICATED', 'This credential is unavailable.');
  return {
    kind: 'agent',
    id: agent.rows[0].id,
    ownerMemberId: agent.rows[0].owner_member_id,
    display_name: agent.rows[0].display_name,
    community_id: agent.rows[0].community_id,
    credentialHash: tokenHash,
    credentialKind: 'agent',
  };
}

/** Revalidate the exact cookie or bearer after a read waited on another transaction. */
export async function assertPrincipalCurrent(
  c: Context,
  auth: CommunityAuth,
  pool: Pool,
  principal: Principal,
  scope: 'read' | 'post'
): Promise<void> {
  const current = await requirePrincipal(c, auth, pool, scope, false);
  if (
    current.id !== principal.id ||
    current.kind !== principal.kind ||
    current.credentialHash !== principal.credentialHash
  ) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'This credential is unavailable.');
  }
}

/** Recheck a read's exact credential on its existing transaction connection. */
export async function assertPrincipalCurrentInTransaction(
  client: PoolClient,
  principal: Principal,
  scope: 'read' | 'post',
  sessionId?: string
): Promise<void> {
  if (principal.kind === 'agent') {
    const current = await client.query(
      `SELECT 1 FROM agent_credentials ac JOIN agents a ON a.id=ac.agent_id
       JOIN members owner ON owner.id=a.owner_member_id
       WHERE ac.agent_id=$1 AND ac.token_hash=$2 AND ac.revoked_at IS NULL
         AND a.active AND owner.active AND a.owner_member_id=$3`,
      [principal.id, principal.credentialHash, principal.ownerMemberId]
    );
    if (current.rowCount) return;
  } else if (principal.credentialKind === 'grant') {
    const current = await client.query(
      `SELECT 1 FROM connection_grants g JOIN members m ON m.id=g.member_id
       WHERE g.member_id=$1 AND g.token_hash=$2 AND g.revoked_at IS NULL
         AND g.scopes @> ARRAY[$3]::text[] AND m.active`,
      [principal.id, principal.credentialHash, scope]
    );
    if (current.rowCount) return;
  } else if (sessionId) {
    const current = await client.query(
      `SELECT 1 FROM session s JOIN members m ON m.user_id=s."userId"
       WHERE s.id=$1 AND m.id=$2 AND s."expiresAt">now() AND m.active`,
      [sessionId, principal.id]
    );
    if (current.rowCount) return;
  }
  throw new ApiError(401, 'UNAUTHENTICATED', 'This credential is unavailable.');
}

/** Lock the quota owner and recheck an actor's credential at a requested scope. */
export async function lockPrincipalAuthority(
  client: PoolClient,
  principal: Principal,
  scope: 'read' | 'post' = 'post'
): Promise<void> {
  const owner = await client.query('SELECT 1 FROM members WHERE id=$1 AND active FOR UPDATE', [
    principal.ownerMemberId,
  ]);
  if (!owner.rowCount) throw new ApiError(403, 'FORBIDDEN', 'The owner membership has ended.');
  if (principal.kind === 'agent') {
    const agent = await client.query(
      'SELECT 1 FROM agents WHERE id=$1 AND owner_member_id=$2 AND active FOR SHARE',
      [principal.id, principal.ownerMemberId]
    );
    if (!agent.rowCount) throw new ApiError(403, 'FORBIDDEN', 'This agent is no longer active.');
    const cred = await client.query(
      'SELECT 1 FROM agent_credentials WHERE agent_id=$1 AND token_hash=$2 AND revoked_at IS NULL FOR SHARE',
      [principal.id, principal.credentialHash]
    );
    if (!cred.rowCount)
      throw new ApiError(401, 'UNAUTHENTICATED', 'This credential is unavailable.');
  } else if (principal.credentialKind === 'grant') {
    const grant = await client.query(
      'SELECT 1 FROM connection_grants WHERE member_id=$1 AND token_hash=$2 AND revoked_at IS NULL AND scopes @> ARRAY[$3]::text[] FOR SHARE',
      [principal.id, principal.credentialHash, scope]
    );
    if (!grant.rowCount)
      throw new ApiError(401, 'UNAUTHENTICATED', 'This connection is unavailable.');
  }
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
export async function lockChannel(
  client: PoolClient,
  channelId: string,
  member: Member | Principal
) {
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
    'kind' in member && member.kind === 'agent'
      ? 'SELECT 1 FROM agent_channel_members WHERE channel_id=$1 AND agent_id=$2'
      : 'SELECT 1 FROM channel_members WHERE channel_id=$1 AND member_id=$2',
    [row.id, member.id]
  );
  const channel = { ...row, joined: Boolean(membership.rowCount) };
  if (!channel || (channel.visibility === 'private' && !channel.joined)) {
    throw new ApiError(404, 'NOT_FOUND', 'Channel not found.');
  }
  return channel;
}

/** Lock and check the current actor after the channel lock for each channel mutation. */
export async function requireLiveRole(
  client: PoolClient,
  member: Member,
  allowed: readonly Member['role'][]
): Promise<Member['role']> {
  const result = await client.query<{ role: Member['role'] }>(
    'SELECT role FROM members WHERE id=$1 AND community_id=$2 AND active FOR SHARE',
    [member.id, member.community_id]
  );
  const role = result.rows[0]?.role;
  if (!role || !allowed.includes(role))
    throw new ApiError(403, 'FORBIDDEN', 'Your current role cannot perform this action.');
  return role;
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
