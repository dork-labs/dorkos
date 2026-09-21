import type { Pool, PoolClient } from 'pg';
import type { Context } from 'hono';
import type { CommunityAuth } from './auth.js';
import { ApiError } from './http.js';
import { hashSecret, readCookie, verifyValue } from './security.js';
import type { CommunityConfig } from './config.js';
import { resolveCommunityContext, type CommunityContext } from './tenant-context.js';

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
  historyOnly?: boolean;
}

function lifecycleError(lifecycle: string): ApiError {
  if (lifecycle === 'archived')
    return new ApiError(423, 'COMMUNITY_ARCHIVED', 'This community is archived.');
  if (lifecycle === 'suspended')
    return new ApiError(503, 'COMMUNITY_SUSPENDED', 'This community is suspended.');
  if (lifecycle === 'deletion_pending')
    return new ApiError(423, 'COMMUNITY_DELETION_PENDING', 'This community is being deleted.');
  return new ApiError(409, 'COMMUNITY_UNAVAILABLE', 'This community is unavailable.');
}

function archivedReadAllowed(
  lifecycle: string,
  scope: 'read' | 'post' | 'enroll-agent',
  scopes?: readonly string[]
): boolean {
  return lifecycle === 'archived' && scope === 'read' && (!scopes || scopes.join(',') === 'read');
}

function bearer(c: Context): string | null {
  const header = c.req.header('authorization');
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
}

/** Lock the selected community and refuse member traffic outside its active lifecycle. */
export async function lockActiveCommunity(client: PoolClient, communityId: string): Promise<void> {
  const result = await client.query<{ lifecycle: string }>(
    'SELECT lifecycle FROM communities WHERE id=$1 FOR SHARE',
    [communityId]
  );
  const lifecycle = result.rows[0]?.lifecycle;
  if (lifecycle === 'active') return;
  if (lifecycle === 'archived')
    throw new ApiError(423, 'COMMUNITY_ARCHIVED', 'This community is archived.');
  if (lifecycle === 'suspended')
    throw new ApiError(503, 'COMMUNITY_SUSPENDED', 'This community is suspended.');
  if (lifecycle === 'deletion_pending')
    throw new ApiError(423, 'COMMUNITY_DELETION_PENDING', 'This community is being deleted.');
  throw new ApiError(409, 'COMMUNITY_UNAVAILABLE', 'This community is unavailable.');
}

/** Require a live scoped personal connection token; cookies cannot issue agent secrets. */
export async function requireConnectionGrant(
  c: Context,
  pool: Pool,
  scope: 'read' | 'post' | 'enroll-agent'
) {
  const token = bearer(c);
  if (!token) throw new ApiError(401, 'UNAUTHENTICATED', 'A connected local install is required.');
  const tenant = await resolveCommunityContext(c, pool);
  const tokenHash = hashSecret(token);
  const result = await pool.query<Member & { scopes: string[]; grant_id: string }>(
    `SELECT m.id,m.user_id,m.display_name,m.role,m.community_id,g.scopes,g.id AS grant_id
     FROM connection_grants g JOIN members m ON m.id=g.member_id
     WHERE g.token_hash=$1 AND g.community_id=$2 AND m.community_id=$2
       AND g.revoked_at IS NULL AND m.active`,
    [tokenHash, tenant.communityId]
  );
  const member = result.rows[0];
  if (!member || !member.scopes.includes(scope))
    throw new ApiError(401, 'UNAUTHENTICATED', 'This connection is unavailable or lacks access.');
  if (tenant.lifecycle !== 'active' && !archivedReadAllowed(tenant.lifecycle, scope, member.scopes))
    throw lifecycleError(tenant.lifecycle);
  await pool.query('UPDATE connection_grants SET last_used_at=now() WHERE id=$1', [
    member.grant_id,
  ]);
  return { member, tokenHash };
}

/** Recheck a personal grant on the mutation connection after it waited on a channel lock. */
export async function assertConnectionGrantCurrent(
  client: PoolClient,
  memberId: string,
  tokenHash: string,
  communityId: string,
  scope: 'read' | 'post' | 'enroll-agent'
): Promise<void> {
  const lifecycleResult = await client.query<{ lifecycle: string }>(
    'SELECT lifecycle FROM communities WHERE id=$1 FOR SHARE',
    [communityId]
  );
  const lifecycle = lifecycleResult.rows[0]?.lifecycle;
  if (lifecycle !== 'active' && !(lifecycle === 'archived' && scope === 'read'))
    throw lifecycleError(lifecycle ?? 'unavailable');
  const owner = await client.query(
    'SELECT 1 FROM members WHERE id=$1 AND community_id=$2 AND active FOR UPDATE',
    [memberId, communityId]
  );
  if (!owner.rowCount) throw new ApiError(403, 'FORBIDDEN', 'Owner membership has ended.');
  const grant = await client.query(
    `SELECT 1 FROM connection_grants WHERE member_id=$1 AND community_id=$2
     AND token_hash=$3 AND revoked_at IS NULL AND scopes @> ARRAY[$4]::text[]
     AND ($5::text <> 'archived' OR history_only) FOR SHARE`,
    [memberId, communityId, tokenHash, scope, lifecycle]
  );
  if (!grant.rowCount)
    throw new ApiError(401, 'UNAUTHENTICATED', 'This connection is unavailable.');
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
    const tenant = await resolveCommunityContext(c, pool);
    if (tenant.lifecycle !== 'active' && !archivedReadAllowed(tenant.lifecycle, scope))
      throw lifecycleError(tenant.lifecycle);
    return {
      kind: 'human',
      id: member.id,
      ownerMemberId: member.id,
      display_name: member.display_name,
      community_id: member.community_id,
    };
  }
  const tenant = await resolveCommunityContext(c, pool);
  const tokenHash = hashSecret(token);
  const human = await pool.query<{
    id: string;
    display_name: string;
    community_id: string;
    scopes: string[];
    history_only: boolean;
  }>(
    `SELECT m.id,m.display_name,m.community_id,g.scopes,g.history_only FROM connection_grants g
     JOIN members m ON m.id=g.member_id WHERE g.token_hash=$1
       AND g.community_id=$2 AND m.community_id=$2 AND g.revoked_at IS NULL AND m.active`,
    [tokenHash, tenant.communityId]
  );
  if (human.rows[0]) {
    if (!human.rows[0].scopes.includes(scope))
      throw new ApiError(403, 'FORBIDDEN', 'This connection cannot perform that action.');
    if (
      tenant.lifecycle !== 'active' &&
      !archivedReadAllowed(tenant.lifecycle, scope, human.rows[0].scopes)
    )
      throw lifecycleError(tenant.lifecycle);
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
      historyOnly: human.rows[0].history_only,
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
     WHERE ac.token_hash=$1 AND ac.community_id=$2 AND a.community_id=$2
       AND m.community_id=$2 AND ac.revoked_at IS NULL AND a.active AND m.active`,
    [tokenHash, tenant.communityId]
  );
  if (!agent.rows[0]) throw new ApiError(401, 'UNAUTHENTICATED', 'This credential is unavailable.');
  if (tenant.lifecycle !== 'active') throw lifecycleError(tenant.lifecycle);
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
    current.community_id !== principal.community_id ||
    current.credentialHash !== principal.credentialHash ||
    current.historyOnly !== principal.historyOnly
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
  const lifecycleResult = await client.query<{ lifecycle: string }>(
    'SELECT lifecycle FROM communities WHERE id=$1 FOR SHARE',
    [principal.community_id]
  );
  const lifecycle = lifecycleResult.rows[0]?.lifecycle;
  if (lifecycle !== 'active' && !(lifecycle === 'archived' && scope === 'read'))
    throw lifecycleError(lifecycle ?? 'unavailable');
  if (principal.kind === 'agent') {
    const current = await client.query(
      `SELECT 1 FROM agent_credentials ac JOIN agents a ON a.id=ac.agent_id
       JOIN members owner ON owner.id=a.owner_member_id
       WHERE ac.agent_id=$1 AND ac.token_hash=$2 AND ac.revoked_at IS NULL
         AND ac.community_id=$3 AND a.community_id=$3 AND owner.community_id=$3
         AND a.active AND owner.active AND a.owner_member_id=$4`,
      [principal.id, principal.credentialHash, principal.community_id, principal.ownerMemberId]
    );
    if (current.rowCount) return;
  } else if (principal.credentialKind === 'grant') {
    const current = await client.query(
      `SELECT 1 FROM connection_grants g JOIN members m ON m.id=g.member_id
       WHERE g.member_id=$1 AND g.token_hash=$2 AND g.revoked_at IS NULL
         AND g.community_id=$3 AND m.community_id=$3
         AND g.scopes @> ARRAY[$4]::text[] AND m.active
         AND ($5::text <> 'archived' OR g.history_only)`,
      [principal.id, principal.credentialHash, principal.community_id, scope, lifecycle]
    );
    if (current.rowCount) return;
  } else if (sessionId) {
    // Member removal locks M then deletes S. Take those row locks in the same
    // order; a joined FOR SHARE can lock S first and deadlock with removal.
    const member = await client.query<{ user_id: string }>(
      'SELECT user_id FROM members WHERE id=$1 AND community_id=$2 AND active FOR SHARE',
      [principal.id, principal.community_id]
    );
    if (member.rows[0]) {
      const current = await client.query(
        'SELECT 1 FROM session WHERE id=$1 AND "userId"=$2 AND "expiresAt">now() FOR SHARE',
        [sessionId, member.rows[0].user_id]
      );
      if (current.rowCount) return;
    }
  }
  throw new ApiError(401, 'UNAUTHENTICATED', 'This credential is unavailable.');
}

/** Lock the quota owner and recheck an actor's credential at a requested scope. */
export async function lockPrincipalAuthority(
  client: PoolClient,
  principal: Principal,
  scope: 'read' | 'post' = 'post'
): Promise<void> {
  const lifecycleResult = await client.query<{ lifecycle: string }>(
    'SELECT lifecycle FROM communities WHERE id=$1 FOR SHARE',
    [principal.community_id]
  );
  const lifecycle = lifecycleResult.rows[0]?.lifecycle;
  if (lifecycle !== 'active' && !(lifecycle === 'archived' && scope === 'read'))
    throw lifecycleError(lifecycle ?? 'unavailable');
  const owner = await client.query(
    'SELECT 1 FROM members WHERE id=$1 AND community_id=$2 AND active FOR UPDATE',
    [principal.ownerMemberId, principal.community_id]
  );
  if (!owner.rowCount) throw new ApiError(403, 'FORBIDDEN', 'The owner membership has ended.');
  if (principal.kind === 'agent') {
    const agent = await client.query(
      'SELECT 1 FROM agents WHERE id=$1 AND community_id=$2 AND owner_member_id=$3 AND active FOR SHARE',
      [principal.id, principal.community_id, principal.ownerMemberId]
    );
    if (!agent.rowCount) throw new ApiError(403, 'FORBIDDEN', 'This agent is no longer active.');
    const cred = await client.query(
      'SELECT 1 FROM agent_credentials WHERE agent_id=$1 AND community_id=$2 AND token_hash=$3 AND revoked_at IS NULL FOR SHARE',
      [principal.id, principal.community_id, principal.credentialHash]
    );
    if (!cred.rowCount)
      throw new ApiError(401, 'UNAUTHENTICATED', 'This credential is unavailable.');
  } else if (principal.credentialKind === 'grant') {
    const grant = await client.query(
      `SELECT 1 FROM connection_grants WHERE member_id=$1 AND community_id=$2
       AND token_hash=$3 AND revoked_at IS NULL AND scopes @> ARRAY[$4]::text[]
       AND ($5::text <> 'archived' OR history_only) FOR SHARE`,
      [principal.id, principal.community_id, principal.credentialHash, scope, lifecycle]
    );
    if (!grant.rowCount)
      throw new ApiError(401, 'UNAUTHENTICATED', 'This connection is unavailable.');
  }
}

/** Require a current Better Auth session and a live admitted member row. */
export async function requireMember(
  c: Context,
  auth: CommunityAuth,
  pool: Pool,
  options: { allowDeletionPending?: boolean } = {}
): Promise<Member> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  let tenant: CommunityContext;
  try {
    tenant = await resolveCommunityContext(c, pool, options);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && !c.req.param('communityId')) {
      throw new ApiError(403, 'FORBIDDEN', 'You have not joined this community.');
    }
    throw error;
  }
  const result = await pool.query<Member>(
    'SELECT id,user_id,display_name,role,community_id FROM members WHERE user_id=$1 AND community_id=$2 AND active',
    [session.user.id, tenant.communityId]
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
    `SELECT id FROM bootstrap_grants WHERE token_hash=$1 AND purpose='first_install'
       AND community_id IS NULL AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`,
    [hashSecret(token)]
  );
  if (!result.rows[0])
    throw new ApiError(403, 'FORBIDDEN', 'The owner grant has expired or was used.');
  return result.rows[0].id;
}

/** Assert that a host account currently holds operational authority. */
export async function requireHostOperator(
  c: Context,
  auth: CommunityAuth,
  pool: Pool
): Promise<{ userId: string; name: string }> {
  const user = await requireSessionUser(c, auth);
  const operator = await pool.query(
    'SELECT 1 FROM host_operators WHERE user_id=$1 AND revoked_at IS NULL',
    [user.id]
  );
  if (!operator.rowCount) {
    throw new ApiError(403, 'FORBIDDEN', 'Host operator access is required.');
  }
  return { userId: user.id, name: user.name };
}

/** Lock a channel before a post or membership change and hide unauthorized private rooms. */
export async function lockChannel(
  client: PoolClient,
  channelId: string,
  member: Member | Principal,
  scope: 'read' | 'post' = 'post'
) {
  if (scope === 'post') {
    await lockActiveCommunity(client, member.community_id);
  } else {
    const lifecycle = await client.query<{ lifecycle: string }>(
      'SELECT lifecycle FROM communities WHERE id=$1 FOR SHARE',
      [member.community_id]
    );
    if (!['active', 'archived'].includes(lifecycle.rows[0]?.lifecycle ?? ''))
      throw lifecycleError(lifecycle.rows[0]?.lifecycle ?? 'unavailable');
  }
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
  await lockActiveCommunity(client, member.community_id);
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
