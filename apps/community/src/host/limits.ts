import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import type {
  CommunityAdminLimitsSchema,
  CommunityAdminUsageSchema,
} from '@dorkos/shared/community-admin-wire';
import { ApiError } from '../http.js';

type Queryable = Pick<Pool | PoolClient, 'query'>;

/**
 * Host-set caps. A cap is a state, not a rate: the request cannot succeed until something
 * changes, so each one is `409` with its own code, never `429`. Lowering a cap below current
 * use removes nothing; it only refuses the next action that would grow past it.
 */
export const memberLimitReached = () =>
  new ApiError(409, 'MEMBER_LIMIT_REACHED', 'This community is full. Ask its owner to make room.');
/** The community's counted file space would go past its host-set limit. */
export const storageLimitReached = () =>
  new ApiError(409, 'STORAGE_LIMIT_REACHED', 'This community is out of file space.');
/** The member's active agents are at their limit in this community. */
export const agentLimitReached = () =>
  new ApiError(409, 'AGENT_LIMIT_REACHED', 'You have reached your agent limit in this community.');

/**
 * Bytes that count against a storage limit: stored or committed attachments and icons.
 * Exports are exempt, so an owner can always take their data out, and bytes already queued
 * for deletion are free the moment they are queued.
 */
const COUNTED_BLOBS = `purpose IN ('attachment','icon') AND state IN ('stored','committed')`;

/** A community's limits; a community without a row has none, at version 1. */
export async function readLimits(
  db: Queryable,
  communityId: string,
  lock: '' | 'FOR SHARE' | 'FOR UPDATE' = ''
): Promise<z.infer<typeof CommunityAdminLimitsSchema>> {
  const row = await db.query<{
    max_active_members: number | null;
    max_storage_bytes: string | null;
    limits_version: number;
  }>(
    `SELECT max_active_members,max_storage_bytes,limits_version
     FROM community_limits WHERE community_id=$1 ${lock}`,
    [communityId]
  );
  const limits = row.rows[0];
  return {
    maxActiveMembers: limits?.max_active_members ?? null,
    maxStorageBytes: limits?.max_storage_bytes == null ? null : Number(limits.max_storage_bytes),
    limitsVersion: limits?.limits_version ?? 1,
  };
}

/**
 * Refuse an admission that would take a community past its member limit.
 *
 * The limit is read without a lock first, so a community without a member limit takes no lock
 * at all. With `lock` and a limit, the row is then taken `FOR UPDATE`, which serializes
 * admissions racing for the last seat. A person who is already an active member is never
 * counted twice.
 */
export async function assertMemberRoom(
  db: Queryable,
  communityId: string,
  options: { lock: boolean; userId?: string }
): Promise<void> {
  let { maxActiveMembers } = await readLimits(db, communityId);
  if (maxActiveMembers === null) return;
  if (options.lock) ({ maxActiveMembers } = await readLimits(db, communityId, 'FOR UPDATE'));
  if (maxActiveMembers === null) return;
  if (options.userId) {
    const already = await db.query(
      'SELECT 1 FROM members WHERE community_id=$1 AND user_id=$2 AND active',
      [communityId, options.userId]
    );
    if (already.rowCount) return;
  }
  const active = await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM members WHERE community_id=$1 AND active',
    [communityId]
  );
  if (active.rows[0].n >= maxActiveMembers) throw memberLimitReached();
}

/** One member's agent limit: the host's override for them, or the host-wide setting. */
export async function effectiveAgentLimit(
  db: Queryable,
  communityId: string,
  memberId: string,
  configured: number
): Promise<number> {
  const override = await db.query<{ agents_per_member: number }>(
    'SELECT agents_per_member FROM member_limit_overrides WHERE community_id=$1 AND member_id=$2',
    [communityId, memberId]
  );
  return override.rows[0]?.agents_per_member ?? configured;
}

async function countedBytes(db: Queryable, communityId: string, exceptKey?: string) {
  const sum = await db.query<{ bytes: string }>(
    `SELECT COALESCE(sum(byte_size),0)::text AS bytes FROM managed_blobs
     WHERE community_id=$1 AND ${COUNTED_BLOBS} AND ($2::text IS NULL OR blob_key<>$2)`,
    [communityId, exceptKey ?? null]
  );
  return Number(sum.rows[0].bytes);
}

/** Bytes of one counted file, such as an icon about to be replaced; 0 if it does not count. */
export async function countedBlobBytes(
  db: Queryable,
  communityId: string,
  key: string
): Promise<number> {
  const row = await db.query<{ bytes: string | null }>(
    `SELECT byte_size::text AS bytes FROM managed_blobs
     WHERE community_id=$1 AND blob_key=$2 AND ${COUNTED_BLOBS}`,
    [communityId, key]
  );
  return Number(row.rows[0]?.bytes ?? 0);
}

/**
 * Fast refusal before any bytes are sent: would `bytes` more fit? `replacingKey` names a
 * counted file the upload replaces, such as the current icon; a replacement no larger than
 * what it replaces is always allowed, even in a community already over its limit.
 */
export async function assertStorageRoom(
  db: Queryable,
  communityId: string,
  bytes: number,
  replacingKey?: string | null
): Promise<void> {
  const { maxStorageBytes } = await readLimits(db, communityId);
  if (maxStorageBytes === null) return;
  const replaced = replacingKey ? await countedBlobBytes(db, communityId, replacingKey) : 0;
  if (bytes <= replaced) return;
  if ((await countedBytes(db, communityId, replacingKey ?? undefined)) + bytes > maxStorageBytes)
    throw storageLimitReached();
}

/**
 * The authoritative check, inside the commit transaction after the new file is stored.
 *
 * `growth` is how many counted bytes this commit adds; a commit that adds none (an icon no
 * larger than the one it replaces) always passes. Only when a limit exists, a per-community
 * advisory lock serializes commits, and the sum is read after the lock is granted, so two
 * uploads can never jointly pass the limit. The limit row itself is read without a lock: the
 * caller already holds a channel or community lock, and a row lock here would order against
 * admissions, which lock the limit row before a channel. The caller's refusal path discards
 * the reservation.
 */
export async function assertStorageWithinLimit(
  client: PoolClient,
  communityId: string,
  growth: number
): Promise<void> {
  if (growth <= 0) return;
  const { maxStorageBytes } = await readLimits(client, communityId);
  if (maxStorageBytes === null) return;
  await client.query("SELECT pg_advisory_xact_lock(hashtext('dorkos:storage:' || $1::text))", [
    communityId,
  ]);
  if ((await countedBytes(client, communityId)) > maxStorageBytes) throw storageLimitReached();
}

type Usage = z.infer<typeof CommunityAdminUsageSchema>;

/**
 * Enforcement aggregates for the host, one row per community, in id order: counts and byte
 * totals only, and the UTC day of the newest message. No names, text, or per-person numbers.
 */
export async function readUsage(
  db: Queryable,
  filter: { communityId: string } | { after: string | null; limit: number }
): Promise<Usage[]> {
  const where =
    'communityId' in filter
      ? { sql: 'c.id=$1', params: [filter.communityId] }
      : {
          sql: '($1::uuid IS NULL OR c.id>$1) ORDER BY c.id LIMIT $2',
          params: [filter.after, filter.limit],
        };
  const rows = await db.query<{
    id: string;
    measured_at: Date;
    active_members: number;
    active_agents: number;
    attachment: string;
    icon: string;
    export: string;
    import_staging: string;
    pending_delete: string;
    counted: string;
    max_active_members: number | null;
    max_storage_bytes: string | null;
    limits_version: number | null;
    last_post_date: string | null;
  }>(
    `SELECT c.id,now() AS measured_at,
       (SELECT count(*)::int FROM members m WHERE m.community_id=c.id AND m.active) AS active_members,
       (SELECT count(*)::int FROM agents a WHERE a.community_id=c.id AND a.active) AS active_agents,
       b.attachment,b.icon,b.export,b.import_staging,b.pending_delete,b.counted,
       l.max_active_members,l.max_storage_bytes::text,l.limits_version,
       (SELECT to_char((max(e.created_at) AT TIME ZONE 'UTC')::date,'YYYY-MM-DD')
          FROM entries e WHERE e.community_id=c.id) AS last_post_date
     FROM communities c
     LEFT JOIN community_limits l ON l.community_id=c.id
     CROSS JOIN LATERAL (
       SELECT
         COALESCE(sum(byte_size) FILTER (WHERE purpose='attachment' AND state IN ('stored','committed')),0)::text AS attachment,
         COALESCE(sum(byte_size) FILTER (WHERE purpose='icon' AND state IN ('stored','committed')),0)::text AS icon,
         COALESCE(sum(byte_size) FILTER (WHERE purpose='export' AND state IN ('stored','committed')),0)::text AS export,
         COALESCE(sum(byte_size) FILTER (WHERE purpose='import_staging' AND state IN ('stored','committed')),0)::text AS import_staging,
         COALESCE(sum(byte_size) FILTER (WHERE state='pending_delete'),0)::text AS pending_delete,
         COALESCE(sum(byte_size) FILTER (WHERE ${COUNTED_BLOBS}),0)::text AS counted
       FROM managed_blobs WHERE community_id=c.id
     ) b
     WHERE ${where.sql}`,
    where.params
  );
  return rows.rows.map((row) => ({
    communityId: row.id,
    measuredAt: row.measured_at.toISOString(),
    activeMembers: row.active_members,
    activeAgents: row.active_agents,
    storage: {
      attachmentBytes: Number(row.attachment),
      iconBytes: Number(row.icon),
      exportBytes: Number(row.export),
      importStagingBytes: Number(row.import_staging),
      pendingDeleteBytes: Number(row.pending_delete),
      countedBytes: Number(row.counted),
    },
    limits: {
      maxActiveMembers: row.max_active_members,
      maxStorageBytes: row.max_storage_bytes === null ? null : Number(row.max_storage_bytes),
      limitsVersion: row.limits_version ?? 1,
    },
    lastPostDate: row.last_post_date,
  }));
}
