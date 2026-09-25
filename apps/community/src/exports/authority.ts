import type { Pool, PoolClient } from 'pg';

/** Who an export is for: one member's own data, or the whole community for its owner. */
export type ExportScope = 'personal' | 'owner';

/**
 * Lifecycles in which an owner may export: a host hold keeps the owner's way out open. A personal
 * export needs an active community.
 */
export const OWNER_EXPORT_LIFECYCLES = ['active', 'archived', 'held'] as const;

type Queryable = Pick<Pool | PoolClient, 'query'>;

/**
 * Channels a member can read now: a channel they belong to, or one an active agent of theirs
 * belongs to while they are active. A personal export covers exactly these, chosen when it starts.
 */
export const READABLE_CHANNEL_SQL = `(
  EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id=c.id AND cm.member_id=$1)
  OR EXISTS (
    SELECT 1 FROM agent_channel_members acm JOIN agents a ON a.id=acm.agent_id
    JOIN members owner ON owner.id=a.owner_member_id
    WHERE acm.channel_id=c.id AND a.owner_member_id=$1 AND a.active AND owner.active
  )
)`;

/** The requester of one export and what it covers. */
export interface ExportRequester {
  communityId: string;
  memberId: string;
  scope: ExportScope;
  /** Personal scope: the channels chosen when the export started. */
  channelIds: readonly string[];
}

/**
 * Whether the requester may still have this export: an active member of a community in an
 * allowed lifecycle, still its owner for an owner export, and still able to read every exported
 * channel for a personal one. `lock` takes the community and member rows `FOR SHARE`, in that
 * order (the order every administration mutation uses), so a demotion or lifecycle change waits
 * for the caller's transaction.
 */
export async function hasExportAuthority(
  db: Queryable,
  requester: ExportRequester,
  lock = false
): Promise<boolean> {
  const share = lock ? ' FOR SHARE' : '';
  const community = await db.query<{ lifecycle: string }>(
    `SELECT lifecycle FROM communities WHERE id=$1${share}`,
    [requester.communityId]
  );
  const lifecycle = community.rows[0]?.lifecycle;
  const allowed =
    requester.scope === 'owner'
      ? (OWNER_EXPORT_LIFECYCLES as readonly string[]).includes(lifecycle ?? '')
      : lifecycle === 'active';
  if (!allowed) return false;
  const member = await db.query<{ role: string }>(
    `SELECT role FROM members WHERE id=$1 AND community_id=$2 AND active${share}`,
    [requester.memberId, requester.communityId]
  );
  const role = member.rows[0]?.role;
  if (!role || (requester.scope === 'owner' && role !== 'owner')) return false;
  if (requester.scope === 'owner' || requester.channelIds.length === 0) return true;
  const readable = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM channels c
     WHERE c.community_id=$3 AND c.id=ANY($2::uuid[]) AND ${READABLE_CHANNEL_SQL}`,
    [requester.memberId, requester.channelIds, requester.communityId]
  );
  return Number(readable.rows[0].count) === requester.channelIds.length;
}
